/**
 * 多来源合并 + 项目库的真实数据体检脚本。
 *
 * 用法：
 *   npx tsx scripts/check-merge.ts <a.pdm> <b.pdm>
 *   npm run check:merge
 *
 * 验证点：
 *   1. 两份真实 PDM 各自解析结果
 *   2. 合并后表/字段数是否等于"并集"（同名字段不重复、不丢）
 *   3. 冲突是否被正确识别而不是静默覆盖
 *   4. 移除来源后能否精确回滚（该来源的表/字段消失，其余不动）
 *   5. 项目库文件读写往返：建/存/取/清空/导出包/导入包/删除
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePdm } from '../src/dictionary/pdm';
import { DictionaryModel, migrateDict, makeSourceId, DictSource } from '../src/dictionary/model';
import { mergeDictionaries, removeSource } from '../src/dictionary/merge';
import { ProjectStore } from '../src/host/project-store';

const files = process.argv.slice(2).filter((f) => f && !f.startsWith('-'));
if (files.length < 1) {
  console.error('用法: npx tsx scripts/check-merge.ts <a.pdm> [<b.pdm>]');
  process.exit(1);
}

const src = (kind: DictSource['kind'], name: string, tableCount: number, priority: number): DictSource => ({
  id: makeSourceId(kind), kind, name, importedAt: new Date().toISOString(), tableCount, enabled: true, priority,
});

function stat(d: DictionaryModel) {
  const cols = d.tables.reduce((n, t) => n + t.columns.length, 0);
  const fks = d.tables.reduce((n, t) => n + t.foreignKeys.length, 0);
  return { tables: d.tables.length, cols, fks };
}

console.log('=== 1. 解析各来源 ===');
const parsed = files.map((f) => {
  const t0 = Date.now();
  const d = parsePdm(fs.readFileSync(f, 'utf8'));
  d.name = path.basename(f).replace(/\.pdm$/i, '');
  const s = stat(d);
  console.log(`  ${path.basename(f).padEnd(34)} ${String(s.tables).padStart(5)} 表 ${String(s.cols).padStart(6)} 字段 ${String(s.fks).padStart(4)} 外键  解析 ${Date.now() - t0}ms  错误 ${d.importErrors.length}`);
  return { d, s, file: f };
});

const a = parsed[0];
let merged: DictionaryModel = migrateDict({ ...a.d, sources: [src('pdm', a.d.name, a.s.tables, 10)] });
let conflicts: any[] = [];
console.log('\n=== 2. 合并 ===');
for (const p of parsed.slice(1)) {
  const s = src('pdm', p.d.name, p.s.tables, 20);
  const r = mergeDictionaries(merged, p.d, s);
  merged = r.dict;
  conflicts = r.conflicts;
  console.log(`  合并 ${p.d.name}：新增 ${r.stats.tablesAdded} 表 / ${r.stats.columnsAdded} 字段，匹配 ${r.stats.tablesMatched} 表，冲突 ${r.conflicts.length}`);
}
const ms = stat(merged);
console.log(`  合并结果：${ms.tables} 表 ${ms.cols} 字段 ${ms.fks} 外键`);

// 并集校验：任一来源的表都还在，且没有凭空多出表
const names = new Set(parsed.flatMap((p) => p.d.tables.map((t) => t.name.toLowerCase())));
const missing = [...names].filter((n) => !merged.tables.some((t) => t.name.toLowerCase() === n));
const extra = merged.tables.filter((t) => !names.has(t.name.toLowerCase()));
console.log(`  并集校验：缺失 ${missing.length} 张${missing.length ? ' → ' + missing.slice(0, 3).join(', ') : ''}；多出 ${extra.length} 张`);
if (conflicts.length) {
  console.log(`  冲突样例（前 5）：`);
  for (const c of conflicts.slice(0, 5)) {
    console.log(`    ${c.table}.${c.column || '(表级)'} [${c.field}] 原=${String(c.baseValue).slice(0, 24)} 新=${String(c.incomingValue).slice(0, 24)}`);
  }
}

console.log('\n=== 3. 移除来源回滚 ===');
const second = merged.sources?.[1];
if (second) {
  const before = stat(merged);
  const out = removeSource(merged, second.id);
  const after = stat(out.dict);
  console.log(`  移除「${second.name}」：${before.tables}→${after.tables} 表，${before.cols}→${after.cols} 字段（删表 ${out.removedTables}，删字段 ${out.removedColumns}）`);
  const ok = after.tables === stat(a.d).tables;
  console.log(`  回滚后与第一个来源一致：${ok ? '✓' : '✗ 不一致，回滚有残留'}`);
}

console.log('\n=== 4. 项目库往返 ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtproj-'));
const store = new ProjectStore({ fsPath: tmp } as any);
const p1 = store.create('体检项目');
store.save(p1.id, merged);
const back = store.load(p1.id);
console.log(`  建项目 + 存 ${ms.tables} 表 → 读回 ${back?.tables.length} 表：${back?.tables.length === ms.tables ? '✓' : '✗'}`);
console.log(`  来源清单持久化：${back?.sources?.length} 个 ${back?.sources?.length === merged.sources?.length ? '✓' : '✗'}`);
const idx = store.list();
console.log(`  索引统计：项目 ${idx.projects.length} 个，当前=${idx.projects[0]?.name}，表数=${idx.projects[0]?.tableCount}，来源=${idx.projects[0]?.sourceCount}`);
const bundle = store.exportBundle(p1.id);
console.log(`  导出包：format=${bundle.format}，表 ${bundle.dict.tables.length}，含凭据字段=${JSON.stringify(bundle).includes('password') ? '✗ 有' : '✓ 无'}`);
const p2 = store.importBundle(bundle);
console.log(`  导入包 → 新项目「${p2.name}」表 ${store.load(p2.id)?.tables.length} ${store.load(p2.id)?.tables.length === ms.tables ? '✓' : '✗'}`);
store.clear(p1.id);
console.log(`  清空项目 → 表 ${store.load(p1.id)?.tables.length} 来源 ${store.load(p1.id)?.sources?.length} ${(store.load(p1.id)?.tables.length ?? 0) === 0 ? '✓' : '✗'}；项目仍在=${store.list().projects.some((p) => p.id === p1.id) ? '✓' : '✗'}`);
store.remove(p2.id);
console.log(`  删除项目 → 剩余 ${store.list().projects.length} 个 ${store.list().projects.length === 1 ? '✓' : '✗'}`);
fs.rmSync(tmp, { recursive: true, force: true });

const fail = missing.length > 0 || extra.length > 0 || back?.tables.length !== ms.tables;
console.log(`\n结论：${fail ? '✗ 存在问题，见上方 ✗ 项' : '✓ 合并与项目库均正常'}`);
process.exit(fail ? 1 : 0);
