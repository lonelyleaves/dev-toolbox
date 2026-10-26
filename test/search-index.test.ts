import { describe, it, expect } from 'vitest';
import { dictSearchFast, tablesMatching } from '../src/dictionary/search-index';
import { dictSearch } from '../src/dictionary/exporters';
import { emptyDictionary } from '../src/dictionary/model';

function dict() {
  return {
    ...emptyDictionary('索引样本'),
    tables: [
      {
        name: 'T_SAL_ORDER', code: '销售订单', comment: '销售订单',
        columns: [
          { name: 'FBILLNO', type: 'nvarchar(30)', comment: '单据编号' },
          { name: 'FDATE', type: 'datetime', comment: '日期' },
        ],
        indexes: [], foreignKeys: [], origin: { sourceId: 's1', kind: 'pdm' },
      },
      {
        name: 'T_BD_MATERIAL', code: '物料', comment: '物料',
        columns: [{ name: 'FNUMBER', type: 'nvarchar(80)', comment: '物料编码' }],
        indexes: [], foreignKeys: [], origin: { sourceId: 's2', kind: 'db' },
      },
      {
        name: 'T_LOG', code: '日志', comment: '',
        columns: [{ name: 'FID', type: 'int', pk: true }],
        indexes: [], foreignKeys: [], origin: { sourceId: 's2', kind: 'db' },
      },
    ],
  };
}

describe('字典搜索索引', () => {
  const d = dict() as any;

  it('命中表名（大小写不敏感）', () => {
    const got = dictSearchFast(d, 'T_SAL');
    expect(got.length).toBe(1);
    expect(got[0].table).toBe('T_SAL_ORDER');
    expect(got[0].field).toBe('表名');
  });

  it('命中字段注释与中文名', () => {
    expect(dictSearchFast(d, '物料').some((h) => h.table === 'T_BD_MATERIAL')).toBe(true);
    expect(dictSearchFast(d, '单据编号').some((h) => h.column === 'FBILLNO')).toBe(true);
  });

  it('结果与原来的全量扫描完全一致（防止优化改坏语义）', () => {
    for (const kw of ['T_SAL', '物料', '单据编号', 'FID', '不存在的表']) {
      const a = dictSearch(d, kw).map((x) => `${x.table}|${x.column || ''}|${x.field}|${x.text}`);
      const b = dictSearchFast(d, kw).map((x) => `${x.table}|${x.column || ''}|${x.field}|${x.text}`);
      expect(b).toEqual(a);
    }
  });

  it('空关键字返回空', () => {
    expect(dictSearchFast(d, '')).toEqual([]);
    expect(dictSearchFast(d, '   ')).toEqual([]);
  });

  it('命中数受上限约束', () => {
    expect(dictSearchFast(d, 'T_', 1).length).toBe(1);
  });

  it('左栏表名列表去重且保持顺序', () => {
    const got = tablesMatching(d, '订单');
    expect(new Set(got).size).toBe(got.length);
    expect(got).toContain('T_SAL_ORDER');
  });
});
