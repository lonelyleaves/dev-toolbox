import { DictionaryModel, TableDef } from './model';
import { createTableSql } from './diffengine';

/** Markdown 数据字典 */
export function exportMarkdown(dict: DictionaryModel): string {
  const lines = [`# ${dict.name} 数据字典`, ``, `> 共 ${dict.tables.length} 张表`, ``];
  const toc = dict.tables.map((t) => `- [${t.name}](#${t.name})${t.comment ? ` — ${t.comment}` : ''}`);
  lines.push(...toc, ``);
  for (const t of dict.tables) {
    lines.push(`## ${t.name}`, '');
    if (t.comment) lines.push(`${t.comment}`, '');
    lines.push(`| # | 字段 | 类型 | 长度 | 可空 | 主键 | 默认值 | 注释 |`, `|---|---|---|---|---|---|---|---|`);
    t.columns.forEach((c, i) => {
      lines.push(`| ${i + 1} | ${c.name} | ${c.type} | ${c.length ?? ''} | ${c.nullable === false ? 'NO' : 'YES'} | ${c.pk ? 'PK' : ''} | ${c.defaultValue ?? ''} | ${c.comment ?? ''} |`);
    });
    if (t.indexes.length) {
      lines.push(``, `索引：`, ...t.indexes.map((x) => `- \`${x.name}\` ${x.unique ? 'UNIQUE ' : ''}(${x.columns.join(', ')})`));
    }
    if (t.foreignKeys.length) {
      lines.push(``, `外键：`, ...t.foreignKeys.map((f) => `- \`${f.name}\` (${f.columns.join(', ')}) → \`${f.refTable}\`(${f.refColumns.join(', ')})`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** HTML 数据字典（自带样式，可直接打印） */
export function exportHtml(dict: DictionaryModel): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tables = dict.tables.map((t) => {
    const rows = t.columns.map((c) =>
      `<tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td><td>${esc(c.length || '')}</td><td>${c.nullable === false ? 'NO' : 'YES'}</td><td>${c.pk ? 'PK' : ''}</td><td>${esc(c.comment || '')}</td></tr>`
    ).join('');
    return `<h2>${esc(t.name)} <small>${esc(t.comment || '')}</small></h2>
<table><thead><tr><th>字段</th><th>类型</th><th>长度</th><th>可空</th><th>键</th><th>注释</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(dict.name)} 数据字典</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222}
table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{border:1px solid #ddd;padding:6px 10px;font-size:13px}
th{background:#f5f5f7;text-align:left}h2{margin-top:32px;border-bottom:2px solid #eee;padding-bottom:4px}h2 small{color:#888;font-weight:normal}</style>
</head><body><h1>${esc(dict.name)} 数据字典</h1><p>共 ${dict.tables.length} 张表 · 导出于 ${new Date().toLocaleString('zh-CN')}</p>${tables}</body></html>`;
}

/**
 * Word 可打开的 HTML（零依赖方案，保存为 .doc）。
 * 说明：不引入 docx 库（会显著增大 vsix 体积），改用 Office HTML 标记：
 * Word/WPS 双击 .doc 可直接打开表格并保留样式，打印/另存为 .docx 均正常。
 */
export function exportWordHtml(dict: DictionaryModel): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = dict.tables.map((t) => {
    const rows = t.columns.map((c, i) =>
      `<tr><td>${i + 1}</td><td>${esc(c.name)}</td><td>${esc(c.code || '')}</td><td>${esc(c.type)}</td><td>${esc(c.length || '')}</td><td>${c.nullable === false ? 'NO' : 'YES'}</td><td>${c.pk ? 'PK' : ''}</td><td>${esc(c.defaultValue || '')}</td><td>${esc(c.comment || '')}</td></tr>`
    ).join('');
    const fk = t.foreignKeys.length
      ? `<p class="sub">外键：${t.foreignKeys.map((f) => `${esc(f.name)} (${esc(f.columns.join(', '))}) → ${esc(f.refTable)}(${esc(f.refColumns.join(', '))})`).join('；')}</p>`
      : '';
    const idx = t.indexes.length
      ? `<p class="sub">索引：${t.indexes.map((x) => `${esc(x.name)}${x.unique ? ' UNIQUE' : ''} (${esc(x.columns.join(', '))})`).join('；')}</p>`
      : '';
    return `<h2>${esc(t.name)}${t.comment ? ` <span class="cmt">${esc(t.comment)}</span>` : ''}</h2>
<table><thead><tr><th>#</th><th>物理名</th><th>显示名</th><th>类型</th><th>长度</th><th>可空</th><th>键</th><th>默认值</th><th>注释</th></tr></thead><tbody>${rows}</tbody></table>${idx}${fk}`;
  }).join('\n');

  const seqSection = dict.sequences?.length
    ? `<h1>序列</h1><table><thead><tr><th>序列名</th><th>起始</th><th>步长</th><th>最小</th><th>最大</th><th>当前</th><th>缓存</th><th>循环</th></tr></thead><tbody>${
      dict.sequences.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.start || '')}</td><td>${esc(s.increment || '')}</td><td>${esc(s.min || '')}</td><td>${esc(s.max || '')}</td><td>${esc(s.current || '')}</td><td>${esc(s.cache || '')}</td><td>${s.cycle ? 'CYCLE' : ''}</td></tr>`).join('')
    }</tbody></table>`
    : '';

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(dict.name)} 数据字典</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>
body{font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:10pt}
table{border-collapse:collapse;width:100%;margin:6pt 0 16pt}
th,td{border:1px solid #999;padding:3pt 6pt;font-size:9pt}
th{background:#f2f2f2}
h1{font-size:16pt;border-bottom:2px solid #666;padding-bottom:4pt}
h2{font-size:12pt;margin-top:14pt}
.cmt{color:#888;font-weight:normal}
.sub{font-size:9pt;color:#555;margin:2pt 0}
</style>
</head><body>
<h1>${esc(dict.name)} 数据字典</h1>
<p class="sub">共 ${dict.tables.length} 张表 · ${dict.sequences?.length || 0} 个序列 · 导出于 ${new Date().toLocaleString('zh-CN')}</p>
${body}
${seqSection}
</body></html>`;
}

/** Mermaid erDiagram 文本 */
export function exportMermaid(dict: DictionaryModel): string {
  const lines = ['erDiagram'];
  for (const t of dict.tables) {
    for (const f of t.foreignKeys) {
      lines.push(`  ${f.refTable} ||--o{ ${t.name} : "${f.name}"`);
    }
  }
  for (const t of dict.tables) {
    lines.push(`  ${t.name} {`);
    for (const c of t.columns) {
      const type = c.type.replace(/[(),\s]/g, '_');
      lines.push(`    ${type} ${c.name}${c.pk ? ' PK' : ''}${t.foreignKeys.some((f) => f.columns.includes(c.name)) ? ' FK' : ''}`);
    }
    lines.push('  }');
  }
  return lines.join('\n');
}

/** DDL SQL */
export function exportDdl(dict: DictionaryModel): string {
  const dialect = dict.dialect === 'postgres' ? 'pg' : dict.dialect === 'mssql' ? 'mssql' : dict.dialect === 'oracle' ? 'oracle' : 'mysql';
  const q = (n: string) => (dialect === 'mysql' ? `\`${n}\`` : dialect === 'mssql' ? `[${n}]` : `"${n}"`);
  return dict.tables.map((t) => createTableSql(t, dialect, q)).join('\n\n');
}

/** Excel 工作簿数据：总览 sheet + 每表一个 sheet（页面里用 xlsx 库落地） */
export function buildExcelSheets(dict: DictionaryModel): { name: string; rows: (string | number)[][] }[] {
  const overview: (string | number)[][] = [['表名', '注释', '字段数', '主键', '索引数', '外键数']];
  for (const t of dict.tables) {
    overview.push([t.name, t.comment || '', t.columns.length, t.columns.filter((c) => c.pk).map((c) => c.name).join('+'), t.indexes.length, t.foreignKeys.length]);
  }
  const sheets: { name: string; rows: (string | number)[][] }[] = [{ name: '总览', rows: overview }];
  for (const t of dict.tables) {
    const rows: (string | number)[][] = [['#', '字段', '类型', '长度', '可空', '主键', '默认值', '注释']];
    t.columns.forEach((c, i) => rows.push([i + 1, c.name, c.type, c.length || '', c.nullable === false ? 'NO' : 'YES', c.pk ? 'PK' : '', c.defaultValue || '', c.comment || '']));
    sheets.push({ name: safeSheetName(t.name, sheets.length), rows });
  }
  return sheets;
}

function safeSheetName(name: string, idx: number): string {
  const cleaned = name.replace(/[\\/*?:[\]]/g, '_').slice(0, 28);
  return cleaned || `sheet_${idx}`;
}

/** 统计：注释覆盖率 / 类型分布 */
export function dictStats(dict: DictionaryModel): {
  tables: number; columns: number; commentedColumns: number; commentedTables: number;
  typeDist: { type: string; count: number }[];
} {
  let columns = 0;
  let commentedColumns = 0;
  const types = new Map<string, number>();
  for (const t of dict.tables) {
    for (const c of t.columns) {
      columns++;
      if (c.comment) commentedColumns++;
      const base = c.type.replace(/\(.*\)/, '').toLowerCase() || 'unknown';
      types.set(base, (types.get(base) || 0) + 1);
    }
  }
  return {
    tables: dict.tables.length,
    columns,
    commentedColumns,
    commentedTables: dict.tables.filter((t) => t.comment).length,
    typeDist: Array.from(types.entries()).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count).slice(0, 12),
  };
}

/** 全局搜索：表/字段/注释命中 */
export function dictSearch(dict: DictionaryModel, keyword: string): { table: string; column?: string; field: string; text: string }[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const hits: { table: string; column?: string; field: string; text: string }[] = [];
  for (const t of dict.tables) {
    if (t.name.toLowerCase().includes(kw)) hits.push({ table: t.name, field: '表名', text: t.name });
    if (t.comment?.toLowerCase().includes(kw)) hits.push({ table: t.name, field: '表注释', text: t.comment });
    for (const c of t.columns) {
      if (c.name.toLowerCase().includes(kw)) hits.push({ table: t.name, column: c.name, field: '字段名', text: c.name });
      else if (c.comment?.toLowerCase().includes(kw)) hits.push({ table: t.name, column: c.name, field: '注释', text: c.comment });
    }
    if (hits.length > 300) break;
  }
  return hits;
}

/** 引用关系：哪些表的外键指向该表 */
export function referrersOf(dict: DictionaryModel, tableName: string): { table: string; fk: string; columns: string[] }[] {
  return dict.tables
    .flatMap((t) => t.foreignKeys.filter((f) => f.refTable.toLowerCase() === tableName.toLowerCase()).map((f) => ({ table: t.name, fk: f.name, columns: f.columns })));
}

export function tableOf(dict: DictionaryModel, name: string): TableDef | undefined {
  return dict.tables.find((t) => t.name === name);
}
