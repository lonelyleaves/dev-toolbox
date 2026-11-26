import { describe, expect, it } from 'vitest';
import { briefValue, diffJson, jsonDiffMarkdown, pickArrayKey } from '../src/logic/json-diff';

describe('JSON 语义差异', () => {
  it('给出路径与左右值', () => {
    const r = diffJson({ total: 1, data: { phone: '' } }, { total: 2, data: { phone: '138' } });
    const paths = r.entries.map((e) => e.path);
    expect(paths).toEqual(['$.total', '$.data.phone']);
    expect(r.entries[0]).toMatchObject({ kind: 'changed', leftText: '1', rightText: '2' });
    expect(r.stats.changed).toBe(2);
  });

  it('新增与删除的键分别标注', () => {
    const r = diffJson({ a: 1, b: 2 }, { a: 1, c: 3 });
    expect(r.entries.find((e) => e.path === '$.b')?.kind).toBe('removed');
    expect(r.entries.find((e) => e.path === '$.c')?.kind).toBe('added');
  });

  it('数组按稳定标识对齐：顺序不同不产生假差异', () => {
    const left = { list: [{ order_id: 'A', qty: 1 }, { order_id: 'B', qty: 2 }] };
    const right = { list: [{ order_id: 'B', qty: 2 }, { order_id: 'A', qty: 5 }] };
    const r = diffJson(left, right);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].path).toBe('$.list[order_id=A].qty');
    expect(r.arrayKeys).toEqual([{ path: '$.list', key: 'order_id' }]);
  });

  it('无共同标识字段时退回按下标对齐', () => {
    const r = diffJson({ list: [1, 2, 3] }, { list: [1, 9, 3] });
    expect(r.entries[0].path).toBe('$.list[1]');
    expect(r.arrayKeys).toEqual([]);
  });

  it('数组长度变化报新增/删除整项', () => {
    const r = diffJson({ list: [{ id: 'x' }] }, { list: [{ id: 'x' }, { id: 'y' }] });
    expect(r.entries).toEqual([expect.objectContaining({ path: '$.list[id=y]', kind: 'added' })]);
  });

  it('ignoreKeys 按字段名忽略任意层级', () => {
    const a = { response_time: '1', data: { list: [{ id: 'x', response_time: '2', qty: 1 }] } };
    const b = { response_time: '9', data: { list: [{ id: 'x', response_time: '8', qty: 1 }] } };
    expect(diffJson(a, b).entries).toHaveLength(2);
    expect(diffJson(a, b, { ignoreKeys: ['response_time'] }).entries).toHaveLength(0);
  });

  it('ignorePaths 支持 * 通配', () => {
    const r = diffJson({ a: { x: { t: 1 } } }, { a: { x: { t: 2 } } }, { ignorePaths: ['$.a.*.t'] });
    expect(r.entries).toHaveLength(0);
  });

  it('值类型变化单独标记', () => {
    const r = diffJson({ n: 1 }, { n: '1' });
    expect(r.entries[0]).toMatchObject({ kind: 'changed', typeChanged: true });
  });

  it('对象/数组摘要只给规模，不刷屏', () => {
    expect(briefValue({ a: 1, b: 2 })).toBe('{…2 个字段}');
    expect(briefValue([1, 2, 3])).toBe('[…3 项]');
  });

  it('超出 maxEntries 时置 truncated 但统计全量', () => {
    const left = { a: 1, b: 2, c: 3 };
    const right = { a: 9, b: 9, c: 9 };
    const r = diffJson(left, right, { maxEntries: 2 });
    expect(r.entries).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.totalDiffs).toBe(3);
  });

  it('路径对特殊 key 加引号', () => {
    const r = diffJson({ 'a b': 1 }, { 'a b': 2 });
    expect(r.entries[0].path).toBe('$["a b"]');
  });

  it('arrayKey 可手动指定', () => {
    const left = { list: [{ sku: 'A', q: 1 }, { sku: 'B', q: 1 }] };
    const right = { list: [{ sku: 'B', q: 1 }, { sku: 'A', q: 7 }] };
    expect(pickArrayKey(left.list, right.list, 'sku')).toBe('sku');
    expect(diffJson(left, right, { arrayKey: 'sku' }).entries[0].path).toBe('$.list[sku=A].q');
  });

  it('Markdown 报告含统计、对齐说明和转义竖线', () => {
    const r = diffJson({ a: 'x|y' }, { a: 'z' });
    const md = jsonDiffMarkdown(r);
    expect(md).toContain('变更 1');
    expect(md).toContain('`$.a`');
    expect(md).toContain('x\\|y');
  });

  it('完全一致时报告写明语义一致', () => {
    const md = jsonDiffMarkdown(diffJson({ a: 1 }, { a: 1 }));
    expect(md).toContain('语义一致');
  });
});
