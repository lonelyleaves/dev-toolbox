/**
 * 跨系统/跨数据库的类型归一与比较。
 *
 * 各来源的类型写法差异很大：
 *   SQL Server: int / bigint / nvarchar(50) / char(1) / datetime2 / bit
 *   MySQL:      int(11) / varchar(50) / tinyint(1) / datetime
 *   PostgreSQL: integer / bigint / character varying(50) / boolean / timestamp
 *   Oracle:     NUMBER(10) / NUMBER(10,2) / VARCHAR2(50) / DATE / CLOB
 *   PowerDesigner / 金蝶元数据：int、char(1)、nvarchar(80) 等混合写法
 *
 * 直接按字符串比较会产生大量假差异（int vs bigint、varchar vs char(1)、
 * datetime vs datetime2）。这里统一归一到「类型族 + 规范化基类型 + 参数」再比较：
 *   - 同族同参数 → 视为相同
 *   - 未知参数（如金蝶 Editlen 缺失）→ 不据此判差异
 *   - 整型宽度（int ↔ bigint）可选忽略，默认严格
 */
import type { DictionaryModel } from './model';

export type TypeDialect = DictionaryModel['dialect'];

export type TypeFamily =
  | 'integer' | 'decimal' | 'float' | 'string' | 'text' | 'datetime' | 'date' | 'time'
  | 'boolean' | 'binary' | 'uuid' | 'json' | 'xml' | 'other';

export interface CanonicalType {
  family: TypeFamily;
  /** 归一后的基类型：int/bigint/string/text/datetime/... */
  base: string;
  /** 字符/二进制长度；'max' 表示不限长 */
  length?: number | 'max';
  precision?: number;
  scale?: number;
  unsigned?: boolean;
  raw: string;
}

export interface TypeCompareOptions {
  /** 忽略整型宽度差异（int / smallint / bigint 互认） */
  ignoreIntegerWidth?: boolean;
  /** 忽略字符串长度差异 */
  ignoreStringLength?: boolean;
  /** 一边长度未知时视为通配（金蝶元数据 Editlen 可能缺失）；默认 true */
  unknownLengthWildcard?: boolean;
  /** 两边来源方言：用于消除 timestamp / tinyint(1) 的歧义 */
  baseDialect?: TypeDialect;
  targetDialect?: TypeDialect;
}

/** 类型别名表：alias → [族, 规范基类型] */
const ALIAS: Record<string, [TypeFamily, string]> = {
  // ---- 整数 ----
  int: ['integer', 'int'], integer: ['integer', 'int'], int4: ['integer', 'int'],
  int32: ['integer', 'int'], mediumint: ['integer', 'int'], serial: ['integer', 'int'], serial4: ['integer', 'int'],
  bigint: ['integer', 'bigint'], int8: ['integer', 'bigint'], int64: ['integer', 'bigint'],
  bigserial: ['integer', 'bigint'], serial8: ['integer', 'bigint'],
  smallint: ['integer', 'smallint'], int2: ['integer', 'smallint'], int16: ['integer', 'smallint'],
  smallserial: ['integer', 'smallint'], serial2: ['integer', 'smallint'],
  tinyint: ['integer', 'tinyint'], int1: ['integer', 'tinyint'],

  // ---- 定点数 ----
  decimal: ['decimal', 'decimal'], numeric: ['decimal', 'decimal'], dec: ['decimal', 'decimal'],
  money: ['decimal', 'decimal'], smallmoney: ['decimal', 'decimal'],

  // ---- 浮点 ----
  float: ['float', 'float'], double: ['float', 'float'], 'double precision': ['float', 'float'],
  real: ['float', 'float'], binary_float: ['float', 'float'], binary_double: ['float', 'float'],

  // ---- 字符串（char/varchar 统一为 string，长度相同即兼容） ----
  varchar: ['string', 'string'], varchar2: ['string', 'string'], nvarchar: ['string', 'string'],
  nvarchar2: ['string', 'string'], 'character varying': ['string', 'string'], varcharacter: ['string', 'string'],
  char: ['string', 'string'], nchar: ['string', 'string'], character: ['string', 'string'], bpchar: ['string', 'string'],

  // ---- 大文本 ----
  text: ['text', 'text'], ntext: ['text', 'text'], clob: ['text', 'text'], nclob: ['text', 'text'],
  longtext: ['text', 'text'], mediumtext: ['text', 'text'], tinytext: ['text', 'text'],
  'long varchar': ['text', 'text'],

  // ---- 日期时间 ----
  datetime: ['datetime', 'datetime'], datetime2: ['datetime', 'datetime'], smalldatetime: ['datetime', 'datetime'],
  datetimeoffset: ['datetime', 'datetime'], timestamp: ['datetime', 'datetime'],
  'timestamp without time zone': ['datetime', 'datetime'], 'timestamp with time zone': ['datetime', 'datetime'],
  date: ['date', 'date'],
  time: ['time', 'time'], 'time without time zone': ['time', 'time'], 'time with time zone': ['time', 'time'],

  // ---- 布尔 ----
  bit: ['boolean', 'boolean'], boolean: ['boolean', 'boolean'], bool: ['boolean', 'boolean'],

  // ---- 二进制 ----
  binary: ['binary', 'binary'], varbinary: ['binary', 'binary'], image: ['binary', 'binary'],
  blob: ['binary', 'binary'], mediumblob: ['binary', 'binary'], longblob: ['binary', 'binary'],
  tinyblob: ['binary', 'binary'], bytea: ['binary', 'binary'], raw: ['binary', 'binary'],
  'long raw': ['binary', 'binary'],

  // ---- 其它 ----
  uniqueidentifier: ['uuid', 'uuid'], uuid: ['uuid', 'uuid'],
  json: ['json', 'json'], jsonb: ['json', 'json'],
  xml: ['xml', 'xml'],
};

/** 拆分类型串：base + 参数；去掉 []、"、` 与 unsigned/zerofill 修饰 */
function splitType(raw: string): { base: string; params?: string } {
  let s = String(raw || '').trim().toLowerCase().replace(/[\[\]"`]/g, '').replace(/\s+/g, ' ');
  s = s.replace(/\s+(unsigned|zerofill)\b/g, '');
  const m = s.match(/^(.+?)\s*(?:\(([^)]*)\))?$/);
  return { base: (m?.[1] || s).trim(), params: m?.[2]?.trim() };
}

function parseParams(params?: string): (number | 'max')[] {
  if (!params) return [];
  return params.split(',').map((p) => {
    const t = p.trim().toLowerCase();
    if (t === 'max') return 'max' as const;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }).filter((x): x is number | 'max' => x !== undefined);
}

/**
 * 归一化类型。
 * @param raw 原始类型串，如 "nvarchar(50)"、"NUMBER(10,2)"
 * @param dialect 来源方言（影响 timestamp / tinyint(1) 等歧义类型）
 */
export function canonicalType(raw: string, dialect: TypeDialect = 'generic'): CanonicalType {
  const { base: rawBase, params } = splitType(raw);
  const p = parseParams(params);
  const first = p[0];
  const second = p[1];
  const hit = ALIAS[rawBase];

  // Oracle NUMBER：scale=0 且给了精度时按整型处理，便于与 int/bigint 对齐
  if (rawBase === 'number') {
    if (typeof first === 'number' && (second === undefined || second === 0)) {
      const b = first <= 4 ? 'smallint' : first <= 9 ? 'int' : first <= 18 ? 'bigint' : 'decimal';
      if (b !== 'decimal') return { family: 'integer', base: b, precision: first, scale: 0, raw };
    }
    return { family: 'decimal', base: 'decimal', precision: typeof first === 'number' ? first : undefined, scale: typeof second === 'number' ? second : undefined, raw };
  }

  if (!hit) return { family: 'other', base: rawBase || 'unknown', raw };

  let [family, base] = hit;

  // SQL Server 的 timestamp 是 rowversion（二进制），不是时间
  if (rawBase === 'timestamp' && dialect === 'mssql') {
    family = 'binary';
    base = 'binary';
  }
  // MySQL 的 tinyint(1) 习惯表示布尔
  if (rawBase === 'tinyint' && String(first) === '1' && dialect !== 'mssql') {
    return { family: 'boolean', base: 'boolean', raw };
  }

  if (family === 'decimal') {
    if (rawBase === 'money') return { family, base, precision: 19, scale: 4, raw };
    if (rawBase === 'smallmoney') return { family, base, precision: 10, scale: 4, raw };
    return {
      family, base,
      precision: typeof first === 'number' ? first : undefined,
      scale: typeof second === 'number' ? second : undefined,
      raw,
    };
  }

  if (family === 'string') {
    // varchar(max)/nvarchar(max) 实际是大文本
    if (first === 'max') return { family: 'text', base: 'text', raw };
    // char 省略长度默认 1（SQL Server 语义）；varchar 省略长度视为未知
    const isFixed = /^(char|nchar|character|bpchar)$/i.test(rawBase);
    const length = typeof first === 'number' ? first : isFixed ? 1 : undefined;
    return { family, base, length, raw };
  }

  if (family === 'binary') {
    if (first === 'max') return { family, base, length: 'max', raw };
    return { family, base, length: typeof first === 'number' ? first : undefined, raw };
  }

  return { family, base, raw };
}

function numEq(a?: number, b?: number): boolean {
  // 一边未知（来源没给精度）时不判差异
  if (a == null || b == null) return true;
  return a === b;
}

function lenEq(a: number | 'max' | undefined, b: number | 'max' | undefined, wildcard: boolean): boolean {
  if (wildcard && (a == null || b == null)) return true;
  if (a == null || b == null) return a === b;
  return a === b;
}

/**
 * 两个类型是否「等价」。
 * 默认严格：同族同基类型、同参数才等价；整型宽度需显式 ignoreIntegerWidth。
 */
export function typesEquivalent(a: string, b: string, opts: TypeCompareOptions = {}): boolean {
  const ca = canonicalType(a, opts.baseDialect);
  const cb = canonicalType(b, opts.targetDialect);
  if (ca.family !== cb.family) return false;

  switch (ca.family) {
    case 'integer':
      return opts.ignoreIntegerWidth ? true : ca.base === cb.base;
    case 'decimal':
      return numEq(ca.precision, cb.precision) && numEq(ca.scale, cb.scale);
    case 'float':
      return true;
    case 'string':
      if (opts.ignoreStringLength) return true;
      return lenEq(ca.length, cb.length, opts.unknownLengthWildcard !== false);
    case 'binary':
      return lenEq(ca.length, cb.length, opts.unknownLengthWildcard !== false);
    // 同族内的时间精度/布尔/文本/大对象差异不视为类型变更
    case 'text':
    case 'datetime':
    case 'date':
    case 'time':
    case 'boolean':
    case 'uuid':
    case 'json':
    case 'xml':
      return true;
    default:
      return ca.base === cb.base;
  }
}

/** 类型族（供统计/展示用） */
export function typeFamilyOf(type: string): TypeFamily {
  return canonicalType(type).family;
}

/** 规范化后的类型名（如 `integer:bigint`、`string:30`），用于分组/统计 */
export function canonicalKey(type: string): string {
  const c = canonicalType(type);
  const params = [c.length, c.precision, c.scale].filter((x) => x != null).join(',');
  return params ? `${c.family}:${c.base}(${params})` : `${c.family}:${c.base}`;
}
