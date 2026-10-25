/** 颜色转换 / 哈希生成 / UUID 工具集 */

// ─── 颜色转换 ──────────────────────────────────────────
export interface RgbColor { r: number; g: number; b: number; a?: number }
export interface HslColor { h: number; s: number; l: number; a?: number }

/** HEX → RGB */
export function hexToRgb(hex: string): RgbColor {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) throw new Error('无效的 HEX 颜色值');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : undefined;
  if ([r, g, b].some((v) => Number.isNaN(v))) throw new Error('无效的 HEX 颜色值');
  return { r, g, b, a };
}

/** RGB → HEX */
export function rgbToHex({ r, g, b, a }: RgbColor): string {
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const base = `#${hex(r)}${hex(g)}${hex(b)}`;
  return a !== undefined && a < 1 ? `${base}${hex(Math.round(a * 255))}` : base;
}

/** RGB → HSL */
export function rgbToHsl({ r, g, b, a }: RgbColor): HslColor {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100), a };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100), a };
}

/** HSL → RGB */
export function hslToRgb({ h, s, l, a }: HslColor): RgbColor {
  const sn = s / 100, ln = l / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return { r: v, g: v, b: v, a };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hn = h / 360;
  return {
    r: Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hn) * 255),
    b: Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
    a,
  };
}

/** 解析 CSS 颜色字符串 → RGB */
export function parseColor(input: string): RgbColor {
  const trimmed = input.trim();
  // HEX
  if (/^#?[0-9a-fA-F]{3,8}$/.test(trimmed)) return hexToRgb(trimmed.startsWith('#') ? trimmed : `#${trimmed}`);
  // rgb(r, g, b) / rgba(r, g, b, a)
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (rgbMatch) return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3], a: rgbMatch[4] ? +rgbMatch[4] : undefined };
  // hsl(h, s%, l%) / hsla(h, s%, l%, a)
  const hslMatch = trimmed.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (hslMatch) return hslToRgb({ h: +hslMatch[1], s: +hslMatch[2], l: +hslMatch[3], a: hslMatch[4] ? +hslMatch[4] : undefined });
  throw new Error(`无法识别的颜色格式: ${trimmed}`);
}

/** RGB → CSS 字符串 */
export function rgbToCssString(c: RgbColor): string {
  return c.a !== undefined && c.a < 1
    ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a.toFixed(2)})`
    : `rgb(${c.r}, ${c.g}, ${c.b})`;
}

// ─── 颜色对比度（WCAG） ────────────────────────────────
function luminance({ r, g, b }: RgbColor): number {
  const [rs, gs, bs] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const la = luminance(a), lb = luminance(b);
  const lighter = Math.max(la, lb), darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function wcagRating(ratio: number): { aa: boolean; aaLarge: boolean; aaa: boolean; aaaLarge: boolean } {
  return { aa: ratio >= 4.5, aaLarge: ratio >= 3, aaa: ratio >= 7, aaaLarge: ratio >= 4.5 };
}

// ─── 哈希生成（Web Crypto API） ────────────────────────
export type HashAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export const HASH_ALGORITHMS: { id: HashAlgorithm; label: string; bits: number }[] = [
  { id: 'SHA-1', label: 'SHA-1', bits: 160 },
  { id: 'SHA-256', label: 'SHA-256', bits: 256 },
  { id: 'SHA-384', label: 'SHA-384', bits: 384 },
  { id: 'SHA-512', label: 'SHA-512', bits: 512 },
];

async function hashBuffer(algo: HashAlgorithm, data: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);
  return crypto.subtle.digest(algo, bytes);
}

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type HashOutputFormat = 'hex' | 'base64';

export async function computeHash(input: string, algo: HashAlgorithm, format: HashOutputFormat = 'hex'): Promise<string> {
  const buf = await hashBuffer(algo, input);
  return format === 'hex' ? bufToHex(buf) : bufToBase64(buf);
}

// ─── UUID 生成 ──────────────────────────────────────────
export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: RFC 4122 v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function generateBulkUuids(count: number): string[] {
  return Array.from({ length: Math.min(count, 1000) }, () => generateUuid());
}
