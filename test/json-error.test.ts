import { describe, expect, it } from 'vitest';
import { parseJsonLoose, repairJson } from '../src/logic/jsonx';
import { describeJsonError } from '../src/logic/json-error';

describe('Python 字典风格自动修复', () => {
  it('True / False / None 转成 JSON 字面量', () => {
    const r = parseJsonLoose("{'a': True, 'b': False, 'c': None}");
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(r.data).toEqual({ a: true, b: false, c: null });
  });

  it("还原 Python 的 \\' 转义", () => {
    const r = parseJsonLoose(String.raw`{'a': 'it\'s ok'}`);
    expect(r.ok).toBe(true);
    expect((r.data as any).a).toBe("it's ok");
  });

  it('数字 key 也要加引号', () => {
    const r = parseJsonLoose("{'a': 1, 2: 'b'}");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ a: 1, 2: 'b' });
  });

  it('b\'x\' / u\'y\' 前缀不再变成两段字符串', () => {
    const r = parseJsonLoose("{'a': b'x', 'c': u'y'}");
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ a: 'x', c: 'y' });
  });

  it('普通数字值不被当成 key 加引号', () => {
    expect(JSON.parse(repairJson("{'a': 1.5, 'b': 2e3}"))).toEqual({ a: 1.5, b: 2000 });
  });
});

describe('JSON 错误中文化定位', () => {
  it('括号未闭合 → 内容不完整', () => {
    const r = parseJsonLoose("{'a': ['x', 'y'");
    expect(r.ok).toBe(false);
    expect(r.errorInfo?.reason || r.errorInfo?.title || '').toContain('不完整');
    expect(r.errorInfo?.hint).toContain('截断');
  });

  it('数组里写键值对 → 指出冒号位置', () => {
    const r = parseJsonLoose("{'a': ['FBillNo', 'FID', 'FDocumentStatus': 'true']}");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.errorInfo?.title).toMatch(/第 \d+ 行第 \d+ 列/);
  });

  it('describeJsonError 能从报文里解析 position 并给出片段', () => {
    const src = '{"a":1 "b":2}';
    const err = new Error('Expected , or } in JSON at position 7 (line 1 column 8)');
    const info = describeJsonError(err, src);
    expect(info.position).toBe(7);
    expect(info.line).toBe(0);
    expect(info.column).toBe(7);
    expect(info.snippet).toContain('"a":1');
    expect(info.caret).toMatch(/\^$/);
  });

  it('错误提示不再是裸英文报文', () => {
    const r = parseJsonLoose('{a:}');
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/^Unexpected|^Expected [a-z]+ (property|token)/);
    expect(r.error).toContain('：');
  });
});
