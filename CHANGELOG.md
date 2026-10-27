# CHANGELOG

## [0.6.9] - 2026-10-27

### Added
- **一个项目支持多条连接配置**：数据库与金蝶 WebAPI 均可配多条（命名列表）
  - 数据模型 `connections.db` / `connections.kingdee` 由单对象改为命名数组（带 id/name）；旧单配置自动迁移为 `id='default'`
  - 凭据按项目+配置隔离：`default` 沿用旧凭据 key（老密码不丢），新配置拼 configId；拉取缓存按 `<kind>__<configId>` 分槽互不覆盖
  - 「连接配置」页改为多配置列表（新增/重命名/删除/切换选中），测试与凭据"已保存"标记都按当前配置
- **比对修复基线来源重设**：一级选「数据库 / 金蝶 WebAPI / JSON 文件」；数据库二级可选 **SQL Server / MySQL / PostgreSQL / Oracle**（端口自动变）
  - 数据库与金蝶分支均新增「从项目配置预填」下拉（多配置时选一条）；JSON 分为**导入文件 / 粘贴 JSON** 两种输入（粘贴走 parseDtcat）
  - 切走再切回数据库会记住上次 DB 类型（lastDbKind）；WebAPI 复用共享组件 KingdeeWebApiForm
- 拉取后显示基线标签；以基线为准回写字典统一走 mergeBaseIntoTarget（带变更标记）；金蝶 WebAPI 基线的修复 SQL 标注「仅参考，金蝶端无 DDL 执行通道」
- 来源记录新增 `configId`/`configName` 溯源；同步/刷新按来源所属配置拉取；项目栏摘要由布尔改为"配了几条"计数

### Notes
- 多配置贯通宿主命令（projectSync / projectSaveCache / kingdee* / db* 均透传 configId）；`configHashOf` 按具体 configId 算指纹

### Tests
- 新增多配置端到端验证（真实磁盘迁移/凭据与缓存隔离/指纹计数/findDbConfig 回落）与 JSON 粘贴行为测试；累计 327 例通过

### Fixed
- SQL Server 拉取报 `Validation failed: Invalid string`：mssql v11 三参绑定修复（原 0.7.2 修复随版本回退并入本版）

## [0.7.2] - 2026-10-27

### Fixed
- **SQL Server 拉取报 `Validation failed: Invalid string`**：mssql v11 API 变更——
  `input(name, value)` 两参形式中 `sql.NVarChar(x)` 现在是类型描述符工厂，
  旧写法把描述符当成了参数值，执行时 NVarChar 校验必抛错（且之前参数值实际恒为 NULL）
  改为 v11 三参形式 `input('tn', sql.NVarChar(200), tn)`

### Tests
- 新增 1 例回归（mock mssql 锁定 tn 参数值必须绑定为字符串），累计 303 例通过

## [0.7.1] - 2026-10-27

### Changed
- **比对修复页签与连接配置打通**：拉取基准库的连接输入默认预填「连接配置」页签的  本项目 DB 连接（host/port/user/database），密码走项目凭据库留空即可；  手改后点「项目连接」一键还原；手动填了新密码则拉取成功后回存凭据库
- 比对修复的库拉取带上 projectId，与 来源同步/扩展字段 用同一套按项目隔离的凭据

### Tests
- 新增 3 例（RepairPanel 预填/无 preset/一键还原），累计 302 例通过

## [0.7.0] - 2026-10-27

### Added
- **编码转换扩至 15 种模式**（原 6 种），对齐业界在线工具集并覆盖 EAS/ERP 报文场景：
  - 纯文本：全角/半角、码点（文本 ↔ U+XXXX）、摩斯电码
  - 密码学（宿主 node:crypto）：Hash（MD5/SHA1/256/384/512 + HMAC）、AES（5 模式 6 填充，密钥/IV 支持文本/Base64/Hex）、DES/3DES
  - 字符编码（Node ICU）：GBK / GB18030 / Big5 ↔ UTF-8 字节（缺 ICU 时明确报错不静默降级）
  - 随机生成：UUID v4 / 随机密码 / 随机数 / 随机字节（crypto 而非 Math.random）
  - EAS 报文一键解析：Base64 → 字符编码（GBK 失败自动按 UTF-8 重试）→ XML 实体还原
- **参数化交互**：各模式动态参数区（AES 的 ECB 隐藏 IV/流模式隐藏填充等），单向模式隐藏方向选择

### Notes
- OpenSSL 3 封锁单 DES：单 DES 走 des-ede3(K,K,K) 通道（数学上等价 E(K,M)，密文与老 OpenSSL 一致）
- 解密输出按 UTF-8 出明文（修复旧实现把明文再按 outEnc 编码一层的方向错误）

### Tests
- 新增 46 例（crypto-ops 20 / encodex 19 / EncodePage UI 7），累计 299 例通过

## [0.6.9] - 2026-10-27

### Fixed
- **金蝶拉取遇 401/403 不再把裸报文当数据**：登录没拿到会话 Cookie 且服务端要求鉴权时，
  原来把 401 响应体（如 unauthorized）直接塞给解析层报"无字段"，现在返回明确的失败提示
  （指向「高级参数 → 附加请求头」排查指引）

### Added
- **金蝶会话链路测试**：新增 5 例锁定 登录无 Cookie 的警告文案 / 有 Cookie 时元数据请求
  自动携带 kdservice-sessionid / 登录失败抛错 / 401 排查指引

### Tests
- 累计 253 例通过

## [0.6.8] - 2026-10-27

### Changed
- **合并重复的「连接配置」入口**：项目操作栏里的「连接配置」按钮与页签行的
  「连接配置」页签功能完全相同，删掉项目栏那个，统一收敛到页签行一处；
  项目栏保留"点状态点（DB/金蝶绿点）跳去配置"的快捷入口，
  项目操作栏也从 8 个按钮减到 7 个，窄面板下更不容易挤

### Tests
- 新增 1 例：项目栏不渲染「连接配置」按钮、状态点点击仍能进配置页
- 累计 248 例通过

## [0.6.7] - 2026-10-27

### Fixed
- **跨项目比对的「仅当前 / 仅对方」标反了**（自查发现）：
  `diffDictionaries(当前, 对方)` 里 `added` = 对方有、当前无，`removed` = 当前有、对方无，
  而面板把 `added` 标成了「仅当前项目有」，两类数字正好对调。
  现在宿主直接返回 `onlyCurrent` / `onlyOther`（按归属方命名），
  调用方不再需要靠记忆二次翻译；并补了一条测试锁死语义，防止再次搞反

### Tests
- 新增 5 例跨项目比对语义：只有对方有的表 → added、只有当前有的 → removed、
  双方共有但类型不同 → modified、列级方向一致、计数与 summary 命名一致
- 累计 246 例通过

## [0.6.6] - 2026-10-27

### Added
- **跨项目比对**（新页签）：拿当前项目字典和另一个项目的字典逐表逐字段对比，
  输出「仅当前项目有 / 仅对方项目有 / 有差异」三类，并可一键复制 Markdown 差异报告。
  新增宿主命令 `projectDiff`
- **字典搜索索引**（`src/dictionary/search-index.ts`）：每张表预先拼好一条扁平文本，
  搜索时先整表快筛再回扫字段；索引按字典对象缓存。大字典（1 万表 / 12 万字段）
  下的搜索不再每次按键全量扫描
- 左栏表列表改用索引，顺带修掉「同一张表命中多次时在左栏重复出现」的问题

### Fixed（布局：按钮与菜单相互遮挡）
- **删掉 `.split > .left input` 的 `position:sticky; top:0; z-index:2`**：
  滚动容器早已改成内部的 `.vlist`，搜索框不在滚动区，这条规则失效且会盖住下方筛选行
- `.split > .left` 改为 flex 列 + `overflow:hidden`，滚动交给 `.vlist`
- 按钮统一 `white-space:nowrap`，窄面板下长文案不会顶到相邻控件
- 新增 `.dc-header` 吸顶操作区（统计 + 导入操作 + 页签），内容区独立滚动，
  层级：项目层 → 操作层 → 内容层，不再互相压
- 页签行 `.dc-tabs` 改 `nowrap + overflow-x:auto`，13 个页签不再换行把内容行顶下去
- 空字典时也渲染同一套吸顶头部（原来直接早退，布局跟有字典时不一致）

### Tests
- 新增 9 例：搜索索引与原全量扫描结果逐条一致、上限生效、去重；
  跨项目比对面板的空态与结果态；页签行必须在吸顶区内
- 累计 241 例通过

## [0.6.5] - 2026-10-27

### Added
- 侧边栏左侧底部显示版本信息（`DevToolbox v{版本号}`），鼠标悬停可看到构建日期与扩展 id，
  文字可选中复制，便于反馈问题时直接贴版本

### Changed
- `.nav` 改为 flex 列布局：工具列表区（`.nav-scroll`）独立滚动，
  版本条常驻底部，不会被长列表顶出视线

### Fixed
- 版本号由宿主在生成 webview HTML 时注入 `window.__DEVTOOLBOX_VERSION__`，
  不再需要（也无法）在 webview 里硬编码，避免升级后显示与 package.json 不一致

### Tests
- 新增 2 例：footer 渲染且显示注入的版本号；取不到版本号时只显示名称，不出现 `undefined`

## [0.6.4] - 2026-10-27

### Fixed
- **点「测试 SQL 连接 / 测试 WebAPI 配置」看不到任何结果（P0）**：结果存进了
  `testMsg` 状态但从未渲染，请求其实发了、结果丢了。现在结果显示在按钮下方，
  成功绿条 / 失败红条，失败时把接口原文一起显示便于定位
- **「改了连接配置」的过期提示永不生效（P0）**：`projectCacheMeta` 没回传
  `configHash`，而前端靠它比对指纹 → `staleNow` 恒为 false。现已回传指纹，
  前端同时兼容宿主预计算的 `stale`
- **跨项目串数据（P0）**：切换项目时未清理「在线库快照 `dbSnap`」与
  「未确认的冲突 `pending`」→ 切到 B 项目仍拿 A 项目的库结构比对
- **新项目会继承上一个项目的连接（P0）**：新建 / 清空项目只清了字典，
  `projectConfig` / `secretKeys` / `cacheMeta` 残留，可能把 A 客户连接写进 B 项目
- **写盘失败无感知（P0）**：`projectSave` 失败后静默退回 `workspaceState`，
  大字典落盘失败用户不知道，换工作区即丢。现在明确报错并提示立即导出备份
- **无项目时「连接配置」页是空白**：改为提示先新建/选择项目
- **新项目死锁**：空字典时页面直接早退渲染导入页，导致进不去配置页
  （配不了连接 → 拉不了数据 → 永远没字典）。现在配置页在空字典下也可访问
- **同步取消后状态不一致**：`projectSync` 曾在宿主侧提前写缓存，用户在冲突面板
  点取消后缓存已是新的（显示"刚刚拉取"但字典没变）。改为确认合并成功后才写缓存
- 搜索输入改为防抖 200ms；表列表过滤计算加 `useMemo`，避免每次渲染全量扫「表 × 字段」

### Tests
- 新增 10 例：缓存读写与清理、按来源隔离、配置指纹稳定性与变化检测、
  凭据不落缓存文件、连接配置白名单过滤
- 新增 4 例 UI：状态点绿/灰、同步按钮仅对 db/金蝶出现、两个测试按钮存在且
  **结果必须渲染在页面上**（锁定本次 P0 缺陷不再复发）
- 累计 230 例通过

## [0.6.3] - 2026-10-26

### Added
- 代码输入框支持软换行：超宽内容在输入框内自动折行，不再出现横向滚动条
- 行号按视觉行对齐：一个逻辑行折行后只在首行显示编号，续行留空；输入框宽度变化时自动重算（ResizeObserver），字体异步加载后也会重新测量

### Changed
- 代码输入框改为 `pre-wrap + break-all`，折行位置可预测，保证行号与文本严格对齐

### Fixed
- 长单行 JSON / 长 cURL 参数需要横向拖动才能看全的问题

## [0.6.2] - 2026-10-26

### Added
- 代码输入框统一换成带行号的 `CodeArea`（JSON / cURL / SQL 格式化 / SQL 还原 / Java / Diff / 正则 / 编码 / 二维码 / 哈希），行号栏随文本滚动同步
- 新增 `logic/text.ts`：粘贴文本归一化（去 BOM、CRLF → LF、去零宽字符）

### Fixed
- **复制内容带换行/CRLF/BOM 导致解析失败**：JSON 解析、时间戳识别、日期解析、JWT 解码（同时支持 `Bearer ` 前缀与终端折行）均已容错
- **cURL 多行粘贴**：支持 bash `\`、PowerShell 反引号、cmd.exe `^` 三种续行符，以及 cmd 的 `^"` 转义引号
- 项目连接配置里数据库密码的「已保存」标记不刷新（补齐 `savedDbKeys` 数据源，测试连接后也同步刷新）
- SQL 格式化：改方言/关键词大小写/输入内容后输出不刷新；打开页面输出为空
- SQL 还原：大文件逐键解析阻塞 UI，改为防抖解析（手动「解析」仍立即执行）
- JSON 页空输入时误报 `Unexpected end of JSON input` 且右侧显示「✓ JSON 合法」
- 二维码批量生成遇到超容量内容时静默失败

### Changed
- 代码输入框关闭自动换行（改为横向滚动），保证行号与内容严格对齐

## [0.6.1] - 2026-10-25

### Added
- **项目级连接配置**（项目配置页签）：每个项目可配自己的数据库连接与金蝶连接，**切换项目 = 切换字典 + 切换连接**
- 项目栏新增「连接配置」入口；DB 反向导入表单与金蝶拉取都会带上当前项目
- 凭据按项目隔离：密码/appSecret 存 SecretStorage 的 `devtoolbox.project.<id>.<kind>` 键，A/B 客户互不串
- 导出项目包会带走连接配置但**不带密码**；导入后配置自动还原（导入的效果：换机器只需再填一次密码）

### Changed
- 在线库 / 金蝶连接改为**只读项目配置**，项目没配连接时直接拒绝并提示去配置（不再回退全局设置）
- 原有的全局 `devToolbox.kingdee.*` 设置保留为"填充默认值"的来源，可通过 UI 一键带进项目

### Fixed
- **左栏滚不动、无法上下筛选（实测 11315 张表必现）**：根因是 CSS 选择器
  `.page-body.fill > .split`，而实际 DOM 是 `.page-body.fill > 页面根div > .split`，
  直接子代选择器匹配不到 → `.split` 拿不到被约束的高度 → 左栏 `overflow:auto` 无处可滚，
  而 `.page-body.fill` 又是 `overflow:hidden`，于是整页也不滚。改为后代选择器 + 页面根 div 变 flex 列

### Changed
- 左栏不再就地展开字段（选中一张 258 字段的表 = 258 个 DOM 节点，是卡顿主因），字段只显示在右侧详情
- 左栏换成虚拟滚动列表：固定行高，只渲染可视区约 30 行，去掉「仅渲染前 300 张」的上限
- 左栏新增筛选下拉：全部 / 缺中文注释 / 缺主键 / 有变更标记 / 按来源

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
