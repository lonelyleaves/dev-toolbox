/**
 * 跨数据库类型映射。
 * 将 Oracle / SQL Server / PostgreSQL 的类型转换为 MySQL 或目标方言的等价类型。
 * PDMReader 内置了类似的转换表，用于跨库迁移时的类型对照。
 */

export type SourceDialect = 'oracle' | 'mssql' | 'postgres' | 'mysql';
export type TargetDialect = 'oracle' | 'mssql' | 'postgres' | 'mysql';

/** 类型映射表：[源类型正则, 目标类型模板] */
const TYPE_MAP: Record<string, [RegExp, string][]> = {
  oracle_to_mysql: [
    [/^varchar2$/i, 'varchar'],
    [/^nvarchar2$/i, 'varchar'],
    [/^number$/i, 'decimal'],
    [/^date$/i, 'datetime'],
    [/^timestamp\s*\(\d*\)$/i, 'datetime'],
    [/^clob$/i, 'text'],
    [/^nclob$/i, 'text'],
    [/^blob$/i, 'blob'],
    [/^raw$/i, 'varbinary'],
    [/^long\s*raw$/i, 'longblob'],
    [/^float$/i, 'double'],
    [/^integer$/i, 'int'],
    [/^smallint$/i, 'smallint'],
    [/^bigint$/i, 'bigint'],
    [/^char$/i, 'char'],
    [/^nchar$/i, 'char'],
  ],
  mssql_to_mysql: [
    [/^nvarchar$/i, 'varchar'],
    [/^ntext$/i, 'text'],
    [/^image$/i, 'longblob'],
    [/^bit$/i, 'tinyint'],
    [/^money$/i, 'decimal(19,4)'],
    [/^smallmoney$/i, 'decimal(10,4)'],
    [/^datetime2$/i, 'datetime'],
    [/^datetimeoffset$/i, 'datetime'],
    [/^smalldatetime$/i, 'datetime'],
    [/^uniqueidentifier$/i, 'char(36)'],
    [/^sql_variant$/i, 'varchar(255)'],
    [/^hierarchyid$/i, 'varchar(255)'],
    [/^geography$/i, 'text'],
    [/^geometry$/i, 'text'],
  ],
  postgres_to_mysql: [
    [/^serial$/i, 'int auto_increment'],
    [/^bigserial$/i, 'bigint auto_increment'],
    [/^smallserial$/i, 'smallint auto_increment'],
    [/^boolean$/i, 'tinyint(1)'],
    [/^bool$/i, 'tinyint(1)'],
    [/^uuid$/i, 'char(36)'],
    [/^jsonb?$/i, 'json'],
    [/^bytea$/i, 'blob'],
    [/^text$/i, 'text'],
    [/^character varying$/i, 'varchar'],
    [/^varchar$/i, 'varchar'],
    [/^character$/i, 'char'],
    [/^char$/i, 'char'],
    [/^real$/i, 'float'],
    [/^double precision$/i, 'double'],
    [/^numeric$/i, 'decimal'],
    [/^timestamp with time zone$/i, 'datetime'],
    [/^timestamp without time zone$/i, 'datetime'],
    [/^date$/i, 'date'],
    [/^time with time zone$/i, 'time'],
    [/^time without time zone$/i, 'time'],
    [/^interval$/i, 'varchar(50)'],
    [/^inet$/i, 'varchar(45)'],
    [/^cidr$/i, 'varchar(45)'],
    [/^macaddr$/i, 'varchar(17)'],
    [/^xml$/i, 'text'],
    [/^array$/i, 'json'],
  ],
  mysql_to_oracle: [
    [/^varchar$/i, 'VARCHAR2'],
    [/^text$/i, 'CLOB'],
    [/^mediumtext$/i, 'CLOB'],
    [/^longtext$/i, 'CLOB'],
    [/^tinytext$/i, 'VARCHAR2(255)'],
    [/^blob$/i, 'BLOB'],
    [/^mediumblob$/i, 'BLOB'],
    [/^longblob$/i, 'BLOB'],
    [/^tinyblob$/i, 'RAW(255)'],
    [/^tinyint\s*\(\s*1\s*\)$/i, 'NUMBER(1)'],
    [/^tinyint$/i, 'NUMBER(3)'],
    [/^smallint$/i, 'NUMBER(5)'],
    [/^mediumint$/i, 'NUMBER(8)'],
    [/^int$/i, 'NUMBER(10)'],
    [/^bigint$/i, 'NUMBER(19)'],
    [/^float$/i, 'FLOAT'],
    [/^double$/i, 'DOUBLE PRECISION'],
    [/^decimal$/i, 'NUMBER'],
    [/^datetime$/i, 'DATE'],
    [/^timestamp$/i, 'TIMESTAMP'],
    [/^date$/i, 'DATE'],
    [/^time$/i, 'VARCHAR2(10)'],
    [/^year$/i, 'NUMBER(4)'],
    [/^json$/i, 'CLOB'],
    [/^enum$/i, 'VARCHAR2(255)'],
    [/^set$/i, 'VARCHAR2(255)'],
    [/^bit$/i, 'RAW(1)'],
    [/^binary$/i, 'RAW'],
    [/^varbinary$/i, 'RAW'],
  ],
  mysql_to_mssql: [
    [/^varchar$/i, 'nvarchar'],
    [/^text$/i, 'ntext'],
    [/^mediumtext$/i, 'ntext'],
    [/^longtext$/i, 'ntext'],
    [/^tinytext$/i, 'nvarchar(255)'],
    [/^blob$/i, 'varbinary(max)'],
    [/^mediumblob$/i, 'varbinary(max)'],
    [/^longblob$/i, 'varbinary(max)'],
    [/^tinyblob$/i, 'varbinary(255)'],
    [/^tinyint\s*\(\s*1\s*\)$/i, 'bit'],
    [/^tinyint$/i, 'tinyint'],
    [/^smallint$/i, 'smallint'],
    [/^mediumint$/i, 'int'],
    [/^int$/i, 'int'],
    [/^bigint$/i, 'bigint'],
    [/^float$/i, 'float'],
    [/^double$/i, 'float'],
    [/^decimal$/i, 'decimal'],
    [/^datetime$/i, 'datetime2'],
    [/^timestamp$/i, 'datetimeoffset'],
    [/^date$/i, 'date'],
    [/^time$/i, 'time'],
    [/^year$/i, 'smallint'],
    [/^json$/i, 'nvarchar(max)'],
    [/^enum$/i, 'nvarchar(255)'],
    [/^set$/i, 'nvarchar(255)'],
    [/^bit$/i, 'bit'],
    [/^binary$/i, 'binary'],
    [/^varbinary$/i, 'varbinary'],
  ],
};

/** 提取类型的基础名（去掉长度/精度） */
function baseType(type: string): string {
  return type.replace(/\(.*\)/, '').trim();
}

/** 提取类型的参数（长度/精度） */
function typeParams(type: string): string | null {
  const m = type.match(/\(([^)]+)\)/);
  return m ? m[1] : null;
}

/**
 * 跨库类型转换。
 * @param type 源类型，如 "VARCHAR2(50)"、"NUMBER(10,2)"
 * @param from 源方言
 * @param to 目标方言
 * @returns 转换后的类型，如 "varchar(50)"、"decimal(10,2)"
 */
export function mapType(type: string, from: SourceDialect, to: TargetDialect): string {
  if (from === to) return type;
  const key = `${from}_to_${to}`;
  const rules = TYPE_MAP[key];
  if (!rules) return type;

  const base = baseType(type);
  const params = typeParams(type);

  for (const [pattern, replacement] of rules) {
    if (pattern.test(base)) {
      // 如果目标类型模板中包含括号（如 decimal(19,4)），直接使用
      if (replacement.includes('(')) return replacement;
      // 否则保留原始参数
      if (params) return `${replacement}(${params})`;
      return replacement;
    }
  }
  return type; // 无匹配，返回原类型
}

/** 批量转换表的所有字段类型 */
export function mapTableTypes(
  columns: { type: string; length?: string }[],
  from: SourceDialect,
  to: TargetDialect
): { type: string; length?: string }[] {
  return columns.map((c) => {
    const mapped = mapType(c.type, from, to);
    // 如果长度分离存储，也尝试映射
    let length = c.length;
    if (length && /\(.*\)/.test(c.type)) {
      // 长度已经在类型参数中，不需要单独处理
    }
    return { type: mapped, length };
  });
}

/** 获取所有支持的类型映射规则（用于 UI 展示） */
export function getTypeMappingRules(from: SourceDialect, to: TargetDialect): { from: string; to: string }[] {
  const key = `${from}_to_${to}`;
  const rules = TYPE_MAP[key];
  if (!rules) return [];
  return rules.map(([pattern, replacement]) => ({
    from: pattern.source.replace(/[\^$\\/i]/g, '').replace(/\s*\(\d*\)/, '(n)'),
    to: replacement,
  }));
}
