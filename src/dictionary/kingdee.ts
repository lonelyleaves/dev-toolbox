/**
 * 金蝶云星空（K3Cloud）元数据解析。
 *
 * 【主路径：官方 QueryBusinessInfo 报文】（已按真实返回校准，2026-10）
 *   { Result: { ResponseStatus:{...}, NeedReturnData: {
 *       Id: "SAL_SaleOrder",                          // 表单标识
 *       Name: [{Key:2052, Value:"销售订单"}],          // 多语言名（数组！）
 *       PkFieldName: "FID",
 *       Entrys: [ { Key:"FBillHead", TableName:"T_SAL_ORDER", EntryPkFieldName:"FID",
 *                   Name:[{Key:2052,Value:"基本信息"}],
 *                   Fields:[ { Key:"FBillNo", FieldName:"FBILLNO", Name:[{Key:2052,Value:"单据编号"}],
 *                             FieldType:231, Editlen:30, MustInput:0, DefValue:"",
 *                             IsViewVisible:true, Extends:[{Value:"Z",Caption:"暂存"}] } ] } ] } } }
 *   一个表单含多个实体（Entrys），每个实体对应**一张物理表**（TableName），
 *   所以「单据 → 表」是按实体拆分的，不是一表单一表。
 *
 * 【FieldType 是 SQL Server 的 system_type_id】（按 Editlen/字段语义/频次交叉验证）
 *   56=int 61=datetime 99=ntext 106=decimal 127=bigint 167=varchar 175=char 231=nvarchar
 *
 * 【兜底路径】其他版本/导出物的字段名不统一，仍走候选名通用遍历。
 */
import { XMLParser } from 'fast-xml-parser';
import { DictionaryModel, TableDef, ColumnDef, emptyDictionary } from './model';

const NAME_KEYS = ['FieldName', 'fieldName', 'Key', 'key', 'PropertyName', 'propertyName', 'Name', 'name', '字段名', '标识'];
// 注意：部分元数据里字段是 { Key: 'FMATERIALID', Name: '物料内码' }，
// 即"名称/Name"也可能承载中文标题，因此标题候选里必须包含 Name，但要排除与标识同值的情况
const CAPTION_KEYS = ['Caption', 'caption', 'DisplayName', 'displayName', 'Label', 'label', 'Title', 'title', 'Name', 'name', '中文名', '标题', '名称'];
const TYPE_KEYS = ['FieldType', 'fieldType', 'DataType', 'dataType', 'Type', 'type', '类型'];
const TABLE_KEYS = ['TableName', 'tableName', 'FTableName', 'EntityKey', 'entityKey', 'Key', 'key'];
const FORM_KEYS = ['FormId', 'formId', 'FormID', 'Id', 'id', 'Number', 'number'];

/** FieldType → 物理类型（SQL Server system_type_id） */
const FIELD_TYPE_MAP: Record<number, string> = {
  34: 'image', 35: 'text', 36: 'uniqueidentifier', 40: 'date', 41: 'time', 42: 'datetime2',
  48: 'tinyint', 52: 'smallint', 56: 'int', 58: 'smalldatetime', 59: 'real', 60: 'money',
  61: 'datetime', 62: 'float', 98: 'sql_variant', 99: 'ntext', 104: 'bit', 106: 'decimal',
  108: 'numeric', 122: 'smallmoney', 127: 'bigint', 165: 'varbinary', 167: 'varchar',
  173: 'binary', 175: 'char', 189: 'timestamp', 231: 'nvarchar', 239: 'nchar', 241: 'xml',
};
/** 需要带长度的定长/变长字符类型 */
const LEN_TYPES = new Set(['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary']);

interface RawField {
  name: string;
  caption?: string;   // 干净的中文标题（显示名），不含枚举/隐藏标记
  comment?: string;   // 列注释：标题 + 枚举 + 隐藏标记
  type?: string; mustInput?: boolean;
  length?: string; defaultValue?: string; pk?: boolean; enumText?: string;
  /** 字段自带的物理表名（主表 / 拆分表 _F / 多语言表 _L） */
  tableName?: string;
  mulLanguage?: boolean;  // 多语言字段：物理上落在 <表>_L
}

function firstOf(obj: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

function isObj(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 取标题：候选名依次取值，且与字段标识同值时跳过（避免把 Key 当标题） */
function firstCaption(obj: any, nameValue?: string): string | undefined {
  for (const k of CAPTION_KEYS) {
    const v = obj?.[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || (nameValue && s === nameValue)) continue;
    return s;
  }
  return undefined;
}

function isTrue(v: any): boolean {
  return String(v) === '1' || String(v).toLowerCase() === 'true';
}

/** 读属性：兼容 JSON 普通键与 XML 解析后的 @_ 前缀 */
function pickAny(obj: any, keys: string[]): any {
  for (const k of keys) {
    const v = obj?.[k] ?? obj?.[`@_${k}`];
    if (v != null && v !== '') return v;
  }
  return undefined;
}

/** 枚举列表的候选键（官方是 Extends，兼容个别版本的其它命名） */
const ENUM_KEYS = ['Extends', 'EnumItems', 'EnumList', 'ValueItems', 'Options'];

/**
 * 字段枚举 → "枚举：Z=暂存,A=创建"。
 * 真实 WebAPI 返回：Extends: [{ Value:"Z", Caption:"暂存", Seq:0, Invalid:false }, …]
 * 兼容 Caption/Name 为多语言数组、Seq 排序、Invalid=true（停用值）、XML 的 @_ 属性。
 */
function enumTextOf(field: any): string | undefined {
  for (const key of ENUM_KEYS) {
    const raw = pickAny(field, [key]);
    const arr = Array.isArray(raw) ? raw : isObj(raw) ? [raw] : null;
    if (!arr || !arr.length) continue;
    const seqOf = (x: any) => (isObj(x) ? Number(pickAny(x, ['Seq', 'Index'])) || 0 : 0);
    const items = [...arr]
      .sort((a, b) => seqOf(a) - seqOf(b))
      .filter((x) => !isObj(x) || String(pickAny(x, ['Invalid']) ?? '').toLowerCase() !== 'true')
      .map((x) => {
        if (!isObj(x)) return String(x ?? '').trim();
        const value = pickAny(x, ['Value', 'Key']);
        const label = mlText(pickAny(x, ['Caption', 'Name', 'DisplayName'])) ?? '';
        return value != null && String(value).trim() !== '' ? `${String(value).trim()}=${label}` : '';
      })
      .filter(Boolean);
    if (items.length) return `枚举：${items.slice(0, 30).join(',')}${items.length > 30 ? '…' : ''}`;
  }
  return undefined;
}

/** 多语言值：[{Key:2052, Value:"销售订单"}] → "销售订单"（优先 2052 简体中文） */
function mlText(v: any): string | undefined {
  if (Array.isArray(v)) {
    const hit = v.find((x) => isObj(x) && String(x?.Key) === '2052' && x?.Value != null)
      ?? v.find((x) => isObj(x) && x?.Value != null);
    return hit ? String(hit.Value).trim() || undefined : undefined;
  }
  if (isObj(v)) return firstOf(v, ['Value', 'value', 'Caption', 'caption']);
  if (typeof v === 'string') return v.trim() || undefined;
  return undefined;
}

/** 多语言字段标记：各版本/导出物的属性名不一致，全部兼容 */
const MUL_LANG_KEYS = ['IsMulLanguage', 'IsMultiLanguage', 'MulLanguage', 'MultiLanguage', 'IsMulLang'];
/** 元数据未给标记时的保守回退：只认金蝶标准多语言字段的逻辑名（Key） */
const MUL_LANG_KEYS_EXACT = /^(FNAME|FDESCRIPTION|FSHORTNAME|FFULLNAME)$/i;

/**
 * 是否多语言字段：优先看元数据标记；没有标记时只认逻辑名（Key）。
 * 注意不能用物理名：财务/银行/组织等实体也有 FDESCRIPTION、FNAME 列（Key 为 FFinanceDesc / FLocName），
 * 那些是普通列，归到 _L 会凭空造出并不存在的表。
 */
function isMulLanguageField(f: any): boolean {
  const flag = pickAny(f, MUL_LANG_KEYS);
  if (flag != null) return isTrue(flag);
  const key = String(pickAny(f, ['Key']) ?? '').trim();
  return MUL_LANG_KEYS_EXACT.test(key);
}

/** 剥掉 WebAPI 常见外层包装：{Result:{...}} / {Result:[...]} */
function unwrap(payload: any): any {
  let cur = payload;
  for (let i = 0; i < 3 && isObj(cur); i++) {
    if (cur.Result !== undefined) { cur = cur.Result; continue; }
    if (cur.Data !== undefined && isObj(cur.Data)) { cur = cur.Data; continue; }
    break;
  }
  return cur;
}

// ---------------------------------------------------------------- 官方报文

/** 找出所有 NeedReturnData 形态的节点（支持一次返回多个表单） */
function findNeedReturnData(payload: any): any[] {
  const found: any[] = [];
  const seen = new Set<any>();
  (function walk(n: any, depth = 0) {
    if (depth > 8 || n == null || seen.has(n)) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    if (!isObj(n)) return;
    seen.add(n);
    if (Array.isArray(n.Entrys) && n.Entrys.some((e: any) => isObj(e) && Array.isArray(e.Fields))) {
      found.push(n);
      return; // 已识别为该表单，不再往里找
    }
    for (const v of Object.values(n)) walk(v, depth + 1);
  })(payload);
  return found;
}

/** .NET 类型串 → SQL 类型（PkFieldType 形如 "System.Int64, mscorlib, Version=..."） */
function dotnetToSql(t: any): string {
  const s = String(t ?? '');
  if (/Int64|UInt64|Long/i.test(s)) return 'bigint';
  if (/Int32|Int16|UInt32|UInt16|Byte|SByte/i.test(s)) return 'int';
  if (/Guid/i.test(s)) return 'uniqueidentifier';
  if (/Decimal|Double|Single|Float/i.test(s)) return 'decimal';
  if (/DateTime/i.test(s)) return 'datetime';
  if (/Boolean/i.test(s)) return 'bit';
  return 'nvarchar';
}

function fieldTypeToSql(fieldType: any, editlen: any): { type: string; length?: string } {
  const code = Number(fieldType);
  const base = Number.isFinite(code) ? FIELD_TYPE_MAP[code] : undefined;
  if (!base) return { type: typeof fieldType === 'string' && fieldType ? String(fieldType) : 'nvarchar' };
  const len = Number(editlen);
  if (LEN_TYPES.has(base) && Number.isFinite(len) && len > 0) return { type: base, length: String(len) };
  return { type: base };
}

/** 字段 → 列：优先 FieldName（物理列名），其次 Key（逻辑名） */
function officialField(f: any, pkKeys: Set<string>): RawField | null {
  if (!isObj(f)) return null;
  const logicalKey = firstOf(f, ['Key', 'key']);
  const physical = firstOf(f, ['FieldName', 'fieldName']);
  const name = physical || logicalKey;
  if (!name) return null;

  const { type, length } = fieldTypeToSql(f.FieldType ?? f.fieldType, f.Editlen ?? f.editlen);
  const caption = mlText(f.Name ?? f.Caption);
  const mustInput = f.MustInput != null ? isTrue(f.MustInput) : undefined;
  const def = f.DefValue != null ? String(f.DefValue).trim() : '';

  // 枚举值：Extends: [{Value:"Z", Caption:"暂存"}, …]
  const enumText = enumTextOf(f);
  const hidden = f.IsViewVisible === false || String(f.IsViewVisible) === 'false';
  // caption 保持干净（显示名）；枚举/隐藏只进 comment
  const comment = [caption, enumText, hidden ? '界面已隐藏' : ''].filter(Boolean).join('；') || undefined;

  const pk = !!(logicalKey && pkKeys.has(logicalKey.toUpperCase()));
  const fieldTable = firstOf(f, ['TableName', 'tableName']);
  return {
    name,
    caption,
    comment,
    type,
    length,
    mustInput,
    defaultValue: def || undefined,
    pk,
    enumText,
    tableName: fieldTable || undefined,
    mulLanguage: (!!fieldTable && /_L$/i.test(fieldTable)) || isMulLanguageField(f) || undefined,
  };
}

/**
 * 一个实体 → 主表 + 字段自带的拆分表（_F 等）/ 多语言表（_L）。
 * 金蝶元数据每个字段都有 TableName：主表字段、拆分表字段、多语言字段混在同一个实体的 Fields 里，
 * 必须按字段的 TableName 分组；否则会把 _F / _L 的列塞进主表（比对时出现实际不存在的列）。
 */
function officialEntryToTable(entry: any, formName: string): TableDef[] {
  if (!isObj(entry)) return [];
  const fields = Array.isArray(entry.Fields) ? entry.Fields : [];
  if (!fields.length) return [];

  const pkKeys = new Set<string>();
  for (const k of [entry.EntryPkFieldName, entry.PkFieldName]) {
    if (k) pkKeys.add(String(k).toUpperCase());
  }
  const entryName = mlText(entry.Name) || firstOf(entry, ['Key', 'key']) || '';
  const tableName = firstOf(entry, ['TableName', 'tableName'])
    || `${formName}_${firstOf(entry, ['Key', 'key']) || ''}`;
  const lowMain = tableName.toLowerCase();
  const pkType = dotnetToSql(entry.EntryPkFieldType ?? entry.PkFieldType);
  const baseComment = formName ? `${formName} · ${entryName || '明细'}`.trim() : entryName;

  // 按字段自带的 TableName 分组；只接受主表本身或以“主表名_”开头的拆分表
  const groups = new Map<string, { name: string; cols: ColumnDef[] }>();
  const addTo = (name: string, col: ColumnDef) => {
    const key = name.toLowerCase();
    let g = groups.get(key);
    if (!g) { g = { name, cols: [] }; groups.set(key, g); }
    g.cols.push(col);
  };

  for (const f of fields) {
    const col = officialField(f, pkKeys);
    if (!col) continue;
    const def: ColumnDef = {
      name: col.name,
      code: col.caption,
      type: col.length && col.type ? `${col.type}(${col.length})` : (col.type || 'nvarchar'),
      nullable: col.pk ? false : (col.mustInput === true ? false : col.mustInput === false ? true : undefined),
      defaultValue: col.defaultValue,
      comment: col.comment || col.caption,
      pk: col.pk || undefined,
    };
    let ft = (col.tableName || '').trim();
    const related = !!ft && (ft.toLowerCase() === lowMain || ft.toLowerCase().startsWith(`${lowMain}_`));
    if (!related) ft = tableName;
    // 没有字段级 TableName 时，用多语言标记兜底
    if (ft.toLowerCase() === lowMain && col.mulLanguage && !/_L$/i.test(tableName)) ft = `${tableName}_L`;
    addTo(ft, def);
  }
  if (!groups.size) return [];

  // 真实报文的 Fields 不含主键列本身，主键挂在实体上（EntryPkFieldName）→ 补出来，
  // 否则字典里每张表都没有主键，与真实库比对时会全部不匹配
  const supplementPk = (cols: ColumnDef[]) => {
    const existing = new Set(cols.map((c) => c.name.toUpperCase()));
    for (const pkName of pkKeys) {
      if (!pkName || existing.has(pkName)) continue;
      cols.unshift({ name: pkName, code: '主键内码', type: pkType, nullable: false, pk: true, comment: '主键内码' });
      existing.add(pkName);
    }
  };

  // 主表始终输出（即使字段都在拆分表里，主表也有主键）
  const main = groups.get(lowMain);
  const mainCols = main?.cols || [];
  supplementPk(mainCols);
  const out: TableDef[] = [{
    name: tableName,
    code: entryName || undefined,
    comment: baseComment,
    columns: mainCols,
    indexes: [],
    foreignKeys: [],
  }];

  for (const [key, g] of groups) {
    if (key === lowMain) continue;
    if (key.endsWith('_l')) {
      // 多语言表：真实主键是 FPKID（代理键），业务主键 + FLOCALEID 是普通非空列
      const langCols: ColumnDef[] = [];
      const names = new Set(g.cols.map((c) => c.name.toUpperCase()));
      if (!names.has('FPKID')) langCols.push({ name: 'FPKID', code: '主键内码', type: 'int', nullable: false, pk: true, comment: '主键内码' });
      for (const pkName of pkKeys) {
        if (names.has(pkName)) continue;
        const cap = mainCols.find((c) => c.name.toUpperCase() === pkName)?.code || '主键内码';
        langCols.push({ name: pkName, code: cap, type: pkType, nullable: false, comment: cap });
      }
      if (!names.has('FLOCALEID')) {
        langCols.push({ name: 'FLOCALEID', code: '语言ID', type: 'int', nullable: false, comment: '语言 ID（2052=简体中文）' });
      }
      out.push({
        name: g.name,
        code: entryName ? `${entryName}（多语言）` : undefined,
        comment: baseComment ? `${baseComment}（多语言表）` : '多语言表',
        columns: [...langCols, ...g.cols],
        indexes: [],
        foreignKeys: [],
      });
    } else {
      // 拆分表（_F / _E …）：与主表共享业务主键
      supplementPk(g.cols);
      const suffix = g.name.slice(tableName.length) || '';
      out.push({
        name: g.name,
        code: entryName ? `${entryName}（拆分表${suffix}）` : undefined,
        comment: baseComment ? `${baseComment}（拆分表${suffix}）` : `拆分表${suffix}`,
        columns: g.cols,
        indexes: [],
        foreignKeys: [],
      });
    }
  }
  return out;
}

/** 官方报文 → 字典（一个表单拆成多张实体表；多语言字段归入 _L 表） */
function parseOfficial(nodes: any[]): DictionaryModel | null {
  const map = new Map<string, TableDef>();
  const addTable = (t: TableDef) => {
    const key = t.name.toLowerCase();
    const prev = map.get(key);
    if (!prev) { map.set(key, t); return; }
    // 同一张 _L 表可能来自多个实体，合并列而不重复
    const names = new Set(prev.columns.map((c) => c.name.toLowerCase()));
    for (const c of t.columns) {
      if (names.has(c.name.toLowerCase())) continue;
      prev.columns.push(c);
      names.add(c.name.toLowerCase());
    }
    prev.comment = prev.comment || t.comment;
    prev.code = prev.code || t.code;
  };

  for (const nd of nodes) {
    const formId = firstOf(nd, ['Id', 'FormId', 'formId']) || '';
    const formName = mlText(nd.Name) || formId;
    const headPk = firstOf(nd, ['PkFieldName']);
    for (const entry of nd.Entrys || []) {
      // 主实体的主键：实体自带 EntryPkFieldName，缺失时用表单级 PkFieldName 兜底
      const enriched = (entry.EntryPkFieldName || headPk) ? entry : { ...entry, EntryPkFieldName: headPk };
      for (const t of officialEntryToTable(enriched, formName)) addTable(t);
    }
  }
  const tables = [...map.values()];
  if (!tables.length) return null;
  const d = emptyDictionary(tables[0]?.comment || '金蝶元数据', 'mssql');
  d.tables = tables;
  d.meta = { source: 'kingdee' };
  return d;
}

// ---------------------------------------------------------------- 通用兜底

/** 从任意 JSON 结构里搜集"字段"对象：有标识名 +（标题或类型） */
function collectFields(node: any, out: RawField[], depth = 0) {
  if (depth > 12 || node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) collectFields(x, out, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  const name = firstOf(node, NAME_KEYS);
  const caption = firstCaption(node, name);
  const type = firstOf(node, TYPE_KEYS);
  if (name && (caption || type) && !/^(ResponseStatus|IsSuccess|Errors|SuccessEntitys)$/i.test(name)) {
    const enumText = enumTextOf(node);
    const hidden = node?.IsViewVisible === false || String(node?.IsViewVisible) === 'false';
    // caption 保持干净；枚举/隐藏只进 comment
    const comment = [caption, enumText, hidden ? '界面已隐藏' : ''].filter(Boolean).join('；') || undefined;
    out.push({ name, caption, comment, type: type || 'varchar', mustInput: node?.MustInput != null ? isTrue(node.MustInput) : undefined, enumText });
  }
  for (const v of Object.values(node)) collectFields(v, out, depth + 1);
}

/** 从任意 JSON 结构里找出"表单/实体"节点：有表单标识 + 内含字段 */
function collectForms(node: any, out: { formId: string; caption?: string; tableName?: string; fields: RawField[] }[], depth = 0) {
  if (depth > 10 || node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) collectForms(x, out, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  const formId = firstOf(node, FORM_KEYS);
  const caption = firstOf(node, CAPTION_KEYS);
  const fields: RawField[] = [];
  // 只看本节点子树里前 3 层，避免把嵌套子实体的字段全算到主表
  for (const v of Object.values(node)) collectFields(v, fields, 8);
  if (formId && fields.length > 0) {
    out.push({ formId, caption, tableName: firstOf(node, TABLE_KEYS), fields: dedupe(fields) });
  }
  for (const v of Object.values(node)) collectForms(v, out, depth + 1);
}

function dedupe(fields: RawField[]) {
  const seen = new Map<string, RawField>();
  for (const f of fields) {
    const k = f.name.toLowerCase();
    const prev = seen.get(k);
    if (!prev || (!prev.comment && f.comment) || (!prev.caption && f.caption)) seen.set(k, f);
  }
  return [...seen.values()];
}

function toDict(forms: { formId: string; caption?: string; tableName?: string; fields: RawField[] }[], name: string): DictionaryModel {
  const d = emptyDictionary(name, 'generic');
  for (const f of forms) {
    d.tables.push({
      name: f.tableName || f.formId,
      // 金蝶元数据里的 Caption/表单名即中文业务含义 → 作为表注释
      comment: f.caption,
      columns: f.fields.map((x) => ({
        name: x.name,
        code: x.caption,
        type: x.type || 'varchar',
        comment: x.comment || x.caption,
        nullable: x.mustInput === true ? false : x.mustInput === false ? true : undefined,
        pk: x.pk || undefined,
      })),
      indexes: [], foreignKeys: [],
    });
  }
  if (d.tables.length === 0) {
    d.importErrors.push({ source: 'kingdee', message: '未在内容中识别到表单/字段结构，请确认是金蝶元数据或 WebAPI 报文' });
  }
  return d;
}

/** XML：把节点摊平成 key-value 后复用同一套候选名取值 */
function xmlToForms(xml: string): { formId: string; caption?: string; tableName?: string; fields: RawField[] }[] {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_',
    parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: false,
  });
  const root = parser.parse(xml);
  const out: { formId: string; caption?: string; tableName?: string; fields: RawField[] }[] = [];
  const strip = (s: string) => s.replace(/^[^:]+:/, '');

  type Ctx = { formId?: string; caption?: string; tableName?: string; fields: RawField[] };

  // 注意：必须看"节点自身"的属性（金蝶 XML 把信息放在属性上），只遍历子元素会漏掉全部字段
  function walk(n: any, ctx: Ctx, tag = '') {
    if (Array.isArray(n)) { for (const x of n) walk(x, ctx, tag); return; }
    if (!isObj(n)) return;
    let local: Ctx = { ...ctx, fields: ctx.fields };
    let started = false;

    if (/^(Form|BillForm|Metadata|Entity)$/i.test(tag)) {
      started = true;
      local = {
        formId: firstOf(n, FORM_KEYS) || firstOf(n, ['@_FormId', '@_Id', '@_ID']) || ctx.formId,
        caption: firstOf(n, CAPTION_KEYS) || firstOf(n, ['@_Caption', '@_Name']),
        tableName: firstOf(n, TABLE_KEYS) || firstOf(n, ['@_TableName']),
        fields: [],
      };
    } else if (/^(Field|FieldMetadata|Item|Property)$/i.test(tag)) {
      const nm = firstOf(n, NAME_KEYS) || firstOf(n, ['@_FieldName', '@_Key', '@_Name']);
      const cap = firstOf(n, CAPTION_KEYS) || firstOf(n, ['@_Caption', '@_DisplayName']);
      const tp = firstOf(n, TYPE_KEYS) || firstOf(n, ['@_FieldType', '@_Type']);
      if (nm && (cap || tp)) {
        const enumText = enumTextOf(n);
        const hidden = String(pickAny(n, ['IsViewVisible']) ?? '').toLowerCase() === 'false';
        const comment = [cap, enumText, hidden ? '界面已隐藏' : ''].filter(Boolean).join('；') || undefined;
        local.fields.push({ name: nm, caption: cap, comment, type: tp || 'varchar', enumText });
      }
    }

    for (const [k, v] of Object.entries(n)) walk(v, local, strip(k));

    if (started && local.fields.length > 0 && local.formId) {
      out.push({ formId: local.formId, caption: local.caption, tableName: local.tableName, fields: dedupe(local.fields) });
    }
  }
  walk(root, { fields: [] });
  return out;
}

/** 识别金蝶服务端错误报文（ShowErrMsg / ResponseStatus.IsSuccess=false），把服务端原文当作导入错误透出 */
function detectServerError(payload: any): string | undefined {
  if (!isObj(payload)) return undefined;
  // { actionname: 'ShowErrMsg', params: [{ errorTitle, errorInfo }] }
  if (String(payload.actionname || '').toLowerCase() === 'showerrmsg' || Array.isArray(payload.params)) {
    const p0 = Array.isArray(payload.params) ? payload.params[0] : undefined;
    const title = p0?.errorTitle ? String(p0.errorTitle) : '';
    const info = p0?.errorInfo ? String(p0.errorInfo).replace(/\s+/g, ' ').slice(0, 300) : '';
    if (title || info) return [title, info].filter(Boolean).join('：');
  }
  // { Result: { ResponseStatus: { IsSuccess:false, Errors:[{Message,FieldName}] } } } 或顶层 ResponseStatus
  const rs = isObj(payload?.Result) ? payload.Result.ResponseStatus : payload?.ResponseStatus;
  if (isObj(rs) && rs.IsSuccess !== undefined && !(rs.IsSuccess === true || String(rs.IsSuccess).toLowerCase() === 'true')) {
    const errs = Array.isArray(rs.Errors) ? rs.Errors : [];
    const msgs = errs.map((e: any) => [e?.Message, e?.FieldName].filter(Boolean).join(' ')).filter(Boolean);
    return `金蝶返回错误${rs.ErrorCode ? `（${rs.ErrorCode}）` : ''}：${msgs.join('；') || '未知错误'}`;
  }
  return undefined;
}

/**
 * 解析金蝶元数据 / WebAPI 报文。
 * 入参可以是：官方 QueryBusinessInfo 报文、其他版本元数据 JSON、元数据 XML。
 */
export function parseKingdeeMetadata(text: string, name = '金蝶元数据'): DictionaryModel {
  const raw = (text || '').trim();
  if (!raw) {
    const d = emptyDictionary(name, 'generic');
    d.importErrors.push({ source: 'kingdee', message: '内容为空' });
    return d;
  }
  try {
    if (raw.startsWith('{') || raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      // 先识别服务端错误报文：直接把原文当作导入错误返回，而不是笼统说“未识别到结构”
      const serverErr = detectServerError(parsed);
      if (serverErr) {
        const de = emptyDictionary(name, 'generic');
        de.importErrors.push({ source: 'kingdee', message: serverErr });
        return de;
      }
      const payload = unwrap(parsed);
      // 主路径：官方 NeedReturnData（含 Entrys/TableName/FieldName/FieldType）
      const official = findNeedReturnData(payload);
      if (official.length) {
        const d = parseOfficial(official);
        if (d && d.tables.length) { d.name = name; return d; }
      }
      const forms: { formId: string; caption?: string; tableName?: string; fields: RawField[] }[] = [];
      collectForms(payload, forms);
      return toDict(forms, name);
    }
    if (raw.startsWith('<')) {
      return toDict(xmlToForms(raw), name);
    }
  } catch (e: any) {
    const d = emptyDictionary(name, 'generic');
    d.importErrors.push({ source: 'kingdee', message: `解析失败：${e?.message || e}` });
    return d;
  }
  const d = emptyDictionary(name, 'generic');
  d.importErrors.push({ source: 'kingdee', message: '内容既不是 JSON 也不是 XML' });
  return d;
}

/** 语义化别名：粘贴 WebAPI 返回报文时用这个入口 */
export const parseKingdeeApiResponse = parseKingdeeMetadata;
