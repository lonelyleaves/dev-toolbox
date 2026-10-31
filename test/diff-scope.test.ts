/**
 * 比对范围自验证：默认只比对基线（JSON/WebAPI/库）返回的表，
 * 字典其余表不参与（不标新增、不生成 CREATE、不标删除）；全量比对时才恢复。
 */
import { describe, it, expect } from 'vitest';
import { diffDictionaries, generateFixSql, mergeBaseIntoTarget } from '../src/dictionary/diffengine';
import { emptyDictionary, type DictionaryModel, type TableDef, type ColumnDef } from '../src/dictionary/model';

const col = (name: string, type: string, comment?: string): ColumnDef => ({ name, type, comment, nullable: true });
const table = (name: string, columns: ColumnDef[]): TableDef => ({ name, columns, indexes: [], foreignKeys: [] });

function mkDict(name: string, tables: TableDef[]): DictionaryModel {
  const d = emptyDictionary(name, 'mysql');
  d.tables = tables;
  return d;
}

// 基线（JSON/WebAPI 返回）只有 1 张表；字典有 3 张（1 共有 + 2 额外）
const baseline = mkDict('baseline', [table('T_A', [col('FID', 'int'), col('FNAME', 'nvarchar(50)')])]);
const dict = mkDict('dict', [
  table('T_A', [col('FID', 'int'), col('FNAME', 'nvarchar(100)')]), // 类型变更
  table('T_B', [col('FID', 'int')]),
  table('T_C', [col('FID', 'int')]),
]);

describe('比对范围：默认只比对基线返回的表', () => {
  it('不再把字典额外表标为 added', () => {
    const items = diffDictionaries(baseline, dict);
    expect(items.some((i) => i.table === 'T_B')).toBe(false);
    expect(items.some((i) => i.table === 'T_C')).toBe(false);
    expect(items.some((i) => i.table === 'T_A' && i.kind === 'modified' && i.changes.some((c) => c.prop === '类型'))).toBe(true);
  });

  it('全量比对时才包含字典额外表', () => {
    const items = diffDictionaries(baseline, dict, { fullCompare: true });
    expect(items.some((i) => i.table === 'T_B' && i.kind === 'added')).toBe(true);
    expect(items.some((i) => i.table === 'T_C' && i.kind === 'added')).toBe(true);
  });

  it('基线表在字典缺失 → 产出字典缺失项，且仍不出现字典额外表', () => {
    const b2 = mkDict('b2', [table('T_MISSING', [col('FID', 'int')])]);
    const items = diffDictionaries(b2, dict);
    expect(items.some((i) => i.table === 'T_MISSING' && i.kind === 'removed')).toBe(true);
    expect(items.some((i) => i.table === 'T_B')).toBe(false);
  });
});

describe('修复 SQL：只为基线表生成', () => {
  it('默认不为字典额外表生成 CREATE', () => {
    const sql = generateFixSql(baseline, dict).join('\n');
    expect(sql).not.toContain('T_B');
    expect(sql).not.toContain('T_C');
    expect(sql).toContain('T_A');
  });

  it('全量比对才为字典额外表生成 CREATE', () => {
    const sql = generateFixSql(baseline, dict, false, { fullCompare: true }).join('\n');
    expect(sql).toContain('T_B');
    expect(sql).toContain('T_C');
  });
});

describe('回写安全：局部基线不误标删除', () => {
  it('默认不把基线外字典表标 deleted', () => {
    const merged = mergeBaseIntoTarget(baseline, dict);
    const byName = new Map(merged.tables.map((t) => [t.name, t]));
    expect(byName.get('T_B')?.changeTag).toBeUndefined();
    expect(byName.get('T_C')?.changeTag).toBeUndefined();
  });

  it('全量比对时才标 deleted', () => {
    const merged = mergeBaseIntoTarget(baseline, dict, { fullCompare: true });
    const byName = new Map(merged.tables.map((t) => [t.name, t]));
    expect(byName.get('T_B')?.changeTag).toBe('deleted');
    expect(byName.get('T_C')?.changeTag).toBe('deleted');
  });
});

describe('降噪开关', () => {
  it('忽略注释差异后，纯注释变更不计入', () => {
    const b = mkDict('b', [table('T', [col('FID', 'int', '旧注释')])]);
    const t = mkDict('t', [table('T', [col('FID', 'int', '新注释')])]);
    expect(diffDictionaries(b, t).some((i) => i.changes.some((c) => c.prop === '注释'))).toBe(true);
    expect(diffDictionaries(b, t, { ignoreComments: true }).length).toBe(0);
  });

  it('忽略默认值差异后，纯默认值变更不计入', () => {
    const b = mkDict('b', [table('T', [{ name: 'F', type: 'int', defaultValue: '0' }])]);
    const t = mkDict('t', [table('T', [{ name: 'F', type: 'int', defaultValue: '1' }])]);
    expect(diffDictionaries(b, t).length).toBe(1);
    expect(diffDictionaries(b, t, { ignoreDefaults: true }).length).toBe(0);
  });
});

describe('假差异归一化（金蝶 WebAPI 常见）', () => {
  it('char 与 char(1) 视为同一类型', () => {
    const b = mkDict('b', [table('T', [col('F', 'char')])]);
    const t = mkDict('t', [table('T', [col('F', 'char(1)')])]);
    expect(diffDictionaries(b, t).length).toBe(0);
  });

  it('注释里的“界面已隐藏”合成后缀不计入差异', () => {
    const b = mkDict('b', [table('T', [col('F', 'int', '允许ATP检查；界面已隐藏')])]);
    const t = mkDict('t', [table('T', [col('F', 'int', '允许ATP检查')])]);
    expect(diffDictionaries(b, t).length).toBe(0);
  });

  it('默认值 True/False ↔ 1/0、带引号与不带引号视为相等', () => {
    const b = mkDict('b', [table('T', [{ name: 'F', type: 'int', defaultValue: 'True' }])]);
    const t = mkDict('t', [table('T', [{ name: 'F', type: 'int', defaultValue: '1' }])]);
    expect(diffDictionaries(b, t).length).toBe(0);
    const b2 = mkDict('b2', [table('T', [{ name: 'F', type: 'char(1)', defaultValue: "'0'" }])]);
    const t2 = mkDict('t2', [table('T', [{ name: 'F', type: 'char(1)', defaultValue: '0' }])]);
    expect(diffDictionaries(b2, t2).length).toBe(0);
  });

  it('ignoreNullable 时不比可空', () => {
    const b = mkDict('b', [table('T', [{ name: 'F', type: 'int', nullable: true }])]);
    const t = mkDict('t', [table('T', [{ name: 'F', type: 'int', nullable: false }])]);
    expect(diffDictionaries(b, t).length).toBe(1);
    expect(diffDictionaries(b, t, { ignoreNullable: true }).length).toBe(0);
  });

  it('类型归一：int/bigint 受开关控制，char/varchar 同长直接等价', () => {
    const b = mkDict('b', [table('T', [{ name: 'F', type: 'bigint' }, { name: 'S', type: 'char(1)' }])]);
    const t = mkDict('t', [table('T', [{ name: 'F', type: 'int' }, { name: 'S', type: 'varchar(1)' }])]);

    const strict = diffDictionaries(b, t).filter((i) => i.changes.some((c) => c.prop === '类型'));
    expect(strict.map((i) => i.object)).toEqual(['F']);

    const loose = diffDictionaries(b, t, { ignoreIntegerWidth: true }).filter((i) => i.changes.some((c) => c.prop === '类型'));
    expect(loose.length).toBe(0);
  });

  it('metadataBaseline：字典多出的系统字段不反向报缺，也不生成 ADD COLUMN', () => {
    const b = mkDict('b', [table('T', [col('A', 'int')])]);
    b.dialect = 'mssql';
    const t = mkDict('t', [table('T', [col('A', 'int'), col('FMASTERID', 'int')])]);

    expect(diffDictionaries(b, t).some((i) => i.object === 'FMASTERID' && i.kind === 'added')).toBe(true);
    expect(diffDictionaries(b, t, { metadataBaseline: true }).some((i) => i.object === 'FMASTERID')).toBe(false);
    expect(generateFixSql(b, t, false, { metadataBaseline: true }).join('\n')).not.toContain('FMASTERID');

    // 回写字典时也不能把元数据未列出的系统字段标 deleted
    const merged = mergeBaseIntoTarget(b, t, { metadataBaseline: true });
    expect(merged.tables[0].columns.find((c) => c.name === 'FMASTERID')?.changeTag).toBeUndefined();
  });

  it('SQL Server 的 ALTER COLUMN 不带 DEFAULT（需单独建约束）', () => {
    const b = mkDict('b', [table('T', [{ name: 'A', type: 'int' }])]);
    b.dialect = 'mssql';
    const t = mkDict('t', [table('T', [{ name: 'A', type: 'bigint', defaultValue: '0' }])]);
    t.dialect = 'mssql';

    const sql = generateFixSql(b, t).join('\n');
    expect(sql).toContain('ALTER COLUMN [A] bigint');
    expect(sql).not.toContain('DEFAULT');
  });
});

describe('WebAPI 基线：跳过索引/外键 + 用基线方言出 SQL', () => {
  it('skipRelations 时不产出索引/外键差异，也不生成对应 SQL', () => {
    const b = mkDict('b', [table('T', [col('A', 'int')])]);
    b.dialect = 'mssql';
    const t = mkDict('t', [table('T', [col('A', 'int')])]);
    t.tables[0].indexes = [{ name: 'IX_A', unique: false, columns: ['A'] }];
    t.tables[0].foreignKeys = [{ name: 'FK_A', columns: ['A'], refTable: 'X', refColumns: ['ID'] }];

    expect(diffDictionaries(b, t).filter((i) => i.level === 'index' || i.level === 'fk').length).toBe(2);
    const items = diffDictionaries(b, t, { skipRelations: true });
    expect(items.filter((i) => i.level === 'index' || i.level === 'fk').length).toBe(0);

    const sql = generateFixSql(b, t, false, { skipRelations: true }).join('\n');
    expect(sql).not.toContain('CREATE INDEX');
    expect(sql).not.toContain('FOREIGN KEY');
  });

  it('修复 SQL 用基线方言：SQL Server 基线 → 方括号，不用反引号/MODIFY COLUMN', () => {
    const b = mkDict('b', [table('T', [col('A', 'int')])]);
    b.dialect = 'mssql';
    const t = mkDict('t', [table('T', [col('A', 'int'), col('B', 'varchar(10)')])]);
    t.dialect = 'mysql';

    const sql = generateFixSql(b, t).join('\n');
    expect(sql).toContain('ALTER TABLE [T] ADD');
    expect(sql).not.toContain('`');
    expect(sql).not.toContain('MODIFY COLUMN');
  });
});

describe('HTML 基线降噪', () => {
  it('字典中文名在 code、注释为空时，不再报“注释 → 空”假差异', () => {
    const b = mkDict('html', [table('T', [{ name: 'F', type: 'int', code: '开户国家' } as any])]);
    const t = mkDict('dict', [table('T', [{ name: 'F', type: 'int', code: '开户国家' } as any])]);
    const items = diffDictionaries(b, t);
    expect(items.some((i) => i.changes.some((c) => c.prop === '注释'))).toBe(false);
  });

  it('skipForeignKeys：不比对/不生成外键 SQL（HTML 无引用表信息）', () => {
    const b = mkDict('html', [table('T', [col('F', 'int')])]);
    const t = mkDict('dict', [{
      name: 'T', columns: [col('F', 'int')], indexes: [],
      foreignKeys: [{ name: 'FK_T_X', columns: ['F'], refTable: 'X', refColumns: ['F'] }],
    }]);
    expect(diffDictionaries(b, t).some((i) => i.level === 'fk')).toBe(true);
    expect(diffDictionaries(b, t, { skipForeignKeys: true }).some((i) => i.level === 'fk')).toBe(false);
    expect(generateFixSql(b, t, false, { skipForeignKeys: true }).join('\n')).not.toContain('FOREIGN KEY');
  });
});
