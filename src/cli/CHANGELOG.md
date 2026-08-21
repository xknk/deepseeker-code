# Changelog

## Unreleased

代码变更红绿 diff 预览 + 计划模式交互对齐 Claude Code；斜杠菜单滚动 + 启动顿挫治理。

### 斜杠菜单与启动

- **菜单视口滚动**：`/` 补全菜单固定显示前 10 条改为视口随选中项滚动（19+ 条本地命令 + 自定义命令后段可选可执行），底栏显示 `↑↓ 滚动 · n/m 条`。
- **启动顿挫治理（UI 先行）**：清屏/横幅/渲染不再等 `initEngine`（MCP 握手常达秒级）——立即进入可交互界面，引擎后台初始化；首次提交/斜杠命令 gate 在 `engineReady` 上（加载中提示一行），就绪后自定义命令目录自动刷新进菜单。

### 终端交互

- **编辑工具红绿 diff**：`edit_file` / `create_file` / `write_file` 工具卡与审批弹窗内联展示变更（LCS 行级 diff + 上下文折叠，− 红 / + 绿，多处以「—— 第 N 处 ——」分隔；纯 UI 层从 args 计算，不耗模型 token）。
- **计划模式对齐 Claude Code**：审批卡「准备开始编码？」四选项（是并自动接受编辑 / 是并手动审批编辑 / 编辑方案 / 否——留在计划模式继续迭代修订）；「否」不再终止，补充要求后模型修订方案再次提交。
- **Markdown 渲染增强**：assistant 标题行（`#`~`######`）剥前缀加粗白渲染——计划方案分节即刻可读。
- **输入框模式标识**：计划模式紫色圆角边框 + `plan mode on` 徽标、自动模式黄色边框 + `auto-accept edits on` 徽标。

---

## 1.0.0

首个 npm 公开发布版本（终端 CLI，React Ink，in-process 直驱 core 引擎）。

### 核心

- **流式 agent 主循环**：逐字输出 + 可折叠思考过程，自动上下文压缩（重复检索检测 + token 估算校准，针对 DeepSeek-V4 调过甜点区）；PHANTOM / EARLY_FINAL / TOOL_DIGEST 三重守护修复多处控制流缺陷。
- **in-process 直驱**：不走 HTTP/端口，工具审批走 Ink 原生模态，独占 stdout。

### 工具链

- 读/写/编辑/移动/删除文件 + 符号大纲（AST）、运行命令（前台/后台进程）、ripgrep 内容搜索 + glob 文件名搜索、Git 操作集（status/log/diff/commit）、网页抓取与搜索、全方法 HTTP 客户端（本地联调）、TypeScript/JS 代码导航与类型诊断、Word/PDF/Excel 文档阅读、依赖清单检查、worktree 管理、子 agent 编排（run_workflow）。
- **持久记忆系统**（`memory_save` / `memory_read` / `memory_list` / `memory_delete`）：跨会话四类记忆（user/feedback/project/reference）。

### 交互

- **审批网关**：SAFE 只读免审、MUTATION/DANGER 弹审；「总是允许」智能落成 glob 权限规则持久化。
- **两阶段计划模式**：只读调研 → 方案审阅（接受并自动执行 / 逐步审批 / 编辑 / 拒绝）→ 落地实现。
- **Undo 回退**：写操作前自动备份，可按操作回退；敏感文件策略可配（skip/deny/allow）。
- **聊天内命令**：`/plan` `/auto` `/model` `/thinking` `/lang` `/sessions` `/output-style` 等。
- **命令行参数**：`--resume <id>` / `--continue` / `--plan` / `--auto`。

### 扩展机制

- MCP（外部工具）、Hooks（6 类生命周期事件）、Skills（按需技能包）、声明式子 Agent / 斜杠命令 / 输出风格。

### 配置

- 三层优先级：环境变量 > `~/.deepseeker-code/config.json` > 内置默认。
- `settings.json`：`engine` / `hooks` / `permissions` / `statusLine`；MCP 走独立 `mcp.json`。
- 首次进入新项目目录交互式确认信任（防恶意仓库 hook 注入）。

### 发布物

- 单文件 `dist/cli.mjs`（esbuild 打包，`packages: "external"` 外部化 node_modules）；`files` 白名单：`dist/cli.mjs` + `dist/builtin`，运行时依赖从全局 `node_modules` 解析。
