import yaml from 'js-yaml';
import { normalizeInput } from './text';
import { describeJsonError, JsonErrorInfo } from './json-error';

/** 修复常见非法 JSON：注释、单引号、尾逗号、未加引号的 key、NaN/undefined */
export function repairJson(text: string): string {
  let out = '';
  let inStr: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      if (ch === '\\') {
        // Python repr 里的 \' 在 JSON 里是非法转义，还原成普通单引号
        if (inStr === "'" && next === "'") { out += "'"; i++; continue; }
        out += ch + (next ?? '');
        i++;
        continue;
      }
      if (ch === inStr) { inStr = null; out += '"'; continue; }
      out += ch === '"' ? '\\"' : ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      out += '"';
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (/[\w$.]/.test(ch)) {
      let word = '';
      let j = i;
      while (j < text.length && /[\w$.]/.test(text[j])) word += text[j++];
      // Python 字符串前缀 b'x' / u'x' / r'x' / rb'x'：丢掉前缀，后面当字符串处理
      if ((text[j] === "'" || text[j] === '"') && /^(b|u|r|br|rb|f|rf|fr)$/i.test(word)) {
        i = j - 1;
        continue;
      }
      i = j - 1;
      const lw = word.toLowerCase();
      if (lw === 'nan' || lw === 'undefined' || lw === 'infinity') { out += 'null'; continue; }
      if (lw === 'true' || lw === 'false') { out += lw; continue; }
      if (lw === 'none' || lw === 'null' || lw === 'nil') { out += 'null'; continue; }
      // 后面紧跟 : 说明是对象 key，不管是裸标识符还是数字都得加双引号
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === ':') { out += `"${word}"`; continue; }
      if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(word)) { out += word; continue; }
      out += `"${word}"`;
      continue;
    }
    out += ch;
  }
  // 去尾逗号
  out = out.replace(/,\s*([}\]])/g, '$1');
  return out;
}

export interface JsonParseResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  repaired?: boolean;
  /** 结构化错误：位置 + 片段 + 排查建议 */
  errorInfo?: JsonErrorInfo;
}

export function parseJsonLoose(text: string): JsonParseResult {
  // BOM（\uFEFF）会让 JSON.parse 直接报 "Unexpected token"，复制粘贴场景很常见
  const source = normalizeInput(text).replace(/^\s+|\s+$/g, '');
  if (!source) {
    return {
      ok: false,
      error: '内容为空',
      errorInfo: { raw: 'empty', title: '内容为空', reason: '内容为空', hint: '粘贴或输入 JSON 后再试。' },
    };
  }
  try {
    return { ok: true, data: JSON.parse(source) };
  } catch (e: any) {
    let fixed = source;
    let repairBroken = false;
    try {
      fixed = repairJson(source);
    } catch {
      repairBroken = true;
    }
    try {
      return { ok: true, data: JSON.parse(fixed), repaired: fixed !== source };
    } catch (e2: any) {
      /* 以前这里报的是第一次 JSON.parse 的原文错误（比如单引号），
         但单引号已经被修好了，用户看到的是完全对不上的位置。
         现在报修复后文本的真正失败点 */
      const info = describeJsonError(repairBroken ? e : e2, repairBroken ? source : fixed, {
        repaired: !repairBroken && fixed !== source,
      });
      if (!repairBroken && fixed !== source && fixed.length !== source.length) {
        info.hint = `${info.hint || ''}（位置按自动修复后的文本计算）`;
      }
      return { ok: false, error: info.title, errorInfo: info };
    }
  }
}

/** JSON → 其他格式 */
export function toYaml(data: unknown): string {
  return yaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true });
}

export function toXml(data: unknown, rootName = 'root'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const walk = (val: unknown, name: string): string => {
    if (Array.isArray(val)) return val.map((v) => walk(v, name)).join('\n');
    if (val !== null && typeof val === 'object') {
      const inner = Object.entries(val as object).map(([k, v]) => walk(v, k)).join('\n');
      return `<${name}>\n${inner}\n</${name}>`;
    }
    return `<${name}>${esc(String(val ?? ''))}</${name}>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${walk(data, rootName)}`;
}

export function toCsv(data: unknown): string {
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return '';
  const cols = Array.from(new Set(rows.flatMap((r: any) => (r && typeof r === 'object' ? Object.keys(r) : []))));
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r: any) => cols.map((c) => esc(r?.[c])).join(','))].join('\n');
}

/** CSV → JSON 数组 */
export function csvToJson(text: string): unknown[] {
  const lines = parseCsvLines(text);
  if (lines.length < 2) return [];
  const head = lines[0];
  return lines.slice(1).map((row) => {
    const o: Record<string, unknown> = {};
    head.forEach((h, i) => {
      const v = row[i] ?? '';
      o[h] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v === '' ? null : v;
    });
    return o;
  });
}

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/** JSON → 多语言类型定义 */
export function generateTypes(data: unknown, rootName = 'Root'): { ts: string; java: string; go: string; kotlin: string } {
  return {
    ts: tsTypes(data, rootName),
    java: javaTypes(data, rootName),
    go: goTypes(data, rootName),
    kotlin: kotlinTypes(data, rootName),
  };
}

type Shape =
  | { kind: 'prim'; t: 'string' | 'number' | 'boolean' | 'null' }
  | { kind: 'array'; item: Shape }
  | { kind: 'object'; name: string; props: Map<string, Shape> };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function shapeOf(value: unknown, name: string, out: Map<string, Shape>): Shape {
  if (value === null || value === undefined) return { kind: 'prim', t: 'null' };
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'array', item: { kind: 'prim', t: 'null' } };
    let item = shapeOf(value[0], name.endsWith('s') ? name.slice(0, -1) : name, out);
    for (const v of value.slice(1)) item = mergeShape(item, shapeOf(v, item.kind === 'object' ? item.name : name, out), out);
    return { kind: 'array', item };
  }
  if (typeof value === 'object') {
    const props = new Map<string, Shape>();
    for (const [k, v] of Object.entries(value as object)) props.set(k, shapeOf(v, cap(k), out));
    const shape: Shape = { kind: 'object', name: cap(name), props };
    out.set(shape.name, shape);
    return shape;
  }
  return { kind: 'prim', t: typeof value as 'string' | 'number' | 'boolean' };
}

function mergeShape(a: Shape, b: Shape, out: Map<string, Shape>): Shape {
  if (a.kind === 'prim' && b.kind === 'prim') return a.t === b.t ? a : { kind: 'prim', t: 'string' };
  if (a.kind === 'array' && b.kind === 'array') return { kind: 'array', item: mergeShape(a.item, b.item, out) };
  if (a.kind === 'object' && b.kind === 'object') {
    for (const [k, v] of b.props) {
      if (!a.props.has(k)) a.props.set(k, v);
      else a.props.set(k, mergeShape(a.props.get(k)!, v, out));
    }
    return a;
  }
  return { kind: 'prim', t: 'string' };
}

function collectObjects(root: Shape, out: Map<string, Shape>): Shape[] {
  const seen = new Set<string>();
  const list: Shape[] = [];
  const walk = (s: Shape) => {
    if (s.kind === 'array') return walk(s.item);
    if (s.kind !== 'object' || seen.has(s.name)) return s;
    seen.add(s.name);
    list.push(s);
    for (const v of s.props.values()) walk(v);
    return s;
  };
  walk(root);
  void out;
  return list;
}

function tsTypes(data: unknown, rootName: string): string {
  const objects = new Map<string, Shape>();
  const root = shapeOf(data, rootName, objects);
  const lines: string[] = [];
  for (const s of collectObjects(root, objects)) {
    if (s.kind !== 'object') continue;
    lines.push(`interface ${s.name} {`);
    for (const [k, v] of s.props) lines.push(`  ${/^\w+$/.test(k) ? k : `"${k}"`}: ${tsOf(v)};`);
    lines.push(`}\n`);
  }
  if (root.kind !== 'object') lines.unshift(`type ${rootName} = ${tsOf(root)};`);
  return lines.join('\n');
}

function tsOf(s: Shape): string {
  if (s.kind === 'prim') return s.t === 'null' ? 'null' : s.t;
  if (s.kind === 'array') return `${tsOf(s.item)}[]`;
  return s.name;
}

function javaTypes(data: unknown, rootName: string): string {
  const objects = new Map<string, Shape>();
  const root = shapeOf(data, rootName, objects);
  const lines: string[] = [];
  for (const s of collectObjects(root, objects)) {
    if (s.kind !== 'object') continue;
    lines.push(`public class ${s.name} {`);
    for (const [k, v] of s.props) lines.push(`    private ${javaOf(v)} ${toCamel(k)};`);
    lines.push(`}\n`);
  }
  if (root.kind !== 'object') lines.unshift(`// 顶层类型: ${javaOf(root)}`);
  return lines.join('\n');
}

function javaOf(s: Shape): string {
  if (s.kind === 'prim') return { string: 'String', number: 'Long', boolean: 'Boolean', null: 'Object' }[s.t];
  if (s.kind === 'array') return `List<${boxOf(s.item)}>`;
  return s.name;
}

function boxOf(s: Shape): string {
  const j = javaOf(s);
  return j === 'Long' ? 'Long' : j;
}

function goTypes(data: unknown, rootName: string): string {
  const objects = new Map<string, Shape>();
  const root = shapeOf(data, rootName, objects);
  const lines: string[] = [];
  for (const s of collectObjects(root, objects)) {
    if (s.kind !== 'object') continue;
    lines.push(`type ${cap(s.name)} struct {`);
    for (const [k, v] of s.props) lines.push(`    ${cap(toCamel(k))} ${goOf(v)} \`json:"${k}"\``);
    lines.push(`}\n`);
  }
  if (root.kind !== 'object') lines.unshift(`// 顶层类型: ${goOf(root)}`);
  return lines.join('\n');
}

function goOf(s: Shape): string {
  if (s.kind === 'prim') return { string: 'string', number: 'float64', boolean: 'bool', null: 'interface{}' }[s.t];
  if (s.kind === 'array') return `[]${goOf(s.item)}`;
  return `*${cap(s.name)}`;
}

function kotlinTypes(data: unknown, rootName: string): string {
  const objects = new Map<string, Shape>();
  const root = shapeOf(data, rootName, objects);
  const lines: string[] = [];
  for (const s of collectObjects(root, objects)) {
    if (s.kind !== 'object') continue;
    const props = Array.from(s.props.entries()).map(([k, v]) => `    val ${toCamel(k)}: ${ktOf(v)}`);
    lines.push(`data class ${cap(s.name)}(\n${props.join(',\n')}\n)\n`);
  }
  if (root.kind !== 'object') lines.unshift(`// 顶层类型: ${ktOf(root)}`);
  return lines.join('\n');
}

function ktOf(s: Shape): string {
  if (s.kind === 'prim') return { string: 'String', number: 'Double', boolean: 'Boolean', null: 'Any?' }[s.t];
  if (s.kind === 'array') return `List<${ktOf(s.item)}>`;
  return cap(s.name);
}

function toCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** 简易 JSONPath：$.a.b[0].c / $['带引号']['键'] */
export function jsonPath(data: unknown, path: string): unknown[] {
  const tokens: (string | number)[] = [];
  const re = /\[(\d+)\]|\["([^"]+)"\]|\['([^']+)'\]|\.([^.[\]]+)|^([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) tokens.push(Number(m[1]));
    else if (m[2] !== undefined) tokens.push(m[2]);
    else if (m[3] !== undefined) tokens.push(m[3]);
    else if (m[4] !== undefined) tokens.push(m[4]);
    else if (m[5] !== undefined && m[5] !== '$') tokens.push(m[5]);
  }
  let cur: unknown[] = [data];
  for (const tk of tokens) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c && typeof c === 'object') {
        const v = (c as any)[tk as any];
        if (v !== undefined) next.push(v);
      }
    }
    cur = next;
  }
  return cur;
}
