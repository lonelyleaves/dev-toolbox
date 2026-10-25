# PowerDesigner PDM 文件格式笔记与解析踩坑

> 来源：v0.2.1 修复"导入 PDM 不成功且不报错"问题的完整结论。改 pdm.ts 前必读。

## 1. 真实 .pdm 文件骨架

```xml
<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="file:///C:/Program Files/.../xxx.xsl"?>
<Model xmlns:a="attribute" xmlns:c="collection" xmlns:o="object">
<o:RootObject Id="o1">
 <c:Children>
  <o:Model Id="o2">
   <a:Name>模型名</a:Name>
   <c:Tables>                          ← 表在 c:Tables 集合！
    <o:Table Id="o3">
     <a:Name>用户表</a:Name>            ← 显示名（中文）
     <a:Code>t_user</a:Code>            ← 物理名（代码），优先作表名
     <a:Comment>注释</a:Comment>
     <c:Columns>
      <o:Column Id="c1">
       <a:Code>id</a:Code><a:DataType>bigint</a:DataType>
       <a:Mandatory>1</a:Mandatory>     ← 1=NOT NULL（注意：不是 Nullable！）
       <a:AutoRec>1</a:AutoRec>         ← 自增
       <a:DefaultValue>0</a:DefaultValue>
      </o:Column>
     </c:Columns>
     <c:Keys>                           ← 主键在 Key 对象，不在列上！
      <o:Key Id="k1">
       <a:PrimaryKey>1</a:PrimaryKey>
       <c:Key.Columns><o:Column Ref="c1"/></c:Key.Columns>   ← 引用列 Id
      </o:Key>
     </c:Keys>
     <c:Indexes>
      <o:Index Id="i1"><a:Unique>0</a:Unique>
       <c:IndexColumns><o:IndexColumn><c:ColumnRef><o:Column Ref="c2"/></c:ColumnRef></o:IndexColumn></c:IndexColumns>
      </o:Index>
     </c:Indexes>
    </o:Table>
   </c:Tables>
   <c:References>                        ← 外键是模型级 Reference 对象
    <o:Reference Id="r1">
     <a:Code>fk_user_dept</a:Code>
     <c:ParentTable><o:Table Ref="o4"/></c:ParentTable>     ← 被引用表
     <c:ChildTable><o:Table Ref="o3"/></c:ChildTable>       ← 带 FK 列的表
     <c:ReferenceJoinElements>
      <o:ReferenceJoinElement>
       <c:ChildColumnRef><o:Column Ref="c3"/></c:ChildColumnRef>
       <c:ParentColumnRef><o:Column Ref="d1"/></c:ParentColumnRef>
      </o:ReferenceJoinElement>
     </c:ReferenceJoinElements>
    </o:Reference>
   </c:References>
  </o:Model>
 </c:Children>
</o:RootObject>
</Model>
```

## 2. 踩坑记录（v0.1 的 bug 为什么静默失败）

| 坑 | 现象 | 结论 |
|---|---|---|
| 表挂在 `c:Tables` 而非 `c:Children` | 解析出 0 表、无异常、UI 只提示"导入完成 0 张表" | **必须深度遍历收集 `o:Table`**，不能假定集合路径；两种结构都要兼容 |
| 主键标记位置 | 列上根本没有 `a:PrimaryKey`（那是简化格式），真实主键在 `c:Keys` 的 `o:Key` 里通过列 Ref 声明 | 先建 `列Id→列名` 映射，Key(PrimaryKey=1) 的引用回填 pk |
| 引用占位节点 | `<o:Column Ref="c1"/>` 与真实 `<o:Column Id="c1">` 同名 key | 收集实体时排除带 `@_Ref` 的节点 |
| Id 属性大小写 | 真实文件是 `Id="o5"`（大写 I） | `@_Id ?? @_id` 双取 |
| 嵌套集合重复收集 | walkDeep 回调对 `o:IndexColumn` 与其内层 `c:ColumnRef` 各命中一次 → 索引列重复 | 回调内必须校验 key 模式（如 `/IndexColumn$/`） |
| CDM/LDM 文件 | 用户可能误选逻辑模型（实体是 o:Table 以外的对象） | 0 表时明确报错提示"确认是 PDM 而非 CDM/LDM" |
| **大文件实体展开上限** | 11MB 金蝶全量 PDM 报 `Entity expansion limit exceeded: 1351 > 1000`，整体失败 | XMLParser 加 `processEntities:false`，并用 decodeEntities() 手动解码 &amp;/&lt;/&#x 等常用实体 |
| **金蝶导出物：主键无 a:PrimaryKey** | 924 个 Key 全无 PrimaryKey 标记，pk 识别为 0 | 约束名/Code/Name 以 `PK_`/`pk_` 开头即视为主键（与 a:PrimaryKey 取或） |
| **金蝶导出物：外键列映射结构不同** | 标准 `c:ReferenceJoinElements/o:ReferenceJoinElement/ChildColumnRef`；金蝶用 `c:Joins/o:ReferenceJoin/c:Object1 + c:Object2` | 两个 Join 键名都收集；Object1=子表列/Object2=父表列；再用"列归属表"智能纠正父子方向防约定差异 |
| **fast-xml-parser 大文件退化（v0.6.0 修复）** | 85MB 金蝶全库 PDM（11315 表/118771 字段）解析 **435 秒**；CPU profile 显示 14.8s 中 12.3s 在 `OrderedObjParser.parseXml`。合成样本却线性（26.9MB→2.28s），加大堆内存无改善，消融（去属性/去空白/去换行）也无改善 → 排除内容与 GC，属解析器自身对超大文本的反复切片开销 | 自研 `parseXmlLight()` 单遍 indexOf 扫描，**435s → 2.0s（209×）**，解析结果与旧解析器**逐项一致**（11315 表/118771 字段/0 错误）。边界（CDATA/注释/DOCTYPE/属性值含 `>`/实体/自闭合）由 test/pdm-xml.test.ts 12 例覆盖 |
| **集合数组中的 Ref 占位节点** | 仅拦截集合本身的 @_Ref 不够；FXP 会把多个 `<o:Table Ref>` 合并成数组，产生 15 条"表缺少名称" | 对 asArray 后的**每个元素**逐个判 @_Ref 再收集 |

## 3. 解析策略（现行实现）

1. **自研轻量扫描器 `parseXmlLight()`（dictionary/pdm-xml.ts）**，只在异常时退回 fast-xml-parser
   配置：`ignoreAttributes:false, attributeNamePrefix:'@_', parseTagValue:false`
2. `walkDeep` 全树收集 `key 匹配 /(^|:)Table$/ 且无 @_Ref` 的节点为表；`/Reference$/` 同理
3. 表内列/键/索引：`findCollection(node, /Columns$|Keys$|Indexes$/)` 不假定具体前缀
4. 外键：`findFirstRef(r, /ParentTable$/)` 等模式在子树内找第一个 `@_Ref`
5. 逐表 try/catch → `importErrors`；**0 表且 0 错误时补一条"非 PDM"错误**（UI 层 0 表弹 error toast 并展示导入报告页）

## 4. 真实文件验证基线（金蝶云星空 MFG制造.pdm，v0.2.2）

- 文件：`开发学习资料/业务系统资料/金蝶云星空/7.6_pdm-bl-lastst/MFG制造.pdm`（11.4MB）
- 结果：**1006 张表 / 14525 列 / 996 表有主键 / 893 表有索引 / 299 个外键（全部含列映射）/ 291 表有注释 / 0 错误 / 解析 ~2.4s**
- 回归保护：test/dictionary.test.ts 含"金蝶导出物变体"用例（PK_前缀 + ReferenceJoin Object1/Object2 + Ref 占位）

## 5. 尚未支持（迭代方向）

- `o:View`（视图定义）、`o:Sequence`（序列）、`o:Procedure`（存储过程）——PDM Reader 的 iPad 版支持展示
- 分区表信息、a:LogicalDataType（逻辑类型对照）
- 超大 PDM（>50MB）：当前为一次性全量建树（85MB 实测 2s，可接受）；若遇 200MB+ 再考虑真流式（边扫边出表，不建整树）
