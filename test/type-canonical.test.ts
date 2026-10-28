/**
 * 跨系统类型归一：不同数据库/来源的类型写法应归到同一族再比较，
 * 避免 int vs bigint、char(1) vs varchar(1)、datetime vs datetime2 这类假差异。
 */
import { describe, it, expect } from 'vitest';
import { canonicalType, canonicalKey, typesEquivalent } from '../src/dictionary/type-canonical';

describe('类型归一（跨系统/跨库）', () => {
  it('整型别名：int / integer / int4 / serial 归为同一类型', () => {
    for (const t of ['int', 'INTEGER', 'int4', 'serial', 'int(11)']) {
      expect(canonicalType(t)).toMatchObject({ family: 'integer', base: 'int' });
    }
    expect(canonicalType('bigint')).toMatchObject({ family: 'integer', base: 'bigint' });
    expect(canonicalType('int8')).toMatchObject({ family: 'integer', base: 'bigint' });
    expect(canonicalType('smallint')).toMatchObject({ family: 'integer', base: 'smallint' });
  });

  it('字符串：varchar/varchar2/nvarchar/character varying 同一；char(1) 与 varchar(1) 等价', () => {
    for (const t of ['varchar(50)', 'varchar2(50)', 'nvarchar(50)', 'character varying(50)']) {
      expect(canonicalType(t)).toMatchObject({ family: 'string', base: 'string', length: 50 });
    }
    expect(typesEquivalent('char(1)', 'varchar(1)')).toBe(true);
  });

  it('长度未知视为通配：varchar vs char(1) 不报差异', () => {
    expect(typesEquivalent('varchar', 'char(1)')).toBe(true);
    expect(typesEquivalent('nvarchar(30)', 'nvarchar(20)')).toBe(false);
  });

  it('整型宽度：int vs bigint 默认严格，ignoreIntegerWidth 时等价', () => {
    expect(typesEquivalent('int', 'bigint')).toBe(false);
    expect(typesEquivalent('int', 'bigint', { ignoreIntegerWidth: true })).toBe(true);
  });

  it('定点数：decimal / numeric / number 同一；精度不同不等等价', () => {
    expect(typesEquivalent('decimal(10,2)', 'numeric(10,2)')).toBe(true);
    expect(typesEquivalent('numeric(10,2)', 'number(10,2)')).toBe(true);
    expect(typesEquivalent('decimal(10,2)', 'decimal(12,2)')).toBe(false);
    expect(canonicalType('money')).toMatchObject({ family: 'decimal', precision: 19, scale: 4 });
  });

  it('Oracle NUMBER：整数精度按整型归一', () => {
    expect(canonicalType('NUMBER(9)')).toMatchObject({ family: 'integer', base: 'int' });
    expect(canonicalType('NUMBER(18)')).toMatchObject({ family: 'integer', base: 'bigint' });
    expect(canonicalType('NUMBER')).toMatchObject({ family: 'decimal' });
  });

  it('时间：datetime / datetime2 / smalldatetime 等价；SQL Server timestamp 是二进制', () => {
    expect(typesEquivalent('datetime', 'datetime2')).toBe(true);
    expect(typesEquivalent('datetime', 'smalldatetime')).toBe(true);
    expect(canonicalType('timestamp', 'mssql').family).toBe('binary');
    expect(canonicalType('timestamp', 'mysql').family).toBe('datetime');
  });

  it('布尔：bit / boolean / MySQL tinyint(1) 等价', () => {
    expect(typesEquivalent('bit', 'boolean')).toBe(true);
    expect(canonicalType('tinyint(1)', 'mysql').family).toBe('boolean');
    expect(canonicalType('tinyint(1)', 'mssql').family).toBe('integer');
  });

  it('大文本：text / ntext / clob 等价；varchar(max) 归为大文本', () => {
    expect(typesEquivalent('text', 'ntext')).toBe(true);
    expect(typesEquivalent('clob', 'text')).toBe(true);
    expect(canonicalType('varchar(max)').family).toBe('text');
    expect(typesEquivalent('nvarchar(max)', 'text')).toBe(true);
  });

  it('不同族不等等价：int vs varchar、datetime vs int', () => {
    expect(typesEquivalent('int', 'varchar(10)')).toBe(false);
    expect(typesEquivalent('datetime', 'int')).toBe(false);
  });

  it('canonicalKey 用于展示/分组', () => {
    expect(canonicalKey('bigint')).toBe('integer:bigint');
    expect(canonicalKey('nvarchar(50)')).toBe('string:string(50)');
  });
});
