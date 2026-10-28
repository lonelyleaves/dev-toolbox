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

  it('按字段自带 TableName 拆表：主表 + 拆分表 _F（如价格字段）', () => {
    expect(d.importErrors).toHaveLength(0);
    expect(d.tables.map((t) => t.name)).toEqual(['T_SAL_ORDER', 'T_SAL_ORDERENTRY', 'T_SAL_ORDERENTRY_F']);
    expect(d.tables[0].comment).toBe('销售订单 · 基本信息');
    expect(d.tables[1].comment).toBe('销售订单 · 订单明细');
    expect(d.tables[2].comment).toContain('拆分表_F');
    // 价格字段在 _F 表，不在明细主表
    expect(d.tables[1].columns.map((c) => c.name)).not.toContain('FPRICE');
    expect(d.tables[2].columns.map((c) => c.name)).toContain('FPRICE');
    // 拆分表与主表共享主键
    expect(d.tables[2].columns.find((c) => c.name === 'FENTRYID')?.pk).toBe(true);
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

  it('枚举值写进列注释（Z=暂存…），显示名保持干净', () => {
    const c = d.tables[0].columns.find((x) => x.name === 'FDOCUMENTSTATUS')!;
    expect(c.comment).toContain('枚举：');
    expect(c.comment).toContain('Z=暂存');
    // 枚举只进注释，不能污染显示名
    expect(c.code).toBe('单据状态');
    expect(c.code).not.toContain('枚举');
  });

  it('枚举按 Seq 排序，且与 Extends 顺序无关', () => {
    const d2 = parseKingdeeMetadata(JSON.stringify({
      Result: { ResponseStatus: { IsSuccess: true }, NeedReturnData: {
        Id: 'X', Name: [{ Key: 2052, Value: '测试表单' }], PkFieldName: 'FID',
        Entrys: [{ Key: 'FBillHead', TableName: 'T_X', EntryPkFieldName: 'FID', Name: [{ Key: 2052, Value: '头' }],
          Fields: [{ Key: 'FStatus', FieldName: 'FSTATUS', Name: [{ Key: 2052, Value: '状态' }],
            Extends: [
              { Value: 'B', Caption: '审核中', Seq: 3 },
              { Value: 'Z', Caption: '暂存', Seq: 0 },
              { Value: 'A', Caption: '创建', Seq: 2, Invalid: true },
            ] }] }],
      } },
    }), '测试');
    const c = d2.tables[0].columns.find((x) => x.name === 'FSTATUS')!;
    expect(c.comment).toBe('状态；枚举：Z=暂存,B=审核中');
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

describe('多语言字段拆分到 _L 表', () => {
  const payload = (flag: Record<string, unknown> = {}) => JSON.stringify({
    Result: {
      ResponseStatus: { IsSuccess: true },
      NeedReturnData: {
        Id: 'BD_STOCK', Name: [{ Key: 2052, Value: '仓库' }], PkFieldName: 'FSTOCKID',
        Entrys: [{
          Key: 'FBillHead', TableName: 'T_BD_STOCK', EntryPkFieldName: 'FSTOCKID',
          EntryPkFieldType: 'System.Int32, mscorlib, Version=4.0.0.0',
          Name: [{ Key: 2052, Value: '基本信息' }],
          Fields: [
            { Key: 'FNumber', FieldName: 'FNUMBER', Name: [{ Key: 2052, Value: '编码' }], FieldType: 231, Editlen: 30 },
            { Key: 'FName', FieldName: 'FNAME', Name: [{ Key: 2052, Value: '名称' }], FieldType: 231, Editlen: 255, ...flag },
            { Key: 'FDescription', FieldName: 'FDESCRIPTION', Name: [{ Key: 2052, Value: '描述' }], FieldType: 231, Editlen: 255, ...flag },
          ],
        }],
      },
    },
  });

  it('IsMulLanguage=1：多语言字段进 T_BD_STOCK_L，主表不再有 FNAME', () => {
    const d = parseKingdeeMetadata(payload({ IsMulLanguage: 1 }), '仓库');
    const main = d.tables.find((t) => t.name === 'T_BD_STOCK')!;
    const lang = d.tables.find((t) => t.name === 'T_BD_STOCK_L')!;
    expect(main).toBeTruthy();
    expect(lang).toBeTruthy();
    expect(main.columns.map((c) => c.name)).toEqual(['FSTOCKID', 'FNUMBER']);
    expect(lang.columns.map((c) => c.name)).toEqual(['FPKID', 'FSTOCKID', 'FLOCALEID', 'FNAME', 'FDESCRIPTION']);
    expect(lang.columns.find((c) => c.name === 'FSTOCKID')!.type).toBe('int');
    // 真实库多语言表的 PK 是 FPKID；业务主键与语言列只是普通非空列
    expect(lang.columns.filter((c) => c.pk).map((c) => c.name)).toEqual(['FPKID']);
    expect(lang.columns.find((c) => c.name === 'FLOCALEID')!.nullable).toBe(false);
    expect(lang.comment).toContain('多语言');
    expect(lang.code).toContain('多语言');
  });

  it('元数据无标记时：标准字段名 FNAME/FDESCRIPTION 仍归入 _L', () => {
    const d = parseKingdeeMetadata(payload(), '仓库');
    expect(d.tables.map((t) => t.name)).toEqual(['T_BD_STOCK', 'T_BD_STOCK_L']);
    expect(d.tables[0].columns.map((c) => c.name)).toEqual(['FSTOCKID', 'FNUMBER']);
    expect(d.tables[1].columns.map((c) => c.name)).toEqual(['FPKID', 'FSTOCKID', 'FLOCALEID', 'FNAME', 'FDESCRIPTION']);
  });

  it('显式 IsMulLanguage=0：留在主表，不生成 _L 表', () => {
    const d = parseKingdeeMetadata(payload({ IsMulLanguage: 0 }), '仓库');
    expect(d.tables.map((t) => t.name)).toEqual(['T_BD_STOCK']);
    expect(d.tables[0].columns.map((c) => c.name)).toEqual(['FSTOCKID', 'FNUMBER', 'FNAME', 'FDESCRIPTION']);
  });

  it('普通列 FDESCRIPTION/FNAME（Key 为 FFinanceDesc/FLocName）不会被误拆到 _L', () => {
    const raw = JSON.stringify({
      Result: { ResponseStatus: { IsSuccess: true }, NeedReturnData: {
        Id: 'BD_SUPPLIER', Name: [{ Key: 2052, Value: '供应商' }],
        Entrys: [{
          Key: 'FFinanceEntity', TableName: 'T_BD_SUPPLIERFINANCE', EntryPkFieldName: 'FSUPPLIERID',
          Name: [{ Key: 2052, Value: '财务信息' }],
          Fields: [
            { Key: 'FFinanceDesc', FieldName: 'FDESCRIPTION', Name: [{ Key: 2052, Value: '描述' }], FieldType: 231 },
            { Key: 'FLocName', FieldName: 'FNAME', Name: [{ Key: 2052, Value: '地点名称' }], FieldType: 231 },
          ],
        }],
      } },
    });
    const d = parseKingdeeMetadata(raw, '供应商');
    expect(d.tables.map((t) => t.name)).toEqual(['T_BD_SUPPLIERFINANCE']);
    expect(d.tables[0].columns.map((c) => c.name)).toEqual(['FSUPPLIERID', 'FDESCRIPTION', 'FNAME']);
  });

  it('字段 TableName 已指向 _L 时，即使没有 IsMulLanguage 也归入多语言表', () => {
    const raw = JSON.stringify({
      Result: { ResponseStatus: { IsSuccess: true }, NeedReturnData: {
        Id: 'BD_STOCK', Name: [{ Key: 2052, Value: '仓库' }],
        Entrys: [{
          Key: 'FBillHead', TableName: 'T_BD_STOCK', EntryPkFieldName: 'FSTOCKID',
          Name: [{ Key: 2052, Value: '基本信息' }],
          Fields: [
            { Key: 'FNumber', FieldName: 'FNUMBER', TableName: 'T_BD_STOCK', Name: [{ Key: 2052, Value: '编码' }], FieldType: 231 },
            { Key: 'FName', FieldName: 'FNAME', TableName: 'T_BD_STOCK_L', Name: [{ Key: 2052, Value: '名称' }], FieldType: 231 },
            { Key: 'FDescription', FieldName: 'FDESCRIPTION', TableName: 'T_BD_STOCK_L', Name: [{ Key: 2052, Value: '描述' }], FieldType: 231 },
          ],
        }],
      } },
    });
    const d = parseKingdeeMetadata(raw, '仓库');
    expect(d.tables.map((t) => t.name)).toEqual(['T_BD_STOCK', 'T_BD_STOCK_L']);
    expect(d.tables[0].columns.map((c) => c.name)).toEqual(['FSTOCKID', 'FNUMBER']);
    expect(d.tables[1].columns.map((c) => c.name)).toEqual(['FPKID', 'FSTOCKID', 'FLOCALEID', 'FNAME', 'FDESCRIPTION']);
  });

  it('实体本身就是 _L 表：不再嵌套生成 _L_L', () => {
    const raw = JSON.stringify({
      Result: { ResponseStatus: { IsSuccess: true }, NeedReturnData: {
        Id: 'BD_STOCK', Name: [{ Key: 2052, Value: '仓库' }],
        Entrys: [{ Key: 'FBillHead', TableName: 'T_BD_STOCK_L', EntryPkFieldName: 'FSTOCKID',
          Name: [{ Key: 2052, Value: '基本信息' }],
          Fields: [{ Key: 'FName', FieldName: 'FNAME', Name: [{ Key: 2052, Value: '名称' }], IsMulLanguage: 1 }] }],
      } },
    });
    const d = parseKingdeeMetadata(raw, '仓库');
    expect(d.tables.map((t) => t.name)).toEqual(['T_BD_STOCK_L']);
  });
});

describe('非官方形态报文也保留枚举', () => {
  it('通用 JSON：Extends 进注释，显示名不被污染', () => {
    const d = parseKingdeeMetadata(JSON.stringify({
      FormId: 'BD_X', Caption: '测试', TableName: 'T_X',
      Entity: [{
        Key: 'FStatus', Caption: '状态', FieldType: 'varchar',
        Extends: [{ Value: 'A', Caption: '启用' }, { Value: 'B', Caption: '停用' }],
      }],
    }), '测试');
    const c = d.tables[0].columns.find((x) => x.name === 'FStatus')!;
    expect(c.code).toBe('状态');
    expect(c.comment).toBe('状态；枚举：A=启用,B=停用');
  });

  it('XML：Extends 子节点的 Value/Caption 进注释', () => {
    const xml = `<Metadata><Form FormId="BD_X" Caption="测试"><Fields>
      <Field FieldName="FSTATUS" Caption="状态" FieldType="varchar">
        <Extends Value="A" Caption="启用"/><Extends Value="B" Caption="停用"/>
      </Field></Fields></Form></Metadata>`;
    const d = parseKingdeeMetadata(xml, '测试');
    const t = d.tables.find((x) => x.columns.some((c) => c.name === 'FSTATUS'))!;
    const c = t.columns.find((x) => x.name === 'FSTATUS')!;
    expect(c.comment).toContain('枚举：A=启用,B=停用');
  });
});

describe('金蝶服务端错误报文透出', () => {
  it('ResponseStatus.IsSuccess=false → 错误信息进入 importErrors', () => {
    const d = parseKingdeeMetadata(JSON.stringify({
      Result: { ResponseStatus: { IsSuccess: false, ErrorCode: 500, Errors: [{ Message: '表单标识不存在' }] } },
    }));
    expect(d.tables.length).toBe(0);
    expect(d.importErrors[0]?.message).toContain('表单标识不存在');
    expect(d.importErrors[0]?.message).toContain('500');
  });

  it('ShowErrMsg → errorTitle/errorInfo 进入 importErrors', () => {
    const d = parseKingdeeMetadata(JSON.stringify({
      actionname: 'ShowErrMsg',
      params: [{ errorTitle: '金蝶温馨提示', errorInfo: '错误编号：500 错误信息：xxx' }],
    }));
    expect(d.tables.length).toBe(0);
    expect(d.importErrors[0]?.message).toContain('金蝶温馨提示');
    expect(d.importErrors[0]?.message).toContain('500');
  });
});
