/**
 * 多来源合并引擎（纯函数，不依赖 vscode/node，便于单测）。
 *
 * 设计要点：
 * - 表/字段按"归一化名"匹配：金蝶 PDM 常用 T_BD_STAFF，库里可能是 t_bd_staff，
 *   不归一化的话同一张表会被当成两张，合并结果直接翻倍。
 * - 冲突不自动覆盖：只记录冲突，由 UI 展示后用户逐条或批量选择（base 保留 / incoming 采用）。
 * - 每个表、每个字段都带 origin，可溯源到具体来源，支持"移除某个来源"时精确回滚。
 */
import {
  DictionaryModel, TableDef, ColumnDef, DictSource, Origin, normalizeType,
} from './model';

/** 表名/字段名归一化：去空白、去引号、转小写（大小写不敏感匹配） */
export function normalizeName(name: string): string {
  return (name || '').trim().toLowerCase().replace(/^["'`[][\s\S]*["'`\]]$/, (m) => m.slice(1, -1)).replace(/^["'`[]+|["'`\]]+$/g, '');
}

export type ConflictField = 'tableComment' | 'comment' | 'type' | 'nullable' | 'pk' | 'default';

export interface MergeConflict {
  /** 稳定 key，用于 UI 勾选与 applyResolutions 定位 */
  id: string;
  table: string;
  column?: string;
  field: ConflictField;
  baseValue?: string | null;
  incomingValue?: string | null;
  baseSourceName?: string;
  incomingSourceName: string;
}

export interface MergeStats {
  tablesAdded: number;
  columnsAdded: number;
  tablesMatched: number;
  conflicts: number;
}

export interface MergeResult {
  dict: DictionaryModel;
  conflicts: MergeConflict[];
  stats: MergeStats;
}

export interface MergeOptions {
  /** 是否允许用来源的注释覆盖已有注释（默认否：已有值优先，冲突交给用户决定） */
  overwriteComment?: boolean;
}

function cloneColumn(c: ColumnDef, origin?: Origin): ColumnDef {
  return { ...c, origin: origin || c.origin };
}

function cloneTable(t: TableDef, origin?: Origin): TableDef {
  return {
    ...t,
    columns: t.columns.map((c) => cloneColumn(c, origin)),
    indexes: t.indexes.map((i) => ({ ...i })),
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, columns: [...f.columns], refColumns: [...f.refColumns] })),
    origin: origin || t.origin,
  };
}

function pushConflict(
  out: MergeConflict[],
  table: string,
  column: string | undefined,
  field: ConflictField,
  baseValue: string | null | undefined,
  incomingValue: string | null | undefined,
  incomingSourceName: string,
  baseSourceName?: string,
) {
  out.push({
    id: `${table}|${column ?? ''}|${field}`,
    table,
    column,
    field,
    baseValue: baseValue ?? null,
    incomingValue: incomingValue ?? null,
    baseSourceName,
    incomingSourceName,
  });
}

/**
 * 把 incoming 合并进 base。base 不会被修改（返回新对象）。
 * 冲突默认保留 base 的值，仅在 conflicts 里回报差异。
 */
export function mergeDictionaries(
  base: DictionaryModel,
  incoming: DictionaryModel,
  source: DictSource,
  opts: MergeOptions = {},
): MergeResult {
  const conflicts: MergeConflict[] = [];
  const stats: MergeStats = { tablesAdded: 0, columnsAdded: 0, tablesMatched: 0, conflicts: 0 };
  const origin: Origin = { sourceId: source.id, kind: source.kind };

  const tables: TableDef[] = base.tables.map((t) => cloneTable(t));
  const index = new Map<string, TableDef>();
  for (const t of tables) index.set(normalizeName(t.name), t);

  for (const it of incoming.tables) {
    const key = normalizeName(it.name);
    const target = index.get(key);
    if (!target) {
      const nt = cloneTable(it, origin);
      tables.push(nt);
      index.set(key, nt);
      stats.tablesAdded++;
      stats.columnsAdded += it.columns.length; // 整表新增时其字段也计入
      continue;
    }
    stats.tablesMatched++;

    // 表级：注释冲突
    if (it.comment && target.comment && it.comment !== target.comment) {
      pushConflict(conflicts, target.name, undefined, 'tableComment', target.comment, it.comment, source.name, target.origin?.sourceId);
      if (opts.overwriteComment) target.comment = it.comment;
    } else if (it.comment && !target.comment) {
      target.comment = it.comment;
    }

    const colIdx = new Map<string, ColumnDef>();
    for (const c of target.columns) colIdx.set(normalizeName(c.name), c);

    for (const ic of it.columns) {
      const ckey = normalizeName(ic.name);
      const tc = colIdx.get(ckey);
      if (!tc) {
        const nc = cloneColumn(ic, origin);
        target.columns.push(nc);
        colIdx.set(ckey, nc);
        stats.columnsAdded++;
        continue;
      }
      // 字段级冲突：注释 / 类型 / 可空 / 主键 / 默认值
      if (ic.comment && tc.comment && ic.comment !== tc.comment) {
        pushConflict(conflicts, target.name, tc.name, 'comment', tc.comment, ic.comment, source.name, tc.origin?.sourceId);
        if (opts.overwriteComment) tc.comment = ic.comment;
      } else if (ic.comment && !tc.comment) {
        tc.comment = ic.comment;
      }
      if (ic.type && normalizeType(ic.type) !== normalizeType(tc.type)) {
        pushConflict(conflicts, target.name, tc.name, 'type', tc.type, ic.type, source.name, tc.origin?.sourceId);
      }
      if (ic.nullable != null && tc.nullable != null && ic.nullable !== tc.nullable) {
        pushConflict(conflicts, target.name, tc.name, 'nullable', String(tc.nullable), String(ic.nullable), source.name, tc.origin?.sourceId);
      }
      if (ic.pk && !tc.pk) {
        pushConflict(conflicts, target.name, tc.name, 'pk', String(!!tc.pk), String(!!ic.pk), source.name, tc.origin?.sourceId);
      }
      if (ic.defaultValue && tc.defaultValue && ic.defaultValue !== tc.defaultValue) {
        pushConflict(conflicts, target.name, tc.name, 'default', tc.defaultValue, ic.defaultValue, source.name, tc.origin?.sourceId);
      }
    }
  }

  stats.conflicts = conflicts.length;
  const dict: DictionaryModel = {
    ...base,
    tables,
    name: base.name || incoming.name,
    dialect: base.dialect === 'generic' ? incoming.dialect : base.dialect,
    // 视图/序列等按来源追加（同名以先到的为准）
    views: appendNamed(base.views, incoming.views),
    procedures: appendNamed(base.procedures, incoming.procedures),
    sequences: appendNamed(base.sequences, incoming.sequences),
    domains: appendNamed(base.domains, incoming.domains),
    importErrors: [...base.importErrors, ...incoming.importErrors.map((e) => ({ source: `[${source.name}] ${e.source}`, message: e.message }))],
    sources: [...(base.sources || []).filter((s) => s.id !== source.id), { ...source }],
  };
  return { dict, conflicts, stats };
}

function appendNamed<T extends { name: string }>(base: T[] | undefined, inc: T[] | undefined): T[] | undefined {
  if (!inc || inc.length === 0) return base;
  const out = [...(base || [])];
  const seen = new Set(out.map((x) => normalizeName(x.name)));
  for (const x of inc) if (!seen.has(normalizeName(x.name))) out.push(x);
  return out;
}

/**
 * 应用用户的冲突决议：choose='incoming' 表示采用新来源的值，'base' 表示保留原值（即不动）。
 */
export function applyResolutions(
  dict: DictionaryModel,
  conflicts: MergeConflict[],
  resolutions: Record<string, 'base' | 'incoming'>,
): DictionaryModel {
  const tables = dict.tables.map((t) => cloneTable(t));
  for (const c of conflicts) {
    if (resolutions[c.id] !== 'incoming') continue;
    const t = tables.find((x) => normalizeName(x.name) === normalizeName(c.table));
    if (!t) continue;
    if (!c.column) {
      if (c.field === 'tableComment') t.comment = c.incomingValue ?? t.comment;
      continue;
    }
    const col = t.columns.find((x) => normalizeName(x.name) === normalizeName(c.column!));
    if (!col) continue;
    if (c.field === 'comment') col.comment = c.incomingValue ?? col.comment;
    else if (c.field === 'type') col.type = String(c.incomingValue ?? col.type);
    else if (c.field === 'nullable') col.nullable = c.incomingValue === 'true';
    else if (c.field === 'pk') col.pk = c.incomingValue === 'true';
    else if (c.field === 'default') col.defaultValue = c.incomingValue ?? col.defaultValue;
  }
  return { ...dict, tables };
}

/** 批量设置：把未逐条选择的冲突统一按某个方向处理 */
export function defaultResolutions(conflicts: MergeConflict[], fallback: 'base' | 'incoming'): Record<string, 'base' | 'incoming'> {
  const out: Record<string, 'base' | 'incoming'> = {};
  for (const c of conflicts) out[c.id] = fallback;
  return out;
}

/**
 * 移除某个来源的贡献：整表来自该来源则删表，否则只删该来源带来的字段。
 * 用于来源面板的"移除/禁用"操作。
 */
export function removeSource(dict: DictionaryModel, sourceId: string): { dict: DictionaryModel; removedTables: number; removedColumns: number } {
  let removedTables = 0;
  let removedColumns = 0;
  const tables: TableDef[] = [];
  for (const t of dict.tables) {
    if (t.origin?.sourceId === sourceId) { removedTables++; continue; }
    const cols = t.columns.filter((c) => {
      if (c.origin?.sourceId === sourceId) { removedColumns++; return false; }
      return true;
    });
    tables.push({ ...t, columns: cols });
  }
  return {
    dict: {
      ...dict,
      tables,
      sources: (dict.sources || []).filter((s) => s.id !== sourceId),
    },
    removedTables,
    removedColumns,
  };
}

/** 按优先级顺序合并多个来源（数字小的先合并，先到先得） */
export function mergeAll(
  parsed: { source: DictSource; dict: DictionaryModel }[],
  baseName: string,
  opts: MergeOptions = {},
): MergeResult {
  const ordered = [...parsed].sort((a, b) => a.source.priority - b.source.priority);
  let dict: DictionaryModel = {
    version: 1, name: baseName, dialect: 'generic', tables: [], importErrors: [], sources: [], schemaVersion: 2,
  };
  const allConflicts: MergeConflict[] = [];
  const stats: MergeStats = { tablesAdded: 0, columnsAdded: 0, tablesMatched: 0, conflicts: 0 };
  for (const p of ordered) {
    const r = mergeDictionaries(dict, p.dict, p.source, opts);
    dict = r.dict;
    allConflicts.push(...r.conflicts);
    stats.tablesAdded += r.stats.tablesAdded;
    stats.columnsAdded += r.stats.columnsAdded;
    stats.tablesMatched += r.stats.tablesMatched;
  }
  stats.conflicts = allConflicts.length;
  return { dict, conflicts: allConflicts, stats };
}
