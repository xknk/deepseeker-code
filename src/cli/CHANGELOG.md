# Changelog

## 1.0.53

工具系统重建（声明化策略/结构化结果/运行时参数校验）+ 压缩熔断单点治理 + hooks 首跑审批门与记忆治理三件套 + 归档索引中文召回增强 + 新工具 read_image 视觉读取 + CI 守门上线 + evals 三套成型 + 本地使用日志 + `/new` 新会话命令；及 09-14 批次：零配置多模态（乐观直发 + 400 自学习降级）、供应链审批整族收紧、`!` shell 直执行、历史思考剥离省 ~25% 请求体积、微压缩保真；及更早未发布：看门狗自动转后台、红绿 diff、计划模式对齐 CC。

### 工具系统重建（2026-09-16）

- **工具策略声明化**：triggersUndo / primaryArg / pathArgs / autoApproval / planAllowed 进工具协议声明，五处按名硬编码名单退役；漏声明 fail-closed 转人工审批。
- **结构化工具结果**：成败判定唯一来源 `ToolExecuteResult.status`，按输出前缀嗅探成败退役——工具不再因输出碰巧含 "Error" 被误判失败。
- **运行时参数校验**：执行前按 JSON Schema（ajv v8）校验入参，畸形调用提前拦截；MCP 工具按目标 schema 共享同一校验。

### 上下文与压缩治理（2026-09-15 ~ 16）

- **压缩熔断单点治理**：超预算单元确定性预截断（保配对、去中段），超长工具结果不再把压缩打熔断、会话可续；熔断文案改指真实根因与自愈指引。
- **todo 完成度守卫**：收尾时清单仍有未完成项自动推一轮核对（全程生效、限 1 次预算）。
- **侧车存档治理**：脱敏后落盘契约单点化、按会话总量 64MB 闸（mtime 最旧先淘汰）、postHook 截断输出同接侧车；recall legacy 会话守卫。

### 扩展面信任与记忆治理（2026-09-16）

- **hooks 首跑审批门**：项目级 command/http/agent 规则首次执行强制人工确认，allow-always 落盘后直通；项目配置声明 `requireApproval: false` 摘不掉门；无审批通道 fail-closed 跳过。
- **记忆治理三件套**：memory_delete 升强制人工审批；memory_save 条数 200 / 索引 16KB 双上限；读写记 last-used 供日后淘汰与画像。

### 召回质量与多模态（2026-09-16）

- **归档索引中文召回增强**：CJK 路径段、中文引号报错原文、错误码、URL、中文实体串入索，大小写归一去重——中文项目的旧上下文召回不再漏。
- **新工具 read_image**：图片视觉读取（vision 闸前置，base64 不进文本上下文）；read_file 命中图片扩展名自动转介。
- 跨 run 衰减折叠提示改指 recall（带确切 tool_call_id），被压缩原文可检索取回。

### 工程质量（2026-09-15）

- **CI 守门上线**：GitHub Actions typecheck + 全量单测；失败三路诊断（run summary / artifact / 分支回推），无鉴权可查。
- **agent 热路径 14 项优化**（前缀缓存零影响）；**evals 三套**：任务级 16 题基线（成本折算列 + 三套 npm 脚本）、压缩质量、风险分类器，外加扩展面行为级 eval（hooks/skills/subagent/MCP）。
- **本地使用日志**：usageLog 落盘 + usage-report 三读口；**CLI `/new` 新会话命令**；memory_save description 200 字符限长 + 持久记忆系统单测；读取工具失败文案统一 toolFailure 工厂出口；native realpath 统一修 Windows 8.3 短名误判越界。

### 零配置多模态：乐观直发 + 400 自学习降级（2026-09-14）

- **贴图不再需要任何配置**：废除「模型 id 含 vision/vlm/-vl 才算多模态」的名字启发式（对 deepseek-v4.1-flash 这类原生多模态但名字无标记的模型必然误判，贴图被降级成文字尾注、模型被迫去找图像识别 MCP）。现改为**乐观直发**：图片默认随消息直达模型；若端点报 400「does not support image」，本轮自动折叠为文本占位并立即重试（400 发生在流开始前，用户无感、仅一条提示），并按模型 id 记入 `~/.deepseeker-code/model-capabilities.json` 永久记住，此后直接走文本降级路径（图片落盘 + 路径线索给图像识别 MCP 中转）。env `DEEP_SEEK_VISION` 语义改为逃生门：`=1` 强开 / `=0` 强关，未设走自学习。
- 附带收益：乐观成功时图片标签行携带落盘存档路径（`🖼 [图片: name | 存档: path]`），模型可经工具复读原图。

### 回复语言误判修复（2026-09-14）

- **长路径/URL 不再参与语言判定**：贴图标签行携带存档路径后，路径的拉丁字母把 CJK 占比稀释到 ~0.19（阈值 0.2），中文提问被误判 en、注入英文引导（「怎么返回英文」）。`detectTextLocale` 现剥离盘符路径、常见 Unix 绝对路径与 http(s) 链接再统计（停在引号/括号/CJK 标点，防 `\S+` 连中文一起吞掉）。
- **纯贴图轮次不再被带偏**：harness 合成行（🖼 图片标签/降级尾注）从语言检测面剔除——只贴图不打字的轮次回退显式 locale（`/lang` 的兜底本职），不再被标签里的英文文件名判成 en。
- `/lang` 回显补说明：AI 回复语言默认跟随每轮提问自动判断；`/lang` 管界面语言并作无文字轮次的兜底。

### 工程质量与行为锁（2026-09-14）

- **client 懒加载**：顶层 `new OpenAI()` 改 `getModel()` 按需构造——缺 `DEEP_SEEK_API_KEY` 的环境不再在加载期崩溃，`npm test` 无凭证 455/455 全绿、typecheck 回绿（6 处 TS2775 清零）。
- **脱敏放过变量引用**：内容脱敏只打码引号字面量与 `Authorization: Bearer` 形态，`process.env.*` / 点号路径 / 裸标识符原样放行（此前读自己项目代码只见 `[MASKED_SECRET]`）。
- **压缩落盘单点化**：`persistCompaction` 收敛「先写滚动状态、再写压缩事件」顺序铁律，两份复制实现合一（失败分支刻意不并入）。
- **nudge 行为锁**：新增 27 条表驱动用例钉死六类守护的触发/预算/优先级，含两次事故回归钉（「你好」寒暄放行、实质长总结限长放行）。

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
