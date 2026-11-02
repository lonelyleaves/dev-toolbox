import { describe, it, expect } from 'vitest';
import { activeFilterCount, distinctTypes, filterColumnIndexes, matchesColumnFilter } from '../src/dictionary/field-filter';
import { ColumnDef } from '../src/dictionary/model';

const cols: ColumnDef[] = [
  { name: 'FID', code: '内码', type: 'varchar(36)', nullable: false, pk: true, defaultValue: '0', comment: '' },
  { name: 'FNAME', code: '名称', type: 'nvarchar(50)', nullable: true, defaultValue: '', comment: '名称' },
  { name: 'FDATE', code: '日期', type: 'datetime', nullable: true, comment: '' },
];

describe('字段表头筛选', () => {
  it('关键字同时匹配物理名、显示名和注释', () => {
    expect(matchesColumnFilter(cols[0], 'fid', {})).toBe(true);
    expect(matchesColumnFilter(cols[1], '名称', {})).toBe(true);
    expect(matchesColumnFilter(cols[2], '不存在', {})).toBe(false);
  });

  it('类型、必填、键、默认值、注释按 AND 组合', () => {
    expect(filterColumnIndexes(cols, '', { type: 'varchar(36)', required: 'yes', key: 'pk', hasDefault: 'yes', hasComment: 'no' }))
      .toEqual([0]);
    expect(filterColumnIndexes(cols, '', { type: 'datetime', required: 'yes' })).toEqual([]);
  });

  it('可选、非主键、无默认值、有注释也能单独筛选', () => {
    expect(filterColumnIndexes(cols, '', { required: 'no', key: 'non', hasDefault: 'no', hasComment: 'yes' }))
      .toEqual([1]);
  });

  it('类型选项去重且排序', () => {
    expect(distinctTypes(cols)).toEqual(['datetime', 'nvarchar(50)', 'varchar(36)']);
  });

  it('活动筛选数不含关键字', () => {
    expect(activeFilterCount({ type: 'int', required: 'yes' })).toBe(2);
    expect(activeFilterCount({})).toBe(0);
  });
});
