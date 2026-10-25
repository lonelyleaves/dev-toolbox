# CHANGELOG

## [0.6.1] - 2026-10-25

### Added
- **项目级连接配置**（项目配置页签）：每个项目可配自己的数据库连接与金蝶连接，**切换项目 = 切换字典 + 切换连接**
- 项目栏新增「连接配置」入口；DB 反向导入表单与金蝶拉取都会带上当前项目
- 凭据按项目隔离：密码/appSecret 存 SecretStorage 的 `devtoolbox.project.<id>.<kind>` 键，A/B 客户互不串
- 导出项目包会带走连接配置但**不带密码**；导入后配置自动还原（导入的效果：换机器只需再填一次密码）

### Changed
- 在线库 / 金蝶连接改为**只读项目配置**，项目没配连接时直接拒绝并提示去配置（不再回退全局设置）
- 原有的全局 `devToolbox.kingdee.*` 设置保留为"填充默认值"的来源，可通过 UI 一键带进项目

## [0.6.0] - 2026-10-25（数据字典管理系统）

### Added
- **项目库（PDMAAS 形态）**：数据字典按"项目"存到扩展全局目录（`globalStorage/projects/`），跨工作区、跨窗口复用
  - 项目操作：切换 / 新建 / 重命名 / 清空 / 删除 / 导出项目包 `.dtproj.json` / 导入项目包
  - **旧版 `workspaceState` 字典首次启动自动迁移为"默认项目"**，不会丢、不用重选文件
- **多来源合并**：一个项目可导入多个来源（PDM/DDL/MD/Excel/在线库/金蝶），按表名归一化匹配后并入
  - 表与字段带 `origin` 溯源；表/字段级差异弹**冲突面板**（逐条选择 + 批量"全部保留原值/全部采用新值"）
  - 新增「来源」页签：查看/刷新（按原路径重解析）/禁用/移除来源，移除时精确回滚该来源带来的表与字段
- **扩展字段**：新增「扩展字段」页签 —— 在线库反向导入叠加 PDM 缺失字段；**金蝶云星空接入**
  - 金蝶方式一：粘贴表单元数据或 WebAPI 返回报文即可解析（不需要网络/账号）
  - 金蝶方式二：WebAPI 直连（站点/账套/接口路径/参数风格均可配置，appSecret 与密码只存 `context.secrets`）
- 新增模块：`dictionary/merge.ts`（纯函数合并引擎）、`dictionary/kingdee.ts`（元数据解析）、`host/project-store.ts`、`host/kingdee.ts`、`webview/pages/dictionary/panels.tsx`

### Changed
- 字典持久化从 `workspaceState`（单字典）改为项目文件库（多项目，容量无限制）
- 导入不再整份覆盖：一律走合并；PDM 优先级高于 DDL/Excel，在线库与金蝶作为补充来源

### Fixed
- **超大 PDM 解析从 435 秒降到 2 秒（209×）**：85MB 金蝶全库 PDM（11315 表/118771 字段）原需 7 分钟，定位到瓶颈是 fast-xml-parser 的 `parseXml`（profile 显示 12.3s/14.8s）；改用自研轻量扫描器 `parseXmlLight()`（单遍扫描），解析结果与旧解析器完全一致
- 无项目时导入会因 state 异步而无限建项目：合并入参改为显式传 `projectId`/`base`
- 刷新来源时旧贡献未撤回（删掉的字段会残留）：改为先 `removeSource` 撤回再合并
- 金蝶 WebAPI `appSecret`/密码被 `undefined` 覆盖，导致取不到密钥
- 来源面板「导入新来源」只支持 PDM：改为按扩展名自动分派（pdm/sql/md/json）

### Tests
- 测试覆盖 131 → 160 例：合并引擎 17 例（归一化匹配/冲突回报/逐条与批量决议/移除来源/多来源优先级/迁移）、金蝶解析 5 例（JSON 元数据/WebAPI 报文/XML/去重/异常处理）

### 金蝶解析按真实 QueryBusinessInfo 报文重写（本次拿到真实返回后修正）
- **一个表单按 Entrys 拆成多张物理表**（用 `TableName`），不再「一表单=一表」——实测一份销售订单表单 = 13 张表 / 508 列
- 列名取 `FieldName`（物理列名）、标题取多语言 `Name[{Key:2052,Value}]`，不再猜；`Key` 只作逻辑名
- `FieldType` 按 **SQL Server system_type_id** 映射真实类型并带长度（231→`nvarchar(30)`、61→datetime、106→decimal、127→bigint…）
- **主键字段并不在 `Fields` 数组里**，改从实体 `EntryPkFieldName` 补出，类型由 `PkFieldType`（.NET 类型串）推断 → 修掉"每张表都没有主键"的隐性错
- `Extends` 枚举值写入列注释（如 `单据状态；枚举：Z=暂存, A=创建, B=审核中…`）；`IsViewVisible=false` 标注「界面已隐藏」
- 旧版/其他形态的元数据仍走通用候选名兜底，不会因为字段命名差异整份丢失

### 金蝶接口校准（依据官方文档与公开资料）
- 元数据接口改为官方的 `DynamicFormService.QueryBusinessInfo.common.kdsvc`（原为推测的 `GetFormMetadata`）
- 登录参数保持官方数组形态 `[acctID, username, password, lcid]`；会话改取 `Set-Cookie` 里的 **`kdservice-sessionid`**
- 请求体改为官方命名对象 `{"FormId":"BD_MATERIAL"}`（`argStyle` 默认 `named`；`parameters` 数组形式仍可切换）
- 解析器按真实报文语义校准：`Key`=字段名、`Name`/`Caption`=中文标题，`MustInput=1` → 必填，`IsViewVisible=false` → 标注「界面已隐藏」
- 新增 `extraHeaders` 配置，应对需要额外鉴权头的部署

### 待确认
- 官方文档页（vip.kingdee.com 知识库）需登录才能读到正文，**返回报文的完整层级（字段名所在层级、是否有 Entity/Items 分组）尚未经真实报文验证**；拿到一段真实返回后可进一步收紧解析

## [0.5.0] - 2026-10-24

### Added
- **数据字典 · 序列（Sequence）**：解析 PDM `o:Sequence`，新增「序列」页签展示起始/步长/最小最大/当前值/缓存/循环
  - 【假设】不同 PowerDesigner 版本属性名不统一，已兼容 `a:StartValue|a:InitialValue`、`a:IncrementBy|a:Increment` 两种写法
- **数据字典 · 外键跳转**：表详情的外键与被引用列表，点击目标表名即跳转并选中该表
- **数据字典 · Word 导出**：新增 `word` 导出格式（零依赖 Office HTML，保存为 `.doc`，Word/WPS 可直接打开），含序列段
- **工具输入持久化**：JSON / SQL 格式化 / cURL / 正则 / 编码转换 / SQL 还原 / Java 转 JSON / 文本对比 / 二维码 的输入跨面板关闭保留
- **面板导航搜索**：左侧导航顶部搜索框，按名称/描述/分类过滤工具

### Fixed（严重：PDM 字段语义反了）
- **导出的 DDL 字段名全是中文**：PDM 里 `a:Name` 是中文显示名（主键/内码/语言标识）、`a:Code` 才是物理名（FPKID/FID），但列解析把中文当成了 `name`。后果：DDL 导出不可执行、与真实库比对全部字段不匹配、命名规范检查对中文字段全量误报、Mermaid 的 FK 标记失效
- 统一为**「`name`=物理名、``code``=显示名」**（与表 / 序列 / 域 / DB 反向导入 / 各导出器一致），并同步修正 UI 与 Word 导出的两列展示
- 回归锁定：新增"字段语义"与"导出 DDL 用物理名"两条测试

### Fixed（真实 PDM 回归：金蝶 BD基础.pdm，2.86MB / 244 表 / 108 外键 / 27 视图）
- **视图 SQL 全空**：真实属性名是 `a:View.SQLQuery`（格式化后为 `a:TaggedSQLQuery`），解析器只认 `a:Select` → 现按优先级取三者
- **视图列恒为 0**：视图列节点是 `o:ViewColumn`，正则 `/(^|:)Column$/` 不匹配 → 改为 `/(^|:)(View)?Column$/`，且类型留空不再伪造 `varchar`
- **外键静默丢失 5 条**：部分 Reference 的父表指向 `o:Shortcut`（跨包快捷引用，如 o605→T_BD_STAFF），未纳入 Id→表名映射 → Shortcut 参与映射，外键 103 → 108（与文件内 108 个 o:Reference 一致）
- 外键父/子表无法解析时不再静默 `continue`，改为记入导入报告

### Fixed
- **prefill 二次失效**：编码转换、颜色页用 `useState(prefill)` 初始化，面板已停留在该工具时再次右键送入内容不刷新 → 改为响应 `prefill` 变化
- **字典页签重复渲染**：视图/存储过程/域面板被渲染了两次（`DictionaryPage.tsx` 六行重复 JSX）→ 删除重复，页签文案抽为 `TAB_LABEL`/`TAB_TITLE` 常量
- **截断策略统一**：各工具页 prefill 统一走 `clipPrefill()`（默认 20000 字符），修复时间戳页硬编码 32 字符导致长文本里的时间戳被切掉

### Added
- **PDM 体检脚本**：`npm run check:pdm -- <xxx.pdm>`，输出解析量并与文件内 `o:xxx Id=` 真实定义节点数对照（占位 `Ref=` 节点单独计数），便于用真实文件快速发现"丢对象"

### Changed（工程化）
- 构建前清空 `dist`：esbuild 的哈希 chunk 旧产物不再堆积进 vsix
- vsix 瘦身 26.7MB → 17.7MB：仅 Webview 使用的依赖（xlsx/sql-formatter/preact/…）已被打包进 `dist/webview`，不再随包重复分发；剔除 `codepage` 死重与 sourcemap
- 新增 `media/icon.png`（128×128）并在 `package.json` 声明 `icon`
- 新增 GitHub Actions CI：tsc + vitest + vsce package

### Tests
- 测试覆盖 98 → 131 例，新增三层：
  - 字典：序列解析（6 例）、Word 导出（4 例，含 HTML 转义防注入）、真实 PDM 结构回归（4 例）、字段语义与 DDL 物理名（2 例）
  - 契约（8 例）：工具↔页面↔命令↔菜单↔prefill 交叉校验、持久化键唯一
  - UI 冒烟（5 例，jsdom 真实渲染）：prefill 二次送入生效回归、导航搜索过滤、13 个工具页逐个挂载

## [0.4.0] - 2026-10-24

### Added
- **编码转换工具**：Base64 / URL / Hex / Unicode / HTML 实体编解码，JWT Token 解码，支持双向转换与交换输入
- **颜色/哈希/UUID 工具**：
  - 颜色格式互转（HEX↔RGB↔HSL）、CSS 颜色解析、实时预览
  - WCAG 对比度检测（AA/AAA 等级）
  - SHA 哈希计算（SHA-1/256/384/512，Hex/Base64 输出）
  - UUID v4 批量生成（最多 1000 个）
- **Web Worker**：大 JSON（>100KB）处理卸载到后台线程，避免主线程卡顿

### Fixed
- `formatMillis(Infinity)` 不再与 NaN 混淆，分别返回"无效时间"和"超出可表示范围"
- `parseDateInTz` 修复时间部分未补零导致 `Date.parse` 返回 NaN 的 bug
- cURL 解析器新增 `--json` 标志支持（curl 7.82+），自动设置 Content-Type/Accept
- `AppSettings` 类型安全：`host.getSettings()` 从 `any` 改为强类型接口

### Tests
- 测试覆盖从 48 例提升至 98 例，新增边界条件、编码转换、颜色工具、UUID 等测试

## [0.3.0] - 2026-10-24

### Changed（UI 美化）
- 全局视觉升级：左侧导航分组+悬停/激活态、页面头部图标、卡片标题强调条、圆角按钮/输入框/表格、斑马纹与悬停行、胶囊徽章、空状态与提示条样式、自定义滚动条、加载动画

### Fixed
- 编辑页改表名后选中错位（选中项改为跟随新表名）
- 大字典性能：浏览树超过 300 表仅渲染前 300（提示用搜索）；ER 图超过 60 表仅渲染有关系的表（提示导出 Mermaid）；编辑页仅克隆当前表，不再每次按键深拷贝整个字典
- Excel 导出超过 200 张表会超 Excel 255 sheet 限制 → 自动改为单 sheet「全部字段」台账
- 二维码嵌入 Logo 未等待图片加载可能画不出来 → 预加载后绘制
- JSON 工具箱逐键解析大文本卡顿 → 300ms 防抖
- SQL 还原切换超过结果表数时索引越界
- 清理无用 hook / 事件监听改用 useEffect 并支持卸载

## [0.2.2] - 2026-10-24

### Fixed
- 真实文件（金蝶云星空 MFG制造.pdm，11.4MB/1006 表）验证通过：表/列/主键/索引/外键全部解析，0 错误
- 大文件实体展开上限（processEntities 默认 1000）导致整体解析失败 → 关闭实体处理并手动解码常用实体
- 金蝶导出物主键无 `a:PrimaryKey` 标记 → 增加 `PK_`/`pk_` 约束名识别规则
- 金蝶导出物外键列映射用 `c:Joins/ReferenceJoin/Object1+Object2` → 两种 Join 结构均支持，并按列归属表纠正父子方向
- 集合数组内 `<o:Table Ref>` 占位节点漏过滤 → 产生"表缺少名称"的错误清空

### Changed
- 面板标题随工具切换实时更新（修复标签页标题停留在上次工具的问题）

## [0.2.1] - 2026-10-24

### Fixed
- **PDM 导入静默失败**：解析器重写为深度遍历，兼容真实 PowerDesigner 结构（表挂 `c:Tables`、主键经 `c:Keys` 的 Key 对象引用列 Id、外键模型级 `c:References`、大写 `Id` 属性、`@_Ref` 占位节点排除）；索引列重复收集修复
- 导入 0 张表时明确报错（error toast + 导入报告页展示原因），不再"无反应"

### Tests
- PDM 测试样本改为真实 PowerDesigner 结构，新增"非 PDM 文件明确报错"用例（47 例全通过）

## [0.2.0] - 2026-10-24

### Added
- 数据字典中心数据库连接扩展至 4 种：MySQL / PostgreSQL / **SQL Server**（mssql/tedious）/ **Oracle**（oracledb Thin 纯 JS，免 Instant Client）
- 修复 SQL 生成支持 mssql/oracle 方言（ADD/ALTER COLUMN/MODIFY/DROP 语法与标识符风格、注释差异处理）
- 表详情新增按方言的建表 SQL 预览（对标 PDM Reader SQL 视图）
- 切换数据库类型自动带默认端口（3306/5432/1433/1521），Oracle 提示填服务名

## [0.1.3] - 2026-10-24

### Removed
- 左侧活动栏 DevToolbox 树形视图（文字冗余，与面板内导航重复）

## [0.1.2] - 2026-10-24

### Added
- 编辑器右上角标题栏常驻「扳手」按钮，一键打开工具箱；按当前文件语言智能落位（json/sql/java）

## [0.1.1] - 2026-10-24

### Added
- 顶部标签页右键 DevToolbox 子菜单：整个文件送入 格式化 JSON / 格式化 SQL / 解析 cURL / Java 转 JSON / 时间戳 / 对比左侧

## [0.1.0] - 2026-10-24

### Added
- 初始版本：11 个工具（时间戳/Cron/Diff/cURL/JSON/Java转JSON/正则/数据字典中心/SQL格式化/SQL还原/二维码）
- 数据字典中心：PDM/DDL/Markdown/Excel/在线库(MySQL/PG) 导入、浏览检索、编辑标记、命名规范、比对修复、多格式导出、ER 图
- MIT 开源合规：零外部素材、THIRD_PARTY_NOTICES、43 例单测
