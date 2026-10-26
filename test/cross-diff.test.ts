import { describe, it, expect } from 'vitest';
import { diffDictionaries } from '../src/dictionary/diffengine';
import { emptyDictionary } from '../src/dictionary/model';

function mk(name: string) {
  return {
    ...emptyDictionary(name),
    tables: [
      {
        name: 'T_ONLY_A', code: 'A', comment: '',
        columns: [{ name: 'FID', type: 'int', pk: true }, { name: 'F_ONLY_A', type: 'int' }],
        indexes: [], foreignKeys: [], origin: { sourceId: 's', kind: 'db' as const },
      },
      {
        name: 'T_BOTH', code: 'B', comment: '',
        columns: [{ name: 'FID', type: 'int', pk: true }, { name: 'FAGE', type: 'int', comment: '年龄' }],
        indexes: [], foreignKeys: [], origin: { sourceId: 's', kind: 'db' as const },
      },
    ],
  } as any;
}

function mkOther(name: string) {
  return {
    ...emptyDictionary(name),
    tables: [
      {
        name: 'T_ONLY_B', code: 'B', comment: '',
        columns: [{ name: 'FID', type: 'int', pk: true }],
        indexes: [], foreignKeys: [], origin: { sourceId: 's', kind: 'db' as const },
      },
      {
        name: 'T_BOTH', code: 'B', comment: '',
        columns: [{ name: 'FID', type: 'int', pk: true }, { name: 'FAGE', type: 'bigint', comment: '年龄' }],
        indexes: [], foreignKeys: [], origin: { sourceId: 's', kind: 'db' as const },
      },
    ],
  } as any;
}

describe('跨项目比对语义', () => {
  const cur = mk('当前');
  const other = mkOther('对方');
  const items = diffDictionaries(cur, other);

  const byKind = (k: string) => items.filter((x) => x.kind === k);
  const names = (k: string, level?: string) =>
    byKind(k).filter((x) => !level || x.level === level).map((x) => x.table);

  it('added = 对方有、当前无（不是反过来）', () => {
    expect(names('added', 'table')).toContain('T_ONLY_B');
    expect(names('added', 'table')).not.toContain('T_ONLY_A');
  });

  it('removed = 当前有、对方无', () => {
    expect(names('removed', 'table')).toContain('T_ONLY_A');
    expect(names('removed', 'table')).not.toContain('T_ONLY_B');
  });

  it('两边都有的表，字段类型不同 → modified', () => {
    const m = byKind('modified').filter((x) => x.table === 'T_BOTH' && x.object === 'FAGE');
    expect(m.length).toBe(1);
    expect(m[0].changes.some((c) => c.prop === '类型')).toBe(true);
  });

  it('列级差异同样遵循：对方新增的字段算 added，当前独有算 removed', () => {
    // 当前独有的字段 F_ONLY_A 在对方没有 → removed
    const rm = byKind('removed').filter((x) => x.level === 'column' && x.table === 'T_BOTH');
    expect(rm).toEqual([]); // T_BOTH 双方字段相同，只有类型不同
    const add = byKind('added').filter((x) => x.level === 'column' && x.table === 'T_ONLY_B');
    expect(add.length).toBe(0); // 整张表都是新增，不再逐字段重复报
  });

  it('计数与宿主 summary 的命名一致', () => {
    const onlyOther = items.filter((x) => x.kind === 'added').length;
    const onlyCurrent = items.filter((x) => x.kind === 'removed').length;
    const modified = items.filter((x) => x.kind === 'modified').length;
    expect(onlyOther).toBeGreaterThan(0);
    expect(onlyCurrent).toBeGreaterThan(0);
    expect(modified).toBe(1);
    expect(items.length).toBe(onlyOther + onlyCurrent + modified);
  });
});
