# deepSeekCode

基于 DeepSeek 的 AI 编码助手（类 Claude Code 架构）：agent 主循环 + 工具系统 + MCP + Hooks + Skills。

## 开发规则

- **优先使用箭头函数**（`const fn = (...) => {...}`），减少 `function` 关键字和 `class` 的使用频率。仅当确实需要 hoisting、`this` 绑定或构造函数语义时才用 `function`/`class`；对象方法可用简写（`execute(args){}`，不算 `function` 关键字）。

## 运行与调试

- 服务启动**必须**指定 core tsconfig（`@/` 路径别名只在 `src/core/tsconfig.json` 配置，根 tsconfig.json 没有，否则报 `Cannot find package '@/tool'`）：
  ```
  npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts
  ```
- 默认监听 `127.0.0.1:3000`；`HOST`/`PORT` 环境变量可覆盖。鉴权：设 `DEEPSEEK_CODE_TOKEN` 跨重启稳定，否则启动时随机生成并打印到 stdout。
- 配置位置：声明式 hooks → `~/.deepSeekCode/settings.json` 或 `<项目>/.deepSeekCode/settings.json`；skills → 对应目录下的 `skills/<name>/SKILL.md`。

## 架构要点

- **agent 主循环**：`src/core/src/agent/runAgent.ts`（流式 `AsyncGenerator`）。硬约定：`message[0]=system`、`message[1]=summary 槽`，被 `ensureSummarySlot`/`ensureFitsWindow` 强依赖——**勿改前两个下标**，提示词注入一律追加到 `message[0].content`。
- **工具注册**：`src/core/src/tool/index.ts` 聚合 `agentTools`；新增工具在 `tool/registry/` 加文件并 `push`；工具协议见 `tool/type.ts`（`CustomTool`，含 safetyLevel/审批/锁/环境断言等）。
- **扩展机制**：
  - Hooks：`src/core/src/hooks/`，6 类生命周期事件（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd），声明式配置 + 程序化注册。
  - Skills：`src/core/src/skills/`，目录发现（builtin/global/project）+ `load_skill` 按需加载；内置 skill 放 `skills/builtin/<name>/SKILL.md`。
  - MCP：`src/core/src/tool/mcp/`，动态发现外部工具。
- **文档索引**：架构与计划见 `.ai-docs/`（对标分析 / 工具扩充 / API 契约 / 验证修复）+ `src/core/方案/`（持久化方案）。
