# DevToolbox 开发者工具箱

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg) ![Node](https://img.shields.io/badge/node-20%2B-brightgreen.svg) ![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-blue.svg) ![Author](https://img.shields.io/badge/author-Leo-orange.svg)

一款免费的开源 VS Code 扩展，把日常开发中高频使用的小工具收进侧边栏：时间戳、Cron、文本对比、cURL、JSON、Java 转 JSON、正则、数据字典、SQL 格式化、SQL 还原、二维码、编码转换、颜色/哈希/UUID。

> 作者 **Leo**。功能灵感来自市面同类工具箱插件；本项目为完全独立实现（clean-room），MIT 开源，
> 转载与二次分发请保留署名，见 [署名说明](NOTICE.md)。

## 目录

- [功能一览](#功能一览)
- [数据字典中心 / 数据字典管理系统](#数据字典中心对标-pdm-reader-并增强)
- [使用入口](#使用入口)
- [隐私与安全](#隐私与安全)
- [开发](#开发)
- [许可证与署名](#许可证与署名)

## 功能一览

| 工具 | 说明 |
|---|---|
| 时间戳转换 | 秒/毫秒/微秒/纳秒自动识别、多时区、相对时间、偏移计算、文本批量识别 |
| Cron 表达式 | 中文人话描述、未来执行时间、24h 执行密度、可视化生成器、常用模板 |
| 文本对比 | 双栏/行内视图、词级高亮、忽略空白/大小写、剪贴板对比、差异块复制 |
| cURL 客户端 | 解析 curl 命令、结构化编辑、发送请求、响应预览、导出 5 种语言代码 |
| JSON 工具箱 | 格式化/压缩、YAML/XML/CSV 互转、生成 TS/Java/Go/Kotlin 类型、JSONPath、非法 JSON 修复、结构对比、树视图 |
| Java 类转 JSON | 解析 Java 源码生成示例 JSON，支持泛型/枚举/嵌套/Jackson 注解 |
| 正则测试 | 实时高亮、分组明细、替换预览、12 个常用正则库、正则含义解释 |
| 数据字典中心 | 见下方专节 |
| SQL 格式化 | 12 种方言、关键字大小写/缩进可配 |
| SQL 还原 | INSERT 语句还原为数据表格，导出 CSV/JSON、生成 UPDATE/DELETE |
| 二维码 | 生成（尺寸/容错/颜色/Logo/批量）与解码 |
| 编码转换 | Base64 / URL / Hex / Unicode / HTML 实体编解码，JWT Token 解码 |
| 颜色/哈希/UUID | 颜色格式互转（HEX↔RGB↔HSL）、WCAG 对比度检测、SHA 哈希计算、UUID 批量生成 |

## 数据字典中心（对标 PDM Reader 并增强）

- **导入**：PowerDesigner `.pdm`、DDL `.sql`（CREATE TABLE）、Markdown 字典、Excel 字典、MySQL/PostgreSQL/SQL Server/Oracle 在线库反向导入；逐表容错并输出导入报告
- **浏览**：树形导航、表/字段/中文注释全局搜索、索引/外键/被引用关系（点击外键目标表可直接跳转）、注释覆盖率统计
- **对象**：表 / 视图 / 存储过程与函数 / **序列**（PDM `o:Sequence`）/ 域定义各自独立页签
- **扩展**：字典内编辑表与字段（新增/修改/删除三色变更标记），保存为 `.dtcat.json` 可进 Git 版本管理
- **规范**：命名规范扫描（表前缀/snake_case/必须有注释/必须有主键/禁用类型）+ 一键修复；词根注释补全建议
- **修复**：字典 vs 真实库字段级 diff 报告；双向修复——以库为准回写字典，或以字典为准生成 ALTER/CREATE 修复 SQL（DROP 类默认不包含）
- **导出**：Markdown / HTML / **Word（.doc，零依赖）** / Excel / DDL / Mermaid erDiagram / 内置简易 ER 图

## 数据字典管理系统（项目化）

一次性加载、跨项目复用，不用每次重新选文件：

- **项目库**：字典按项目存在扩展全局目录，**换工作区/换窗口都能直接用**；支持切换、新建、重命名、清空、删除、导出/导入项目包（`.dtproj.json`）
- **多来源合并**：一个项目可导入多个来源（PDM / DDL / Markdown / Excel / 在线库 / 金蝶），按表名归一化匹配（`T_BD_STAFF` 与 `t_bd_staff` 视为同一张表），表与字段都带来源标记
- **冲突可控**：同名表/字段出现差异时弹冲突面板，逐条选「保留原值 / 采用新值」，也可一键批量；金蝶单模型刷新不会触发大批量冲突
- **来源管理**：「来源」页签可查看、按原路径刷新、禁用、移除来源（移除时只回滚该来源带来的表与字段）
- **扩展字段**：
  - 在线库：在 PDM 基础上叠加真实库里新增的表/字段
  - **金蝶云星空**：① 粘贴表单元数据或 WebAPI 返回报文直接解析（无需网络/账号）② WebAPI 直连（按官方形态实现，见下表；appSecret 与密码只存 VS Code 凭据库，不进项目文件）

**金蝶 WebAPI 配置（`devToolbox.kingdee.*`）**

| 配置项 | 默认/说明 |
|---|---|
| `baseUrl` | 站点地址，如 `http://server/k3cloud` |
| `dbId` / `user` | 数据中心 ID（acctID）与登录用户名 |
| `loginPath` | `AuthService.ValidateUser.common.kdsvc`（参数 `[acctID, user, password, lcid]`） |
| `metadataPath` | `DynamicFormService.QueryBusinessInfo.common.kdsvc`（请求体 `{"FormId":"BD_MATERIAL"}`） |
| `argStyle` | `named`（官方） / `parameters`（数组形式） |
| `extraHeaders` | 附加请求头 JSON，如需额外鉴权头可填 |
| `lcid` | 2052（简体中文） |

会话取登录响应 `Set-Cookie` 里的 **`kdservice-sessionid`** 并回传；报错时把接口原文前 200 字符显示出来，便于定位。

> 旧版本存在 `workspaceState` 的字典会在首次启动时**自动迁移成"默认项目"**，不会丢。

## 使用入口

- 编辑器右上角标题栏「扳手」按钮 → 打开工具箱（按当前文件语言智能落位）
- 命令面板输入 `DevToolbox:`
- 编辑器选中内容右键 → DevToolbox 子菜单（JSON/SQL/cURL/Java/时间戳/对比）
- 顶部标签页右键 → DevToolbox 子菜单（整个文件送入对应工具）
- 面板内左侧导航顶部搜索框：按名称/描述/分类过滤工具

> 注：v0.1.3 已移除活动栏树形视图（与面板内导航重复），入口见上。

## 状态保持

各工具的输入内容（JSON / SQL / cURL / 正则 / 编码转换 / SQL 还原 / Java 转 JSON / 文本对比 / 二维码）会随工作区保留，关闭面板再打开不丢失；数据字典同样会自动缓存并在启动时恢复。

## 隐私与安全

- **不上传任何数据**：本扩展没有服务端，只有你主动点「测试连接 / 反向导入 / 拉取元数据」时才会请求**你自己配置的地址**
- **凭据存系统钥匙串**：数据库密码、金蝶 `appSecret`/密码 存 VS Code `SecretStorage`，不写进项目文件，导出项目包时也不带走
- **反向导入只读结构**：仅读取 `information_schema` 等系统表，不读取业务数据行
- 其余约定见 [SECURITY.md](SECURITY.md)

## 开发

详细文档（供维护者与 AI 助手接手迭代）：

- [CONTRIBUTING.md](CONTRIBUTING.md) — 提交前的检查项、目录约定、**哪些东西不能入库**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构分层、数据字典模型、已知坑
- [docs/PDM-NOTES.md](docs/PDM-NOTES.md) — PowerDesigner PDM 格式结构与解析踩坑
- [docs/ROADMAP.md](docs/ROADMAP.md) — 待办与迭代方向（P0～P3 + 技术债）
- [docs/DEV-GUIDE.md](docs/DEV-GUIDE.md) — 环境、改→测→装→验闭环、四库联调、合规红线
- [CHANGELOG.md](CHANGELOG.md) — 版本演进记录

```bash
npm install
npm run build      # esbuild 双构建（宿主 + webview）
npm run compile    # tsc 类型检查
npm test           # vitest 纯逻辑单测
npm run package    # 产出 .vsix

# 拿真实 PDM 体检：解析量 vs 文件内真实定义节点数对照，快速发现丢对象
npm run check:pdm -- /path/to/xxx.pdm
# 真实数据端到端回归：两份 PDM 的合并 / 并集校验 / 移除来源回滚 / 项目库往返
npm run check:merge -- /path/to/a.pdm /path/to/b.pdm
```

已用两份真实金蝶 PDM 验证（均 0 导入错误）：
`BD基础.pdm` 2.86MB / 244 表 / 108 外键 / 27 视图；`MFG制造.pdm` 10.65MB / 1006 表 / 299 外键 / 48 视图。

F5 运行扩展开发主机（`.vscode/launch.json` 已配置）。

## 许可证与署名

本项目采用 **MIT** 许可证，见 [LICENSE](LICENSE)。

你可以自由使用、复制、修改与再分发，**唯一要求**是保留署名：不得移除版权声明 `Copyright (c) 2026 Leo` 与 MIT 许可全文。
各场景（Fork、抄片段、二次发布、打 VSIX 分发、写教程引用）具体怎么做，见 [NOTICE.md](NOTICE.md)。

第三方依赖的许可证清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
