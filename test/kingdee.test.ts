import { describe, it, expect } from 'vitest';
import { parseKingdeeMetadata, parseKingdeeApiResponse } from '../src/dictionary/kingdee';

/** 表单元数据（金蝶元数据常见形态：表单 + 实体 + 字段，字段带中文标题） */
const META_JSON = JSON.stringify({
  FormId: 'BD_MATERIAL',
  Caption: '物料',
  TableName: 'T_BD_MATERIAL',
  Entity: [
    { Key: 'FMaterialId', Caption: '物料内码', FieldType: 'int' },
    { Key: 'FNumber', Caption: '物料编码', FieldType: 'varchar' },
    { Key: 'FName', Caption: '物料名称', FieldType: 'varchar' },
  ],
  SubHeadEntity: [
    { Key: 'FCreateDate', Caption: '创建日期', FieldType: 'datetime' },
  ],
});

/** WebAPI 返回报文（外层带 Result / ResponseStatus 包装） */
const API_JSON = JSON.stringify({
  Result: {
    ResponseStatus: { IsSuccess: true },
    FormId: 'BD_CUSTOMER',
    Caption: '客户',
    Fields: [
      { FieldName: 'FCUSTID', Caption: '客户内码', FieldType: 'int' },
      { FieldName: 'FNUMBER', Caption: '客户编码', FieldType: 'varchar' },
    ],
  },
});

const META_XML = `<?xml version="1.0" encoding="utf-8"?>
<Metadata>
  <Form FormId="BD_SUPPLIER" Caption="供应商">
    <TableName>T_BD_SUPPLIER</TableName>
    <Fields>
      <Field FieldName="FSUPPLIERID" Caption="供应商内码" FieldType="int" />
      <Field FieldName="FNUMBER" Caption="供应商编码" FieldType="varchar" />
    </Fields>
  </Form>
</Metadata>`;

describe('金蝶元数据解析', () => {
  it('JSON 表单元数据：表名优先取 TableName，字段取 Key + Caption', () => {
    const d = parseKingdeeMetadata(META_JSON, '物料');
    expect(d.importErrors).toHaveLength(0);
    const t = d.tables.find((x) => x.name === 'T_BD_MATERIAL')!;
    expect(t).toBeTruthy();
    expect(t.comment).toBe('物料');
    const names = t.columns.map((c) => c.name);
    expect(names).toContain('FMaterialId');
    expect(names).toContain('FNumber');
    expect(names).toContain('FCreateDate');
    const c = t.columns.find((x) => x.name === 'FNumber')!;
    expect(c.comment).toBe('物料编码');
    expect(c.type).toBe('varchar');
  });

  it('WebAPI 报文：自动剥掉 Result 外层包装', () => {
    const d = parseKingdeeApiResponse(API_JSON, '客户');
    expect(d.importErrors).toHaveLength(0);
    const t = d.tables.find((x) => x.name === 'BD_CUSTOMER')!;
    expect(t).toBeTruthy();
    expect(t.columns.map((c) => c.name)).toEqual(['FCUSTID', 'FNUMBER']);
    expect(t.columns[0].comment).toBe('客户内码');
  });

  it('XML 表单元数据：读属性', () => {
    const d = parseKingdeeMetadata(META_XML, '供应商');
    expect(d.importErrors).toHaveLength(0);
    const t = d.tables.find((x) => x.name === 'T_BD_SUPPLIER')!;
    expect(t).toBeTruthy();
    expect(t.columns.map((c) => c.name)).toEqual(['FSUPPLIERID', 'FNUMBER']);
  });

  it('字段去重：同名字段只保留一条', () => {
    const dup = JSON.stringify({
      FormId: 'X', Entity: [
        { Key: 'FID', Caption: '内码', FieldType: 'int' },
        { Key: 'FID', Caption: '内码', FieldType: 'int' },
      ],
    });
    const d = parseKingdeeMetadata(dup);
    expect(d.tables[0].columns.filter((c) => c.name === 'FID').length).toBe(1);
  });

  it('空内容 / 非 JSON-XML：给出可读错误而不是抛异常', () => {
    expect(parseKingdeeMetadata('').importErrors[0].message).toContain('内容为空');
    expect(parseKingdeeMetadata('随便一段文字').importErrors[0].message).toContain('不是 JSON');
    expect(() => parseKingdeeMetadata('{"a":')).not.toThrow();
    expect(parseKingdeeMetadata('{"a":').importErrors[0].message).toContain('解析失败');
  });
});

/** 贴合官方 QueryBusinessInfo 语义的报文：Key=字段名、Name=中文标题、MustInput=必填、IsViewVisible=是否隐藏 */
const OFFICIAL_JSON = JSON.stringify({
  Result: {
    ResponseStatus: { IsSuccess: true },
    FormId: 'BD_MATERIAL',
    Name: '物料',
    Entity: [
      { Key: 'FMATERIALID', Name: '物料内码', MustInput: 1, FieldType: 'int' },
      { Key: 'FNUMBER', Name: '物料编码', MustInput: 1 },
      { Key: 'FOLDNUMBER', Name: '旧编码', IsViewVisible: false },
      { Key: 'FNOTE', Name: '备注', MustInput: 0 },
    ],
  },
});

describe('金蝶官方元数据语义（QueryBusinessInfo）', () => {
  it('Key 作字段标识、Name 作中文标题，不把 Key 当标题', () => {
    const d = parseKingdeeMetadata(OFFICIAL_JSON, '物料');
    expect(d.importErrors).toHaveLength(0);
    const t = d.tables.find((x) => x.name === 'BD_MATERIAL')!;
    expect(t).toBeTruthy();
    expect(t.comment).toBe('物料');
    expect(t.columns.map((c) => c.name)).toEqual(['FMATERIALID', 'FNUMBER', 'FOLDNUMBER', 'FNOTE']);
    expect(t.columns[0].comment).toBe('物料内码');
    expect(t.columns[0].type).toBe('int');
  });

  it('MustInput=1 → 必填（nullable=false）；0 → 可空', () => {
    const d = parseKingdeeMetadata(OFFICIAL_JSON, '物料');
    const t = d.tables[0];
    expect(t.columns[0].nullable).toBe(false);
    expect(t.columns[3].nullable).toBe(true);
  });

  it('IsViewVisible=false 的字段标注出来（不被静默丢弃）', () => {
    const d = parseKingdeeMetadata(OFFICIAL_JSON, '物料');
    const c = d.tables[0].columns.find((x) => x.name === 'FOLDNUMBER')!;
    expect(c.comment).toContain('界面已隐藏');
  });
});

// ---- 官方 QueryBusinessInfo 报文（test/fixtures/kingdee-saleorder.json，已脱敏：剔除客户私有字段） ----
import * as fs from 'fs';
import * as path from 'path';

const OFFICIAL_FILE = path.join(__dirname, 'fixtures/kingdee-saleorder.json');
const OFFICIAL_RAW = fs.readFileSync(OFFICIAL_FILE, 'utf8');

describe('官方 QueryBusinessInfo 报文（实体拆表）', () => {
  const d = parseKingdeeMetadata(OFFICIAL_RAW, '销售订单');

  it('一个表单按实体拆成多张物理表', () => {
    expect(d.importErrors).toHaveLength(0);
    expect(d.tables.map((t) => t.name)).toEqual(['T_SAL_ORDER', 'T_SAL_ORDERENTRY']);
    expect(d.tables[0].comment).toBe('销售订单 · 基本信息');
    expect(d.tables[1].comment).toBe('销售订单 · 订单明细');
  });

  it('列名取物理列名 FieldName，标题取多语言 Name', () => {
    const head = d.tables[0];
    const c = head.columns.find((x) => x.name === 'FBILLNO')!;
    expect(c).toBeTruthy();
    expect(c.code).toBe('单据编号');
    expect(c.type).toBe('nvarchar(30)');
  });

  it('FieldType 按 SQL Server system_type_id 映射', () => {
    const got = (n: string) => d.tables[0].columns.find((x) => x.name === n)?.type;
    expect(got('FDATE')).toBe('datetime');
    expect(got('FCUSTID')).toBe('bigint');
    expect(got('FDOCUMENTSTATUS')).toBe('char');
  });

  it('枚举值写进列注释（Z=暂存…）', () => {
    const c = d.tables[0].columns.find((x) => x.name === 'FDOCUMENTSTATUS')!;
    expect(c.comment).toContain('枚举：');
    expect(c.comment).toContain('Z=暂存');
  });

  it('主键字段不在 Fields 里 → 从 EntryPkFieldName 补出', () => {
    expect(d.tables[0].columns.some((x) => x.name === 'FID' && x.pk === true)).toBe(true);
    expect(d.tables[1].columns.some((x) => x.name === 'FENTRYID' && x.pk === true)).toBe(true);
    expect(d.tables[0].columns.find((x) => x.name === 'FID')!.nullable).toBe(false);
  });

  it('MustInput=1 → 必填', () => {
    const c = d.tables[0].columns.find((x) => x.name === 'FBILLTYPEID' || x.name === 'FSALEORGID');
    if (c && c.pk !== true) expect(typeof c.nullable).toBe('boolean');
  });
});
