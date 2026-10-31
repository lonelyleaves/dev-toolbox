/**
 * 数据字典统一中间模型。
 * 所有导入源（PDM/DDL/Markdown/Excel/在线库）解析为 DictionaryModel；
 * 所有导出目标、diff 引擎、规范检查只依赖该模型 —— 导入源/导出目标/修复方向可自由组合。
 * 本文件必须保持纯 TS（不依赖 vscode / node），供 webview 与 host 共用。
 */

export type ChangeTag = 'added' | 'modified' | 'deleted' | undefined;

/** 导入来源类型 */
export type SourceKind = 'pdm' | 'ddl' | 'md' | 'excel' | 'db' | 'kingdee' | 'kingdee-html' | 'dtcat';

/** 导入来源（一个项目可有多个来源，合并成一份字典） */
export interface DictSource {
  id: string;                 // 来源唯一 id（kind + 时间戳）
  kind: SourceKind;
  name: string;               // 显示名：文件名 / 库名 / 账套名
  path?: string;              // 文件类来源的完整路径（用于自动重解析）
  conn?: string;              // 非文件类来源的连接标识（库名/账套，不含凭据）
  configId?: string;          // db/kingdee 来源：属于项目里的哪一条连接配置（多配置溯源）
  configName?: string;        // 配置显示名（来源列表展示用）
  importedAt: string;
  parserVersion?: number;
  tableCount: number;
  enabled: boolean;           // 禁用后不参与合并（保留记录）
  priority: number;           // 数字越小优先级越高；冲突时高优先级胜出
}

/** 字段/表的出处：这个字段是从哪个来源进来的 */
export interface Origin {
  sourceId: string;
  kind: SourceKind;
}

export interface ColumnDef {
  name: string;       // 物理名（英文），如 "FKEEPERTYPEID"（全模型统一：name=物理名）
  code?: string;      // 显示名（中文），如 "保管者类型"
  type: string;       // 原始类型串，如 varchar(64)、decimal(10,2)
  length?: string;    // 长度/精度，如 "30"、"19,2"（与 type 分离，便于单独展示）
  pk?: boolean;
  nullable?: boolean;
  defaultValue?: string;
  comment?: string;
  autoIncrement?: boolean;
  /** 解析器推测出的字段（如金蝶 HTML 主键未在字段表列出），不参与字段属性比对 */
  guessed?: boolean;
  changeTag?: ChangeTag;
  origin?: Origin;          // 该字段来自哪个来源（多来源合并后用于溯源）
}

export interface IndexDef {
  name: string;
  unique: boolean;
  /** 导出源是否提供了唯一性信息（金蝶 HTML 只有 CLUSTERED/NONCLUSTERED，不提供 UNIQUE） */
  uniqueKnown?: boolean;
  columns: string[];
  changeTag?: ChangeTag;
}

export interface FkDef {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  changeTag?: ChangeTag;
}

export interface TableDef {
  name: string;       // 物理表名，如 "T_BD_Supplier_L"
  code?: string;      // 显示名/中文名，如 "供应商多语言"
  comment?: string;   // 表注释
  creator?: string;   // 创建者
  modifier?: string;  // 修改者
  columns: ColumnDef[];
  indexes: IndexDef[];
  foreignKeys: FkDef[];
  changeTag?: ChangeTag;
  origin?: Origin;          // 该表来自哪个来源
}

/** 视图定义 */
export interface ViewDef {
  name: string;
  code?: string;
  comment?: string;
  definition?: string;  // SELECT 语句
  columns: ColumnDef[];
}

/** 存储过程/函数定义 */
export interface ProcedureDef {
  name: string;
  code?: string;
  comment?: string;
  returnType?: string;  // 函数返回类型，存储过程为空
  parameters: { name: string; type: string; direction: 'IN' | 'OUT' | 'INOUT'; defaultValue?: string }[];
  body?: string;
}

/** 序列定义（PDM o:Sequence / 各库 SEQUENCE） */
export interface SequenceDef {
  name: string;
  code?: string;
  comment?: string;
  start?: string;
  increment?: string;
  min?: string;
  max?: string;
  current?: string;
  cache?: string;
  cycle?: boolean;
}

/** 域定义（可复用类型） */
export interface DomainDef {
  name: string;
  code?: string;
  dataType: string;
  length?: string;
  precision?: string;
  scale?: string;
  nullable?: boolean;
  defaultValue?: string;
  comment?: string;
  checkConstraint?: string;
}

export interface DictionaryModel {
  version: 1;
  name: string;
  dialect: 'mysql' | 'postgres' | 'mssql' | 'oracle' | 'generic';
  tables: TableDef[];
  views?: ViewDef[];          // 视图
  procedures?: ProcedureDef[]; // 存储过程/函数
  sequences?: SequenceDef[];   // 序列
  domains?: DomainDef[];       // 域定义
  /** 导入报告：解析失败的条目说明 */
  importErrors: { source: string; message: string }[];
  /** 来源清单：字典可由多个来源合并而来，每个来源可单独刷新/禁用/移除 */
  sources?: DictSource[];
  meta?: { source?: string; sourcePath?: string; importedAt?: string; creator?: string; parser?: number };
  /** 字典结构版本（来源清单/溯源字段引入后为 2） */
  schemaVersion?: number;
}

/**
 * 解析器语义版本。**改动解析结果的含义时必须 +1**（例如把列的 name/code 语义对调、
 * 显示名清洗规则变化），否则用户升级后会被 workspaceState 里的旧解析结果"复活"，
 * 看到的是旧数据却以为是新版本没生效。
 */
export const PARSER_VERSION = 2;

/**
 * 字典结构版本（区别于 PARSER_VERSION）：本轮引入 sources 来源清单与字段级 origin 溯源。
 * 老字典没有这两个字段，靠 migrateDict() 补齐，不做作废处理。
 */
export const DICT_SCHEMA_VERSION = 2;

/** 结构迁移：补全新增字段，保证老字典/老项目文件能直接加载 */
export function migrateDict(d: DictionaryModel): DictionaryModel {
  // 只有当结构版本已是最新、且确实有来源清单时才跳过
  if (d.schemaVersion === DICT_SCHEMA_VERSION && (d.sources?.length ?? 0) > 0) return d;
  const legacySourceId = d.meta?.source ? `legacy:${d.meta.source}` : 'legacy';
  const legacyKind: SourceKind = (d.meta?.source || '').toLowerCase().endsWith('.pdm') ? 'pdm' : 'dtcat';
  d.schemaVersion = DICT_SCHEMA_VERSION;
  if (!d.sources || d.sources.length === 0) {
    d.sources = [{
      id: legacySourceId,
      kind: legacyKind,
      name: d.meta?.source || d.name || '旧版字典',
      path: d.meta?.sourcePath,
      importedAt: d.meta?.importedAt || new Date().toISOString(),
      parserVersion: d.meta?.parser,
      tableCount: d.tables.length,
      enabled: true,
      priority: 10,
    }];
  }
  const sid = d.sources[0]?.id;
  const kind0 = d.sources[0]?.kind ?? legacyKind;
  for (const t of d.tables) {
    if (!t.origin && sid) t.origin = { sourceId: sid, kind: kind0 };
    for (const c of t.columns) if (!c.origin && sid) c.origin = { sourceId: sid, kind: kind0 };
  }
  return d;
}

/** 建来源 id：kind + 时间戳，保证同一项目内不重复 */
export function makeSourceId(kind: SourceKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyDictionary(name: string, dialect: DictionaryModel['dialect'] = 'generic'): DictionaryModel {
  return { version: 1, name, dialect, tables: [], importErrors: [], sources: [], schemaVersion: DICT_SCHEMA_VERSION };
}

export function findTable(dict: DictionaryModel, name: string): TableDef | undefined {
  const lower = name.toLowerCase();
  return dict.tables.find((t) => t.name.toLowerCase() === lower);
}

export function findColumn(table: TableDef, name: string): ColumnDef | undefined {
  const lower = name.toLowerCase();
  return table.columns.find((c) => c.name.toLowerCase() === lower);
}

/** 主键列（显式 pk 标记，或名为 id 的约定不视为 pk） */
export function pkColumns(table: TableDef): ColumnDef[] {
  return table.columns.filter((c) => c.pk);
}

/** 归一化类型串用于比较：小写、去空格、int 族同义 */
export function normalizeType(type: string): string {
  let t = type.toLowerCase().replace(/\s+/g, '').replace(/unsigned$/, '').replace(/zerofill$/, '');
  const intAlias: Record<string, string> = {
    int4: 'integer', int8: 'bigint', int2: 'smallint',
    'int(11)': 'int', 'int(10)': 'int', numeric: 'decimal',
    bool: 'boolean', character: 'char', 'character varying': 'varchar',
  };
  const m = t.match(/^(int|integer|smallint|bigint|tinyint|mediumint)\(\d+\)$/);
  if (m) t = m[1];
  const out = intAlias[t] ?? t;
  // char/nchar/binary 省略长度等价于长度 1（SQL Server 默认），避免 char vs char(1) 假差异
  return /^(char|nchar|binary)$/.test(out) ? `${out}(1)` : out;
}

/** 类型是否兼容（宽松比较：varchar(64) vs varchar(128) 视为变更但同族） */
export function typeFamily(type: string): string {
  const t = normalizeType(type);
  const m = t.match(/^([a-z_]+)/);
  return m ? m[1] : t;
}
