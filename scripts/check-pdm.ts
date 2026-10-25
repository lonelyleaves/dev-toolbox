/**
 * 真实 PDM 文件体检脚本（开发工具，不参与打包）。
 *
 * 用法：
 *   npm run check:pdm -- /path/to/xxx.pdm
 *
 * 输出：解析耗时、表/列/主键/索引/外键、视图、序列、存储过程、域、导入错误明细，
 * 并与 XML 里 `o:xxx Id=` 的真实定义节点数对照（用于发现"看起来解析成功但其实丢对象"）。
 * 注意：`grep '<o:Table '` 会把 `<o:Table Ref=>` 占位节点一起算进来，不能当作应有表数。
 */
import * as fs from 'node:fs';
import { parsePdm } from '../src/dictionary/pdm';

const file = process.argv[2];
if (!file) {
  console.error('用法: npm run check:pdm -- <xxx.pdm>');
  process.exit(1);
}

const xml = fs.readFileSync(file, 'utf8');

/** 统计 XML 里某类对象的真实定义节点数（带 Id=）与占位引用节点数（带 Ref=） */
function countNodes(tag: string) {
  const re = new RegExp(`<o:${tag}\\s+Id=`, 'g');
  const reRef = new RegExp(`<o:${tag}\\s+Ref=`, 'g');
  return { def: (xml.match(re) || []).length, ref: (xml.match(reRef) || []).length };
}

const t0 = Date.now();
const d = parsePdm(xml);
const ms = Date.now() - t0;

const sum = (arr: any[], f: (x: any) => number) => arr.reduce((n, x) => n + f(x), 0);
const cols = sum(d.tables, (t) => t.columns.length);
const idx = sum(d.tables, (t) => t.indexes.length);
const fks = sum(d.tables, (t) => t.foreignKeys.length);
const cmt = sum(d.tables, (t) => t.columns.filter((c: any) => c.comment).length);
const pkTables = d.tables.filter((t) => t.columns.some((c) => c.pk)).length;
const viewCols = sum(d.views ?? [], (v) => v.columns.length);
const viewSql = (d.views ?? []).filter((v) => v.definition).length;

const cmp = (label: string, got: number | undefined, tag: string) => {
  const { def, ref } = countNodes(tag);
  const mark = got === def ? '✓' : '✗ 不一致';
  console.log(`${label}: 解析 ${got ?? 0} / 真实定义 ${def}（占位 ${ref}）  ${mark}`);
};

console.log(`文件: ${file}`);
console.log(`大小: ${(xml.length / 1024 / 1024).toFixed(2)} MB   解析耗时: ${ms} ms\n`);
cmp('表    ', d.tables.length, 'Table');
cmp('外键  ', fks, 'Reference');
cmp('视图  ', d.views?.length ?? 0, 'View');
cmp('存储过程', d.procedures?.length ?? 0, 'Procedure');
cmp('序列  ', d.sequences?.length ?? 0, 'Sequence');
cmp('域    ', d.domains?.length ?? 0, 'Domain');
console.log(`\n列 ${cols} | 有主键的表 ${pkTables}/${d.tables.length} | 索引 ${idx}`);
console.log(`列注释 ${cmt}/${cols} (${((cmt / Math.max(cols, 1)) * 100).toFixed(1)}%)`);
console.log(`视图列 ${viewCols} | 有 SQL 的视图 ${viewSql}/${d.views?.length ?? 0}`);

// 抽样三张表，确认显示名已清洗（a:Name 常写成「物理名(中文名)」，不清洗会重复显示两次）
const tablesSample = d.tables.slice(0, 3).map((t) => `${t.name}${t.code ? `/${t.code}` : ''}`);
console.log(`表名抽样: ${tablesSample.join('  ')}`);

// 抽样一列，确认 name=物理名 / code=显示名（中文名跑到 DDL 里是致命问题）
const sample = d.tables.find((t) => t.columns.length > 1);
if (sample) {
  const s = sample.columns.slice(0, 3).map((c) => `${c.name}${c.code && c.code !== c.name ? `/${c.code}` : ''}`).join('  ');
  console.log(`字段抽样（${sample.name}）: ${s}`);
}

const noPk = d.tables.filter((t) => !t.columns.some((c) => c.pk));
if (noPk.length) {
  console.log(`\n无主键表 ${noPk.length} 张（前 15）：${noPk.slice(0, 15).map((t) => t.name).join(', ')}`);
}
console.log(`导入错误 ${d.importErrors.length}`);
for (const e of d.importErrors.slice(0, 15)) console.log(`  [${e.source}] ${e.message}`);
if (d.importErrors.length > 15) console.log(`  …共 ${d.importErrors.length} 条`);
process.exit(0);
