import { DictionaryModel, TableDef, ColumnDef, emptyDictionary } from './model';

/**
 * Markdown 数据字典解析。识别两种版式：
 * 1) 标题式：`## t_user 用户表` 后跟一个管道表格（表头含 字段/类型/注释 等）
 * 2) 单表式：整篇一个表格，含"表名"列
 */
export function parseMarkdownDict(md: string): DictionaryModel {
  const dict = emptyDictionary('markdown-import', 'generic');
  dict.meta = { source: 'markdown' };
  const lines = md.split(/\r?\n/);

  const headerRe = /^(#{1,6})\s+(.+)$/;
  let current: { name: string; comment?: string; start: number } | null = null;
  const sections: { name: string; comment?: string; lines: string[] }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (m && i > 0) {
      if (current) sections.push({ ...current, lines: lines.slice(current.start + 1, i) });
      const title = m[2].trim();
      const tm = title.match(/^([\w.\-]+)\s*(?:[（(]\s*(.+?)\s*[)）])?\s*(.*)$/);
      current = { name: (tm?.[1] || title).replace(/^表[:：]\s*/, ''), comment: tm?.[2] || tm?.[3] || undefined, start: i };
    }
  }
  if (current) sections.push({ ...current, lines: lines.slice(current.start + 1) });

  const addSection = (sec: { name: string; comment?: string; lines: string[] }) => {
    const tableLines = sec.lines.filter((l) => /^\s*\|/.test(l));
    if (tableLines.length < 2) return;
    const rows = tableLines.map(parsePipeRow);
    const header = rows[0].map((h) => h.toLowerCase());
    const colIdx = findIndex(header, ['字段', 'field', 'column', '列名', '字段名', 'name']);
    const typeIdx = findIndex(header, ['类型', 'type', '字段类型', 'data type']);
    const nullableIdx = findIndex(header, ['是否为空', '允许空', 'nullable', '可空', '非空']);
    const pkIdx = findIndex(header, ['主键', 'pk', 'primary key']);
    const commentIdx = findIndex(header, ['注释', '说明', 'comment', '描述', 'desc', '备注']);
    const defaultIdx = findIndex(header, ['默认值', 'default']);
    if (colIdx < 0) return;
    const table: TableDef = { name: sec.name, comment: sec.comment, columns: [], indexes: [], foreignKeys: [] };
    for (const r of rows.slice(1)) {
      if (/^[-: ]+$/.test(r[colIdx] || '')) continue;
      const col: ColumnDef = {
        name: (r[colIdx] || '').replace(/`/g, '').trim(),
        type: typeIdx >= 0 ? (r[typeIdx] || 'varchar').replace(/`/g, '').trim() : 'varchar',
      };
      if (!col.name) continue;
      if (nullableIdx >= 0) {
        const v = (r[nullableIdx] || '').toUpperCase();
        col.nullable = !['NO', 'N', '否', '非空', 'NOT NULL'].includes(v);
      }
      if (pkIdx >= 0) col.pk = ['YES', 'Y', '是', '√', '✓', '1', 'PRI'].includes((r[pkIdx] || '').trim().toUpperCase());
      if (commentIdx >= 0) col.comment = (r[commentIdx] || '').trim() || undefined;
      if (defaultIdx >= 0) col.defaultValue = (r[defaultIdx] || '').trim() || undefined;
      table.columns.push(col);
    }
    if (table.columns.length) dict.tables.push(table);
  };

  if (sections.length) {
    for (const sec of sections) addSection(sec);
  }

  // 单表式（无标题分节）：含"表名"列
  if (dict.tables.length === 0) {
    const tableLines = lines.filter((l) => /^\s*\|/.test(l));
    if (tableLines.length >= 2) {
      const rows = tableLines.map(parsePipeRow);
      const header = rows[0].map((h) => h.toLowerCase());
      const tableIdx = findIndex(header, ['表名', 'table', '表']);
      if (tableIdx >= 0) {
        const colIdx = findIndex(header, ['字段', 'field', 'column', '字段名']);
        const typeIdx = findIndex(header, ['类型', 'type']);
        const commentIdx = findIndex(header, ['注释', '说明', 'comment']);
        const grouped = new Map<string, string[][]>();
        for (const r of rows.slice(1)) {
          if (/^[-: ]*$/.test(r[tableIdx] || '')) continue;
          const tn = (r[tableIdx] || '').trim();
          if (!tn) continue;
          if (!grouped.has(tn)) grouped.set(tn, []);
          grouped.get(tn)!.push(r);
        }
        for (const [tn, rs] of grouped) {
          const table: TableDef = { name: tn, columns: [], indexes: [], foreignKeys: [] };
          for (const r of rs) {
            table.columns.push({
              name: (r[colIdx] || '').trim(),
              type: typeIdx >= 0 ? (r[typeIdx] || 'varchar').trim() : 'varchar',
              comment: commentIdx >= 0 ? (r[commentIdx] || '').trim() || undefined : undefined,
            });
          }
          dict.tables.push(table);
        }
      }
    }
  }
  if (dict.tables.length === 0) {
    dict.importErrors.push({ source: 'markdown', message: '未识别到任何表格（需要"标题+管道表格"或含表名列的表格）' });
  }
  return dict;
}

function parsePipeRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function findIndex(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = header.findIndex((h) => h.includes(c.toLowerCase()));
    if (i >= 0) return i;
  }
  return -1;
}
