/**
 * 编码转换工具集：Base64 / URL / Hex / Unicode / HTML 实体 / JWT 解码
 * + 纯文本变换（全半角 / 码点 / 摩斯电码）
 * 哈希/AES/DES/字符编码/随机数 在宿主进程算（cryptoOps），本文件只标注哪些模式走宿主
 */

import { normalizeInput } from './text';

// ─── Base64 ────────────────────────────────────────────
export function toBase64(input: string): string {
  try {
    return btoa(unescape(encodeURIComponent(input)));
  } catch {
    // 回退：逐字节编码
    const bytes = new TextEncoder().encode(input);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
}

/** Base64 / Base64URL → 字节 Hex（容忍换行、"-----BEGIN..." 包裹行、URL-safe 变体） */
export function base64ToHex(input: string): string {
  let cleaned = input
    .replace(/-----(BEGIN|END)[A-Z ]+-----/g, '')
    .replace(/[^A-Za-z0-9+/=_-]/g, '')
    .replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned.length % 4 === 1) throw new Error('无效的 Base64 长度');
  cleaned = cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, '=');
  const bin = atob(cleaned);
  return Array.from(Uint8Array.from(bin, (c) => c.charCodeAt(0)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromBase64(input: string): string {
  try {
    const cleaned = input.replace(/\s/g, '');
    const bin = atob(cleaned);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new Error('无效的 Base64 编码');
  }
}

// ─── URL 编码 ──────────────────────────────────────────
export function toUrlEncode(input: string): string {
  return encodeURIComponent(input);
}

export function fromUrlEncode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    throw new Error('无效的 URL 编码');
  }
}

// ─── Hex 十六进制 ──────────────────────────────────────
export function toHex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function fromHex(input: string): string {
  const cleaned = input.replace(/[\s,0x]/gi, '').replace(/^\\x/g, '');
  if (cleaned.length % 2 !== 0) throw new Error('Hex 字符串长度必须为偶数');
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error('包含非法十六进制字符');
  const bytes = new Uint8Array(cleaned.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}

// ─── Unicode 转义 ──────────────────────────────────────
export function toUnicodeEscape(input: string): string {
  return Array.from(input).map((ch) => {
    const code = ch.codePointAt(0)!;
    return code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }).join('');
}

export function fromUnicodeEscape(input: string): string {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

// ─── HTML 实体 ─────────────────────────────────────────
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const HTML_DECODE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(HTML_ENTITIES).map(([k, v]) => [v, k])
);

export function toHtmlEntities(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]);
}

export function fromHtmlEntities(input: string): string {
  return input.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (entity) => {
    if (HTML_DECODE_MAP[entity]) return HTML_DECODE_MAP[entity];
    // 数字实体 &#NNN; 或 &#xHHH;
    const numMatch = entity.match(/^&#(\d+);$/);
    if (numMatch) return String.fromCharCode(parseInt(numMatch[1]));
    const hexMatch = entity.match(/^&#x([0-9a-fA-F]+);$/);
    if (hexMatch) return String.fromCharCode(parseInt(hexMatch[1], 16));
    return entity;
  });
}

// ─── JWT 解码（仅解码 payload，不验证签名） ────────────
export interface JwtPayload {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  error?: string;
}

export function decodeJwt(token: string): JwtPayload {
  // 复制出来的 Token 常带 "Bearer " 前缀，且被终端折行；先去掉空白再分段
  const raw = normalizeInput(token).replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '');
  const parts = raw.split('.');
  if (parts.length !== 3) throw new Error('JWT 必须包含 3 段（以 . 分隔）');
  const decode = (seg: string) => {
    const pad = seg.length % 4 === 0 ? '' : '='.repeat(4 - (seg.length % 4));
    const bin = atob(seg.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  return {
    header: decode(parts[0]),
    payload: decode(parts[1]),
  };
}

// ─── 全角/半角 ─────────────────────────────────────────
/** 全角转半角：FF01-FF5E → 0021-007E，全角空格 3000 → 20 */
export function toHalfWidth(input: string): string {
  return Array.from(input).map((ch) => {
    const c = ch.charCodeAt(0);
    if (c === 0x3000) return ' ';
    if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0);
    return ch;
  }).join('');
}

/** 半角转全角：0021-007E → FF01-FF5E，空格 → 全角空格 3000 */
export function toFullWidth(input: string): string {
  return Array.from(input).map((ch) => {
    const c = ch.charCodeAt(0);
    if (c === 0x20) return '\u3000';
    if (c >= 0x21 && c <= 0x7e) return String.fromCharCode(c + 0xfee0);
    return ch;
  }).join('');
}

// ─── 码点（文本 ↔ 十六进制码点序列）────────────────────
export function textToCodePoints(input: string): string {
  return Array.from(input).map((ch) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
}

export function codePointsToText(input: string): string {
  const tokens = input.trim().split(/[\s,，;；]+/).filter(Boolean);
  let out = '';
  for (const t of tokens) {
    const m = t.match(/^U?\+?([0-9a-fA-F]{1,6})$/);
    if (!m) throw new Error(`非法码点: ${t}`);
    const cp = parseInt(m[1], 16);
    if (cp > 0x10ffff) throw new Error(`码点越界: ${t}`);
    out += String.fromCodePoint(cp);
  }
  return out;
}

// ─── 摩斯电码 ──────────────────────────────────────────
const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....',
  '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', "'": '.----.', '@': '.--.-.',
  '/': '-.-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-..-.',
  '+': '.-.-.', '"': '.-..-.', '$': '...-..-',
};
const MORSE_REV: Record<string, string> = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

export function toMorse(input: string): string {
  return Array.from(input.toUpperCase()).map((ch) => MORSE[ch] ?? '?').join(' ');
}

export function fromMorse(input: string): string {
  return input.trim().split(/\s+/).map((code) => {
    if (code === '/') return ' ';
    if (MORSE_REV[code] !== undefined) return MORSE_REV[code];
    return '';
  }).join('');
}

// ─── 统一入口 ──────────────────────────────────────────
export type EncodeMode =
  | 'base64' | 'url' | 'hex' | 'unicode' | 'html' | 'jwt'
  | 'fullhalf' | 'codepoint' | 'morse'
  | 'hash' | 'aes' | 'des' | 'random' | 'charset' | 'eas';

/** 在宿主进程（node:crypto/ICU）执行的运算模式，webview 端只透传 */
export const HOST_MODES = new Set<EncodeMode>(['hash', 'aes', 'des', 'random', 'charset', 'eas']);

/** 单向模式（没有"解码"方向）：界面隐藏方向选择 */
export const ONE_WAY_MODES = new Set<EncodeMode>(['hash', 'random', 'eas']);

export const ENCODE_MODES: { id: EncodeMode; label: string; desc: string }[] = [
  { id: 'base64', label: 'Base64', desc: 'Base64 编解码' },
  { id: 'url', label: 'URL 编码', desc: 'URL encode/decode' },
  { id: 'hex', label: 'Hex', desc: '十六进制编解码' },
  { id: 'unicode', label: 'Unicode', desc: 'Unicode 转义/反转义' },
  { id: 'html', label: 'HTML 实体', desc: 'HTML entity 编解码' },
  { id: 'jwt', label: 'JWT 解码', desc: '解析 JWT Token（仅解码 payload）' },
  { id: 'fullhalf', label: '全角/半角', desc: '全角 ↔ 半角转换' },
  { id: 'codepoint', label: '码点', desc: '文本 ↔ U+XXXX 码点序列' },
  { id: 'morse', label: '摩斯电码', desc: '文本 ↔ 摩斯电码' },
  { id: 'hash', label: 'Hash 计算', desc: 'MD5 / SHA1 / SHA256 / SHA512 / HMAC' },
  { id: 'aes', label: 'AES 加密解密', desc: 'AES-128/192/256 · 5 模式 · 6 填充' },
  { id: 'des', label: 'DES / 3DES', desc: '老系统 DES · 3DES 加解密' },
  { id: 'random', label: '随机生成', desc: 'UUID / 随机密码 / 随机数 / 随机字节' },
  { id: 'charset', label: '字符编码转换', desc: 'GBK / GB18030 / Big5 ↔ UTF-8 字节' },
  { id: 'eas', label: 'EAS 报文解析', desc: 'Base64 → 字符编码 → XML 实体 一键还原' },
];

export function encode(input: string, mode: EncodeMode): string {
  switch (mode) {
    case 'base64': return toBase64(input);
    case 'url': return toUrlEncode(input);
    case 'hex': return toHex(input);
    case 'unicode': return toUnicodeEscape(input);
    case 'html': return toHtmlEntities(input);
    case 'jwt': return JSON.stringify(decodeJwt(input), null, 2);
    case 'fullhalf': return toFullWidth(input);
    case 'codepoint': return textToCodePoints(input);
    case 'morse': return toMorse(input);
    default:
      // 宿主运算模式不会走本地 encode；走到这里说明调用方未按 HOST_MODES 分流
      throw new Error(`模式 ${mode} 在宿主进程计算，不应调用本地 encode`);
  }
}

export function decode(input: string, mode: EncodeMode): string {
  switch (mode) {
    case 'base64': return fromBase64(input);
    case 'url': return fromUrlEncode(input);
    case 'hex': return fromHex(input);
    case 'unicode': return fromUnicodeEscape(input);
    case 'html': return fromHtmlEntities(input);
    case 'jwt': return JSON.stringify(decodeJwt(input), null, 2);
    case 'fullhalf': return toHalfWidth(input);
    case 'codepoint': return codePointsToText(input);
    case 'morse': return fromMorse(input);
    default:
      throw new Error(`模式 ${mode} 在宿主进程计算，不应调用本地 decode`);
  }
}
