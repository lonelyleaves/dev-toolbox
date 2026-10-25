import { describe, it, expect } from 'vitest';
import {
  toBase64, fromBase64, toUrlEncode, fromUrlEncode,
  toHex, fromHex, toUnicodeEscape, fromUnicodeEscape,
  toHtmlEntities, fromHtmlEntities, decodeJwt,
  encode, decode,
} from '../src/logic/encodex';
import {
  hexToRgb, rgbToHex, rgbToHsl, hslToRgb, parseColor, rgbToCssString,
  contrastRatio, wcagRating, generateUuid, generateBulkUuids,
} from '../src/logic/colorx';

describe('编码转换 - Base64', () => {
  it('英文编码解码一致', () => {
    const encoded = toBase64('Hello, World!');
    expect(encoded).toBe('SGVsbG8sIFdvcmxkIQ==');
    expect(fromBase64(encoded)).toBe('Hello, World!');
  });
  it('中文编码解码一致', () => {
    const text = '你好世界';
    const encoded = toBase64(text);
    expect(fromBase64(encoded)).toBe(text);
  });
  it('空字符串', () => {
    expect(toBase64('')).toBe('');
    expect(fromBase64('')).toBe('');
  });
  it('无效 Base64 报错', () => {
    expect(() => fromBase64('!!!invalid!!!')).toThrow();
  });
});

describe('编码转换 - URL', () => {
  it('特殊字符编码解码', () => {
    const text = 'hello world&foo=bar#tag';
    const encoded = toUrlEncode(text);
    expect(encoded).toContain('%20');
    expect(fromUrlEncode(encoded)).toBe(text);
  });
  it('中文 URL 编码', () => {
    const encoded = toUrlEncode('搜索');
    expect(encoded).not.toContain('搜');
    expect(fromUrlEncode(encoded)).toBe('搜索');
  });
});

describe('编码转换 - Hex', () => {
  it('编码解码一致', () => {
    const hex = toHex('ABC');
    expect(hex).toBe('41 42 43');
    expect(fromHex(hex)).toBe('ABC');
  });
  it('奇数长度 Hex 报错', () => {
    expect(() => fromHex('abc')).toThrow();
  });
});

describe('编码转换 - Unicode', () => {
  it('ASCII 不变', () => {
    expect(toUnicodeEscape('hello')).toBe('hello');
  });
  it('中文转义还原', () => {
    const escaped = toUnicodeEscape('你好');
    expect(escaped).toContain('\\u');
    expect(fromUnicodeEscape(escaped)).toBe('你好');
  });
});

describe('编码转换 - HTML 实体', () => {
  it('特殊字符转义', () => {
    expect(toHtmlEntities('<div class="x">&</div>')).toContain('&lt;');
    expect(toHtmlEntities('<div class="x">&</div>')).toContain('&amp;');
  });
  it('反转义还原', () => {
    const encoded = '&lt;div&gt;&amp;&quot;&#39;&lt;/div&gt;';
    expect(fromHtmlEntities(encoded)).toBe('<div>&"\'</div>');
  });
});

describe('编码转换 - JWT', () => {
  // eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG DGOiIsImlhdCI6MTUxNjIzOTAyMn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  it('段数不足报错', () => {
    expect(() => decodeJwt('a.b')).toThrow();
  });
  it('标准 JWT 解码 header', () => {
    const result = decodeJwt(jwt);
    expect(result.header).toHaveProperty('alg');
  });
});

describe('编码转换 - 统一入口', () => {
  it('encode/decode base64 往返', () => {
    const text = 'test123';
    expect(decode(encode(text, 'base64'), 'base64')).toBe(text);
  });
  it('encode/decode url 往返', () => {
    const text = 'a b+c';
    expect(decode(encode(text, 'url'), 'url')).toBe(text);
  });
});

describe('颜色工具 - HEX/RGB/HSL 互转', () => {
  it('HEX 3 位展开', () => {
    const rgb = hexToRgb('#f00');
    expect(rgb).toEqual({ r: 255, g: 0, b: 0 });
  });
  it('HEX 6 位解析', () => {
    const rgb = hexToRgb('#4f8cc9');
    expect(rgb.r).toBe(79);
    expect(rgb.g).toBe(140);
    expect(rgb.b).toBe(201);
  });
  it('RGB → HEX 往返', () => {
    const rgb = { r: 100, g: 200, b: 50 };
    expect(hexToRgb(rgbToHex(rgb))).toEqual(rgb);
  });
  it('RGB → HSL → RGB 往返', () => {
    const rgb = { r: 100, g: 150, b: 200 };
    const hsl = rgbToHsl(rgb);
    const back = hslToRgb(hsl);
    expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
  });
  it('parseColor 识别 rgb() 格式', () => {
    const rgb = parseColor('rgb(255, 128, 0)');
    expect(rgb).toEqual({ r: 255, g: 128, b: 0 });
  });
  it('parseColor 识别 rgba() 格式', () => {
    const rgb = parseColor('rgba(255, 128, 0, 0.5)');
    expect(rgb.a).toBe(0.5);
  });
  it('rgbToCssString 无 alpha', () => {
    expect(rgbToCssString({ r: 1, g: 2, b: 3 })).toBe('rgb(1, 2, 3)');
  });
  it('rgbToCssString 含 alpha', () => {
    expect(rgbToCssString({ r: 1, g: 2, b: 3, a: 0.5 })).toBe('rgba(1, 2, 3, 0.50)');
  });
});

describe('颜色工具 - WCAG 对比度', () => {
  it('黑白对比度 21:1', () => {
    const ratio = contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 });
    expect(ratio).toBeCloseTo(21, 0);
  });
  it('wcagRating 高对比度全通过', () => {
    const r = wcagRating(21);
    expect(r.aa).toBe(true);
    expect(r.aaa).toBe(true);
  });
  it('wcagRating 低对比度全不通过', () => {
    const r = wcagRating(1);
    expect(r.aa).toBe(false);
    expect(r.aaa).toBe(false);
  });
});

describe('UUID 生成', () => {
  it('格式正确', () => {
    const uuid = generateUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('批量生成数量正确', () => {
    const uuids = generateBulkUuids(10);
    expect(uuids.length).toBe(10);
    expect(new Set(uuids).size).toBe(10); // 全部唯一
  });
  it('批量生成上限 1000', () => {
    expect(generateBulkUuids(2000).length).toBe(1000);
  });
});
