/** 时间戳核心逻辑（纯函数，供 webview 与测试共用） */

import { normalizeInput, toSingleLine } from './text';

export type TsUnit = 's' | 'ms' | 'us' | 'ns';

export interface TsDetect {
  value: bigint | number;
  unit: TsUnit;
  millis: number;
}

/** 按位数自动识别单位：10 位秒 / 13 位毫秒 / 16 位微秒 / 19 位纳秒 */
export function detectTimestamp(input: string): TsDetect | null {
  // 复制时间戳时常带 BOM / 换行 / 零宽字符，先归一化再判断位数
  const t = normalizeInput(input).trim();
  if (!/^\d{9,20}$/.test(t)) return null;
  const len = t.length;
  let unit: TsUnit;
  if (len <= 12) unit = 's';
  else if (len <= 15) unit = 'ms';
  else if (len <= 18) unit = 'us';
  else unit = 'ns';
  const n = Number(t);
  const factor = { s: 1000, ms: 1, us: 0.001, ns: 0.000001 }[unit];
  return { value: len > 15 ? BigInt(t) : n, unit, millis: Math.round(n * factor) };
}

export function nowByUnit(unit: TsUnit): string {
  const ms = Date.now();
  switch (unit) {
    case 's': return String(Math.floor(ms / 1000));
    case 'ms': return String(ms);
    case 'us': return String(BigInt(ms) * 1000n);
    case 'ns': return String(BigInt(ms) * 1000000n);
  }
}

/** 毫秒时间戳 → 指定时区的 yyyy-MM-dd HH:mm:ss.SSS */
export function formatMillis(millis: number, timeZone: string, withMs = false, pattern: 'iso' | 'space' = 'space'): string {
  if (Number.isNaN(millis)) return '无效时间';
  const d = new Date(millis);
  if (!Number.isFinite(d.getTime())) return '超出可表示范围';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}:${get('second')}`;
  const ms = withMs ? `.${String(d.getMilliseconds()).padStart(3, '0')}` : '';
  const sep = pattern === 'iso' ? 'T' : ' ';
  return `${date}${sep}${time}${ms}`;
}

/** 常用格式预览 */
export function formatVariants(millis: number, timeZone: string): { label: string; value: string }[] {
  const space = formatMillis(millis, timeZone);
  const iso = formatMillis(millis, timeZone, false, 'iso');
  const tzName = timeZone;
  return [
    { label: `本地格式 (${tzName})`, value: space },
    { label: 'ISO8601', value: `${iso}${tzOffsetLabel(millis, timeZone)}` },
    { label: 'RFC3339', value: `${iso}${tzOffsetLabel(millis, timeZone)}` },
    { label: '日志格式', value: `${space.replace(/-/g, '/')} ${weekdayCn(millis, timeZone)}` },
    { label: 'Unix 秒', value: String(Math.floor(millis / 1000)) },
    { label: 'Unix 毫秒', value: String(millis) },
    { label: 'UTC', value: formatMillis(millis, 'UTC') + ' UTC' },
  ];
}

function weekdayCn(millis: number, timeZone: string): string {
  const w = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(new Date(millis));
  return w;
}

function tzOffsetLabel(millis: number, timeZone: string): string {
  if (timeZone === 'UTC') return 'Z';
  const utcStr = formatMillis(millis, 'UTC');
  const localStr = formatMillis(millis, timeZone);
  const diffMin = Math.round((Date.parse(localStr.replace(' ', 'T') + 'Z') - Date.parse(utcStr.replace(' ', 'T') + 'Z')) / 60000);
  const sign = diffMin >= 0 ? '+' : '-';
  const abs = Math.abs(diffMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** 相对时间："3 天前" */
export function relativeTime(millis: number, now = Date.now()): string {
  const diff = now - millis;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  const table: [number, string][] = [
    [1000, '毫秒'], [60000, '秒'], [3600000, '分钟'], [86400000, '小时'],
    [2592000000, '天'], [31536000000, '个月'],
  ];
  if (abs < 1000) return '刚刚';
  if (abs < 60000) return `${Math.floor(abs / 1000)} 秒${suffix}`;
  if (abs < 3600000) return `${Math.floor(abs / 60000)} 分钟${suffix}`;
  if (abs < 86400000) return `${Math.floor(abs / 3600000)} 小时${suffix}`;
  if (abs < 2592000000) return `${Math.floor(abs / 86400000)} 天${suffix}`;
  if (abs < 31536000000) return `${Math.floor(abs / 2592000000)} 个月${suffix}`;
  void table;
  return `${Math.floor(abs / 31536000000)} 年${suffix}`;
}

/** 日期字符串 → 毫秒（按指定时区解释 yyyy-MM-dd[ HH:mm[:ss]]） */
export function parseDateInTz(dateStr: string, timeZone: string): number | null {
  const source = toSingleLine(dateStr);
  if (!source) return null;
  const m = source.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) {
    const t = Date.parse(source);
    return Number.isNaN(t) ? null : t;
  }
  // 构造 UTC 时间，再通过时区偏移修正：找出让 timeZone 本地时间等于输入的 UTC 毫秒
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const asLocal = formatMillis(guess, timeZone);
  const want = `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')} ${h.padStart(2,'0')}:${mi.padStart(2,'0')}:${s.padStart(2,'0')}`;
  const drift = Date.parse(want.replace(' ', 'T') + 'Z') - Date.parse(asLocal.replace(/\s/, 'T') + 'Z');
  return guess + drift;
}

/** 批量：把文本中所有 9-19 位数字时间戳转成日期 */
export function batchConvert(text: string, timeZone: string): { original: string; converted: string }[] {
  const results: { original: string; converted: string }[] = [];
  const re = /\b\d{9,19}\b/g;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = re.exec(text))) {
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    const det = detectTimestamp(match[0]);
    if (det) results.push({ original: match[0], converted: `${formatMillis(det.millis, timeZone)} (${det.unit})` });
  }
  return results;
}

export const COMMON_TIMEZONES = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'America/Chicago',
  'Australia/Sydney', 'Asia/Dubai', 'UTC',
];
