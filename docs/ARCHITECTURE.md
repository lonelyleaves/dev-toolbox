# DevToolbox 架构文档

> 面向后续维护者（含 AI 助手）的架构总览。改代码前先读本文 + [PDM-NOTES.md](PDM-NOTES.md) + [ROADMAP.md](ROADMAP.md)。

## 1. 项目定位

开源 VS Code 扩展（MIT），11 个开发者工具收进一个 Webview 面板。对标闭源插件 RSSC Toolbox 的功能概念做 clean-room 重写（零素材复制），数据字典中心对标 PDM Reader 并增强（多库逆向 + 比对修复）。

## 2. 分层架构

```
┌─ 宿主进程 (Node, src/extension.ts + src/host/ + src/core/)
│   ├─ 命令注册: devToolbox.open.<toolId> ×11 / devToolbox.openPanel(右上角扳手) /
│   │            devToolbox.editor.*(选区右键) / devToolbox.tab.*(标签页右键,整文件)
│   ├─ ToolboxPanel (core/webview-panel.ts): 单例 Webview 面板, CSP+nonce,
│   │            就绪握手(webview push 'ready') + pendingPrefill 机制
│   ├─ RPC 协议 (core/messaging.ts): webview→host {kind:'request',id,cmd,payload},
│   │            host→webview {kind:'response',id,ok,data|error}; 超时默认 120s
│   └─ host/dispatcher.ts 路由: httpRequest(node http/https 跟随重定向)、
│       dbTestConnection/dbIntrospect/dbSavePassword(mysql2|pg|mssql|oracledb-thin,
│       密码存 SecretStorage)、文件对话框读写、剪贴板、workspaceState 持久化
│
└─ Webview 进程 (浏览器, src/webview/)
    ├─ main.tsx → app.tsx: 左侧分类导航 + 页面路由, 接收宿主 openTool 推送(prefill 选区)
    ├─ bridge.ts: acquireVsCodeApi 封装 host.xxx() RPC
    └─ pages/*Page.tsx: 11 个工具页 (Preact + hooks)
```

**纯逻辑全部隔离**在 `src/logic/` 与 `src/dictionary/`（不 import vscode/DOM），vitest 直测。

## 3. 数据字典中心（核心模块）

### 统一中间模型 src/dictionary/model.ts
`DictionaryModel { version:1, name, dialect: mysql|postgres|mssql|oracle|generic, tables[], importErrors[] }`
TableDef{columns,indexes,foreignKeys,changeTag} / ColumnDef{name,type,pk,nullable,defaultValue,comment,autoIncrement,changeTag}。
**所有导入源解析成该模型；所有导出/diff/规范检查只依赖该模型** → 导入源×导出目标×修复方向自由组合。

### 导入源
| 源 | 实现 | 要点 |
|---|---|---|
| .pdm | pdm.ts | 深度遍历收集 o:Table/o:Reference/o:View/o:Procedure/o:Sequence/o:Domain（兼容 c:Tables 与 c:Children 两种集合）；主键经 c:Keys 的 o:Key(PrimaryKey=1)+列引用回填；序列数值属性名在不同 PD 版本不统一，按候选名取值；详见 PDM-NOTES.md |
| DDL .sql | ddl.ts + logic/sqltoken.ts | 自研词法分析（引号/转义/注释/中文标识符），CREATE TABLE + ALTER FK + PG COMMENT ON |
| Markdown | markdown.ts | 标题分节+管道表 / 含"表名"列的单表 |
| Excel | DictionaryPage 内 xlsx 解析 | 每 sheet 一表，表头模糊匹配 字段/类型/注释/主键；"总览"sheet 跳过 |
| 在线库 | host/db.ts 反向导入 | MySQL(information_schema)/PG(pg_catalog)/MSSQL(sys.*)/Oracle(ALL_*视图,owner=用户名大写)；Oracle 用 Thin 模式免 Instant Client |

### 处理链
- **diffengine.ts**: `diffDictionaries(base=现状库, target=期望字典)` → DiffItem[]（表/列/索引/外键级，类型经 normalizeType 归一比较）；`generateFixSql` 按方言生成 ALTER/CREATE（DROP 类需 includeDangerous=true）；`mergeBaseIntoTarget` 以库为准回写并打三色 changeTag
- **naming.ts**: 规则(表前缀/snake_case/必须注释/必须主键/禁用类型) → Violation[]（部分带 fix 可一键应用）；ROOT_WORDS 词根表生成注释建议
- **exporters.ts**: Markdown/HTML/Word(零依赖 Office HTML, .doc)/Mermaid erDiagram 文本/DDL/Excel sheets/统计/搜索/被引用关系
- **merge.ts**: 多来源合并引擎（纯函数）—— 名称归一化匹配、冲突检测、决议应用、按来源移除；冲突不自动覆盖
- **kingdee.ts**: 金蝶云星空元数据解析（JSON 元数据 / WebAPI 报文 / XML），字段命名按候选名兼容
- **host/project-store.ts**: 项目库（globalStorage 文件库：`projects/index.json` + `<id>/dict.json`），跨工作区复用
- **host/kingdee.ts**: 金蝶 WebAPI 客户端（登录拿 Cookie → 取元数据），接口路径/参数风格可配置，凭据走 `context.secrets`
- ER 图：自研 SVG 网格布局（不依赖 mermaid 渲染，导出 .mmd 文本供外部渲染）

## 4. 构建与打包

- `esbuild.mjs` 双构建：宿主 CJS 单文件（external: vscode/mysql2/pg/mssql/oracledb → 运行时走 node_modules）；Webview ESM+splitting（codicons 字体、chunk 落 dist/webview/）
- **非 watch 构建会先 `cleanDist()` 清空 dist**：esbuild 的 chunk 名带内容哈希，旧 chunk 不会覆盖只会堆积，最终被 vsce 一起打进 vsix
- vsix 瘦身靠 `.vscodeignore`：仅 Webview 使用的依赖（xlsx/sql-formatter/preact/qrcode/jsqr/diff/cron-parser/cronstrue/fast-xml-parser/js-yaml/@vscode/codicons）已被 esbuild 打包进 `dist/webview`，无需再随包分发；**`node_modules/@azure/**` 与 `@js-joda/**` 不能删**（tedious 顶层 eager require，删了 SQL Server 连接直接失败）
- 打包 `npm run package`（vsce）；**本机 Node 18 与新版 undici 不兼容 → package.json 里 overrides 钉 undici@^6.21.0，勿删**
- 安装到 Qoder CN IDE：`"/Applications/Qoder CN IDE.app/Contents/Resources/app/bin/code" --install-extension xxx.vsix`；**升级必须先 --uninstall-extension local.dev-toolbox 再装，否则静默失败**

## 5. 测试

`npm run check:pdm -- <xxx.pdm>`：拿真实 PDM 体检（解析量 vs 真实定义节点数对照），已验证 BD基础.pdm（244 表/108 外键/27 视图）与 MFG制造.pdm（1006 表/299 外键/48 视图），均 0 导入错误。

`npm test`（vitest, 131 例）分三层：① 纯逻辑（logic/dictionary）② 契约一致性（工具↔页面↔命令↔菜单↔prefill 交叉校验，防死菜单/空白页）③ UI 冒烟（jsdom 真实渲染 Preact，含 prefill 二次生效回归、13 页挂载）：logic 层（时间戳/cron/curl 分词/INSERT 解析/JSON 修复与代码生成/正则/diff/Java 解析）+ dictionary 层（真实 PDM 结构样例、序列解析、DDL、MD、diff 引擎、四方言修复 SQL、命名规范、Word 导出）。**PDM/DDL 样本全部自造于测试文件内，禁止引入外部素材。**

## 6. 已知坑（改前必读）

1. Webview 是 ESM，**不能用 require()**（JsonPage 曾踩）
2. SearchReplace 类多替换有顺序干扰，改同函数需一次到位
3. fast-xml-parser: 属性前缀 `@_`，PDM 的 Id 是大写 `@_Id`；`<o:Column Ref>` 占位节点要按 `@_Ref` 排除，否则误当实体收集
4. walkDeep 收集回调必须校验 key 模式，否则嵌套同名后缀导致重复（索引列 ['name','name'] 教训）
5. cron-parser `it.next()` 直接返回 CronDate（非 {value,done}）
6. 右键"发送到工具箱"依赖 `editorHasSelection`，无选区菜单不出现——是特性不是 bug
7. **Excel 单工作簿 sheet 上限 255**：导出按表分 sheet，>200 表时必须降级为单表台账（ExportPanel）
8. **大字典渲染阈值**：浏览树 `TREE_RENDER_CAP=300`、ER 图 `ER_RENDER_CAP=60`（仅有关系表），新增列表/图渲染前先想上限；编辑页只克隆当前表不克隆全字典
9. **prefill 必须用 `useEffect([prefill])` 响应，不能用 `useState(prefill.text)` 初始化**：面板已停留在某工具时再次右键送入内容，组件不会重挂载，初始值写法会导致内容不刷新（EncodePage/ColorHashPage 踩过）
10. **`usePersistentState` 的读取是异步的**：先读 workspaceState 再 `setValue`，期间若已被 prefill/用户输入改过（dirty 标记）则不再覆盖，否则会把送入内容冲掉；新增持久化字段须沿用该 hook，不要手写 readState
10.5 **`name` 永远是物理名、`code` 是显示名（中文）** —— 全模型（表/列/视图列/序列/域/DB 反向导入）统一。曾经列解析把 `a:Name`（中文）当 `name`，导致导出的 DDL 字段名是中文、与真实库比对全不匹配。**新增任何解析/展示代码前先确认这对语义，别再用 `c.code || c.name` 猜**
11. **PDM 真实文件的三种"看起来像 bug"的结构**（金蝶 BD基础.pdm 实测）：
    - 视图 SQL 在 `a:View.SQLQuery` / `a:TaggedSQLQuery`，**不是** `a:Select`
    - 视图列节点是 **`o:ViewColumn`**，不是 `o:Column`
    - `o:Reference` 的父表可能指向 **`o:Shortcut`**（跨包快捷引用，带 `a:Code`），必须把 Shortcut 也纳入 Id→表名映射，否则外键被静默丢弃
12. **统计"丢了几个对象"时别用 `grep -c '<o:Table '`**：真实定义是 `<o:Table Id=`，还有大量 `<o:Table Ref=` 占位节点（BD基础.pdm：244 定义 + 392 占位 = 636），按后者计数会误判成丢表——用 `npm run check:pdm` 自动对照
13. **"表没有主键"不一定是解析失败**：MFG制造.pdm 有 10 张表在 PDM 里压根没有 `c:Keys` 块（如 `T_QT_LOTSNRELATION`），属数据现状；主键识别靠 `a:PrimaryKey=1` 或约束名 `PK_` 前缀（含 `a:Code`/`a:Name` 回退，MFG 有 814 个 Key 的 `a:Code` 才是 PK_）
