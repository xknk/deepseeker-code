# DeepSeeker-Code for Visual Studio Code

> DeepSeek 驱动的终端级 AI 编程助手（自研 agentic 架构）：agent 主循环 + 工具系统 + MCP + Hooks + Skills + 计划模式 + Undo 回退。

DeepSeeker-Code 把一个完整的 agent 编码引擎塞进 VS Code 的一个聊天面板：流式逐字输出、可折叠思考过程、工具调用卡、内联审批、两阶段计划模式、历史会话续接、文件级 Undo 回退，以及对 MCP / Hooks / Skills / 声明式子 Agent 的全套支持。

- **自包含，无需另装 CLI**：整个 core 引擎已内联进插件，只需填一个 DeepSeek API Key 即可用。
- **与终端版 CLI 同源**：两者共享同一套 core 引擎和 `~/.deepseeker-code/` 数据目录，同一项目下会话可互续。

---

## 安装

### 方式一：VS Code 扩展市场（推荐）

> *（上架后补充市场链接）*

### 方式二：从 .vsix 安装

```bash
# 在 VS Code 命令面板（Ctrl+Shift+P）执行：
# Developer: Install Extension from Location...  →  指向本目录
# 或命令行：
code --install-extension deepseeker-code-<version>.vsix
```

---

## 快速开始

1. **配置 API Key**：打开 VS Code 设置，搜索 `deepseekerCode`，在 **API Key** 填入你的 DeepSeek API Key（也可改用环境变量，见下）。
2. **打开聊天面板**：命令面板执行 `DeepSeeker-Code: 打开聊天`，或快捷键 `Ctrl+Esc`。
3. **开始对话**：在输入框提问即可。agent 会自主读文件、改代码、跑命令，危险操作会弹审批条。

---

## 功能特性

- **流式输出**：逐字打字效果 + 可折叠的思考过程块。
- **工具调用**：读/写/编辑文件 + 符号大纲、运行命令（前台/后台）、ripgrep 搜索 + glob、Git 操作集、网页抓取与搜索、HTTP 客户端（联调）、TypeScript 诊断与跳转、Word/PDF/Excel 阅读，每步以工具卡展示。
- **审批网关**：写操作 / 危险命令弹内联审批（允许本次 / 总是允许 / 拒绝）；「总是允许」会智能落成 glob 规则持久化。
- **两阶段计划模式**：先只读调研出方案 → 你审阅（接受并自动执行 / 逐步审批 / 编辑 / 拒绝）→ 再落地实现。
- **结构化提问**：agent 需要澄清时以选项按钮提问，而非盲猜。
- **历史会话**：`/sessions` 点选续接过往会话；同一项目目录的会话在 CLI 与插件间互通。
- **Undo 回退**：每次写操作前自动备份，可按操作回退文件变更。
- **持久记忆**：跨会话记忆（用户偏好 / 反馈 / 项目约束 / 外部资源），agent 主动保存与召回。
- **多根工作区**：agent 跟随「当前活动编辑器所属文件夹」工作，无需手动切目录。
- **MCP / Hooks / Skills / 子 Agent**：完整的声明式扩展机制（见下「可扩展配置」）。

---

## 配置

### VS Code 设置项

命令面板 → `Preferences: Open Settings` → 搜索 `deepseekerCode`：

| 设置项 | 说明 |
|---|---|
| `deepseekerCode.apiKey` | DeepSeek API Key。**留空**则回退读取环境变量 `DEEP_SEEK_API_KEY`。 |
| `deepseekerCode.model` | 默认模型（如 `deepseek-v4` / `deepseek-v4-flash`）。**留空**回退 `DEEP_SEEK_MODEL`，再缺省 `deepseek-v4-flash`。 |
| `deepseekerCode.apiUrl` | API 基址（兼容 OpenAI 协议的代理可改）。留空回退 `DEEP_SEEK_API_URL`，再缺省 `https://api.deepseek.com`。 |
| `deepseekerCode.auxModel` | 辅助模型（摘要等轻量任务）。留空回退 `DEEP_SEEK_AUX_MODEL`，再缺省 `deepseek-v4-flash`。 |
| `deepseekerCode.reasoningEffort` | 推理力度：`high` / `max`（low/medium 已废弃）。留空回退环境变量，缺省 `high`。 |
| `deepseekerCode.thinking` | 深度思考：`on` / `off`，留空默认开。选 `off` 等价 `DEEP_SEEK_THINKING=0`。 |
| `deepseekerCode.parallelSafeTools` | 同轮 SAFE 只读工具并发（写/审批/后台仍串行）。**默认开**；关掉回退完全串行。 |
| `deepseekerCode.workflowConcurrency` | run_workflow 子 agent 并发上限。留空(0)回退环境变量，缺省 4。 |
| `deepseekerCode.workflowMaxSteps` | run_workflow 单次最大步骤数。留空(0)回退环境变量，缺省 8。 |
| `deepseekerCode.streamIdleTimeoutMs` | 流式 idle 超时(ms)。留空(0)回退环境变量，缺省 120000。 |
| `deepseekerCode.locale` | 界面/回复语言：`zh` / `en`，留空表示首次询问。 |

> 优先级：**设置项 > 环境变量 > 内置默认**。留空(0/未选)的设置项不覆盖环境变量。VSCode 插件**不读取** CLI 的 `~/.deepseeker-code/config.json`——所有配置都在设置界面完成（如需跨 CLI/VSCode 共享某项，用环境变量）。

### 环境变量

> VS Code 里设置环境变量的方式：在系统环境变量里配置，然后**重启 VS Code**（插件激活时读取，激活后改环境变量无效）。

#### 模型 / API（`DEEP_SEEK_*` — 指向 DeepSeek 厂商）

| 变量 | 作用 | 默认 |
|---|---|---|
| `DEEP_SEEK_API_KEY` | DeepSeek API Key（与 `deepseekerCode.apiKey` 二选一，必填） | — |
| `DEEP_SEEK_API_URL` | API 基址（兼容 OpenAI 协议的代理可用此项改） | `https://api.deepseek.com` |
| `DEEP_SEEK_MODEL` | 主模型 | `deepseek-v4-flash` |
| `DEEP_SEEK_AUX_MODEL` | 辅助模型（摘要 / 风险分类） | `deepseek-v4-flash` |
| `DEEP_SEEK_REASONING_EFFORT` | 推理强度，仅 `high` / `max`（`low`/`medium` 已废弃） | `high` |
| `DEEP_SEEK_THINKING` | 深度思考开关，设 `0` 关闭 | 开 |
| `DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS` | 流式 idle 超时（ms） | `120000` |

#### 产品行为（`DEEPSEEKER_CODE_*` / `DEEP_SEEK_*`）

| 变量 | 作用 | 默认 |
|---|---|---|
| `DEEPSEEKER_CODE_DATA_DIR` | 用户数据目录（会话/skills/hooks/mcp 全在此；解决 Windows C 盘小等场景） | `~/.deepseeker-code` |
| `DEEP_SEEK_PARALLEL_SAFE_TOOLS` | 设 `0` 关闭同轮只读工具并发（默认开） | 开（并发） |
| `DEEP_SEEK_WORKFLOW_CONCURRENCY` | run_workflow 子 agent 并发上限 | `4` |
| `DEEP_SEEK_WORKFLOW_MAX_STEPS` | run_workflow 单次步数上限 | `8` |
| `SEARCH_PROVIDER` | 搜索后端 `tavily` / `bing` / `ddg` | 自动（有 Tavily key 用 Tavily，否则 Bing） |
| `TAVILY_API_KEY` | Tavily 搜索密钥 | — |
| `WEB_FETCH_ALLOW_PRIVATE` | 设 `1` 放行 web_fetch 访问内网/回环（云元数据端点仍硬拦） | 关（SSRF 安全） |
| `MCP_CONFIG` | MCP 配置文件路径 | `<数据目录>/mcp.json` |

### 引擎偏好（`settings.json` 的 `engine` 段）

少数用户偏好类参数可在 settings.json 里调（CLI 与插件共享）。在数据目录下编辑 `settings.json`：

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

> 项目级 `<项目>/.deepseeker-code/settings.json` 的 `engine` 段会**覆盖**全局。非法值会被忽略并告警。
>
> ⚠️ **不可调**：上下文窗口（`MAX_HISTORY_TOKENS`）、压缩阈值（`COMPACT_RATIO`）、推理轮数等是针对 DeepSeek-V4 精调过的引擎参数，刻意不开放——调高反而越过精度甜点区。如确需改，改源码重编。

---

## 聊天内命令

在输入框以 `/` 开头：

| 命令 | 作用 |
|---|---|
| `/plan` | 切换计划模式（只读调研 → 方案 → 实现） |
| `/auto` | 切换自动模式（按权限规则自动执行，少打断） |
| `/model <名称>` | 切换模型 |
| `/thinking <off\|high\|max>` | 切换思考强度 |
| `/lang <zh\|en>` | 切换语言 |
| `/sessions` | 列出并续接历史会话 |
| `/clear`、`/new` | 新会话 |
| `/help` | 帮助 |

快捷键：`Ctrl+Esc` 打开聊天面板。

---

## 可扩展配置（声明式）

下列配置对 CLI 与 VS Code 插件**完全一致**，都从 `~/.deepseeker-code/`（全局）+ `<项目>/.deepseeker-code/`（项目，需信任该目录）读取：

| 配置 | 位置 | 作用 |
|---|---|---|
| **Hooks** | `settings.json` 的 `hooks` 段 | 6 类生命周期事件（PreToolUse/PostToolUse/UserPromptSubmit/Stop 等）触发命令/http/注入/子 agent |
| **权限规则** | `settings.json` 的 `permissions` 段 | `allow`/`deny`/`ask` 细粒度工具放行（如 `run_command(npm:*)`） |
| **状态栏** | `settings.json` 的 `statusLine` 段 | 自定义底部状态栏命令（CLI 专用，插件不消费） |
| **MCP** | `mcp.json`（独立文件，**非** settings.json） | 接入外部 MCP server 工具 |
| **Skills** | `skills/<name>/SKILL.md` | 可被 agent 按需加载的技能包 |
| **子 Agent** | `agents/<name>.agent.md` | 声明式子 agent 角色 |
| **斜杠命令** | `commands/<name>.md` | 自定义 `/命令` |
| **输出风格** | `output-styles/<name>.md` | 自定义回复人格 |

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
  }
}
```

MCP 配置（`mcp.json`，独立文件）：

```jsonc
{
  "mcpServers": {
    "local":  { "command": "npx", "args": ["-y", "@xxx/server"], "env": { "KEY": "..." } },
    "remote": { "type": "http", "url": "https://.../mcp", "headers": { "Authorization": "Bearer ..." } }
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

> 工作区 key 由项目绝对路径的 sha256 短哈希派生，故**同一项目在 CLI 和 VS Code 打开会命中同一份会话历史**。

---

## 架构

```text
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  webview（前端，零依赖 DOM）  │  ◄──►  │  extension host（Node 进程）  │
│  聊天流 / 审批条 / 方案卡 /     │ 消息   │  extension.ts 激活/chdir/env  │
│  提问 / 工具栏 / 历史会话       │ 协议   │  host.ts 会话编排             │
└─────────────────────────────┘        └──────────────┬───────────────┘
                                                      │ handleUnifiedChat / agentTools / initEngine
                                              ┌───────▼───────┐
                                              │  core（内联）  │  runAgent / MCP / hooks / undo / skills…
                                              └───────────────┘
```

- **配置注入通道**：插件激活时把 `apiKey`/`model` 写入 `process.env`、`chdir` 到工作区，**之后**才动态 import core；core 的 `appConfig` 与文件沙箱随之就位。
- **审批**：core 的 `createWebRequestApproval` 把 `approval_request` 发给前端 → 前端弹按钮 → `resolveUserApprovalLock` 解锁挂起的工具调用。
- **多根工作区**：按「活动编辑器所属文件夹」解析项目根，每次提问自动跟随，无需重载窗口。

---

## 开发与调试

> 以下面向贡献者。普通用户无需关心。

```bash
cd src/vscode
npm install
npm run build      # 产出 dist/（extension.js 内联 core 全部源码 + webview.js + 资产）
npm run dev        # 监听模式
npm run package    # 打 .vsix（esbuild 瘦身：纯 JS 依赖全 bundle，只 external vscode + vscode-ripgrep）
```

- **F5 调试**：用 VS Code 打开 `src/vscode/`，F5 启动「Run Extension (DeepSeeker-Code)」（preLaunchTask 自动 `node build.mjs`），会弹出 Extension Development Host 新窗口。
- **打包瘦身约定**：`build.mjs` 把 openai/undici/ignore/typescript 等纯 JS 依赖 bundle 进 `dist/extension.js`，`dependencies` 只留 `vscode-ripgrep`（原生 rg 二进制），故 vsix ~4.8MB（随 read_docx/read_pdf/read_xlsx 等新工具引入 mammoth/exceljs/unpdf 等纯 JS 依赖而增长）。新增运行时依赖默认进 `devDependencies`（会被 bundle），只有原生二进制才进 `dependencies`。

---

## 已知限制

- webview 前端零依赖，markdown 为最小渲染器（代码块/行内码/粗体/列表/链接/标题）。
- 插件激活后修改环境变量需重启 VS Code 方能生效（core 模块加载期冻结）。
- 关闭面板时若仍有挂起的审批/提问，重开后需重新触发。

## License

MIT
