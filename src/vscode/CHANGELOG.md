# Changelog

## 1.0.54

代码变更 diff 视图 + 计划模式交互对齐 Claude Code；斜杠命令菜单补全 + 启动顿挫治理。

### 斜杠命令菜单补全（VSCode 与 CLI 对齐）

- **全量命令表**：`/` 菜单从硬编码 10 条（且只显示前 6 条）扩到与 CLI 一致的本地全集（`/usage` `/context` `/permissions` `/mcp` `/hooks` `/trust` `/debug` `/output-style` `/fork` 等观测/管理命令经扩展宿主采集回显）。
- **自定义命令合并**：core 注册的自定义斜杠命令（builtin/global/project 三源 `.md`）在引擎就绪后推送给 webview，合并进 `/` 菜单常驻可见。
- **菜单可滚动**：去掉 6 条截断，限高 260px 滚动 + 选中项 `scrollIntoView` 跟随；拖滚动条不夺输入焦点。
- **CLI 菜单视口滚动**：固定显示前 10 条改为视口随选中项滚动（19+ 条命令后段可选可执行），底栏显示 `n/m 条` 计数。

### 启动顿挫治理（UI 先行、引擎后台加载）

- **VSCode**：`activate` 不再 `await initEngine`（MCP spawn+握手常达秒级，期间 contributes 命令点不动）——面板秒开，引擎后台初始化，首轮提交经 `waitEngineReady` 闸门等待（加载中自动提示）。
- **CLI**：清屏/横幅/渲染不再等引擎初始化完成，立即进入可交互界面；首次提交/斜杠命令 gate 在 `engineReady` 上，引擎就绪后自定义命令目录自动刷新进菜单。

### 代码变更 diff 视图（三档，不依赖 git）

- **内嵌左右对比**：`edit_file` / `create_file` / `write_file` 工具卡与审批弹窗内联红删绿增栅格（纯 UI 层从工具 args 计算 LCS 行级 diff，不进工具结果字符串、不耗模型 token；长上下文自动折叠）。
- **点击放大全屏**：点击内嵌 diff → 占满面板的大号对比（行数上限放开至 3000、上下文保留 6 行），✕ / Esc / 点空白关闭；打开期间接管 ↑↓/Enter，防穿透到审批键盘导航。
- **原生 vscode.diff**：host 在工具执行前同步留存「修改前」快照，工具卡「⎇ 打开左右对比」一键唤起 VS Code 原生 diff 编辑器长期对照（历史回放无快照时按钮自然隐藏）。

### 计划模式对齐 Claude Code

- 方案审批卡改为「📋 准备开始编码？」：✅ 是并自动接受编辑 / 是并手动审批编辑 / ✏️ 编辑方案 / ↩ 否——留在计划模式（原「拒绝」终止语义改为**继续规划迭代**：补充要求后模型修订方案再次提交）。
- 新增 `mode.change` 事件：host 内部翻转模式（拒绝留计划 / 接受退出）时同步 webview 模式标识。
- 输入框模式标识：计划模式紫色边框 + `plan mode on` 徽标、自动模式黄色边框 + `auto-accept edits on` 徽标（`/plan`、模式弹窗、host 翻转三路同步）。
- 计划正文与长回复正文点击放大全屏阅读（复用 diff overlay，链接与文字选区不触发）。

---

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
