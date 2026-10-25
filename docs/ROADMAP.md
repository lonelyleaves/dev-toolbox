# ROADMAP — 待办与迭代方向

> 供后续 AI/维护者接手：按优先级排列，标注了现状与切入文件。完成一项就更新此文档并在 CHANGELOG 记一笔。

## P0（用户已明确提出）

- [x] **数据字典管理系统**（v0.6.0）：项目库持久化（globalStorage 文件库，跨工作区复用）、多文件导入合并、项目切换/清空/删除/导出导入包、来源管理、冲突面板
- [x] **扩展字段**：在线库反向导入叠加 PDM 缺失字段（v0.6.0）
- [x] **金蝶云星空接入**（v0.6.0）：表单元数据/WebAPI 报文解析（免账号）+ WebAPI 直连（配置化）
  - [ ] **待校准**：需贵司接口文档或真实报文确认登录/元数据接口名（现按通用形态实现 + 可配置项）

- [x] **PDM 导入真实文件回归**：v0.2.2（金蝶云星空 MFG制造.pdm，11.4MB/1006 表）+ v0.5.0（金蝶 BD基础.pdm，2.86MB/244 表/108 外键/27 视图）两份真实文件验证通过，0 导入错误
- [x] 数据字典中心持续完善（对标 PDM Reader 全功能）：
  - [x] PDM 视图/存储过程/域解析（o:View/o:Procedure/o:Domain）—— v0.4.0 前已完成
  - [x] PDM 序列解析（o:Sequence）+「序列」页签 —— v0.5.0
  - [x] Word 导出 —— v0.5.0，采用零依赖 Office HTML（`.doc`），未引入 docx 库以免继续增大 vsix
  - [x] 表/字段级"跳转"：点击外键/被引用目标表直接选中 —— v0.5.0

## P1（体验与质量）

- [x] JSON 工具箱大文件 Web Worker 解析 —— v0.4.0（`src/webview/json-worker.ts`）
- [x] 面板内导航支持搜索工具 —— v0.5.0
- [x] 各工具页 prefill 超长内容截断策略统一（`clipPrefill()`，默认 20000 字符）—— v0.5.0
- [x] 工具输入跨面板关闭保持（`usePersistentState`）—— v0.5.0
- [ ] ER 图布局优化：当前为网格排布（DictionaryPage ErPanel），FK 密集时连线交叉多 → 可改力导向或按引用拓扑分层
- [ ] cURL：请求历史/收藏独立管理界面（当前仅下拉选择）

## P2（发布与开源）

- [ ] 换正式 publisher 与 repository（package.json 两处占位：`local`、`CHANGEME`）
- [x] 128x128 PNG 图标 + package.json `icon` 字段 —— v0.5.0（`media/icon.png`）
- [x] CI：tsc + vitest + vsce package —— v0.5.0（`.github/workflows/ci.yml`）
- [ ] Open VSX 镜像发布（Cursor/VSCodium 用户）
- [ ] i18n：英文界面（现全中文硬编码，切入点 webview 各页文案集中化）
- [ ] README 演示 GIF 自录（合规要求：不可用任何外部素材）

## P3（远期候选功能）

- [ ] 字典 `.dtcat.json` 与 Git diff 友好的稳定序列化（键排序、时间戳可选剥离）
- [ ] 定时/监听式字典-库漂移检测（激活时 diff 一次并状态栏提示）
- [ ] SQL 执行计划解析工具、HTTP Mock 工具（新工具页，注册进 tool-registry 即可）
- [ ] Oracle 支持 SID 连接方式（现 Thin 仅 Service Name）

## 技术债

- [x] `host.getSettings()` 返回 any → 已定义 `AppSettings` 强类型接口（v0.4.0）
- [ ] DictionaryPage 已超 800 行 → 按 Tab 拆组件文件（browse / export / repair 各自独立文件）
- [ ] 多库 introspect 的 SQL 方言差异集中在 db.ts → 若加达梦/人大金仓需抽象 provider 接口
- [ ] vsix 仍 17.7MB：主要为 mssql→tedious→@azure/identity 链（tedious 顶层 eager require，无法简单剔除）；可选方案是按需动态安装驱动
