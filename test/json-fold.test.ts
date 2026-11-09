import { describe, expect, it } from 'vitest';
import { allFoldStarts, buildJsonFoldModel, visibleFoldRows } from '../src/logic/json-fold';

describe('JSON 折叠范围', () => {
  it('识别对象和数组的跨行范围', () => {
    const text = JSON.stringify({ a: [1, { b: 2 }] }, null, 2);
    const model = buildJsonFoldModel(text);
    expect(model.rangesByStart.get(0)?.end).toBe(model.lines.length - 1);
    expect(model.rangesByStart.get(1)?.end).toBe(6);
    expect(model.rangesByStart.get(3)?.end).toBe(5);
  });

  it('字符串里的括号不参与折叠判断', () => {
    const text = JSON.stringify({ a: '{[}' }, null, 2);
    const model = buildJsonFoldModel(text);
    expect(allFoldStarts(model)).toEqual([0]);
  });

  it('折叠后只保留起始行和结束行', () => {
    const text = JSON.stringify({ a: { b: 1 } }, null, 2);
    const model = buildJsonFoldModel(text);
    const rows = visibleFoldRows(model, new Set([1]));
    expect(rows.map((r) => r.line)).toEqual([0, 1, 4]);
    expect(rows.find((r) => r.line === 1)?.hidden).toBe(2);
  });

  it('同一行连续开括号时保留外层范围', () => {
    const model = buildJsonFoldModel('[{\n  "a": 1\n}]');
    expect(model.rangesByStart.get(0)?.end).toBe(2);
  });
});
