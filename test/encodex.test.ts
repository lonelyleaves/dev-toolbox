import { describe, it, expect } from 'vitest';
import {
  toFullWidth, toHalfWidth,
  textToCodePoints, codePointsToText,
  toMorse, fromMorse,
  ENCODE_MODES, HOST_MODES, ONE_WAY_MODES, EncodeMode, base64ToHex,
} from '../src/logic/encodex';

describe('全角/半角转换', () => {
  it('ASCII 半角 → 全角', () => {
    expect(toFullWidth('a')).toBe('ａ');
    expect(toFullWidth('1')).toBe('１');
    expect(toFullWidth('A')).toBe('Ａ');
    expect(toFullWidth(' ')).toBe('\u3000'); // 空格 → 全角空格
  });
  it('全角 → 半角（含全角空格）', () => {
    expect(toHalfWidth('ａ１Ａ')).toBe('a1A');
    expect(toHalfWidth('\u3000')).toBe(' ');
  });
  it('非 ASCII/非全角字符保持原样', () => {
    expect(toFullWidth('中')).toBe('中');
    expect(toHalfWidth('中')).toBe('中');
  });
  it('往返互逆：半角→全角→半角', () => {
    const s = 'Hello 123 !?';
    expect(toHalfWidth(toFullWidth(s))).toBe(s);
  });
});

describe('码点', () => {
  it('文本 → U+XXXX 序列', () => {
    expect(textToCodePoints('A')).toBe('U+0041');

    expect(textToCodePoints('中')).toBe('U+4E2D');
    // 代理对 emoji 应展开为完整码点
    expect(textToCodePoints('a')).toBe('U+0061');
  });
  it('码点序列 → 文本（含 0x 前缀与大码点）', () => {
    expect(codePointsToText('U+0041 U+4E2D')).toBe('A中');
    expect(codePointsToText('41, 4E2D')).toBe('A中'); // 无 U+ 前缀、逗号分隔
    expect(codePointsToText('U+1F600')).toBe('\u{1F600}'); // 大码点
  });
  it('往返互逆', () => {
    const s = '中文 aZ 9';
    expect(codePointsToText(textToCodePoints(s))).toBe(s);
  });
  it('非法码点报错', () => {
    expect(() => codePointsToText('U+110000')).toThrow(); // 越界（> 0x10FFFF）
    expect(() => codePointsToText('hello')).toThrow(); // 非码点
  });
});

describe('摩斯电码', () => {
  it('文本 → 摩斯（大小写不敏感，字母/数字/常用标点）', () => {
    expect(toMorse('SOS')).toBe('... --- ...');
    expect(toMorse('123')).toBe('.---- ..--- ...--');
    expect(toMorse('S.O.S')).toContain('.-.-.-');
  });
  it('未知字符 → ?', () => {
    expect(toMorse('é')).toBe('?');
  });
  it('摩斯 → 文本（/ 代表空格）', () => {
    expect(fromMorse('... --- ...')).toBe('SOS');
    expect(fromMorse('.... . / -.-. ---.. / ... --- ...')).toBe('HE /8 SOS'); // ....→H .→E -.-.→/ ---..→8
  });
  it('往返（字母数字）：文本→摩斯→文本', () => {
    const s = 'HELLO123';
    expect(fromMorse(toMorse(s))).toBe(s);
  });
});

describe('模式表完整性', () => {
  it('所有模式 id 在表中都有 label/desc', () => {
    for (const m of ENCODE_MODES) {
      expect(typeof m.label).toBe('string');
      expect(typeof m.desc).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
    }
  });
  it('宿主运算模式全部包含在模式表中', () => {
    const ids = new Set(ENCODE_MODES.map((m) => m.id));
    for (const h of HOST_MODES) expect(ids.has(h as EncodeMode)).toBe(true);
  });
  it('单向模式与宿主模式有交集', () => {
    for (const o of ONE_WAY_MODES) expect(HOST_MODES.has(o as EncodeMode)).toBe(true);
  });
  it('ENCODE_MODES 共 14 种模式', () => {
    expect(ENCODE_MODES.length).toBe(15);
  });
});

describe('base64ToHex（EAS 报文流水线第一步）', () => {
  it('标准 Base64 → 字节 hex（大小写与换行容忍）', () => {
    // "你好" 的 GBK 字节 d6d0 c4e3 → base64 = 1tDE4w==
    expect(base64ToHex('1tDE4w==')).toBe('d6d0c4e3');
    expect(base64ToHex('1tDE4\nw==')).toBe('d6d0c4e3');
  });
  it('URL-safe 变体与 BEGIN/END 包裹行容忍', () => {
    expect(base64ToHex('-----BEGIN CERTIFICATE-----\n1tDE4w==\n-----END CERTIFICATE-----')).toBe('d6d0c4e3');
    // -_ 替换 +/（fb ff = "+/8="）
    expect(base64ToHex('-_8=')).toBe('fbff');
    expect(base64ToHex('-_8=')).toBe(base64ToHex('+/8='));
  });
  it('长度非法（%4==1）报错', () => {
    expect(() => base64ToHex('abcde')).toThrow();
  });
});
