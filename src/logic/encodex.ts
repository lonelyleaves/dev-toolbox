/** 编码转换工具集：Base64 / URL / Hex / Unicode / HTML 实体 / JWT 解码 */

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

// ─── 统一入口 ──────────────────────────────────────────
export type EncodeMode = 'base64' | 'url' | 'hex' | 'unicode' | 'html' | 'jwt';

export const ENCODE_MODES: { id: EncodeMode; label: string; desc: string }[] = [
  { id: 'base64', label: 'Base64', desc: 'Base64 编解码' },
  { id: 'url', label: 'URL 编码', desc: 'URL encode/decode' },
  { id: 'hex', label: 'Hex', desc: '十六进制编解码' },
  { id: 'unicode', label: 'Unicode', desc: 'Unicode 转义/反转义' },
  { id: 'html', label: 'HTML 实体', desc: 'HTML entity 编解码' },
  { id: 'jwt', label: 'JWT 解码', desc: '解析 JWT Token（仅解码 payload）' },
];

export function encode(input: string, mode: EncodeMode): string {
  switch (mode) {
    case 'base64': return toBase64(input);
    case 'url': return toUrlEncode(input);
    case 'hex': return toHex(input);
    case 'unicode': return toUnicodeEscape(input);
    case 'html': return toHtmlEntities(input);
    case 'jwt': return JSON.stringify(decodeJwt(input), null, 2);
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
  }
}
