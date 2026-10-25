# 贡献指南

感谢愿意一起改进 DevToolbox。本项目的目标很朴素：**每条改动都要能在真实数据上跑通**，所以流程偏重"验证"。

## 环境

- Node.js 20（CI 用 20）
- VS Code ≥ 1.85（用于 `npm run build` 之外手动安装验证）

```bash
npm ci
npm run compile    # tsc 类型检查，必须 0 错误
npm test           # vitest 单测，必须全绿
npm run build      # esbuild 构建宿主 + webview
npm run package    # 产出 .vsix
```

**提交前必须 `npm run compile` && `npm test` 全绿。**

## 目录约定

| 目录 | 放什么 | 注意 |
|---|---|---|
| `src/host/` | 需要 VS Code / Node API 的代码（文件、网络、SecretStorage） | 不易单测，逻辑尽量薄 |
| `src/webview/` | Preact 面板 UI | 只通过 `bridge.ts` 与宿主通信 |
| `src/core/` | 纯逻辑（格式化、转换、协议类型） | 无副作用，必须可单测 |
| `src/dictionary/` | 数据字典模型与解析器（pdm/ddl/md/kingdee/merge） | 纯函数为主 |

新增宿主命令要三处同步：`src/core/messaging.ts`（命令名与载荷类型）、`src/host/dispatcher.ts`（实现）、`src/webview/bridge.ts`（前端调用）。

## 测试要求

- 解析器类改动：**必须**附真实结构样例（脱敏后放 `test/fixtures/`）
- 合并/存储类改动：跑 `npm run check:merge -- <a.pdm> <b.pdm>` 做真实数据回归
- 纯 UI 改动：在 `test/ui.test.tsx` 补渲染断言（怕的就是"编译通过但面板打不开"）

## 不要提交这些东西

`.vsix`、`dist/`、`node_modules/`、任何 `.env` / 凭据文件、`scripts/_*.tmp.*` 临时脚本，
以及**含真实客户数据的文件**（真实 PDM、真实 ERP 元数据报文、真实库连接串）。
需要样例时请脱敏：删掉客户私有字段（如 `F_SCY_*`、`F_QQTS_*` 这类自定义字段），只保留结构。

## 风格

- 注释与文档用中文；代码标识符用英文
- 能写成纯函数的逻辑，不要写进 `.tsx`
- 修改第三方依赖行为前先看 `docs/DEV-GUIDE.md` 里的合规红线
