/**
 * JSON 语义化差异对比。
 *
 * 与文本行 diff 的区别：
 * - 按 JSON 路径给出差异（`$.order_list[order_id='SKC14'].phone`），而不是第几行
 * - 数组按稳定标识对齐，顺序不同不再产生整块 +/- 的假差异
 * - 变更项同时给出左值和右值
 */

export type JsonDiffKind = 'changed' | 'added' | 'removed';

export interface JsonDiffEntry {
  path: string;
  kind: JsonDiffKind;
  /** 左值/右值的可读摘要（对象数组只给规模，避免刷屏） */
  leftText: string;
  rightText: string;
  left?: unknown;
  right?: unknown;
  depth: number;
  /** 值类型变了（如 1 vs '1'、对象 vs null） */
  typeChanged?: boolean;
}

export interface JsonDiffOptions {
  /** 任意层级按字段名忽略（如 response_time,request_id） */
  ignoreKeys?: string[];
  /** 按路径前缀忽略，支持 * 通配（如 $.data.list.*.update_time） */
  ignorePaths?: string[];
  /** 手动指定数组元素匹配字段；留空则自动挑 */
  arrayKey?: string;
  /** 最多产出多少条差异，超出置 truncated */
  maxEntries?: number;
}

export interface JsonDiffResult {
  entries: JsonDiffEntry[];
  totalDiffs: number;
  truncated: boolean;
  stats: { changed: number; added: number; removed: number };
  /** 实际生效的数组匹配键，便于 UI 说明"这块是按 xxx 对齐的" */
  arrayKeys: { path: string; key: string }[];
}

/** 常见的稳定标识候选（大小写不敏感） */
const KEY_CANDIDATES = [
  'id', 'fid', 'entryid', 'fentryid', 'detailid',
  'order_id', 'orderid', 'fbillno', 'billno', 'bill_code',
  'fnumber', 'number', 'code', 'sku', 'sku_id', 'skuid', 'key', 'name',
];

const DEFAULT_MAX_ENTRIES = 2000;

function typeTag(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 摘要：对象/数组只给规模，标量给截断后的 JSON 文本 */
export function briefValue(v: unknown, limit = 90): string {
  if (v === undefined) return '';
  if (Array.isArray(v)) return `[…${v.length} 项]`;
  if (isPlainObject(v)) return `{…${Object.keys(v).length} 个字段}`;
  const text = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  const one = String(text).replace(/\s+/g, ' ');
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
}

function scalar(v: unknown): string | undefined {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** 不用 Object.hasOwn（lib 目标没有），也不能用 obj.hasOwnProperty（数据里可能有同名 key） */
function hasKey(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 数组元素的可读标签：优先用匹配键，否则用下标 */
function arrayLabel(item: unknown, key: string | undefined, index: number): string {
  const raw = isPlainObject(item) ? scalar(item[key ?? '']) : undefined;
  if (key && raw !== undefined && raw !== '') return `${key}=${raw}`;
  return String(index);
}

function childPath(base: string, key: string): string {
  if (/^\d+$/.test(key)) return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function pathMatches(pattern: string, path: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(path);
}

/**
 * 在一组数组元素里挑一个"每个元素都有、且值唯一"的标量字段做对齐键。
 * 找不到就返回 undefined（退回按下标对齐）。
 */
export function pickArrayKey(left: unknown[], right: unknown[], preferred?: string): string | undefined {
  const candidates = preferred ? [preferred, ...KEY_CANDIDATES.filter((k) => k !== preferred.toLowerCase())] : KEY_CANDIDATES;
  for (const want of candidates) {
    const ok = (arr: unknown[]) => {
      if (arr.length === 0) return false;
      const seen = new Set<string>();
      for (const item of arr) {
        if (!isPlainObject(item)) return false;
        const keys = Object.keys(item);
        const hit = preferred ? item[want] : item[keys.find((k) => k.toLowerCase() === want) ?? ''];
        const s = scalar(hit);
        if (s === undefined || s === '') return false;
        if (seen.has(s)) return false;
        seen.add(s);
      }
      return true;
    };
    // 只有两边都能用同一个字段唯一标识时才对齐，否则按下标更安全
    const hitKey = (arr: unknown[]) => {
      if (arr.length === 0) return undefined;
      const first = arr[0];
      if (!isPlainObject(first)) return undefined;
      if (preferred) return hasKey(first, preferred) ? preferred : undefined;
      return Object.keys(first).find((k) => k.toLowerCase() === want);
    };
    const k = hitKey(left) || hitKey(right);
    if (k && ok(left) && ok(right)) return k;
  }
  return undefined;
}

export function diffJson(left: unknown, right: unknown, opts: JsonDiffOptions = {}): JsonDiffResult {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ignoreKeys = (opts.ignoreKeys || []).map((s) => s.trim()).filter(Boolean);
  const ignorePaths = (opts.ignorePaths || []).map((s) => s.trim()).filter(Boolean);
  const entries: JsonDiffEntry[] = [];
  const arrayKeys: { path: string; key: string }[] = [];
  let totalDiffs = 0;
  let truncated = false;

  const ignored = (path: string, key?: string) => {
    if (key && ignoreKeys.some((k) => k.toLowerCase() === key.toLowerCase())) return true;
    return ignorePaths.some((p) => pathMatches(p, path));
  };

  const push = (entry: Omit<JsonDiffEntry, 'depth'> & { depth?: number }) => {
    totalDiffs++;
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    entries.push({ depth: 0, ...entry } as JsonDiffEntry);
  };

  const diffValue = (l: unknown, r: unknown, path: string, depth: number, key?: string) => {
    if (ignored(path, key)) return;
    const lt = typeTag(l);
    const rt = typeTag(r);

    if (lt === 'object' && rt === 'object') {
      const lo = l as Record<string, unknown>;
      const ro = r as Record<string, unknown>;
      const names = [...new Set([...Object.keys(lo), ...Object.keys(ro)])];
      for (const name of names) {
        const child = childPath(path, name);
        const inL = hasKey(lo, name);
        const inR = hasKey(ro, name);
        if (inL && inR) diffValue(lo[name], ro[name], child, depth + 1, name);
        else if (inR) push({ path: child, kind: 'added', leftText: '', rightText: briefValue(ro[name]), right: ro[name], depth: depth + 1 });
        else push({ path: child, kind: 'removed', leftText: briefValue(lo[name]), left: lo[name], rightText: '', depth: depth + 1 });
      }
      return;
    }

    if (lt === 'array' && rt === 'array') {
      const la = l as unknown[];
      const ra = r as unknown[];
      const key = pickArrayKey(la, ra, opts.arrayKey?.trim() || undefined);
      if (key) arrayKeys.push({ path, key });

      if (!key) {
        // 按下标对齐：长度差按新增/删除报，位置相同但值不同报变更
        const len = Math.max(la.length, ra.length);
        for (let i = 0; i < len; i++) {
          const child = `${path}[${i}]`;
          if (i < la.length && i < ra.length) diffValue(la[i], ra[i], child, depth + 1);
          else if (i < ra.length) push({ path: child, kind: 'added', leftText: '', rightText: briefValue(ra[i]), right: ra[i], depth: depth + 1 });
          else push({ path: child, kind: 'removed', leftText: briefValue(la[i]), left: la[i], rightText: '', depth: depth + 1 });
        }
        return;
      }

      const indexBy = (arr: unknown[]) => {
        const m = new Map<string, { item: unknown; index: number }>();
        arr.forEach((item, index) => {
          const id = scalar((item as Record<string, unknown>)[key]);
          if (id !== undefined) m.set(id, { item, index });
        });
        return m;
      };
      const lm = indexBy(la);
      const rm = indexBy(ra);
      const ids = [...new Set([...lm.keys(), ...rm.keys()])];
      for (const id of ids) {
        const lHit = lm.get(id);
        const rHit = rm.get(id);
        const label = arrayLabel(rHit?.item ?? lHit?.item, key, rHit?.index ?? lHit?.index ?? 0);
        const child = `${path}[${label}]`;
        if (lHit && rHit) diffValue(lHit.item, rHit.item, child, depth + 1);
        else if (rHit) push({ path: child, kind: 'added', leftText: '', rightText: briefValue(rHit.item), right: rHit.item, depth: depth + 1 });
        else if (lHit) push({ path: child, kind: 'removed', leftText: briefValue(lHit.item), left: lHit.item, rightText: '', depth: depth + 1 });
      }
      return;
    }

    if (l === r) return;
    // 0 与 '0'、null 与 {} 这类：值不同且类型也不同，单独标出来
    const sameLoose = lt !== rt ? false : String(l) === String(r);
    if (l !== r && !(sameLoose && lt === rt)) {
      push({
        path,
        kind: 'changed',
        leftText: briefValue(l),
        rightText: briefValue(r),
        left: l,
        right: r,
        depth,
        typeChanged: lt !== rt,
      });
    } else if (lt !== rt) {
      push({ path, kind: 'changed', leftText: briefValue(l), rightText: briefValue(r), left: l, right: r, depth, typeChanged: true });
    }
  };

  if (ignored('$')) {
    return { entries, totalDiffs, truncated, stats: statsOf(entries), arrayKeys };
  }
  diffValue(left, right, '$', 0);
  return { entries, totalDiffs, truncated, stats: statsOf(entries), arrayKeys };
}

function statsOf(entries: JsonDiffEntry[]) {
  const stats = { changed: 0, added: 0, removed: 0 };
  for (const e of entries) stats[e.kind]++;
  return stats;
}

const KIND_LABEL: Record<JsonDiffKind, string> = { changed: '变更', added: '新增', removed: '删除' };

export function jsonDiffMarkdown(res: JsonDiffResult, title = 'JSON 差异报告'): string {
  const lines: string[] = [`# ${title}`, ''];
  lines.push(`- 变更 ${res.stats.changed} ／ 新增 ${res.stats.added} ／ 删除 ${res.stats.removed}`);
  if (res.truncated) lines.push(`- 差异共 ${res.totalDiffs} 处，仅列出前 ${res.entries.length} 条`);
  if (res.arrayKeys.length) {
    lines.push(`- 数组按稳定标识对齐：${res.arrayKeys.map((a) => `\`${a.path}\` → \`${a.key}\``).join('；')}`);
  }
  lines.push('');
  if (!res.entries.length) {
    lines.push('两份 JSON 语义一致。');
    return lines.join('\n');
  }
  lines.push('| 类型 | 路径 | 左值 | 右值 |');
  lines.push('|---|---|---|---|');
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  for (const e of res.entries) {
    lines.push(`| ${KIND_LABEL[e.kind]}${e.typeChanged ? '（类型变化）' : ''} | \`${esc(e.path)}\` | ${esc(e.leftText) || '—'} | ${esc(e.rightText) || '—'} |`);
  }
  return lines.join('\n');
}
