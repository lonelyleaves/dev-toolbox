import { tokenizeSql, splitTopLevel, SqlToken, tokensText } from './sqltoken';

export interface InsertTable {
  table: string;
  columns: string[];
  rows: string[][]; // 保留原始 SQL 字面量文本（NULL/函数等原样保留）
}

/** 解析一段 SQL 中的全部 INSERT 语句，按表聚合 */
export function parseInserts(sql: string): { tables: InsertTable[]; errors: string[] } {
  const tables: InsertTable[] = [];
  const errors: string[] = [];
  const statements = splitTopLevel(tokenizeSql(sql), ';');
  for (const st of statements) {
    if (st.length === 0) continue;
    try {
      const parsed = parseOneInsert(st);
      if (!parsed) continue;
      let target = tables.find((t) => t.table.toLowerCase() === parsed.table.toLowerCase());
      if (!target) {
        tables.push(parsed);
      } else {
        if (target.columns.join('|').toLowerCase() !== parsed.columns.join('|').toLowerCase()) {
          errors.push(`表 ${parsed.table} 的列清单不一致，后续语句单列展示`);
          target = parsed;
          tables.push(parsed);
          continue;
        }
        target.rows.push(...parsed.rows);
      }
    } catch (e: any) {
      errors.push(`语句解析失败: ${e?.message || e}（片段: ${tokensText(st).slice(0, 60)}…）`);
    }
  }
  return { tables, errors };
}

function parseOneInsert(tokens: SqlToken[]): InsertTable | null {
  const words = tokens.filter((t) => t.type === 'word').map((t) => t.value.toUpperCase());
  if (words[0] !== 'INSERT') return null;
  let i = 0;
  const kw = () => tokens[i] && tokens[i].type === 'word' ? tokens[i].value.toUpperCase() : '';
  while (i < tokens.length && !['INTO'].includes(kw())) i++; // 跳过 IGNORE 等
  i++; // INTO
  if (!tokens[i]) throw new Error('缺少表名');
  const table = tokens[i++].value;
  // 可选列清单
  let columns: string[] = [];
  while (i < tokens.length && tokens[i].type === 'word' && !['VALUES', 'VALUE', 'SELECT', 'ON'].includes(kw())) i++;
  if (tokens[i] && tokens[i].type === 'symbol' && tokens[i].value === '(') {
    const start = i + 1;
    let depth = 1;
    while (i < tokens.length && depth > 0) {
      i++;
      if (tokens[i]?.value === '(') depth++;
      if (tokens[i]?.value === ')') depth--;
    }
    columns = tokens.slice(start, i).filter((t) => t.type !== 'symbol').map((t) => t.value);
    i++; // 跳过 VALUES
  }
  while (i < tokens.length && !['VALUES', 'VALUE'].includes(kw())) i++;
  if (!tokens[i]) throw new Error('缺少 VALUES');
  i++;
  const rowsPart = tokens.slice(i).filter((t) => !(t.type === 'word' && /^(ON|DUPLICATE|KEY|UPDATE|SET|RETURNING)$/i.test(t.value)));
  const tuples = splitTopLevel(rowsPart, ',').filter((p) => p.length);
  const rows: string[][] = [];
  for (const tuple of tuples) {
    let t = tuple;
    if (t[0]?.value === '(' && t[t.length - 1]?.value === ')') t = t.slice(1, -1);
    const values = splitTopLevel(t, ',').map((v) => renderValue(v));
    rows.push(values);
  }
  if (columns.length === 0) {
    const maxCols = Math.max(...rows.map((r) => r.length), 0);
    columns = Array.from({ length: maxCols }, (_, idx) => `col_${idx + 1}`);
  }
  return { table, columns, rows };
}

/** 值 token 序列 → 展示文本：字符串去引号并标记类型，NULL 保留 */
function renderValue(tokens: SqlToken[]): string {
  if (tokens.length === 0) return '';
  const first = tokens[0];
  if (tokens.length === 1 && first.type === 'string') return first.value;
  if (tokens.length === 1 && first.type === 'word' && first.value.toUpperCase() === 'NULL') return 'NULL';
  return tokensText(tokens);
}

/** 值是否字符串字面量（用于生成 SQL 时决定引号） */
export function quoteForSql(value: string): string {
  if (value === 'NULL') return 'NULL';
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  if (/^[A-Za-z_][\w]*\(/.test(value)) return value; // 函数
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function generateUpdates(table: InsertTable, pkColumns: string[]): string[] {
  const pkIdx = pkColumns.map((c) => table.columns.indexOf(c)).filter((i) => i >= 0);
  if (pkIdx.length === 0) throw new Error(`主键列 ${pkColumns.join(',')} 不在列清单中`);
  return table.rows.map((row) => {
    const sets = table.columns
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !pkIdx.includes(i))
      .map(({ c, i }) => `\`${c}\` = ${quoteForSql(row[i] ?? 'NULL')}`);
    const where = pkIdx.map((i) => `\`${table.columns[i]}\` = ${quoteForSql(row[i] ?? 'NULL')}`).join(' AND ');
    return `UPDATE \`${table.table}\` SET ${sets.join(', ')} WHERE ${where};`;
  });
}

export function generateDeletes(table: InsertTable, pkColumns: string[]): string[] {
  const pkIdx = pkColumns.map((c) => table.columns.indexOf(c)).filter((i) => i >= 0);
  if (pkIdx.length === 0) throw new Error(`主键列 ${pkColumns.join(',')} 不在列清单中`);
  return table.rows.map((row) => {
    const where = pkIdx.map((i) => `\`${table.columns[i]}\` = ${quoteForSql(row[i] ?? 'NULL')}`).join(' AND ');
    return `DELETE FROM \`${table.table}\` WHERE ${where};`;
  });
}

export function toCsv(table: InsertTable): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [table.columns.map(esc).join(',')];
  for (const r of table.rows) lines.push(r.map((v) => esc(v === 'NULL' ? '' : v)).join(','));
  return lines.join('\n');
}

export function toJsonArray(table: InsertTable): string {
  return JSON.stringify(
    table.rows.map((r) => {
      const o: Record<string, unknown> = {};
      table.columns.forEach((c, i) => {
        const v = r[i];
        o[c] = v === 'NULL' ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      });
      return o;
    }),
    null,
    2
  );
}

/** 多行 VALUES 拆成单行 INSERT */
export function splitToSingleRowInserts(table: InsertTable): string[] {
  const cols = table.columns.map((c) => `\`${c}\``).join(', ');
  return table.rows.map((r) => `INSERT INTO \`${table.table}\` (${cols}) VALUES (${r.map(quoteForSql).join(', ')});`);
}
