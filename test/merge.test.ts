import { describe, it, expect } from 'vitest';
import {
  mergeDictionaries, applyResolutions, removeSource, mergeAll, normalizeName, defaultResolutions,
} from '../src/dictionary/merge';
import { emptyDictionary, migrateDict, DictionaryModel, DictSource, makeSourceId } from '../src/dictionary/model';

const src = (id: string, name: string, priority = 10): DictSource => ({
  id, kind: 'pdm', name, importedAt: '2026-10-25T00:00:00.000Z', tableCount: 0, enabled: true, priority,
});

function dictWith(tables: { name: string; comment?: string; cols: { name: string; type?: string; comment?: string; pk?: boolean; nullable?: boolean }[] }[]): DictionaryModel {
  const d = emptyDictionary('t');
  for (const t of tables) {
    d.tables.push({
      name: t.name,
      comment: t.comment,
      columns: t.cols.map((c) => ({ name: c.name, type: c.type || 'varchar', comment: c.comment, pk: c.pk, nullable: c.nullable })),
      indexes: [], foreignKeys: [],
    });
  }
  return d;
}

describe('名称归一化', () => {
  it('忽略大小写与前缀差异（金蝶 T_BD_STAFF vs 库里 t_bd_staff）', () => {
    expect(normalizeName('T_BD_STAFF')).toBe(normalizeName('t_bd_staff'));
    expect(normalizeName('`t_user`')).toBe('t_user');
    expect(normalizeName(' [T_User] ')).toBe('t_user');
  });
});

describe('多来源合并', () => {
  it('新表直接并入，并打上来源标记', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'id', type: 'bigint' }] }]);
    const inc = dictWith([{ name: 't_order', cols: [{ name: 'id', type: 'bigint' }, { name: 'amount', type: 'decimal(10,2)' }] }]);
    const r = mergeDictionaries(base, inc, src('s2', '订单库'));
    expect(r.dict.tables.map((t) => t.name)).toEqual(['t_user', 't_order']);
    expect(r.dict.tables[1].origin?.sourceId).toBe('s2');
    expect(r.stats.tablesAdded).toBe(1);
    expect(r.stats.columnsAdded).toBe(2);
  });

  it('同名表按归一化匹配，不会变成两张表', () => {
    const base = dictWith([{ name: 'T_BD_STAFF', cols: [{ name: 'FPKID' }] }]);
    const inc = dictWith([{ name: 't_bd_staff', cols: [{ name: 'FNAME' }] }]);
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    expect(r.dict.tables.length).toBe(1);
    expect(r.dict.tables[0].columns.map((c) => c.name)).toEqual(['FPKID', 'FNAME']);
    expect(r.stats.tablesMatched).toBe(1);
  });

  it('新增字段并入，已有字段不丢', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'id', comment: '主键' }, { name: 'name' }] }]);
    const inc = dictWith([{ name: 't_user', cols: [{ name: 'id' }, { name: 'age', type: 'int' }, { name: 'email' }] }]);
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    expect(r.dict.tables[0].columns.map((c) => c.name)).toEqual(['id', 'name', 'age', 'email']);
    expect(r.dict.tables[0].columns[0].comment).toBe('主键');
  });

  it('注释冲突不自动覆盖，只回报冲突', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'id', comment: '主键' }] }]);
    const inc = dictWith([{ name: 't_user', cols: [{ name: 'id', comment: '用户ID' }] }]);
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    expect(r.dict.tables[0].columns[0].comment).toBe('主键');  // 保留 base
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0].field).toBe('comment');
    expect(r.conflicts[0].incomingValue).toBe('用户ID');
  });

  it('base 缺注释时用来源的补上（不算冲突）', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'id' }] }]);
    const inc = dictWith([{ name: 't_user', cols: [{ name: 'id', comment: '用户ID' }] }]);
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    expect(r.dict.tables[0].columns[0].comment).toBe('用户ID');
    expect(r.conflicts.length).toBe(0);
  });

  it('类型差异记为冲突（varchar vs int）', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'age', type: 'varchar(10)' }] }]);
    const inc = dictWith([{ name: 't_user', cols: [{ name: 'age', type: 'int' }] }]);
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    expect(r.conflicts.some((c) => c.field === 'type')).toBe(true);
  });

  it('不修改传入的 base', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'id' }] }]);
    const before = JSON.stringify(base);
    mergeDictionaries(base, dictWith([{ name: 't_x', cols: [{ name: 'a' }] }]), src('s2', '库'));
    expect(JSON.stringify(base)).toBe(before);
  });

  it('来源清单累加且不重复', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'id' }] }]);
    let r = mergeDictionaries(base, dictWith([{ name: 't_a', cols: [{ name: 'x' }] }]), src('s1', 'A'));
    r = mergeDictionaries(r.dict, dictWith([{ name: 't_b', cols: [{ name: 'y' }] }]), src('s2', 'B'));
    expect(r.dict.sources?.map((s) => s.id)).toEqual(['s1', 's2']);
    r = mergeDictionaries(r.dict, dictWith([{ name: 't_b2', cols: [{ name: 'z' }] }]), src('s1', 'A(刷新)'));
    expect(r.dict.sources?.length).toBe(2);
  });
});

describe('冲突决议', () => {
  const base = dictWith([{ name: 't_user', cols: [{ name: 'id', comment: '主键' }, { name: 'age', type: 'varchar(10)' }] }]);
  const inc = dictWith([{ name: 't_user', cols: [{ name: 'id', comment: '用户ID' }, { name: 'age', type: 'int' }] }]);

  it('逐条选择：只改勾了 incoming 的那条', () => {
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    const res: Record<string, 'base' | 'incoming'> = {};
    const c1 = r.conflicts.find((c) => c.column === 'id')!;
    res[c1.id] = 'incoming';
    const applied = applyResolutions(r.dict, r.conflicts, res);
    expect(applied.tables[0].columns[0].comment).toBe('用户ID');
    expect(applied.tables[0].columns[1].type).toBe('varchar(10)'); // 未选 → 保留 base
  });

  it('批量应用：统一采用来源值（金蝶单模型刷新场景）', () => {
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    const applied = applyResolutions(r.dict, r.conflicts, defaultResolutions(r.conflicts, 'incoming'));
    expect(applied.tables[0].columns[0].comment).toBe('用户ID');
    expect(applied.tables[0].columns[1].type).toBe('int');
  });

  it('批量应用：统一保留原值', () => {
    const r = mergeDictionaries(base, inc, src('s2', '库'));
    const applied = applyResolutions(r.dict, r.conflicts, defaultResolutions(r.conflicts, 'base'));
    expect(applied.tables[0].columns[0].comment).toBe('主键');
    expect(applied.tables[0].columns[1].type).toBe('varchar(10)');
  });
});

describe('移除来源', () => {
  it('整表来自该来源 → 删表；否则只删该来源的字段', () => {
    const base = dictWith([{ name: 't_user', cols: [{ name: 'id' }] }]);
    const r = mergeDictionaries(base, dictWith([{ name: 't_order', cols: [{ name: 'id' }, { name: 'amt' }] }]), src('s2', '订单'));
    // 手动给 t_user 里塞一个来自 s2 的字段
    r.dict.tables[0].columns.push({ name: 'ext', type: 'varchar', origin: { sourceId: 's2', kind: 'pdm' } });
    const out = removeSource(r.dict, 's2');
    expect(out.dict.tables.map((t) => t.name)).toEqual(['t_user']);
    expect(out.dict.tables[0].columns.map((c) => c.name)).toEqual(['id']);
    expect(out.removedTables).toBe(1);
    expect(out.removedColumns).toBe(1);
    expect(out.dict.sources?.some((s) => s.id === 's2')).toBe(false);
  });
});

describe('多来源整体合并', () => {
  it('按 priority 顺序合并，先到先得', () => {
    const a = { source: src('a', 'A库', 1), dict: dictWith([{ name: 't_user', cols: [{ name: 'id', comment: 'A说的' }] }]) };
    const b = { source: src('b', 'B库', 2), dict: dictWith([{ name: 't_user', cols: [{ name: 'id', comment: 'B说的' }] }]) };
    const r = mergeAll([b, a], '项目'); // 乱序传入，应按 priority 排序
    expect(r.dict.tables[0].columns[0].comment).toBe('A说的');
    expect(r.conflicts.some((c) => c.field === 'comment')).toBe(true);
    expect(r.dict.sources?.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('老字典迁移', () => {
  it('补齐 sources 与 origin，不清空数据', () => {
    const old = dictWith([{ name: 't_user', cols: [{ name: 'id' }] }]);
    old.meta = { source: 'DB.pdm', sourcePath: '/x/DB.pdm' };
    delete old.sources;
    delete old.schemaVersion; // 模拟旧版字典（没有来源清单与结构版本）
    const m = migrateDict(old);
    expect(m.schemaVersion).toBe(2);
    expect(m.sources?.length).toBe(1);
    expect(m.sources![0].kind).toBe('pdm');
    expect(m.sources![0].path).toBe('/x/DB.pdm');
    expect(m.tables[0].origin?.sourceId).toBe(m.sources![0].id);
    expect(m.tables[0].columns[0].origin?.kind).toBe('pdm');
    expect(m.tables.length).toBe(1); // 数据保留
  });
  it('已是新版本时不重复迁移', () => {
    const d = dictWith([{ name: 't', cols: [] }]);
    const once = migrateDict(d);
    const sid = once.sources![0].id;
    expect(migrateDict(once).sources![0].id).toBe(sid);
  });
  it('makeSourceId 不重复', () => {
    const ids = new Set([makeSourceId('pdm'), makeSourceId('pdm'), makeSourceId('db')]);
    expect(ids.size).toBe(3);
  });
});
