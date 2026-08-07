# DeepSeeker-Code

> 基于 DeepSeek 的 AI 编码助手（架构对齐 Claude Code）：agent 主循环 + 工具系统 + MCP + Hooks + Skills + 声明式子 Agent + 计划模式 + Undo 回退。

DeepSeeker-Code 是一套自研的 agentic 编码引擎，外加三个共享同一 core 的入口。core 是一个流式 agent 主循环，配备完整的工具链（读写文件 / 跑命令 / 搜索 / 网页抓取）、审批网关、上下文压缩、会话持久化，以及 MCP / Hooks / Skills / 子 Agent 四套扩展机制。三个入口——VS Code 插件、终端 CLI、HTTP 服务——共享同一引擎和 `~/.deepseeker-code/` 数据目录，同一项目下会话可互续。

---

## 三种使用方式

| 入口 | 适用场景 | 详细文档 |
| --- | --- | --- |
| **VS Code 插件** | 日常编码，IDE 内聊天面板，对齐 Claude Code 插件交互 | [src/cli/vscode/README.md](./src/cli/vscode/README.md) |
| **终端 CLI** | 终端原生体验（React Ink），对标 Claude Code CLI | [src/cli/README.md](./src/cli/README.md) |
| **HTTP 服务** | 程序化对接 / 远程访问 / 多并发会话 / SSE 流式 | 见下方「HTTP 服务」 |

三者功能等价（同一 core 引擎、同一套工具/审批/计划模式/Undo/MCP/Hooks/Skills），区别仅在交互形态。

### VS Code 插件

```bash
# 安装 .vsix（或上架后从市场装）
code --install-extension deepseeker-code-<version>.vsix
```

在设置里填 `deepseekerCode.apiKey`，命令面板 `DeepSeeker-Code: 打开聊天`（或 `Ctrl+Esc`）。**自包含，无需另装 CLI**——core 引擎已内联进插件。详见 [插件 README](./src/cli/vscode/README.md)。

### 终端 CLI

```bash
npm install -g deepseeker-code
export DEEP_SEEK_API_KEY=sk-你的key
cd 你的项目 && deepseeker-code
```

in-process 直驱引擎，工具审批走 Ink 原生模态。详见 [CLI README](./src/cli/README.md)。

### HTTP 服务

```bash
npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts
```

默认监听 `127.0.0.1:3000`；鉴权 token 见启动日志（设 `DEEPSEEKER_CODE_TOKEN` 可跨重启固定，`DEEPSEEKER_CODE_TOKEN_FILE` 可落盘到文件避免 stdout 泄露）。`HOST` / `PORT` 环境变量可覆盖监听地址。

---

## 核心能力

- **流式 agent 主循环**：逐字输出 + 可折叠思考过程，自动上下文压缩（针对 DeepSeek-V4 调过甜点区）。
- **完整工具链**：读/写/编辑/删除文件、运行命令（前台/后台）、ripgrep 搜索、glob、网页抓取与搜索、worktree 管理、子 agent 编排（run_workflow）。
- **审批网关**：SAFE 只读免审、MUTATION/DANGER 弹审；「总是允许」智能落成 glob 权限规则持久化。
- **两阶段计划模式**：只读调研 → 方案审阅（接受并自动执行 / 逐步审批 / 编辑 / 拒绝）→ 落地实现。
- **Undo 回退**：写操作前自动备份，可按操作回退；敏感文件策略可配（skip/deny/allow）。
- **四套扩展机制**：MCP（外部工具）、Hooks（6 类生命周期事件）、Skills（按需技能包）、声明式子 Agent / 斜杠命令 / 输出风格。
- **会话持久化**：按工作区隔离的 transcript，可 `/sessions` 续接。

---

## 配置（三层）

配置由三层拼成，CLI 与 VS Code 插件完全一致（详见各入口 README）：

1. **环境变量**：模型/API（`DEEP_SEEK_*`）、产品行为（`DEEPSEEKER_CODE_DATA_DIR`、并行/workflow、搜索后端等）、HTTP 服务（`HOST`/`PORT`/`DEEPSEEKER_CODE_TOKEN`）。完整清单见 [CLI README](./src/cli/README.md#配置)。
2. **声明式配置文件** `settings.json`：`engine`（引擎偏好白名单）/ `hooks` / `permissions` / `statusLine`；MCP 走独立的 `mcp.json`。从 `~/.deepseeker-code/`（全局）+ `<项目>/.deepseeker-code/`（项目）读取。
3. **目录发现的扩展**：`skills/` / `agents/` / `commands/` / `output-styles/`（builtin → global → project，同名后者覆盖）。

数据目录默认 `~/.deepseeker-code/`（`DEEPSEEKER_CODE_DATA_DIR` 可改）。

---

## 架构（Monorepo）

```text
deepseeker-code/                 # pnpm workspace（src/*）
├── src/core/                    # 引擎：agent 主循环 + 工具 + MCP + hooks + skills + serve
│                                #   private（不单独发布），经 tsconfig @/* 别名内联进 cli/vscode 产物
├── src/cli/                     # 终端 CLI（React Ink）→ 发布为 npm 包 deepseeker-code
│   ├── README.md                #   npm 展示页
│   └── vscode/                  # VS Code 插件（独立用 npm，打 vsix）
│       └── README.md            #   商城展示页
└── .ai-docs/                    # 架构对标 / API 契约 / 扩充计划等设计文档
```

- **core 不发布**：它是引擎源码，被 cli 和 vscode 的 esbuild 构建**内联**进各自产物（`dist/cli.mjs` / `dist/extension.js`），靠 tsconfig 路径别名 `@/* → core/src/*` 引用，不是 npm 依赖。
- **发布面**：只发布 cli 包（`npm publish` 在 `src/cli/`）；VS Code 插件打 `.vsix`（`src/cli/vscode/` 内 `npm run package`）。

### 配置注入流向

```text
CLI argv / VS Code settings  ──▶  process.env + chdir  ──▶  core（appConfig 冻结 + 文件沙箱）
settings.json / mcp.json      ──▶  core 各 loader（bootstrap 期加载）
```

---

## 开发

### 环境要求

- Node.js ≥ 20
- pnpm（workspace 管理 core + cli）；VS Code 插件目录用 npm

### 常用脚本（根目录）

```bash
pnpm install              # 装 core + cli 依赖（workspace）
pnpm typecheck            # tsc -p src/core/tsconfig.json && tsc -p src/cli/tsconfig.json
pnpm test                 # cd src/core && node --import tsx --test tests/*.test.ts

pnpm cli:dev              # 终端 CLI 开发态（tsx 直跑）
pnpm cli:build            # 终端 CLI 打包（esbuild → dist/cli.mjs）
```

VS Code 插件：`cd src/cli/vscode && npm install && npm run build`（或 `npm run dev` 监听、`npm run package` 打 vsix）。

> ⚠️ **core tsconfig 必须显式指定**：`@/` 路径别名只在 `src/core/tsconfig.json` 配了，根 `tsconfig.json` 没有。跑 core 相关命令必须带 `--tsconfig src/core/tsconfig.json`，否则报 `Cannot find package '@/tool'`。

### 开发规则

- **优先箭头函数**（`const fn = (...) => {...}`），少用 `function` / `class`（仅 hoisting / `this` / 构造语义时才用）。
- agent 主循环硬约定：`message[0]=system`、`message[1]=summary 槽`，被 `ensureSummarySlot`/`ensureFitsWindow` 强依赖——**勿改前两个下标**，提示词注入一律追加到 `message[0].content`。
- 完整架构要点见 [CLAUDE.md](./CLAUDE.md)。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [CLAUDE.md](./CLAUDE.md) | 项目指令：架构要点、运行调试、开发规则 |
| [src/cli/README.md](./src/cli/README.md) | 终端 CLI 使用与配置（npm 发布档） |
| [src/cli/vscode/README.md](./src/cli/vscode/README.md) | VS Code 插件使用与配置（商城发布档） |
| [.ai-docs/Claude-Code对标分析.md](./.ai-docs/Claude-Code对标分析.md) | 全功能对标 Claude Code + 优化路线 |
| [.ai-docs/API契约.md](./.ai-docs/API契约.md) | HTTP 服务 API 契约（前端对接说明书） |
| [.ai-docs/工具扩充计划.md](./.ai-docs/工具扩充计划.md) | 工具链扩充计划与落地状态 |
| [.ai-docs/下一步计划.md](./.ai-docs/下一步计划.md) | 引擎能力盘点与字段时机 |
| [.ai-docs/全项目验证与修复计划.md](./.ai-docs/全项目验证与修复计划.md) | 全项目审查与修复清单 |

## License

MIT
