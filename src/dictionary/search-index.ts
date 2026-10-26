import { DictionaryModel } from './model';

/**
 * 字典搜索索引（自研，无第三方依赖）
 *
 * 背景：字典可能上万张表、十几万个字段。原来每次按键都走「表 × 字段」的嵌套扫描
 * （每个字段两次 toLowerCase + includes，外加属性读取），在 11315 表 / 118771 字段
 * 的样本上明显卡顿。
 *
 * 做法：为每张表预先拼好一条小写的扁平文本（表名 + 中文名 + 字段名 + 字段注释），
 * 索引只建一次并按字典对象缓存（dict 引用变了自动重建）。搜索时先对这一条串做
 * 原生 includes 快速排除整表，只有候选表才回扫字段，解释执行的工作量大幅下降。
 *
 * 语义保证：命中结果与原 dictSearch 逐条一致（由 test/search-index.test.ts 断言）。
 */

export interface SearchHit {
  table: string;
  column?: string;
  field: string;
  text: string;
}

interface ColEntry {
  name: string;
  nameLower: string;
  comment: string;
}

interface Entry {
  name: string;
  nameLower: string;
  comment: string;
  cols: ColEntry[];
  /** 扁平化后的可搜索文本（已小写），用于整表快筛 */
  hay: string;
}

/** key = 字典对象引用；WeakMap 保证字典被丢弃时索引可回收 */
const CACHE = new WeakMap<DictionaryModel, Entry[]>();

function build(dict: DictionaryModel): Entry[] {
  const out: Entry[] = [];
  for (const t of dict.tables || []) {
    const cols: ColEntry[] = (t.columns || []).map((c) => ({
      name: c.name || '',
      nameLower: (c.name || '').toLowerCase(),
      comment: c.comment || '',
    }));
    const name = t.name || '';
    const comment = t.comment || '';
    const parts: string[] = [name, t.code || '', comment];
    for (const c of cols) parts.push(c.name, c.comment);
    out.push({
      name,
      nameLower: name.toLowerCase(),
      comment,
      cols,
      hay: parts.join(' ').toLowerCase(),
    });
  }
  return out;
}

function entriesOf(dict: DictionaryModel): Entry[] {
  let e = CACHE.get(dict);
  if (!e) { e = build(dict); CACHE.set(dict, e); }
  return e;
}

/**
 * 关键字搜索。与原 dictSearch 逐条等价，
 * 只是多了「整表快筛」：不含关键字的表直接跳过，不再逐字段扫描。
 */
export function dictSearchFast(
  dict: DictionaryModel,
  keyword: string,
  maxHits = 300,
): SearchHit[] {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return [];

  const hits: SearchHit[] = [];
  for (const e of entriesOf(dict)) {
    if (hits.length >= maxHits) break; // 先查上限，避免单张表把结果撑爆
    if (!e.hay.includes(kw)) continue; // 快筛：整表都不含关键字 → 跳过
    if (e.nameLower.includes(kw)) hits.push({ table: e.name, field: '表名', text: e.name });
    if (e.comment.toLowerCase().includes(kw)) {
      hits.push({ table: e.name, field: '表注释', text: e.comment });
    }
    for (const c of e.cols) {
      if (hits.length >= maxHits) break;
      if (c.nameLower.includes(kw)) {
        hits.push({ table: e.name, column: c.name, field: '字段名', text: c.name });
      } else if (c.comment.toLowerCase().includes(kw)) {
        hits.push({ table: e.name, column: c.name, field: '注释', text: c.comment });
      }
    }
  }
  return hits;
}

/** 命中关键字的表名列表（按原顺序、去重），供左栏虚拟列表使用 */
export function tablesMatching(dict: DictionaryModel, keyword: string): string[] {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const out: string[] = [];
  for (const e of entriesOf(dict)) {
    if (e.hay.includes(kw)) out.push(e.name);
  }
  return out;
}
