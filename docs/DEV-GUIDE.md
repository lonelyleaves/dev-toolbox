# 开发/验证指南（环境速查）

## 环境

- Node.js ≥ 18（当前开发机 v18.20.8）；**若升级 Node 到 20+，可移除 package.json 中 `overrides.undici`**
- IDE：Qoder CN IDE（VS Code 内核），CLI 路径：`/Applications/Qoder CN IDE.app/Contents/Resources/app/bin/code`

## 日常命令

```bash
cd dev-toolbox
npm install                # 首次
npm run build              # esbuild 双构建（改代码后必跑）
npm run compile            # tsc --noEmit 类型检查
npm test                   # vitest 47 例
npm run package            # 产出 dev-toolbox-<version>.vsix
```

## 修改 → 验证闭环（每轮迭代标准流程）

1. 改 `src/` 代码
2. `npx tsc --noEmit && npm test`（都绿才继续）
3. 升 `package.json` version（sed 或手改）
4. `npm run build && npm run package`
5. **先卸载再安装**（同版本覆盖会静默失败）：
   ```bash
   CODE="/Applications/Qoder CN IDE.app/Contents/Resources/app/bin/code"
   $CODE --uninstall-extension local.dev-toolbox
   $CODE --install-extension dev-toolbox-<new-version>.vsix
   $CODE --list-extensions --show-versions | grep dev-toolbox   # 确认版本
   ```
6. IDE 内 `Cmd+Shift+P` → `开发人员: 重新加载窗口`
7. 功能入口：右上角标题栏扳手按钮 / 命令面板 `DevToolbox:` / 标签页右键 / 编辑器选区右键

## 调试

- 扩展宿主报错：菜单 帮助 → 切换开发人员工具 → Console；或输出面板选扩展宿主日志
- Webview 白屏：面板打开后 帮助 → 切换开发人员工具，找对应 webview 的报错；常见原因是 CSP（新引入外部资源需改 `core/webview-panel.ts` 的 CSP 头）
- 纯逻辑 bug：直接在 `test/` 加用例复现（逻辑层无 vscode/DOM 依赖，vitest 秒级跑完）
- 开发模式热编译：`npm run watch` + F5（`.vscode/launch.json` 已配 Extension Development Host）

## 数据库联调（数据字典中心）

- MySQL/PG：本地 Docker 即可
- SQL Server：`mcr.microsoft.com/mssql/server:2022-latest`（端口 1433，database 填库名）
- Oracle：database 栏填**服务名**（如 `ORCLPDB1`），默认端口 1521；驱动为 oracledb Thin 纯 JS 模式，**无需安装 Instant Client**
- 密码存 SecretStorage（不落配置）；连接表单留空密码时会尝试读取已存密码

## 合规红线（开源前必守）

- 不复制 RSSC/PDM Reader 任何素材（GIF/文案/CSS/图标），演示图只能自录
- 不引入 GPL/AGPL 依赖；新增依赖必须同步更新 THIRD_PARTY_NOTICES.md 并核对许可证
- 测试样本一律自造（PDM/DDL 样例见 test/dictionary.test.ts）
