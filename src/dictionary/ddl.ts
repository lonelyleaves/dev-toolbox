import { tokenizeSql, splitTopLevel, SqlToken, tokensText } from '../logic/sqltoken';
import { DictionaryModel, TableDef, emptyDictionary, ColumnDef } from './model';

/**
 * DDL 文件解析：CREATE TABLE + ALTER TABLE ADD CONSTRAINT FK。
 * 逐语句容错，失败语句记入 importErrors。
 */
export function parseDdl(sql: string, dialect: 'mysql' | 'postgres' | 'generic' = 'mysql'): DictionaryModel {
  const dict = emptyDictionary('ddl-import', dialect);
  dict.meta = { source: 'ddl' };
  const statements = splitTopLevel(tokenizeSql(sql), ';').filter((s) => s.length);

  for (const st of statements) {
    try {
      const head = st.slice(0, 4).map((t) => t.value.toUpperCase());
      if (head.includes('TABLE') && (head[0] === 'CREATE' || head.includes('CREATE'))) {
        parseCreateTable(st, dict);
      } else if (head[0] === 'ALTER' && head.includes('TABLE')) {
        parseAlterFk(st, dict);
      } else if (head[0] === 'COMMENT' && /ON/i.test(tokensText(st))) {
        parseCommentOn(st, dict);
      }
    } catch (e: any) {
      dict.importErrors.push({ source: tokensText(st).slice(0, 50), message: e?.message || String(e) });
    }
  }
  return dict;
}

function wordIs(t: SqlToken | undefined, w: string) {
  return !!t && t.type === 'word' && t.value.toUpperCase() === w;
}

function parseCreateTable(tokens: SqlToken[], dict: DictionaryModel) {
  let i = 0;
  while (i < tokens.length && !wordIs(tokens[i], 'TABLE')) i++;
  i++;
  while (wordIs(tokens[i], 'IF') || wordIs(tokens[i], 'NOT') || wordIs(tokens[i], 'EXISTS') || wordIs(tokens[i], 'TEMPORARY') || wordIs(tokens[i], 'UNLOGGED')) i++;
  const nameTok = tokens[i++];
  if (!nameTok) throw new Error('缺少表名');
  let name = nameTok.value.split('.').pop()!;
  // 找顶层括号体
  while (i < tokens.length && tokens[i].value !== '(') i++;
  if (tokens[i]?.value !== '(') throw new Error('缺少列定义括号');
  let depth = 0;
  const bodyStart = ++i;
  while (i < tokens.length) {
    if (tokens[i].value === '(') depth++;
    if (tokens[i].value === ')') {
      if (depth === 0) break;
      depth--;
    }
    i++;
  }
  const body = tokens.slice(bodyStart, i);
  const table: TableDef = { name, columns: [], indexes: [], foreignKeys: [] };

  const parts = splitTopLevel(body, ',');
  for (const part of parts) {
    const def = part.map((t) => t.value).join(' ').toUpperCase();
    if (/^PRIMARY\s+KEY/.test(def)) {
      const cols = extractParenCols(part.slice(part.findIndex((t) => t.value === '(')));
      for (const c of cols) {
        const col = table.columns.find((x) => x.name.toLowerCase() === c.toLowerCase());
        if (col) col.pk = true;
      }
      continue;
    }
    if (/^(UNIQUE\s+)?(KEY|INDEX)\b/.test(def)) {
      const unique = /^UNIQUE/.test(def);
      const rest = part.slice(/^\w+$/.test(part[0].value) && /key|index/i.test(part[0].value) ? 1 : part[1] && /key|index/i.test(part[1].value) ? 2 : 0);
      const nm = rest[0] && rest[0].type !== 'symbol' ? rest[0].value : `idx_${table.columns.length}`;
      const paren = rest.slice(rest.findIndex((t) => t.value === '('));
      table.indexes.push({ name: nm, unique, columns: extractParenCols(paren) });
      continue;
    }
    if (/^CONSTRAINT\b/.test(def)) {
      const fk = parseConstraintFk(part);
      if (fk) table.foreignKeys.push(fk);
      continue;
    }
    if (/^(FOREIGN\s+KEY)\b/.test(def)) {
      const cols = extractParenCols(part.slice(part.findIndex((t) => t.value === '(')));
      const refIdx = part.findIndex((t) => wordIs(t, 'REFERENCES'));
      if (refIdx >= 0) {
        const refName = part[refIdx + 1]?.value.split('.').pop() || '';
        const refCols = extractParenCols(part.slice(refIdx + 2).slice(part.slice(refIdx + 2).findIndex((t) => t.value === '(')));
        table.foreignKeys.push({ name: `fk_${name}_${cols.join('_')}`, columns: cols, refTable: refName, refColumns: refCols });
      }
      continue;
    }
    if (/^(CHECK|EXCLUDE|PERIOD)\b/.test(def)) continue;
    const col = parseColumnDef(part);
    if (col) table.columns.push(col);
  }

  // 表级注释：MySQL `COMMENT = 'xx'` / PG WITH 后注释
  const tail = tokens.slice(i + 1);
  const tailText = tokensText(tail);
  const cm = tailText.match(/COMMENT(?:\s*=\s*)?'([^']+)'/i);
  if (cm) table.comment = cm[1];
  dict.tables.push(table);
}

function parseColumnDef(tokens: SqlToken[]): ColumnDef | null {
  const nameTok = tokens[0];
  if (!nameTok || nameTok.type === 'symbol') return null;
  const name = nameTok.value;
  // 类型：name 之后连续的类型词（含括号参数）
  let i = 1;
  let type = '';
  const STOP = /^(NOT|NULL|DEFAULT|PRIMARY|UNIQUE|COMMENT|AUTO_INCREMENT|UNSIGNED|ZEROFILL|COLLATE|CHARACTER|GENERATED|IDENTITY|CHECK|ON)$/i;
  while (i < tokens.length && tokens[i].type === 'word' && !STOP.test(tokens[i].value)) {
    type += tokens[i].value;
    i++;
    if (tokens[i]?.value === '(') {
      let depth = 0;
      let args = '';
      while (i < tokens.length) {
        const v = tokens[i].value;
        if (v === '(') depth++;
        if (v === ')') depth--;
        args += v;
        i++;
        if (depth === 0) break;
      }
      type += args;
      break;
    }
  }
  const rest = tokensText(tokens.slice(i)).toUpperCase();
  const col: ColumnDef = { name, type: type || 'varchar', nullable: !/NOT\s+NULL/.test(rest) };
  // 从类型串中提取长度/精度：varchar(64)->64, decimal(10,2)->10,2
  const lenMatch = col.type.match(/\(([^)]+)\)$/);
  if (lenMatch) {
    col.length = lenMatch[1];
  }
  if (/PRIMARY\s+KEY/.test(rest)) col.pk = true;
  if (/AUTO_INCREMENT|BIGSERIAL|SERIAL/.test(rest)) col.autoIncrement = true;
  const dft = tokensText(tokens.slice(i)).match(/DEFAULT\s+(\S+)/i);
  if (dft) col.defaultValue = dft[1];
  const cmt = tokensText(tokens.slice(i)).match(/COMMENT\s+'([^']*)'/i);
  if (cmt) col.comment = cmt[1];
  return col;
}

function extractParenCols(tokens: SqlToken[]): string[] {
  let depth = 0;
  const cols: string[] = [];
  let cur = '';
  for (const t of tokens) {
    if (t.value === '(') { depth++; if (depth === 1) continue; }
    if (t.value === ')') { depth--; if (depth === 0) { if (cur) cols.push(cur.trim()); break; } }
    if (depth >= 1 && t.type === 'symbol' && t.value === ',') { cols.push(cur.trim()); cur = ''; continue; }
    if (depth >= 1 && t.type !== 'symbol') cur += (cur ? ' ' : '') + t.value;
  }
  return cols.map((c) => c.split(/\s+/)[0]?.replace(/\(.*\)$/, '') || c).filter(Boolean);
}

function parseConstraintFk(part: SqlToken[]) {
  const fkIdx = part.findIndex((t) => wordIs(t, 'FOREIGN'));
  if (fkIdx < 0) return null;
  const name = part[1]?.value || '';
  const cols = extractParenCols(part.slice(part.findIndex((t, i) => i > fkIdx && t.value === '(')));
  const refIdx = part.findIndex((t) => wordIs(t, 'REFERENCES'));
  if (refIdx < 0) return null;
  const refTable = part[refIdx + 1]?.value.split('.').pop() || '';
  const refCols = extractParenCols(part.slice(refIdx + 2).slice(part.slice(refIdx + 2).findIndex((t) => t.value === '(')));
  return { name: name || `fk_${cols.join('_')}`, columns: cols, refTable, refColumns: refCols };
}

function parseAlterFk(tokens: SqlToken[], dict: DictionaryModel) {
  let i = 2;
  while (wordIs(tokens[i], 'ONLY')) i++;
  const tableName = tokens[i++]?.value.split('.').pop();
  if (!tableName) return;
  const table = dict.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
  if (!table) return;
  const fk = parseConstraintFk(tokens.slice(i));
  if (fk) table.foreignKeys.push(fk);
}

/** PG: COMMENT ON TABLE x IS 'c' / COMMENT ON COLUMN t.c IS 'c' */
function parseCommentOn(tokens: SqlToken[], dict: DictionaryModel) {
  const text = tokensText(tokens);
  const tableM = text.match(/COMMENT\s+ON\s+TABLE\s+([\w.]+)\s+IS\s+'([^']*)'/i);
  if (tableM) {
    const t = dict.tables.find((x) => x.name.toLowerCase() === tableM[1].split('.').pop()!.toLowerCase());
    if (t) t.comment = tableM[2];
    return;
  }
  const colM = text.match(/COMMENT\s+ON\s+COLUMN\s+([\w.]+)\.(\w+)\s+IS\s+'([^']*)'/i);
  if (colM) {
    const t = dict.tables.find((x) => x.name.toLowerCase() === colM[1].split('.').pop()!.toLowerCase());
    const c = t?.columns.find((x) => x.name.toLowerCase() === colM[2].toLowerCase());
    if (c) c.comment = colM[3];
  }
}
