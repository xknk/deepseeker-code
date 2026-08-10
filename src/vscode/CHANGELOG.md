# Changelog

## 1.0.0

首个公开发布版本。

### 功能

- **流式 agent 主循环**：逐字输出 + 可折叠思考过程，自动上下文压缩（针对 DeepSeek-V4 调过甜点区）。
- **完整工具链**：读写/编辑/删除文件、运行命令（前台/后台）、ripgrep 搜索、glob、网页抓取与搜索、worktree 管理、子 agent 编排（run_workflow）。
- **审批网关**：SAFE 免审、MUTATION/DANGER 弹审；「总是允许」智能落成 glob 权限规则持久化。
- **两阶段计划模式**：只读调研 → 方案审阅（接受并自动执行 / 逐步审批 / 编辑 / 拒绝）→ 落地实现。
- **结构化提问**：以选项按钮提问而非盲猜。
- **会话持久化**：按工作区隔离的 transcript，`/sessions` 续接；与终端 CLI 互续。
- **Undo 回退**：写操作前自动备份，可按操作回退；敏感文件策略可配。
- **四套扩展机制**：MCP（外部工具）、Hooks（生命周期事件）、Skills（按需技能包）、声明式子 Agent / 斜杠命令 / 输出风格。
- **多根工作区**：agent 跟随活动编辑器所属文件夹，无需手动切目录。

### 配置

- VS Code 设置：`deepseekerCode.apiKey` / `model` / `locale`。
- `settings.json`：`engine`（用户偏好白名单：Undo 开关/隐私/保留天数/工具结果截断）、`hooks`、`permissions`、`statusLine`。
- 环境变量：`DEEP_SEEK_*`（模型/API）、`DEEPSEEKER_CODE_DATA_DIR`（数据目录）等。

### 打包

- core 引擎经 esbuild 内联进插件（自包含，无需另装 CLI）；纯 JS 依赖全 bundle，只 external `vscode` + `vscode-ripgrep`，vsix ~3.8 MB。
