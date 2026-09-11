# Changelog

## Unreleased

供应链审批整族收紧 + `!` shell 直执行 + 历史思考剥离省 ~25% 请求体积 + 微压缩保真 + 任务级 eval 基线；及上批未发布：多模态、看门狗自动转后台、红绿 diff、计划模式对齐 CC。

### 供应链审批与 `!` 直执行（2026-09-11）

- **npm/pnpm/yarn/npx/corepack 整族命令首次执行强制人工确认**（allow-always 按精确命令串记住；版本号查询如 `npm -v` 豁免）：scripts 是仓库作者的任意代码、npx/dlx 会从 registry 拉取执行——分类器看不见脚本内容，一律不放行。枚举式清单漏掉的 `npm exec` / `pnpm dlx` / `yarn build`（隐式 run）/ 大小写 / `.CMD` / tab 等变体已收口为整族正则。
- **cwd 漂移重审**：script-runner 类命令带显式 cwd 且 ≠ 工作区根时，即使命中 allow 规则也重新弹审批（防批 A 包跑 B 包的投毒 package.json）。
- **`!<命令>` shell 直执行**（对齐 Claude Code bang）：不经模型/审批本机直跑，输出以 user 消息落 transcript 下轮模型可见；env 经脱敏防密钥上云、中文 Windows GBK 解码；`DEEP_SEEK_BANG_TIMEOUT_MS` 可调（默认 60s）。
- **成功幻觉治理**：run_command 输出缺退出码哨兵改判 FAILED；自动转后台标记升级为 `⟦DSC_BG⟧` 尾部锚定哨兵（正文中段出现字面量不再误判）。

### 压缩与上下文经济

- **历史思考剥离**：DeepSeek 请求出口剥离历史轮 reasoning_content（落盘保留，UI/recall 不受影响），省 ~25% 请求体积、压缩更晚触发；`DEEP_SEEK_REASONING_PASSTHROUGH=1` 还原。
- **微压缩保真**：不再折叠行首缩进、不再剥 HTML 注释——read_file 行号格式下缩进被压曾是 edit_file「顶格」问题根因。
- **【环境】块注入**：系统提示词声明工作区根/OS/shell/今天日期（按天粒度，同日内字节稳定不击穿前缀缓存）。

### 其他

- 新工具 `find_references`（TS/JS 符号反向引用，类型感知）；hooks 热重载幂等 + 尾部 `*` 通配 + 旧 `mcp_call` matcher 兼容映射；agents/skills 目录按名排序防缓存击穿；流式重试单层化（修 429 最坏 15 次请求放大）；任务级 eval 基线（6 种子任务确定性 checker，回退退出码 1 可当门禁）。

---

图片附件多模态支持 + 命令运行时看门狗（自动转后台）；代码变更红绿 diff 预览 + 计划模式交互对齐 Claude Code；斜杠菜单滚动 + 启动顿挫治理。

### 多模态与后台任务

- **图片附件多模态**（需 `DEEP_SEEK_VISION=1` 开启）：聊天消息可携带图片附件随提问进入模型上下文（OpenAI `image_url` parts，单张 ≤8MB）；无附件消息保持纯 string，行为逐字节不变。token 估算对图片固定计价（默认 1500/张，`DEEP_SEEK_IMAGE_TOKENS` 可调）；base64 三不进红线——绝不进 token 估算的 stringify 分支、归档索引正则扫描面、辅助模型摘要批（text-only 请求图片自动折叠占位）。
- **run_command 运行时看门狗（自动转后台）**：前台流式超过 120s（`RUN_COMMAND_AUTO_BG_MS` 可调）仍未退出 → 进程自动收编进后台任务注册表并返回 task_id（`get_background_output` 查结果 / `stop_background_task` 终止），主循环即刻释放、**进程不杀**、已产出字节全量保留。60s 空闲看门狗从「杀进程」反转为「转后台」——静默 install / dev server 不再被一刀切断。

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
