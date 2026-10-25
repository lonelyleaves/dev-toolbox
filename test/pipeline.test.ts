/**
 * 端到端管线：PDM/DDL 导入 → 字典 → 各格式导出 / 规范检查 / diff 修复 SQL。
 * 目的是保证"整条链路跑得通"，而不是只验证单个函数。
 */
import { describe, it, expect } from 'vitest';
import { parsePdm } from '../src/dictionary/pdm';
import { parseDdl } from '../src/dictionary/ddl';
import {
  exportMarkdown, exportHtml, exportWordHtml, exportMermaid, exportDdl, buildExcelSheets,
} from '../src/dictionary/exporters';
import { lintDictionary } from '../src/dictionary/naming';
import { diffDictionaries, generateFixSql } from '../src/dictionary/diffengine';

const PDM = `<Model xmlns:a="attribute" xmlns:c="collection" xmlns:o="object"><o:RootObject Id="o1"><c:Children><o:Model Id="o2">
<c:Tables>
<o:Table Id="t1"><a:Name>用户表</a:Name><a:Code>t_user</a:Code><a:Comment>系统用户</a:Comment>
  <c:Columns>
    <o:Column Id="c1"><a:Code>id</a:Code><a:Name>主键</a:Name><a:DataType>bigint</a:DataType><a:Mandatory>1</a:Mandatory><a:Comment>主键</a:Comment></o:Column>
    <o:Column Id="c2"><a:Code>name</a:Code><a:Name>姓名</a:Name><a:DataType>varchar(32)</a:DataType><a:Length>32</a:Length><a:Comment>姓名</a:Comment></o:Column>
    <o:Column Id="c3"><a:Code>dept_id</a:Code><a:Name>部门</a:Name><a:DataType>bigint</a:DataType></o:Column>
  </c:Columns>
  <c:Keys><o:Key Id="k1"><a:Code>PK_T_USER</a:Code><a:PrimaryKey>1</a:PrimaryKey><c:Key.Columns><o:Column Ref="c1"/></c:Key.Columns></o:Key></c:Keys>
</o:Table>
<o:Table Id="t2"><a:Code>t_dept</a:Code><a:Comment>部门</a:Comment>
  <c:Columns><o:Column Id="d1"><a:Code>id</a:Code><a:Name>主键</a:Name><a:DataType>bigint</a:DataType><a:Mandatory>1</a:Mandatory><a:Comment>主键</a:Comment></o:Column></c:Columns>
  <c:Keys><o:Key Id="k2"><a:Code>PK_T_DEPT</a:Code><a:PrimaryKey>1</a:PrimaryKey><c:Key.Columns><o:Column Ref="d1"/></c:Key.Columns></o:Key></c:Keys>
</o:Table>
</c:Tables>
<c:References><o:Reference Id="r1"><a:Code>fk_user_dept</a:Code>
  <c:ParentTable><o:Table Ref="t2"/></c:ParentTable><c:ChildTable><o:Table Ref="t1"/></c:ChildTable>
  <c:Joins><o:ReferenceJoin Id="j1"><c:Object1><o:Column Ref="c3"/></c:Object1><c:Object2><o:Column Ref="d1"/></c:Object2></o:ReferenceJoin></c:Joins>
</o:Reference></c:References>
<c:Sequences><o:Sequence Id="s1"><a:Code>SEQ_USER</a:Code><a:StartValue>1</a:StartValue><a:IncrementBy>1</a:IncrementBy></o:Sequence></c:Sequences>
</o:Model></c:Children></o:RootObject></Model>`;

const DDL = `CREATE TABLE t_user (
  id bigint NOT NULL COMMENT '主键',
  name varchar(32) DEFAULT NULL COMMENT '姓名',
  PRIMARY KEY (id)
) ENGINE=InnoDB COMMENT='系统用户';`;

describe('导入 → 导出的全链路', () => {
  const pdm = parsePdm(PDM);

  it('PDM 导入无错误、结构完整（含序列与外键）', () => {
    expect(pdm.importErrors).toHaveLength(0);
    expect(pdm.tables.map((t) => t.name).sort()).toEqual(['t_dept', 't_user']);
    expect(pdm.tables.find((t) => t.name === 't_user')!.foreignKeys[0].refTable).toBe('t_dept');
    expect(pdm.sequences).toHaveLength(1);
  });

  it('字段语义：name=物理名、code=显示名（与表/序列/DB 反向导入一致）', () => {
    const cols = pdm.tables.find((t) => t.name === 't_user')!.columns;
    // 样本里 a:Code=id/name/dept_id，a:Name=主键/姓名/部门（真实金蝶 PDM 就是中文显示名）
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'dept_id']);
    expect(cols.map((c) => c.code)).toEqual(['主键', '姓名', '部门']);
  });

  it('导出的 DDL 用物理名而非中文显示名（否则建表语句不可用）', () => {
    const ddl = exportDdl(pdm);
    expect(ddl).toContain('`id` bigint');
    expect(ddl).toContain('`dept_id`');
    // 逐行取"第一个反引号标识符"= 字段名，不能是中文（COMMENT '主键' 里的中文是合法的）
    const colLines = ddl.split('\n').filter((l) => /^\s+`/.test(l));
    expect(colLines.length).toBeGreaterThanOrEqual(4);
    for (const l of colLines) {
      const ident = l.match(/^\s+`([^`]+)`/)![1];
      expect(ident, `字段名 ${ident}`).not.toMatch(/[一-龥]/);
    }
  });

  it('五种导出格式都能产出且不抛错', () => {
    expect(exportMarkdown(pdm)).toContain('t_user');
    expect(exportHtml(pdm)).toContain('t_user');
    expect(exportWordHtml(pdm)).toContain('SEQ_USER');
    expect(exportMermaid(pdm)).toContain('erDiagram');
    expect(exportDdl(pdm)).toContain('CREATE TABLE');
    const sheets = buildExcelSheets(pdm);
    expect(sheets.length).toBeGreaterThanOrEqual(2);
  });

  it('导出的 DDL 能被自己的 DDL 解析器再吃回去（往返闭环）', () => {
    const ddl = exportDdl(pdm);
    const back = parseDdl(ddl);
    expect(back.tables.length).toBe(2);
    const t = back.tables.find((x) => x.name === 't_user')!;
    expect(t.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'name']));
  });

  it('导出的 Markdown 能被自己的 MD 解析器再吃回去', async () => {
    const { parseMarkdownDict } = await import('../src/dictionary/markdown');
    const md = exportMarkdown(pdm);
    const back = parseMarkdownDict(md);
    expect(back.tables.length).toBe(2);
    expect(back.tables.find((t) => t.name === 't_user')).toBeTruthy();
  });
});

describe('导入 → 规范检查 / diff 修复', () => {
  const rules = { requireComment: true, requirePrimaryKey: true, forbiddenTypes: ['TEXT', 'BLOB'] };

  it('规范检查能给出缺失注释类问题，且不会崩', () => {
    const dict = parsePdm(PDM);
    const v = lintDictionary(dict, rules);
    expect(Array.isArray(v)).toBe(true);
    // dept_id 无注释 → 必然命中「必须有注释」
    expect(v.some((x) => x.table === 't_user' && /注释/.test(x.message || ''))).toBe(true);
  });

  it('以字典为准能生成 ALTER 修复 SQL', () => {
    const base = parseDdl(DDL);            // 现状：只有 2 列
    const target = parsePdm(PDM);          // 期望：含 dept_id
    const items = diffDictionaries(base, target);
    expect(items.some((i) => /dept_id/.test(JSON.stringify(i)))).toBe(true);
    const sqls = generateFixSql(base, target);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.join('\n')).toContain('ALTER TABLE');
    expect(sqls.join('\n')).toContain('dept_id');
  });
});
