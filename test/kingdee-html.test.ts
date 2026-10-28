import { describe, it, expect } from 'vitest';
import { parseKingdeeHtml, splitDefault, buildHtmlType } from '../src/dictionary/kingdee-html';

/** 模拟金蝶数据字典导出 HTML 的一个实体节 */
const SAMPLE = `
<html><body>
<h4>供应商-单据头</h4>
<h5>概述</h5>
<table>
  <tr><td>表名称</td><td>实体名称</td><td>ORM实体名</td></tr>
  <tr><td>T_BD_SUPPLIER</td><td>单据头</td><td>Supplier</td></tr>
</table>
<h5>字段</h5>
<table>
  <tr><td>标题</td><td>标识</td><td>实体属性</td><td>名称</td><td>数据类型</td><td>长度</td><td>精度</td><td>小数精度</td><td>允许空值</td><td>默认值</td><td>系统预设</td></tr>
  <tr><td>内码</td><td>FSupplierId</td><td>SupplierId</td><td>FSUPPLIERID</td><td>int</td><td>4</td><td>10</td><td>0</td><td>否</td><td>((0))</td><td>是</td></tr>
  <tr><td>数据状态</td><td>FDocumentStatus</td><td>DocumentStatus</td><td>FDOCUMENTSTATUS</td><td>char</td><td>1</td><td>1</td><td>0</td><td>否</td><td>(' ') 注：Z=暂存,A=创建,B=审核中</td><td>是</td></tr>
  <tr><td>编码</td><td>FNumber</td><td>Number</td><td>FNUMBER</td><td>nvarchar</td><td>510</td><td>255</td><td>0</td><td>否</td><td>(' ')</td><td>是</td></tr>
  <tr><td>金额</td><td>FAmount</td><td>Amount</td><td>FAMOUNT</td><td>decimal</td><td>19</td><td>19</td><td>2</td><td>是</td><td>((0))</td><td>否</td></tr>
</table>
<h5>索引</h5>
<table>
  <tr><td>名称</td><td>类型</td><td>字段</td></tr>
  <tr><td>PK_BD_SUPPLIER</td><td>CLUSTERED</td><td>FSUPPLIERID</td></tr>
  <tr><td>IDX_BD_SUPPLIER_NUMBER</td><td>NONCLUSTERED</td><td>FNUMBER</td></tr>
</table>
<h5>主外键</h5>
<table>
  <tr><td>名称</td><td>类型</td><td>字段</td></tr>
  <tr><td>PK_BD_SUPPLIER</td><td>PK</td><td>FSUPPLIERID</td></tr>
</table>
</body></html>`;

describe('金蝶 HTML 数据字典解析', () => {
  const d = parseKingdeeHtml(SAMPLE);
  const t = d.tables[0];

  it('识别实体：表名 / 显示名 / 注释', () => {
    expect(d.tables.length).toBe(1);
    expect(t.name).toBe('T_BD_SUPPLIER');
    expect(t.code).toBe('单据头');
    expect(t.comment).toBe('供应商-单据头');
  });

  it('字段：物理名 / 中文标题 / 类型（精度优先）', () => {
    const f = (n: string) => t.columns.find((c) => c.name === n)!;
    expect(f('FDOCUMENTSTATUS').code).toBe('数据状态');
    expect(f('FDOCUMENTSTATUS').type).toBe('char(1)');
    expect(f('FNUMBER').type).toBe('nvarchar(255)');
    expect(f('FAMOUNT').type).toBe('decimal(19,2)');
    expect(f('FSUPPLIERID').type).toBe('int');
  });

  it('枚举值并入注释', () => {
    const c = t.columns.find((x) => x.name === 'FDOCUMENTSTATUS')!;
    expect(c.comment).toBe('数据状态；枚举：Z=暂存,A=创建,B=审核中');
  });

  it('可空 / 默认值', () => {
    const f = (n: string) => t.columns.find((c) => c.name === n)!;
    expect(f('FDOCUMENTSTATUS').nullable).toBe(false);
    expect(f('FAMOUNT').nullable).toBe(true);
    expect(f('FSUPPLIERID').defaultValue).toBe('0');
    expect(f('FNUMBER').defaultValue).toBeUndefined(); // (' ') → 空白视为无默认
  });

  it('主键（主外键表 PK）与索引', () => {
    expect(t.columns.find((c) => c.name === 'FSUPPLIERID')!.pk).toBe(true);
    expect(t.columns.find((c) => c.name === 'FNUMBER')!.pk).toBeFalsy();
    expect(t.indexes.map((i) => i.name)).toEqual(['IDX_BD_SUPPLIER_NUMBER']);
  });
});

describe('splitDefault / buildHtmlType', () => {
  it('默认值拆分：枚举与字面量', () => {
    expect(splitDefault("(' ') 注：Z=暂存,A=创建")).toEqual({ defaultValue: undefined, enumText: 'Z=暂存,A=创建' });
    expect(splitDefault('((0))')).toEqual({ defaultValue: '0', enumText: undefined });
    expect(splitDefault("('')")).toEqual({ defaultValue: undefined, enumText: undefined });
    expect(splitDefault("('0')")).toEqual({ defaultValue: '0', enumText: undefined });
    expect(splitDefault('')).toEqual({});
  });

  it('类型拼接', () => {
    expect(buildHtmlType('nvarchar', '510', '255', '0')).toBe('nvarchar(255)');
    expect(buildHtmlType('char', '1', '1', '0')).toBe('char(1)');
    expect(buildHtmlType('decimal', '19', '19', '2')).toBe('decimal(19,2)');
    expect(buildHtmlType('int', '4', '10', '0')).toBe('int');
  });
});
