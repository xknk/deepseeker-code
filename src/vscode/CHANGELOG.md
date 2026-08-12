# Changelog

## 1.0.1

工具系统重构与扩充 + agent 主循环稳定性强化。

### 新增工具

- **持久记忆系统**（`memory_save` / `memory_read` / `memory_list` / `memory_delete`）：跨会话四类记忆（user / feedback / project / reference），agent 可主动保存事实并在后续会话召回，启动时注入记忆索引辅助决策。
- **HTTP 客户端**（`http_request`）：全方法 REST 调用（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS），用于本地前后端联调与 API 测试，返回原始响应（状态码 + 响应头 + body 原文）。默认放行 localhost / 内网段（联调必需），始终拦截云元数据端点。
- **TypeScript / JS 代码导航与诊断**（`get_diagnostics` / `goto_definition`）：基于 in-process LanguageService，精准取类型错误与跳转定义，输出对齐 tsc；无 typescript 模块时自动隐藏。
- **Word / PDF 文档阅读**（`read_docx` / `read_pdf`）：提取 Word 与文字版 PDF 的正文文本，补 `read_file` 读不了的二进制文档。
- **Excel 电子表格阅读**（`read_xlsx`）：把 .xlsx 工作表转为 Markdown 表格返回。

### 引擎与稳定性

- **agent 主循环守护体系**：PHANTOM（卡死 / 幽灵轮）、EARLY_FINAL（有内容提前收尾）、TOOL_DIGEST（拿到工具结果不总结就结束）三重守护，修复多处控制流缺陷。
- **上下文压缩优化**：重复检索检测（dedup 断路器）+ token 估算校准，减少跨轮重复背负与无效压缩，针对 DeepSeek-V4 甜点区再调。
- **计划模式增强**：计划正文可折叠 + 回放控制。
- **信任机制**：新增可信目录管理（首次进入新项目目录交互式确认，防恶意仓库 hook 注入）。

### VS Code 插件

- 聊天面板打开时自动并排到当前编辑器右侧（`ViewColumn.Beside`，设置项 `deepseekerCode.openBeside` 可关）。

### 文档

- 修正 README 中 VS Code 插件目录的失效路径（`src/cli/vscode/` → `src/vscode/`）。

---

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
