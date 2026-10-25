/** 轻量 SQL 词法分析：拆出字符串/标识符/符号，供 INSERT 解析与 DDL 解析共用 */

export interface SqlToken {
  type: 'string' | 'ident' | 'number' | 'symbol' | 'word';
  value: string;
  /** 原始引号风格（string 时有效） */
  quote?: "'" | '"' | '`';
}

export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let val = '';
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && quote === "'") {
          const nxt = sql[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', "'": "'", '"': '"' };
          val += map[nxt] ?? nxt;
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { val += quote; i += 2; continue; }
          i++;
          break;
        }
        val += sql[i++];
      }
      out.push({ type: quote === "'" ? 'string' : 'ident', value: val, quote: quote as any });
      continue;
    }
    if (/[\d.]/.test(ch) && !(ch === '.' && !/\d/.test(sql[i + 1] || ''))) {
      let val = '';
      while (i < sql.length && /[\d.eE+\-]/.test(sql[i])) {
        if ((sql[i] === '+' || sql[i] === '-') && !/[eE]/.test(val[val.length - 2] || '')) break;
        val += sql[i++];
      }
      out.push({ type: 'number', value: val });
      continue;
    }
    if (/[A-Za-z_@$一-龥]/.test(ch)) {
      let val = '';
      while (i < sql.length && /[A-Za-z0-9_@$.\u4e00-\u9fa5]/.test(sql[i])) val += sql[i++];
      out.push({ type: 'word', value: val });
      continue;
    }
    out.push({ type: 'symbol', value: ch });
    i++;
  }
  return out;
}

/** 按顶层逗号切分 token 序列 */
export function splitTopLevel(tokens: SqlToken[], sep = ','): SqlToken[][] {
  const parts: SqlToken[][] = [];
  let depth = 0;
  let cur: SqlToken[] = [];
  for (const t of tokens) {
    if (t.type === 'symbol' && t.value === '(') depth++;
    if (t.type === 'symbol' && t.value === ')') depth--;
    if (t.type === 'symbol' && t.value === sep && depth === 0) {
      parts.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
}

export function tokensText(tokens: SqlToken[]): string {
  return tokens
    .map((t) => (t.type === 'string' ? `'${t.value.replace(/'/g, "''")}'` : t.value))
    .join(' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/,\s*/g, ', ');
}
