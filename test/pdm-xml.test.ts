import { describe, it, expect } from 'vitest';
import { parseXmlLight, decodeXmlEntities } from '../src/dictionary/pdm-xml';
import { parsePdm } from '../src/dictionary/pdm';

describe('轻量 XML 扫描器', () => {
  it('属性：双引号/单引号/自闭合/Ref 占位', () => {
    const r = parseXmlLight(`<Root><o:Table Id="t1"><o:Column Ref="o5"/><o:Column Id='c1'/></o:Table></Root>`);
    const t = r.Root['o:Table'];
    expect(t['@_Id']).toBe('t1');
    const cols = t['o:Column'];
    expect(Array.isArray(cols)).toBe(true);
    expect(cols[0]['@_Ref']).toBe('o5');
    expect(cols[1]['@_Id']).toBe('c1');
  });

  it('纯文本叶子直接是字符串（与 fast-xml-parser 形状一致）', () => {
    const r = parseXmlLight(`<Root><a:Name>物料</a:Name><a:Code>T_BD_MATERIAL</a:Code></Root>`);
    expect(r.Root['a:Name']).toBe('物料');
    expect(r.Root['a:Code']).toBe('T_BD_MATERIAL');
  });

  it('属性 + 文本 → { @_x, #text }', () => {
    const r = parseXmlLight(`<Root><a:Comment Id="c">含备注</a:Comment></Root>`);
    expect(r.Root['a:Comment']).toEqual({ '@_Id': 'c', '#text': '含备注' });
  });

  it('空元素与自闭合无属性 → 空串', () => {
    const r = parseXmlLight(`<Root><a:Comment></a:Comment><b:X/></Root>`);
    expect(r.Root['a:Comment']).toBe('');
    expect(r.Root['b:X']).toBe('');
  });

  it('跳过注释 / 处理指令 / XML 声明 / DOCTYPE', () => {
    const r = parseXmlLight(`<?xml version="1.0"?><!DOCTYPE Model SYSTEM "x.dtd" [<!ENTITY a "b">]><!-- 注释 --><Root><a:Code>T1</a:Code></Root>`);
    expect(r.Root['a:Code']).toBe('T1');
    expect(JSON.stringify(r)).not.toContain('注释');
  });

  it('CDATA 原文保留', () => {
    const r = parseXmlLight(`<Root><a:SQL><![CDATA[select a > 1 from t]]></a:SQL></Root>`);
    expect(r.Root['a:SQL']).toBe('select a > 1 from t');
  });

  it('实体解码：命名实体 + 十进制 + 十六进制', () => {
    expect(decodeXmlEntities('a &amp; b &lt; c &#65; &#x42;')).toBe('a & b < c A B');
    const r = parseXmlLight(`<Root><a:Comment>1 &lt; 2 &amp; 3</a:Comment></Root>`);
    expect(r.Root['a:Comment']).toBe('1 < 2 & 3');
  });

  it('属性值里的 > 不会提前截断标签', () => {
    const r = parseXmlLight(`<Root><a:Name>表A</a:Name><o:T Id="x" Expr="a &gt; b"><a:Code>T1</a:Code></o:T></Root>`);
    expect(r.Root['o:T']['@_Expr']).toBe('a > b');
    expect(r.Root['o:T']['a:Code']).toBe('T1');
  });

  it('重复标签收集为数组，单个为对象', () => {
    const r = parseXmlLight(`<Root><c:Columns><o:Column Id="1"/><o:Column Id="2"/></c:Columns></Root>`);
    expect(Array.isArray(r.Root['c:Columns']['o:Column'])).toBe(true);
    expect(r.Root['c:Columns']['o:Column'].length).toBe(2);
  });

  it('非法/不完整 XML 不抛异常（由 parsePdm 兜底）', () => {
    expect(() => parseXmlLight('<Root><a>1')).not.toThrow();
  });
});

describe('parsePdm 走轻量扫描器', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Model><o:RootObject Id="o1"><c:Children><o:Model Id="m1">
  <c:Tables>
    <o:Table Id="t1"><a:ObjectID>t1</a:ObjectID><a:Name>物料</a:Name><a:Code>T_BD_MATERIAL</a:Code><a:Comment>物料表</a:Comment>
      <c:Columns>
        <o:Column Id="c1"><a:ObjectID>c1</a:ObjectID><a:Name>物料内码</a:Name><a:Code>FMATERIALID</a:Code><a:DataType>int(10)</a:DataType><a:Mandatory>1</a:Mandatory></o:Column>
        <o:Column Id="c2"><a:ObjectID>c2</a:ObjectID><a:Name>编码</a:Name><a:Code>FNUMBER</a:Code><a:DataType>varchar(50)</a:DataType></o:Column>
      </c:Columns>
      <c:Keys><o:Key Id="k1"><a:PrimaryKey>1</a:PrimaryKey><c:Key.Columns><o:Column Ref="c1"/></c:Key.Columns></o:Key></c:Keys>
    </o:Table>
    <o:Table Ref="t1"/>
  </c:Tables>
</o:Model></c:Children></o:RootObject></Model>`;

  it('表/列/主键/可空解析正确，Ref 占位不算表', () => {
    const d = parsePdm(xml);
    expect(d.importErrors).toHaveLength(0);
    expect(d.tables).toHaveLength(1);
    const t = d.tables[0];
    expect(t.name).toBe('T_BD_MATERIAL');
    expect(t.code).toBe('物料');
    expect(t.columns.map((c) => c.name)).toEqual(['FMATERIALID', 'FNUMBER']);
    expect(t.columns[0].comment).toBeUndefined();
    expect(t.columns[0].nullable).toBe(false);  // a:Mandatory=1
    expect(t.columns[1].nullable).toBe(true);
    expect(t.columns[0].pk).toBe(true);         // c:Keys 主键
  });

  it('CDATASQL / 含 > 的属性不破坏解析', () => {
    const x = `<Model><o:Model><c:Tables><o:Table Id="t"><a:Code>T_X</a:Code><c:Columns><o:Column Id="c"><a:Code>F1</a:Code><a:DataType>int</a:DataType><a:DefaultValue><![CDATA[if a &gt; b then 1]]></a:DefaultValue></o:Column></c:Columns></o:Table></c:Tables></o:Model></Model>`;
    const d = parsePdm(x);
    expect(d.tables[0].columns[0].defaultValue).toBe('if a > b then 1');
  });
});
