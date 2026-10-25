import { describe, it, expect } from 'vitest';
import { parsePdm } from '../src/dictionary/pdm';
import { parseDdl } from '../src/dictionary/ddl';
import { parseMarkdownDict } from '../src/dictionary/markdown';
import { diffDictionaries, generateFixSql, mergeBaseIntoTarget } from '../src/dictionary/diffengine';
import { lintDictionary, applyFixes, suggestComments, acceptSuggestions } from '../src/dictionary/naming';
import { exportMarkdown, exportMermaid, exportDdl, exportWordHtml, dictStats, dictSearch, referrersOf, buildExcelSheets } from '../src/dictionary/exporters';
import { emptyDictionary, DictionaryModel } from '../src/dictionary/model';

const SAMPLE_PDM = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="file:///C:/Program%20Files/PD/Template/xsl"?>
<Model xmlns:a="attribute" xmlns:c="collection" xmlns:o="object">
<o:RootObject Id="o1">
<c:Children>
<o:Model Id="o2">
<a:Name>测试模型</a:Name>
<c:Tables>
<o:Table Id="o3">
  <a:Name>用户表</a:Name>
  <a:Code>t_user</a:Code>
  <a:Comment>系统用户</a:Comment>
  <c:Columns>
    <o:Column Id="c1"><a:Name>ID</a:Name><a:Code>id</a:Code><a:DataType>bigint</a:DataType><a:Mandatory>1</a:Mandatory><a:Comment>主键</a:Comment></o:Column>
    <o:Column Id="c2"><a:Name>姓名</a:Name><a:Code>name</a:Code><a:DataType>varchar(64)</a:DataType><a:Length>64</a:Length><a:Comment>姓名</a:Comment></o:Column>
    <o:Column Id="c3"><a:Code>dept_id</a:Code><a:DataType>bigint</a:DataType></o:Column>
  </c:Columns>
  <c:Keys>
    <o:Key Id="k1"><a:Code>PK_T_USER</a:Code><a:PrimaryKey>1</a:PrimaryKey><c:Key.Columns><o:Column Ref="c1"/></c:Key.Columns></o:Key>
  </c:Keys>
  <c:Indexes>
    <o:Index Id="i1"><a:Code>idx_name</a:Code><a:Unique>0</a:Unique>
      <c:IndexColumns><o:IndexColumn Id="ic1"><c:ColumnRef><o:Column Ref="c2"/></c:ColumnRef></o:IndexColumn></c:IndexColumns>
    </o:Index>
  </c:Indexes>
</o:Table>
<o:Table Id="o4">
  <a:Code>t_dept</a:Code>
  <c:Columns><o:Column Id="d1"><a:Code>id</a:Code><a:DataType>bigint</a:DataType><a:Mandatory>1</a:Mandatory></o:Column></c:Columns>
  <c:Keys><o:Key Id="k2"><a:Code>PK_T_DEPT</a:Code><a:PrimaryKey>1</a:PrimaryKey><c:Key.Columns><o:Column Ref="d1"/></c:Key.Columns></o:Key></c:Keys>
</o:Table>
</c:Tables>
<c:References>
  <o:Reference Id="r1">
    <a:Code>fk_user_dept</a:Code>
    <c:ParentTable><o:Table Ref="o4"/></c:ParentTable>
    <c:ChildTable><o:Table Ref="o3"/></c:ChildTable>
    <c:ReferenceJoinElements>
      <o:ReferenceJoinElement Id="rje1">
        <c:ChildColumnRef><o:Column Ref="c3"/></c:ChildColumnRef>
        <c:ParentColumnRef><o:Column Ref="d1"/></c:ParentColumnRef>
      </o:ReferenceJoinElement>
    </c:ReferenceJoinElements>
  </o:Reference>
</c:References>
</o:Model>
</c:Children>
</o:RootObject>
</Model>`;

// 旧版/简化格式：表直接挂 c:Children，主键标在列上
describe('pdm 解析（真实 PowerDesigner 结构）', () => {
  const dict = parsePdm(SAMPLE_PDM);
  it('c:Tables 集合 + 大写 Id 属性', () => {
    expect(dict.tables.length).toBe(2);
    const user = dict.tables.find((t) => t.name === 't_user')!;
    expect(user.comment).toBe('系统用户');
    // name 是显示名（中文或英文大写），code 是物理名（英文小写）
    const idCol = user.columns.find((c) => c.code?.toLowerCase() === 'id' || c.name.toLowerCase() === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.pk).toBe(true);
    expect(idCol!.nullable).toBe(false);
    const nameCol = user.columns.find((c) => c.code?.toLowerCase() === 'name' || c.name.toLowerCase() === 'name');
    expect(nameCol).toBeDefined();
    expect(nameCol!.type).toBe('varchar(64)');
  });
  it('c:Keys 主键对象→列引用回填', () => {
    const user = dict.tables.find((t) => t.name === 't_user')!;
    const idCol = user.columns.find((c) => c.code?.toLowerCase() === 'id' || c.name.toLowerCase() === 'id');
    expect(idCol!.pk).toBe(true);
    const deptCol = user.columns.find((c) => c.code?.toLowerCase() === 'dept_id' || c.name.toLowerCase() === 'dept_id');
    expect(deptCol!.pk).toBeFalsy();
  });
  it('索引与外键引用', () => {
    const user = dict.tables.find((t) => t.name === 't_user')!;
    expect(user.indexes[0].columns).toEqual(['name']);
    expect(user.foreignKeys[0].refTable).toBe('t_dept');
    expect(user.foreignKeys[0].columns).toEqual(['dept_id']);
    expect(user.foreignKeys[0].refColumns).toEqual(['id']);
  });
  it('损坏 XML 容错', () => {
    const bad = parsePdm('<Model><c:Children><o:Table>');
    expect(bad.tables.length).toBe(0);
    expect(bad.importErrors.length).toBeGreaterThan(0);
  });
  it('非 PDM（无表）给出明确错误', () => {
    const empty = parsePdm('<Model><o:RootObject><c:Children></c:Children></o:RootObject></Model>');
    expect(empty.tables.length).toBe(0);
    expect(empty.importErrors.some((e) => e.message.includes('PDM'))).toBe(true);
  });
  it('金蝶导出物变体：PK前缀+ReferenceJoin(Object1/Object2)+Ref占位数组', () => {
    const xml = `<Model xmlns:a="attribute" xmlns:c="collection" xmlns:o="object">
<o:RootObject Id="o1"><c:Children><o:Model Id="o2"><c:Tables>
<o:Table Id="oA"><a:Code>BILL</a:Code><c:Columns>
  <o:Column Id="a1"><a:Code>FID</a:Code><a:DataType>int</a:DataType><a:Mandatory>1</a:Mandatory></o:Column>
</c:Columns><c:Keys><o:Key Id="kA"><a:Name>PK_BILL</a:Name><a:ConstraintName>PK_BILL</a:ConstraintName><c:Key.Columns><o:Column Ref="a1"/></c:Key.Columns></o:Key></c:Keys></o:Table>
<o:Table Id="oB"><a:Code>BILL_L</a:Code><c:Columns>
  <o:Column Id="b1"><a:Code>FID</a:Code><a:DataType>int</a:DataType></o:Column>
  <o:Column Id="b2"><a:Code>FENTRYID</a:Code><a:DataType>int</a:DataType></o:Column>
</c:Columns></o:Table>
</c:Tables>
<c:References><o:Reference Id="oR"><a:Code>Ref_1</a:Code>
  <c:ParentTable><o:Table Ref="oA"/></c:ParentTable>
  <c:ChildTable><o:Table Ref="oB"/></c:ChildTable>
  <c:Joins><o:ReferenceJoin Id="j1">
    <c:Object1><o:Column Ref="b1"/></c:Object1>
    <c:Object2><o:Column Ref="a1"/></c:Object2>
  </o:ReferenceJoin></c:Joins>
</o:Reference></c:References>
</o:Model></c:Children></o:RootObject></Model>`;
    const d = parsePdm(xml);
    expect(d.importErrors).toEqual([]);
    expect(d.tables.length).toBe(2);
    // 无 PrimaryKey 标记，靠 PK_ 约束名识别
    expect(d.tables.find((t) => t.name === 'BILL')!.columns[0].pk).toBe(true);
    // 非标准 Join：Object1=子表列 / Object2=父表列
    const fk = d.tables.find((t) => t.name === 'BILL_L')!.foreignKeys[0];
    expect(fk.refTable).toBe('BILL');
    expect(fk.columns).toEqual(['FID']);
    expect(fk.refColumns).toEqual(['FID']);
  });
});

const SAMPLE_DDL = `CREATE TABLE t_order (
  id bigint NOT NULL AUTO_INCREMENT COMMENT '主键',
  order_no varchar(32) NOT NULL COMMENT '订单号',
  amount decimal(10,2) DEFAULT 0.00,
  status tinyint NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_status (status)
) COMMENT='订单表';

CREATE TABLE t_order_item (
  id bigint NOT NULL,
  order_id bigint NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_item_order FOREIGN KEY (order_id) REFERENCES t_order (id)
);`;

describe('ddl 解析', () => {
  const dict = parseDdl(SAMPLE_DDL, 'mysql');
  it('列/类型/注释/默认值', () => {
    const order = dict.tables.find((t) => t.name === 't_order')!;
    expect(order.comment).toBe('订单表');
    expect(order.columns.find((c) => c.name === 'id')!.pk).toBe(true);
    expect(order.columns.find((c) => c.name === 'id')!.autoIncrement).toBe(true);
    expect(order.columns.find((c) => c.name === 'amount')!.type).toBe('decimal(10,2)');
    expect(order.columns.find((c) => c.name === 'status')!.defaultValue).toBe('1');
  });
  it('索引与约束外键', () => {
    const order = dict.tables.find((t) => t.name === 't_order')!;
    expect(order.indexes.find((i) => i.name === 'uk_order_no')!.unique).toBe(true);
    const item = dict.tables.find((t) => t.name === 't_order_item')!;
    expect(item.foreignKeys[0].refTable).toBe('t_order');
  });
});

const SAMPLE_MD = `# 数据字典

## t_product 商品表
| 字段 | 类型 | 是否为空 | 主键 | 注释 |
|---|---|---|---|---|
| id | bigint | 否 | 是 | 商品ID |
| sku_code | varchar(32) | 否 | | SKU编码 |
| price | decimal(10,2) | 是 | | 售价 |
`;

describe('markdown 字典解析', () => {
  const dict = parseMarkdownDict(SAMPLE_MD);
  it('标题分节 + 表格列映射', () => {
    const t = dict.tables.find((x) => x.name === 't_product')!;
    expect(t.comment).toBe('商品表');
    expect(t.columns.length).toBe(3);
    expect(t.columns[0].pk).toBe(true);
    expect(t.columns[0].nullable).toBe(false);
    expect(t.columns[2].comment).toBe('售价');
  });
});

function makeDict(): DictionaryModel {
  const d = emptyDictionary('test', 'mysql');
  d.tables.push({
    name: 't_user',
    columns: [
      { name: 'id', type: 'bigint', pk: true, nullable: false },
      { name: 'name', type: 'varchar(32)', nullable: true, comment: '姓名' },
    ],
    indexes: [], foreignKeys: [],
  });
  return d;
}

describe('diff 修复引擎', () => {
  it('字典 vs 库：新增列/类型变更/删表', () => {
    const db = makeDict();
    const target = makeDict();
    target.tables[0].columns.push({ name: 'email', type: 'varchar(64)' });
    target.tables[0].columns[1].type = 'varchar(64)';
    db.tables.push({ name: 't_legacy', columns: [], indexes: [], foreignKeys: [] });

    const items = diffDictionaries(db, target);
    expect(items.some((i) => i.level === 'column' && i.object === 'email' && i.kind === 'added')).toBe(true);
    expect(items.some((i) => i.object === 'name' && i.kind === 'modified' && i.changes[0].prop === '类型')).toBe(true);
    expect(items.some((i) => i.level === 'table' && i.kind === 'removed' && i.dangerous)).toBe(true);
  });
  it('生成修复 SQL（默认不含 DROP）', () => {
    const db = makeDict();
    const target = makeDict();
    target.tables[0].columns.push({ name: 'email', type: 'varchar(64)' });
    target.tables[0].columns.push({ name: 'gone', type: 'int' });
    db.tables[0].columns[1].comment = '旧注释';
    const sqls = generateFixSql(db, target, false);
    expect(sqls.some((s) => /ADD COLUMN `email`/.test(s))).toBe(true);
    expect(sqls.some((s) => /DROP COLUMN/.test(s))).toBe(false);
    expect(sqls.some((s) => /COMMENT '旧注释'|COMMENT/.test(s))).toBe(true);
    const withDrop = generateFixSql(target, db, false);
    expect(withDrop.some((s) => /DROP COLUMN `gone`/.test(s))).toBe(false);
    expect(generateFixSql(target, db, true).some((s) => /DROP COLUMN `gone`/.test(s))).toBe(true);
  });
  it('以库为准回写字典带变更标记', () => {
    const db = makeDict();
    const target = makeDict();
    target.tables[0].columns[1].type = 'varchar(999)';
    db.tables[0].columns.push({ name: 'extra', type: 'int' });
    const merged = mergeBaseIntoTarget(db, target);
    const nameCol = merged.tables[0].columns.find((c) => c.name === 'name')!;
    expect(nameCol.type).toBe('varchar(32)');
    expect(nameCol.changeTag).toBe('modified');
    expect(merged.tables[0].columns.find((c) => c.name === 'extra')!.changeTag).toBe('added');
  });
  it('SQL Server 方言修复 SQL', () => {
    const db = makeDict();
    db.dialect = 'mssql';
    const target = makeDict();
    target.dialect = 'mssql';
    target.tables[0].columns.push({ name: 'email', type: 'nvarchar(64)' });
    const sqls = generateFixSql(db, target, false);
    expect(sqls.some((s) => /ALTER TABLE \[t_user\] ADD \[email\] nvarchar\(64\) NULL;/.test(s))).toBe(true);
    const dropSql = generateFixSql(target, db, true);
    expect(dropSql.some((s) => /DROP COLUMN \[email\]/.test(s))).toBe(true);
  });
  it('Oracle 方言建表与修复 SQL', () => {
    const d = emptyDictionary('ora', 'oracle');
    d.tables.push({
      name: 'T_USER',
      comment: '用户表',
      columns: [
        { name: 'ID', type: 'NUMBER(19,0)', pk: true, nullable: false, comment: '主键' },
        { name: 'NAME', type: 'VARCHAR2(64)', nullable: true },
      ],
      indexes: [{ name: 'IDX_NAME', unique: false, columns: ['NAME'] }],
      foreignKeys: [],
    });
    const ddl = exportDdl(d);
    expect(ddl).toContain('CREATE TABLE "T_USER"');
    expect(ddl).toContain('"ID" NUMBER(19,0) NOT NULL');
    expect(ddl).toContain("COMMENT ON TABLE \"T_USER\" IS '用户表'");
    expect(ddl).toContain('CREATE INDEX "IDX_NAME" ON "T_USER" ("NAME");');
    const base = emptyDictionary('ora', 'oracle');
    base.tables.push({ name: 'T_USER', columns: [{ name: 'ID', type: 'NUMBER(19,0)', pk: true, nullable: false }], indexes: [], foreignKeys: [] });
    const sqls = generateFixSql(base, d, false);
    expect(sqls.some((s) => /ADD \("NAME" VARCHAR2\(64\)\)/.test(s))).toBe(true);
  });
});

describe('命名规范与注释补全', () => {
  it('扫描违规并一键修复', () => {
    const d = makeDict();
    d.tables[0].columns.push({ name: 'userName', type: 'varchar(16)' });
    d.tables.push({ name: 'order_log', columns: [{ name: 'id', type: 'text', pk: true }], indexes: [], foreignKeys: [] });
    const v = lintDictionary(d, { tablePrefix: 't_', requireComment: true, requirePrimaryKey: true, forbiddenTypes: ['TEXT'] });
    expect(v.some((x) => x.rule === '表名前缀')).toBe(true);
    expect(v.some((x) => x.rule === 'snake_case' && x.fix)).toBe(true);
    expect(v.some((x) => x.rule === '禁用类型')).toBe(true);
    const fixed = applyFixes(d, v);
    expect(fixed.tables.some((t) => t.name === 't_order_log')).toBe(true);
    expect(fixed.tables[0].columns.some((c) => c.name === 'user_name')).toBe(true);
  });
  it('注释建议与采纳', () => {
    const d = makeDict();
    d.tables[0].columns.push({ name: 'mobile', type: 'varchar(11)' });
    const s = suggestComments(d);
    expect(s.find((x) => x.column === 'mobile')!.suggestion).toBe('手机号');
    const accepted = acceptSuggestions(d, s.filter((x) => x.column === 'mobile'));
    expect(accepted.tables[0].columns.find((c) => c.name === 'mobile')!.comment).toBe('手机号');
  });
});

describe('导出与统计', () => {
  const d = makeDict();
  it('Markdown/Mermaid/DDL/Excel sheets', () => {
    expect(exportMarkdown(d)).toContain('## t_user');
    expect(exportMermaid(d)).toContain('erDiagram');
    expect(exportDdl(d)).toContain('CREATE TABLE `t_user`');
    expect(buildExcelSheets(d).length).toBe(2);
  });
  it('统计与搜索', () => {
    const st = dictStats(d);
    expect(st.tables).toBe(1);
    expect(st.commentedColumns).toBe(1);
    expect(dictSearch(d, '姓名')[0].column).toBe('name');
    expect(dictSearch(d, 't_user').length).toBeGreaterThan(0);
  });
  it('被引用关系', () => {
    const d2 = makeDict();
    d2.tables.push({ name: 't_child', columns: [], indexes: [], foreignKeys: [{ name: 'fk1', columns: ['uid'], refTable: 't_user', refColumns: ['id'] }] });
    expect(referrersOf(d2, 't_user')[0].table).toBe('t_child');
  });
});

describe('PDM 显示名清洗（a:Name 形如「物理名(中文名)」）', () => {
  const xml = `<Model xmlns:a="attribute" xmlns:c="collection" xmlns:o="object"><o:RootObject Id="o1"><c:Children><o:Model Id="o2">
<c:Tables>
  <o:Table Id="t1"><a:Name>T_BD_STAFF(员工表)</a:Name><a:Code>T_BD_STAFF</a:Code>
    <c:Columns><o:Column Id="c1"><a:Code>FPKID</a:Code><a:Name>主键</a:Name><a:DataType>int</a:DataType></o:Column></c:Columns>
  </o:Table>
  <o:Table Id="t2"><a:Name>T_BD_DEPT</a:Name><a:Code>T_BD_DEPT</a:Code></o:Table>
  <o:Table Id="t3"><a:Name>工号（员工编号）</a:Name><a:Code>T_HR_NO</a:Code></o:Table>
</c:Tables></o:Model></c:Children></o:RootObject></Model>`;
  const dict = parsePdm(xml);

  it('「物理名(中文名)」→ 显示名只留中文名，不再重复', () => {
    const t = dict.tables.find((x) => x.name === 'T_BD_STAFF')!;
    expect(t.code).toBe('员工表');
    expect(t.comment).toBe('员工表'); // a:Comment 为空时用清洗后的显示名兜底
  });
  it('显示名与物理名完全相同 → 不产生显示名（避免 UI 重复两行）', () => {
    expect(dict.tables.find((x) => x.name === 'T_BD_DEPT')!.code).toBeUndefined();
  });
  it('括号内不是物理名的补充说明 → 原样保留', () => {
    expect(dict.tables.find((x) => x.name === 'T_HR_NO')!.code).toBe('工号（员工编号）');
  });
  it('列名不受影响（列的中文名本来就单独存在 code 里）', () => {
    const cols = dict.tables.find((x) => x.name === 'T_BD_STAFF')!.columns;
    expect(cols[0].name).toBe('FPKID');
    expect(cols[0].code).toBe('主键');
  });
});

describe('PDM 序列解析（o:Sequence）', () => {
  const xml = `<Model xmlns:a="attribute" xmlns:c="collection" xmlns:o="object">
<o:RootObject Id="o1"><c:Children><o:Model Id="o2">
<c:Tables>
  <o:Table Id="o3"><a:Code>t_user</a:Code>
    <c:Columns><o:Column Id="c1"><a:Code>id</a:Code><a:DataType>bigint</a:DataType></o:Column></c:Columns>
  </o:Table>
</c:Tables>
<c:Sequences>
  <o:Sequence Id="s1">
    <a:Name>用户序列</a:Name><a:Code>SEQ_USER</a:Code><a:Comment>用户主键序列</a:Comment>
    <a:StartValue>1</a:StartValue><a:IncrementBy>1</a:IncrementBy>
    <a:MinValue>1</a:MinValue><a:MaxValue>9999999999</a:MaxValue>
    <a:CurrentValue>100</a:CurrentValue><a:Cache>20</a:Cache><a:Cycle>1</a:Cycle>
  </o:Sequence>
  <o:Sequence Id="s2"><a:Code>SEQ_ORDER</a:Code><a:InitialValue>1000</a:InitialValue><a:Increment>10</a:Increment></o:Sequence>
</c:Sequences>
</o:Model></c:Children></o:RootObject></Model>`;

  const dict = parsePdm(xml);

  it('解析出序列且不影响表解析', () => {
    expect(dict.tables.length).toBe(1);
    expect(dict.sequences?.length).toBe(2);
  });
  it('标准属性名（StartValue/IncrementBy/CurrentValue/Cycle）', () => {
    const s = dict.sequences!.find((x) => x.name === 'SEQ_USER')!;
    expect(s.start).toBe('1');
    expect(s.increment).toBe('1');
    expect(s.min).toBe('1');
    expect(s.max).toBe('9999999999');
    expect(s.current).toBe('100');
    expect(s.cache).toBe('20');
    expect(s.cycle).toBe(true);
    expect(s.comment).toBe('用户主键序列');
  });
  it('备选属性名（InitialValue/Increment）也能识别', () => {
    const s = dict.sequences!.find((x) => x.name === 'SEQ_ORDER')!;
    expect(s.start).toBe('1000');
    expect(s.increment).toBe('10');
    expect(s.cycle).toBeUndefined();
  });
  it('无序列的 PDM 不产生 sequences 字段', () => {
    const d2 = parsePdm(SAMPLE_PDM);
    expect(d2.sequences).toBeUndefined();
  });
});

/**
 * 真实 PowerDesigner 文件采样回归（金蝶 BD基础.pdm，2.86MB / 244 表 / 108 外键 / 27 视图）
 * 属性名与节点名均取自该真实文件，样本为按需缩小后的等价片段（不引入外部素材）
 */
describe('PDM 真实结构回归（BD基础.pdm）', () => {
  const xml = `<Model xmlns:a="attribute" xmlns:c="collection" xmlns:o="object">
<o:RootObject Id="o1"><c:Children><o:Model Id="o2">
<c:Tables>
  <o:Table Id="o542"><a:Name>T_BD_STAFF(员工表)</a:Name><a:Code>T_BD_STAFF</a:Code>
    <c:Columns><o:Column Id="c1"><a:Code>FPKID</a:Code><a:DataType>int</a:DataType><a:Mandatory>1</a:Mandatory></o:Column></c:Columns>
    <c:Keys><o:Key Id="k1"><a:Code>PK_STAFF</a:Code><a:PrimaryKey>1</a:PrimaryKey><c:Key.Columns><o:Column Ref="c1"/></c:Key.Columns></o:Key></c:Keys>
  </o:Table>
  <o:Table Id="o544"><a:Code>T_BD_STAFF_L</a:Code>
    <c:Columns><o:Column Id="c2"><a:Code>FSTAFFID</a:Code><a:DataType>int</a:DataType></o:Column></c:Columns>
  </o:Table>
</c:Tables>
<c:Shortcuts>
  <o:Shortcut Id="o605"><a:Name>T_BD_STAFF(员工表)</a:Name><a:Code>T_BD_STAFF</a:Code>
    <a:TargetID>BC1EB2B1-7DB3-4108-B189-4FE6D9C8101C</a:TargetID><a:TargetPackagePath>&lt;Model&gt;::1.基础资料</a:TargetPackagePath>
  </o:Shortcut>
</c:Shortcuts>
<c:References>
  <o:Reference Id="o4730"><a:Name>reference_42</a:Name><a:Code>reference_42</a:Code>
    <c:ParentTable><o:Table Ref="o605"/></c:ParentTable>
    <c:ChildTable><o:Table Ref="o544"/></c:ChildTable>
    <c:Joins><o:ReferenceJoin Id="o4731">
      <c:Object1><o:Column Ref="c2"/></c:Object1><c:Object2><o:Column Ref="c1"/></c:Object2>
    </o:ReferenceJoin></c:Joins>
  </o:Reference>
  <o:Reference Id="o9999"><a:Code>reference_broken</a:Code>
    <c:ParentTable><o:Table Ref="oNOTEXIST"/></c:ParentTable>
    <c:ChildTable><o:Table Ref="o544"/></c:ChildTable>
  </o:Reference>
</c:References>
<c:Views>
  <o:View Id="o448"><a:Name>V_ITEMCLASS_SUPPLYTYPE_L(多语言视图)</a:Name><a:Code>V_ITEMCLASS_SUPPLYTYPE_L</a:Code>
    <a:View.SQLQuery>SELECT FPKID, FORGId AS FItemId, FLocaleId, FName AS FName FROM T_ORG_Organizations_L</a:View.SQLQuery>
    <c:Columns>
      <o:ViewColumn Id="o4500"><a:Name>FPKID</a:Name><a:Code>FPKID</a:Code></o:ViewColumn>
      <o:ViewColumn Id="o4501"><a:Name>物料分类内码</a:Name><a:Code>FItemId</a:Code></o:ViewColumn>
    </c:Columns>
  </o:View>
</c:Views>
</o:Model></c:Children></o:RootObject></Model>`;

  const dict = parsePdm(xml);

  it('视图：认 a:View.SQLQuery（而非只认 a:Select）', () => {
    const v = dict.views!.find((x) => x.name === 'V_ITEMCLASS_SUPPLYTYPE_L')!;
    expect(v).toBeDefined();
    expect(v.definition).toContain('SELECT FPKID');
    expect(v.definition).toContain('T_ORG_Organizations_L');
  });
  it('视图：认 o:ViewColumn 节点（视图列不再恒为 0）', () => {
    const v = dict.views!.find((x) => x.name === 'V_ITEMCLASS_SUPPLYTYPE_L')!;
    expect(v.columns.length).toBe(2);
    // 与表列同语义：name=物理名，code=显示名（中文）
    expect(v.columns.map((c) => c.name)).toEqual(['FPKID', 'FItemId']);
    expect(v.columns[1].code).toBe('物料分类内码');
    // 视图列不声明类型，应留空而非伪造 varchar
    expect(v.columns[0].type).toBe('');
  });
  it('外键：父表指向 o:Shortcut 时仍能解析（不再静默丢弃）', () => {
    const child = dict.tables.find((t) => t.name === 'T_BD_STAFF_L')!;
    const fk = child.foreignKeys.find((f) => f.name === 'reference_42')!;
    expect(fk).toBeDefined();
    expect(fk.refTable).toBe('T_BD_STAFF');
    expect(fk.columns).toEqual(['FSTAFFID']);
    expect(fk.refColumns).toEqual(['FPKID']);
  });
  it('外键：父表无法解析时记入导入报告（原先静默 continue）', () => {
    expect(dict.importErrors.some((e) => e.source === 'reference#o9999' && e.message.includes('未解析到表名'))).toBe(true);
  });
});

describe('Word 导出（零依赖 Office HTML）', () => {
  const d = makeDict();
  d.sequences = [{ name: 'SEQ_USER', start: '1', increment: '1', cycle: true }];
  const html = exportWordHtml(d);

  it('含 Office 命名空间与 WordDocument 声明', () => {
    expect(html).toContain('urn:schemas-microsoft-com:office:word');
    expect(html).toContain('<w:WordDocument>');
  });
  it('含表结构与字段行', () => {
    expect(html).toContain('t_user');
    expect(html).toContain('<th>物理名</th>');
    expect(html).toContain('name');
  });
  it('含序列段', () => {
    expect(html).toContain('序列');
    expect(html).toContain('SEQ_USER');
  });
  it('内容做 HTML 转义，防注入', () => {
    const d2 = makeDict();
    d2.tables[0].name = '<img src=x onerror=alert(1)>';
    const out = exportWordHtml(d2);
    expect(out).toContain('&lt;img');
    expect(out).not.toContain('<img src=x');
  });
});
