# deepSeekCode

基于 DeepSeek V4 的 AI 编码助手（类 Claude Code 架构）：agent 主循环 + 工具系统 + MCP + Hooks + Skills + 声明式子 Agent。HTTP server 架构，支持多并发会话 / SSE 流式 / 远程访问。

## 快速开始

```bash
npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts
```

默认监听 `127.0.0.1:3000`；鉴权 token 见启动日志（设 `DEEPSEEK_CODE_TOKEN` 可跨重启固定）。运行/调试细节见 [CLAUDE.md](./CLAUDE.md)。

## 终端 CLI（React Ink，对标 Claude Code）

除 HTTP server 外，另有一个 **in-process 终端客户端**（`src/cli/`）：直接驱动 `runAgent`，不走 HTTP/端口/token，工具审批走 Ink 原生模态。需先设 `DEEP_SEEK_API_KEY`，并在真实终端运行（Ink 依赖 TTY）。

```bash
# 开发态：从源码用 tsx 跑
pnpm --filter cli dev

# 打包成单文件 bin（esbuild，内联 cli+core 源码，外部化 node_modules 依赖）
pnpm --filter cli build          # 产出 src/cli/dist/cli.mjs
pnpm --filter cli start          # 运行打包产物

# 全局安装（本地仓库）→ 得到 deep-code 命令
pnpm --filter cli build && npm i -g ./src/cli
deep-code [--resume <会话id>] [--plan]
```

快捷键：`Ctrl+C` 退出 · `Esc` 中止/清输入 · `Ctrl+G` 中止当前轮 · `Ctrl+T` 展开/收起思考 · 模态/菜单 `↑↓ Enter`。本地命令：`/help /plan /model /clear /status /exit`。能力对标 Claude Code：流式逐字 / 思考折叠 / 工具卡 / 任务面板 / 审批模态 / 计划模式两阶段 / 模型切换 / 会话恢复。

> 发布到 npm：在 `src/cli/` 下执行 `npm publish`（`prepublishOnly` 会自动构建产物）。安装方 `npm i -g deep-code` 后即可运行 `deep-code`。


## 文档导航

| 文档 | 内容 |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | 项目指令：架构要点、运行调试、开发规则 |
| [.ai-docs/Claude-Code对标分析.md](./.ai-docs/Claude-Code对标分析.md) | 全功能对标 Claude Code + 优化路线 |
| [.ai-docs/API契约.md](./.ai-docs/API契约.md) | 后端 API 契约（前端对接说明书）|
| [.ai-docs/工具扩充计划.md](./.ai-docs/工具扩充计划.md) | 工具链扩充计划与落地状态 |
| [.ai-docs/下一步计划.md](./.ai-docs/下一步计划.md) | 引擎能力盘点与字段时机 |
| [.ai-docs/全项目验证与修复计划.md](./.ai-docs/全项目验证与修复计划.md) | 全项目审查与修复清单 |
