# DeepSeeker-Code

> DeepSeek 驱动的终端级 AI 编程助手，架构对齐 Claude Code：agent 主循环 + 工具系统 + MCP + Hooks + Skills + 计划模式 + Undo 回退。本包是 **React Ink 终端客户端**。

```bash
npm i -g deepseeker-code
export DEEP_SEEK_API_KEY=sk-你的key
cd 你的项目
deepseeker-code
```

DeepSeeker-Code 在你的终端里跑一个自主 agent：流式逐字输出、可折叠思考过程、工具调用卡、审批模态、两阶段计划模式、会话恢复，全套对标 Claude Code。**in-process 直驱引擎**——不走 HTTP/端口，工具审批走 Ink 原生模态。

> 另有 **VS Code 插件**版本（同名 `deepseeker-code`），与终端版同源共享 core 引擎和 `~/.deepseeker-code/` 数据目录，同一项目下会话可互续。

---

## 前置要求

- **Node.js ≥ 20**（esbuild target node20）
- **DeepSeek API Key**：仅通过环境变量 `DEEP_SEEK_API_KEY` 提供（**无交互式输入、无 `--model` 参数**）；缺失会直接退出并提示。
- **真实终端（TTY）**：UI 基于 React Ink，依赖 TTY；不要在 `npm run` / 管道 / 非交互 shell 里跑。

---

## 快速开始

```bash
# 1. 全局安装
npm install -g deepseeker-code

# 2. 配置 API Key（写入 shell 配置持久化，如 ~/.bashrc / ~/.zshrc / PowerShell $PROFILE）
export DEEP_SEEK_API_KEY=sk-你的key          # Windows PowerShell: $env:DEEP_SEEK_API_KEY="sk-..."

# 3. 进入项目目录运行（agent 的工作区 = 当前目录）
cd ~/projects/my-app
deepseeker-code

# 可选：进入即计划模式
deepseeker-code --plan
```

---

## 命令行参数

| 参数 | 短写 | 作用 |
| --- | --- | --- |
| `--resume <会话id>` | `-r` | 续接指定会话 |
| `--continue` | `-c` | 自动续接本工作区最近一次会话 |
| `--plan` | `-p` | 初始进入计划模式（只读调研 → 方案 → 实现） |
| `--auto` | `-a` | 初始进入自动模式（按权限规则自动执行，少打断） |

> 没有 `--model` / `--print` / `--output-style` / `--session` 等参数。模型经 `DEEP_SEEK_MODEL` 环境变量设；输出风格经运行时 `/output-style <名称>` 切换。

## 聊天内命令

输入框以 `/` 开头（输入 `/` 会弹出补全菜单）：

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/plan` | 切换计划模式 |
| `/auto` | 切换自动模式 |
| `/model <名称>` | 切换模型 |
| `/thinking <off\|high\|max>` | 切换思考强度 |
| `/lang <zh\|en>` | 切换语言 |
| `/output-style <名称>` | 切换输出风格（人格） |
| `/sessions` | 列出并续接历史会话 |
| `/clear` | 新会话 |
| `/status` / `/usage` / `/context` | 查看状态 / 用量 / 上下文 |
| `/permissions` / `/mcp` / `/hooks` | 查看已加载的权限规则 / MCP / Hooks |
| `/debug` | 调试信息 |
| `/exit` / `/quit` | 退出 |

**快捷键**：`Ctrl+C` 退出 · `Esc` 中止/清输入 · `Ctrl+G` 中止当前轮 · `Ctrl+T` 展开/收起思考 · 模态/菜单 `↑↓ Enter`。

---

## 配置

### 环境变量

#### 模型 / API（`DEEP_SEEK_*` — 指向 DeepSeek 厂商）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DEEP_SEEK_API_KEY` | DeepSeek API Key（**必填**） | — |
| `DEEP_SEEK_API_URL` | API 基址（兼容 OpenAI 协议的代理可改此项） | `https://api.deepseek.com` |
| `DEEP_SEEK_MODEL` | 主模型 | `deepseek-v4-flash` |
| `DEEP_SEEK_AUX_MODEL` | 辅助模型（摘要 / 风险分类） | `deepseek-v4-flash` |
| `DEEP_SEEK_REASONING_EFFORT` | 推理强度，仅 `high` / `max` | `high` |
| `DEEP_SEEK_THINKING` | 深度思考开关，设 `0` 关闭 | 开 |
| `DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS` | 流式 idle 超时（ms） | `120000` |

#### 产品行为

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `DEEPSEEKER_CODE_DATA_DIR` | 用户数据目录（会话/skills/hooks/mcp 全在此） | `~/.deepseeker-code` |
| `DEEP_SEEK_PARALLEL_SAFE_TOOLS` | 设 `1` 开启同轮只读工具并发 | 关（串行） |
| `DEEP_SEEK_WORKFLOW_CONCURRENCY` | run_workflow 子 agent 并发上限 | `4` |
| `DEEP_SEEK_WORKFLOW_MAX_STEPS` | run_workflow 单次步数上限 | `8` |
| `SEARCH_PROVIDER` | 搜索后端 `tavily` / `bing` / `ddg` | 自动（有 Tavily key 用 Tavily，否则 Bing） |
| `TAVILY_API_KEY` | Tavily 搜索密钥 | — |
| `WEB_FETCH_ALLOW_PRIVATE` | 设 `1` 放行 web_fetch 访问内网/回环（云元数据端点仍硬拦） | 关（SSRF 安全） |
| `MCP_CONFIG` | MCP 配置文件路径 | `<数据目录>/mcp.json` |

> CLI 经 Ink 独占 stdout；core 的 console 日志启动期被静默（调试时注释 `main.tsx` 里的重定向即可恢复）。

### 引擎偏好（`settings.json` 的 `engine` 段）

少数用户偏好类参数可在 settings.json 里调（与 VS Code 插件共享）。在数据目录下编辑 `settings.json`：

```jsonc
// ~/.deepseeker-code/settings.json （或 DEEPSEEKER_CODE_DATA_DIR 指向的目录）
{
  "engine": {
    "undoEnabled": true,              // Undo 总开关：false 跳过所有写前备份（紧急降级）
    "undoBackupSensitive": "skip",    // 敏感文件(.env/私钥)备份策略：skip|deny|allow
    "undoRetentionDays": 7,           // Undo 备份保留天数
    "traceRetentionDays": 7,          // trace 诊断日志保留天数
    "MAX_TOOL_RESULT_CHARS": 16000    // 单次工具结果截断长度（读大日志可放宽）
  }
}
```

项目级 `<项目>/.deepseeker-code/settings.json` 的 `engine` 段会**覆盖**全局；非法值会被忽略并告警。

> ⚠️ **不可调**：上下文窗口（`MAX_HISTORY_TOKENS`）、压缩阈值（`COMPACT_RATIO`）、推理轮数等是针对 DeepSeek-V4 精调过的引擎参数，刻意不开放——调高反而越过精度甜点区。如确需改，改源码重编。

### 声明式配置（Hooks / 权限 / 状态栏 / MCP / Skills）

均从 `~/.deepseeker-code/`（全局）+ `<项目>/.deepseeker-code/`（项目，**首次进入该目录会交互式确认信任**）读取。CLI 与 VS Code 插件**完全一致**：

| 配置 | 位置 | 作用 |
| --- | --- | --- |
| **Hooks** | `settings.json` 的 `hooks` 段 | 生命周期事件（PreToolUse/PostToolUse/UserPromptSubmit/Stop 等）触发命令/http/注入/子 agent |
| **权限规则** | `settings.json` 的 `permissions` 段 | `allow`/`deny`/`ask` 细粒度工具放行（如 `run_command(npm:*)`） |
| **状态栏** | `settings.json` 的 `statusLine` 段 | 自定义底部状态栏命令（stdin 收 JSON 上下文，stdout 首行作状态栏） |
| **MCP** | `mcp.json`（独立文件，**非** settings.json） | 接入外部 MCP server 工具 |
| **Skills** | `skills/<name>/SKILL.md` | 可被 agent 按需加载的技能包 |
| **子 Agent** | `agents/<name>.agent.md` | 声明式子 agent 角色 |
| **斜杠命令** | `commands/<name>.md` | 自定义 `/命令` |
| **输出风格** | `output-styles/<name>.md` | 自定义回复人格（`/output-style <name>` 选用） |

settings.json 完整示例（代码真正消费的字段）：

```jsonc
{
  "engine": { /* 见上 */ },
  "hooks": {
    "PreToolUse": [
      { "matcher": "run_command", "command": "./audit.sh", "denyOnNonZero": true }
    ],
    "UserPromptSubmit": [
      { "type": "prompt", "text": "涉及数据库时先确认备份策略。" }
    ]
  },
  "permissions": {
    "allow": ["run_command(npm:*)", "read_file(src/*)"],
    "deny":  ["read_file(.env)", "run_command(rm:*)"],
    "ask":   ["web_fetch(*)"]
  },
  "statusLine": { "command": "~/.deepseeker-code/statusline.sh", "padding": 0 }
}
```

MCP 配置（`mcp.json`，独立文件）：

```jsonc
{
  "mcpServers": {
    "local":  { "command": "npx", "args": ["-y", "@xxx/server"], "env": { "KEY": "..." } },
    "remote": { "type": "http", "url": "https://.../mcp", "headers": { "Authorization": "Bearer ..." } },
    "stream": { "type": "sse", "url": "https://.../sse" }
  }
}
```

---

## 数据目录

默认 `~/.deepseeker-code/`（可用 `DEEPSEEKER_CODE_DATA_DIR` 改位置）。布局：

```text
~/.deepseeker-code/
├── settings.json          # 声明式配置（engine/hooks/permissions/statusLine）
├── mcp.json               # MCP server 配置（独立文件）
├── prefs.json             # UI 偏好（语言等）
├── skills/                # 全局 skills
├── agents/                # 全局子 agent
├── commands/              # 全局斜杠命令
├── output-styles/         # 全局输出风格
└── <工作区key>/           # 按工作区隔离的会话 transcript / trace / undo 备份
```

> 工作区 key 由项目绝对路径的 sha256 短哈希派生，故**同一项目无论从 CLI 还是 VS Code 打开，都命中同一份会话历史**。首次进入一个新项目目录时，CLI 会交互式询问是否信任（信任后才会加载该项目级 hooks/permissions/skills，防恶意仓库）。

---

## 从源码构建（开发者）

```bash
cd src/cli
pnpm install
pnpm build          # esbuild 产出 dist/cli.mjs（内联 cli + core 源码，外部化 node_modules 依赖）
pnpm start          # 运行打包产物
pnpm dev            # 开发态（tsx 直跑）

# 全局安装本地构建：
pnpm build && npm i -g .
```

- **打包约定（与 VS Code 插件不同）**：CLI 用 `packages: "external"`，所有 node_modules 外部化，运行时从全局 `node_modules` 解析（ink/react/openai 等都是真运行时依赖，故留在 `dependencies`）。发布只发 `dist/cli.mjs` 单文件（`files` 字段）。
- **发布到 npm**：在 `src/cli/` 下 `npm publish`（`prepublishOnly` 自动构建）。安装方 `npm i -g deepseeker-code`。

---

## License

MIT
