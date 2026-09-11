# Changelog

## 1.0.59

供应链审批整族收紧 + `!` shell 直执行（双端）+ 历史思考剥离省 ~25% 请求体积 + 双端模型选择器 + 微压缩保真 + 任务级 eval 基线 + EARLY_FINAL 按信号武装（寒暄不写结题报告）+ webview 表格渲染 + CLI markdown 补齐（代码围栏/表格）。

### EARLY_FINAL 早收尾守护按信号武装（寒暄不再被逼写「结题报告」）

- 修复：发「你好」等非任务型消息时，早收尾守护误判为「草率收尾」，逼模型对一句寒暄自检子目标——产出「没有未落地的子目标……已完成的部分……」式结题报告，且问候文本重复两遍、白烧一轮全上下文调用。
- 闸门重构：守护仅在 **本 run 已发生过工具调用**（开过工，草率收尾才可疑）或 **首条 prompt 疑似非平凡实现任务**（复用 `looksComplex`，文本-only = 逃避干活）时武装；寒暄/闲聊/问答/含糊短句一律放行、模型自收敛（非任务型输入枚举不完，弃用白名单方案）。
- nudge 文案自拆弹：逼问文案改为「若用户输入本就无需工具、或你在等用户澄清，直接正常回应即可」，兜住残余误拦（如复杂任务前模型先反问澄清）不再产出公文腔。
- 有意收窄：模糊短任务（如「做个小任务」）零工具轮的文本-only 敷衍不再拦截，救回责任交还用户追问。

### webview 表格渲染（GFM）

- 聊天面板的 markdown 渲染器（自写 `mdToHtml`）此前没有表格语法，模型输出的 GFM 表格一直以竖线原文显示。现支持「表头行 + `| --- |` 分隔行 + 数据行」整块转 `<table>`：单元格内 **加粗** / `行内码` 照常生效，代码围栏内的竖线不误判，无分隔行的普通含竖线文本不误转，窄面板内横向滚动不撑破布局；历史回放与点击正文的放大阅读同构生效。

### CLI markdown 补齐（代码围栏 + GFM 表格）+ webview 有序列表

- CLI 此前只渲染标题/列表/加粗/行内码，模型输出的代码围栏和表格全部原样刷屏。现 MessageBlock 块级解析：代码围栏剥标记行、保留缩进、`│` 引导线统一着色、不再参与折行（流式中未闭合到 EOF 的部分也按代码渲染）；GFM 表格按列内最宽单元格等宽对齐（CJK 按 2 格宽计），超宽列截断补 `…`、总宽超终端自动压缩最宽列，表头加粗 + 暗色分隔线。
- webview 补有序列表 `1.` / `1)` 识别（归一化为点号 bullet）。
- 顺手修预存 bug：webview 的列表/标题/引用规则此前会漏进代码围栏（代码行以 `-`/`#` 开头被误加 bullet/当标题），现围栏内代码一律原样。

### 供应链跑脚本审批收紧（P0）

- npm/pnpm/yarn/npx/corepack **整族命令**首次执行强制人工确认（allow-always 按精确命令串记住）：package.json scripts 是仓库作者的任意代码、npx/pnpm dlx 未装包时从 registry 拉取执行、install 的生命周期脚本同源——分类器只见命令串、看不见脚本内容，一律不放行。此前枚举式清单漏 `npm exec` / `npm t` / `pnpm dlx` / `yarn build`（隐式 run）/ 大小写 / `.CMD` 后缀 / tab 分隔等十余种等价拼写，已收口为整族正则 + 版本号查询豁免（`npm -v` 等保持免审）。
- **cwd 漂移重审**：allow 规则只记命令串、不含目录——script-runner 类命令带显式 cwd 且 ≠ 工作区根时（monorepo 子包是另一份 package.json），即使命中 allow 规则也重新弹审批（审批面板显示目录，防批 A 包跑 B 包）。
- **成功幻觉治理**：run_command 输出缺退出码哨兵（进程被杀树/输出中断）改判 FAILED，逼模型正视「未验证成功」；自动转后台标记升级为 `⟦DSC_BG⟧` 尾部锚定哨兵——正文出现同名字面量（如 `cat` 回显源码）不再被误判为「仍在运行」。

### `!` 前缀 shell 直执行（CLI + VSCode 双端）

- 输入 `!<命令>` 不经模型/审批、本机 shell 直跑（对齐 Claude Code bang）：输出截断 4000 字符保头尾，以 user 消息落 transcript（下轮模型可见，带 `!bash $` 来源前缀，模型可归因非自身动作）。
- 安全对齐 run_command：env 经 `scrubCommandEnv` 剔除 agent 自身凭证（`!printenv` / `!type .env` 不再外泄密钥上云）；中文 Windows 输出 GBK 解码（不再菱形乱码进上下文）；超时 `DEEP_SEEK_BANG_TIMEOUT_MS` 可调（默认 60s）。
- VSCode 端生成期间同样本地直跑（不落入 inbox 排队把字面文本送给模型）。

### 历史思考剥离 + 流式重试单层化（省 ~25% 请求体积）

- DeepSeek 请求出口统一剥离历史轮 `reasoning_content`（transcript 落盘保留，UI 思考展示 / recall 召回不受影响）：历史思考记录占请求 ~25%，剥离后窗口瘦身、压缩更晚触发；草稿续写/守护轮形状自动回退全量回传（15 条协议探针实证分档）。`DEEP_SEEK_REASONING_PASSTHROUGH=1` 还原全量回传。
- 流式对话关闭 SDK 层内建重试（maxRetries:0），瞬态重试单层归应用层——修复双层重试叠加（429 最坏放大 5×3=15 次请求）。

### 模型选择器（双端）

- VSCode：命令面板「DeepSeeker-Code: 切换模型」候选选择器 + `/model <id>` 直输 + `/switch`；设置项 `deepseekerCode.models` 可追加候选；选择存 workspaceState 跨重启恢复。CLI：`/model` / `/switch` 存 prefs.json（全局生效）。

### 微压缩保真（缩进与注释）

- 微压缩不再折叠行首缩进连多空格、不再剥 HTML 注释——read_file 输出 `行号: 代码` 格式下缩进连多空格被压，曾导致 edit_file 基于压缩视图写错缩进（「顶格」问题根因）。

### 其他

- hooks：声明式规则热重载幂等（先摘后挂，防重复注册翻倍）；matcher 支持尾部 `*` 前缀通配（`mcp__server__*`）；hook 合成名切换后旧 `mcp_call` matcher 自动映射为 `mcp__` 前缀全匹配（既有审计规则不静默失效）。
- 新工具 `find_references`：TS/JS 符号反向引用（类型感知，注释/字符串同名词免疫；与 goto_definition 一查来源一查去向）。
- 系统提示词新增【环境】块（工作区根 / OS / shell / 今天日期）——相对日期推理与路径构造不再靠蒙；agents/skills 目录按名称排序（消除 readdir 顺序对 fresh-session 前缀缓存的隐式击穿）。
- 视觉门控按当前模型即时生效（换模型即切，无需重启）；token 估算纳入工具 schema 常数项（与压缩阈值、llm.request 校准三处口径一致）；新增 tools/sys/sum 前缀分段指纹埋点（缓存 miss 分歧定位）。
- 任务级 eval 基线：`src/core/tests/evals/task.eval.ts` 端到端真跑 6 个种子任务，确定性 checker 对比 `.results/baseline.json` 报回退/修复（回退时退出码 1 可当门禁；全败轮拒绝固化基线防环境故障伪装水位）。

## 1.0.58

TS/JS 代码工具源文件扩展名闸门 + hooks stdout 决议解析健壮性 + 系统提示词注入缓存语义澄清。

### TS/JS 代码工具扩展名闸门（诚实拒绝替代误导输出）

- `get_diagnostics` / `goto_definition` / `view_symbol_outline` 三个 TS 引擎工具统一接入源文件扩展名闸门（`checkSupportedSourceExt`，白名单单一来源：`.ts/.tsx/.js/.jsx/.mjs/.cjs`）。
- 非白名单扩展名（.java/.py/.go 及 .vue SFC 等）在进 TS 引擎前即被拦下：此前 `get_diagnostics` 对未知扩展名抛误导性 `Could not find source file`；`view_symbol_outline` 的 `createSourceFile` 无视 parseDiagnostics 硬按 TS 语法解析，静默产出残缺伪大纲（类名碰巧对、方法签名错乱）——比报错更误导模型。现统一返回拦截提示，引导改用 read_file/grep 查看内容、编译验证走对应语言工具链（如 `mvn compile` / `tsc --noEmit`）。
- 三个工具的 description 同步收紧（「仅支持 TS/JS 扩展名，其余直接拒绝、勿传入」），降低模型试错调用。
- 新增单元测试 `typescript-gate.test.ts` 覆盖闸门矩阵。

### hooks stdout 决议解析健壮性

- `parseStdoutDecision` 不再要求 stdout 整体是纯 JSON：改为提取文本尾部的 `{...}` 块解析。hook 脚本在 JSON 决议前打印日志/横幅不再导致 deny/改写决议被静默丢弃；无 JSON 时行为不变（静默忽略）。

### 系统提示词注入与前缀缓存语义澄清

- `injectMarkedBlock`（P0-B 会话首锁）注释与 warn 文案修正：锁实际只在「同一 message 数组被二次 setup」（热重载/测试重入）时拦截；正常对话流每轮经 buildContextMessages 全新重建 message[0]（fence 不存在 → 走建块分支），skills/agents/memory 等源变化在同会话**下一条消息即生效**（击穿一次缓存，此后按新字节稳定）——原「下个新会话生效」表述过宽。
- runAgent 事件日志注释修正：`round.end` 在两条正常收尾路径（completed 与无工具收尾）都写；abort/error/repeat/terminal 不写，缺失即取证信号。

## 1.0.56

图片附件多模态 + 命令运行时看门狗（自动转后台）+ 会话历史召回（recall）+ 滚动摘要双段结构 + 超长工具结果侧车存档：被上下文压缩归档的内容可按需检索取回，摘要不再丢检索入口。

### 图片附件多模态（需 `DEEP_SEEK_VISION=1` 开启）

- **直接贴图提问**：视觉模式开启后，聊天输入框支持直接上传/粘贴图片（单张 ≤8MB），随消息进入模型上下文（OpenAI `image_url` parts）；用户消息行内联缩略图回显，历史回放视图同构。
- **无附件零变化**：不贴图的消息保持纯 string，请求体逐字节不变；单张坏图（超限/非 image MIME/空数据）跳过并尾注说明，不中断整轮。
- **上下文红线**：图片固定计价进 token 估算（默认 1500/张）；base64 绝不进归档索引扫描面与辅助模型摘要批（自动折叠占位，防估算风暴与垃圾实体）。
- **边界如实告知**：生成中排队与计划模式调研轮不支持携带图片——提示重新发送/实现阶段再贴，不静默丢图。

### run_command 运行时看门狗（自动转后台）

- 前台命令流式超过 120s（`RUN_COMMAND_AUTO_BG_MS` 可调）仍未退出 → 自动收编进后台任务注册表并返回 task_id（`get_background_output` 查结果 / `stop_background_task` 终止），主循环即刻释放、进程不杀、已产出字节全量保留。
- 60s 空闲看门狗从「杀进程」反转为「转后台」——静默 install / dev server 不再被一刀切断；收编时延续流式解码状态（GBK 中文跨块截断不再乱码）。

### recall 工具（本会话全量历史检索）

- **归档细节按需取回**：对 transcript 全量转录做关键词/正则检索（含已被压缩归档的原始消息与工具结果），免重跑工具、免凭摘要臆测；命中按时间旧→新（优先归档区），单次 16K 封顶防 context thrashing。
- **staleness 实时校验**：文件类工具结果命中时现场 stat——`⚠️ 观察后已修改/已不存在`（必须重读后才能据以修改）vs `✓ 未变`（可直接引用）；用户手动改文件靠 mtime 探测，误报方向安全（宁可多验）。
- **run 定位 + 防递归**：runId 前缀过滤到具体回合；跳过 recall 自身调用与结果（历史套历史的自匹配噪音）。
- **跨会话检索默认不开放**（注入复活 + 信息越界风险）。

### 滚动摘要双段结构（索引无损）

- 摘要槽拆为 `⟦DSC:ARCHIVE-INDEX⟧`（实体索引：代码侧正则从被压缩原文确定性提取文件路径/反引号实体，去重合并、永不送 LLM 压缩——recall 的查询词来源）+ `⟦DSC:ARCHIVE-NOTES⟧`（叙述：LLM 行式摘要，可自收敛）。
- 摘要自收敛只压叙述段、索引原样保留：修掉"二级摘要丢实体名 → 检索入口失效"的机制性瓶颈；旧格式摘要自动兼容并随首轮合并迁移。
- 压缩 prompt 三要素：概要骨架 + 实体名保留 + 不确定细节标注"(细节已归档)"不臆测。

### 超长工具结果侧车存档

- 截断前全文（已脱敏）落盘 `<会话目录>/tool-outputs/<tool_call_id>.txt`；截断标记行标注 `with_full` 取回方式，截断不再是单方面信息丢失。recall 的 `with_full`/`full_offset` 分页读取（14K/页，卡在自身预算内防二次截断）。

### 其他

- transcript 消息行补 `ts` 盖章（staleness 校验基准；`cleanMsg` 回传模型前剥离，不污染 API 消息体）。
- recall 纳入计划模式只读白名单（长调研早前轮次被压缩归档，恰是主场景）。

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
