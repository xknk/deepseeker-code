# deepSeekCode

基于 DeepSeek V4 的 AI 编码助手（类 Claude Code 架构）：agent 主循环 + 工具系统 + MCP + Hooks + Skills + 声明式子 Agent。HTTP server 架构，支持多并发会话 / SSE 流式 / 远程访问。

## 快速开始

```bash
npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts
```

默认监听 `127.0.0.1:3000`；鉴权 token 见启动日志（设 `DEEPSEEK_CODE_TOKEN` 可跨重启固定）。运行/调试细节见 [CLAUDE.md](./CLAUDE.md)。

## 文档导航

| 文档 | 内容 |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | 项目指令：架构要点、运行调试、开发规则 |
| [.ai-docs/Claude-Code对标分析.md](./.ai-docs/Claude-Code对标分析.md) | 全功能对标 Claude Code + 优化路线 |
| [.ai-docs/API契约.md](./.ai-docs/API契约.md) | 后端 API 契约（前端对接说明书）|
| [.ai-docs/工具扩充计划.md](./.ai-docs/工具扩充计划.md) | 工具链扩充计划与落地状态 |
| [.ai-docs/下一步计划.md](./.ai-docs/下一步计划.md) | 引擎能力盘点与字段时机 |
| [.ai-docs/全项目验证与修复计划.md](./.ai-docs/全项目验证与修复计划.md) | 全项目审查与修复清单 |
