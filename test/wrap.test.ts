import { describe, it, expect } from 'vitest';
import { buildGutterText, countWrappedRows, isWideChar } from '../src/logic/wrap';

describe('软换行行号计算', () => {
  it('宽度足够时每个逻辑行占 1 个视觉行', () => {
    expect(countWrappedRows('abc\ndefg', 100, 10, 20)).toEqual([1, 1]);
  });

  it('超宽逻辑行按字符折行', () => {
    // 10 个字符，每字符 10px，可用宽度 50px → 每行 5 个字符 → 2 行
    expect(countWrappedRows('abcdefghij', 50, 10, 20)).toEqual([2]);
  });

  it('恰好填满不折行，多一个字符才折行', () => {
    expect(countWrappedRows('abcde', 50, 10, 20)).toEqual([1]);
    expect(countWrappedRows('abcdef', 50, 10, 20)).toEqual([2]);
  });

  it('CJK / emoji 按双宽计算', () => {
    expect(isWideChar('中')).toBe(true);
    expect(isWideChar('ａ')).toBe(true);
    expect(isWideChar('a')).toBe(false);
    // 4 个汉字 = 4 * 20 = 80px，可用 40px → 2 行
    expect(countWrappedRows('中文中文', 40, 10, 20)).toEqual([2]);
  });

  it('Tab 按 4 个字符宽度计算', () => {
    expect(countWrappedRows('\tabc', 50, 10, 20)).toEqual([2]);
    expect(countWrappedRows('\tabc', 80, 10, 20)).toEqual([1]);
  });

  it('空内容 / 空行', () => {
    expect(countWrappedRows('', 100, 10, 20)).toEqual([1]);
    expect(countWrappedRows('a\n\nb', 100, 10, 20)).toEqual([1, 1, 1]);
  });

  it('不可见（宽度为 0）时退化为每个逻辑行 1 行', () => {
    expect(countWrappedRows('abcdefghij', 0, 10, 20)).toEqual([1]);
  });

  it('行号文本：续行留空，编号只出现在逻辑行首行', () => {
    expect(buildGutterText([1, 2, 1])).toBe('1\n2\n\n3');
    expect(buildGutterText([1, 1])).toBe('1\n2');
    expect(buildGutterText([3])).toBe('1\n\n');
  });
});
