# Changelog

## 1.0.74

修复钉顶提问块穿模（2026-10-21）：滚动时钉在顶部的提问卡片，下方滑过的内容会从卡片里透出来与提问文字叠影。根因是卡片的不透明遮挡只靠气泡自身背景一处，而它同时是被 clip-path 裁剪的元素、底色又由主题变量混合而来（部分主题该变量自带 alpha，常态看不出来，一盖到滚动内容上就透字）。现改为**独立不透明垫板**（`::before` 伪元素，与裁剪解耦）+ **双层同色背景强制不透明化**（变量在上、#252526 兜底在下，变量带 alpha 也合成出不透明色）；只垫到卡片视觉底边，卡片下方仍留给渐变带做溶入过渡，常规主题渲染结果与此前逐像素一致。纯 CSS 改动，布局与滚动跟随语义零变化。

## 1.0.73

收尾回复治理·对标 CC 原则化（2026-10-21）：针对「每次结论都是长篇结题报告」——【回答形式】新增**说人话**（先讲效果再讲手段、术语跟白话解释）与**收尾自然简短**（结论一句 + 改动与验证要点、篇幅以说清为准，附长度参照示例；无硬性行数上限、无固定三段式——对标 Claude Code「短而精靠原则不靠模板」）；EARLY_FINAL / TOOL_DIGEST nudge 文案同步收紧（final 前最后一条 system 的 recency 位点，「简述成果」改为「简短自然总结、勿长篇报告」）。完成判据与四类收尾守护逻辑零改动（不削弱"必须真完成"约束）；nudge-scheduler 词表钉逐字未动；core 全量绿（secondbatch 1 例 IPC 反序列化为已知间歇 flake，单跑恒绿）+ 三端 typecheck 绿。根因：整套守护单向推"别停太早"、仅一句"收尾要短"，DS 完整性倾向放大为枚举式自证完成。

## 1.0.72

Agent 内核审查报告（.ai-docs/Agent内核审查报告.md v3.6）第四批（收尾批）修复四项（2026-10-21）：allow-session 真会话级、CLI /rewind + /diff、CLI 审批完整内容展开、processToolCall 四阶段拆分——收口批：权限作用域补真、两条后置命令对标 Claude Code 形态、审批可看全文、安全链重构为纯移动。守门测试 kernel-audit-fourthbatch.test.ts 12 例 + core 全量 702 例绿 + 三端 typecheck 绿，§8.0 五约束逐条核对无违反。

- **allow-session 真会话级（I-4，P3 修复）**：会话级规则从进程级单列表拆为 `Map<sessionId, 规则桶>`——`checkPermission` 增可选 sessionId 尾参（执行层与调度层并行判定均传），guard 入账带 `ctx.sessionId` 归桶；判定时桶与全局合并、优先序不变（deny > ask > allow，桶 deny 照样压过全局 allow）。会话结束等价路径清桶：CLI loadSession/newSession、VSCode setSessionId/deleteSession；桶容量上限 64（淘汰最旧）防 serve 常驻进程无界增长。零变化项：allow-once / allow-always / deny 与 CLI 单会话体感不动。守门含双会话隔离行为断言（A/B 互不可见、清桶失效），非仅结构扫描。
- **CLI /rewind（I-3）**：斜杠菜单新增检查点回退选择器——`listUndoable` 列本会话可回退变更（路径 · 操作类型 · 相对时间，分页），选择后按 `restoreByUndoId` **选择性回退**（非仅 restoreLast 弹最新一条），成功/失败结果入会话流；新建文件（creation_marker）回退=删除。同款注册 `/diff`：按本 run 时间窗过滤 undo 记录，逐文件装配「改前备份 vs 当前磁盘」净变化红绿 diff（复用红绿基建；creation_marker 以空为改前全绿；备份已清理/文件不在盘等降级 note 行，不抛错）。双语文案 + /help 条目，命令表紧随 usage 注册（第三批守门形态不破坏）。
- **CLI 审批完整内容展开（I-6，CLI 侧收口）**：CLI 审批桥补 `meta.fullDetail` 透传（core 侧 1.0.71 已附带、VSCode 已用），审批弹窗按 `f` 键展开截断前全文——同一套红绿解析管线，展开态不设折叠行数封顶、仅 400 行绝对上限防糊屏；无 fullDetail 的审批不显示提示。
- **processToolCall 四阶段拆分（P2-10，纯移动重构）**：~470 行单函数拆为 `ToolCallState` 可变中间态 + 四阶段函数——`resolveEarlyOutcome`（终结/abort/计划门禁）→ `runSecurityGates`（安全链：hook→参数校验→保护路径→权限→命令语义→灾难闸→锁→分类器→人工审批→旧位 hook→undo 备份，顺序敏感）→ `executeTool`（执行+post-hooks）→ `finalizeOutcome`（脱敏→侧车→截断→outputFilter→终结分流）；processToolCall 收编为编排器。验收=既有测试与守门**零改动全绿** + 三端 typecheck——行为等价由旧守门逐条结构断言背书，不顺手改任何行为/文案。

## 1.0.71

Agent 内核审查报告（.ai-docs/Agent内核审查报告.md v3.3）第三批修复六项（2026-10-20）：CLI /undo、分类器可见性、会话级允许、子 agent 进度分行、结算单子任务花费、挂机解释器闸门——交互短板收口 + 两项实测答疑 + 架构不变式补钉，守门测试 kernel-audit-thirdbatch.test.ts 12 例 + core 全量 690 例绿，§8.0 五约束逐条核对无违反。

- **CLI /undo 最小版（I-3）**：斜杠菜单新增 `/undo`（fork 与 usage 之间注册），直调 core `restoreLast` 与模型 `undo_restore` 工具同一恢复链路——LIFO 弹最近一条写操作记录回滚磁盘，再次执行沿反向记录回走（撤销撤销=可逆）；无可回退项给专门提示不抛错。
- **分类器可见性（I-5）**：命令类走 LLM 安全分类器时全程可观测——调用前发「🔒 安全判定中…（最长 10s）」进度，返回后回报「放行/未放行」结论；文件类确定性快路径刻意零打扰（不发进度）。审批弹窗在分类器未放行转人工时，detail 追加 fail-closed 来由说明（不在自动放行范围 / 判 risky / 判定超时或异常），审批者不再对着莫名弹窗猜原因。
- **审批新增「本会话内允许」（I-4）**：ApprovalDecision 从三态扩四态——allow-once / **allow-session（新）** / allow-always / deny。allow-session 经 `addSessionPermissionRule` 记内存级会话规则（同形调用本会话免审，重启即失效），与 allow-always（落项目 settings.json）之间补上「想放行一阵子但不想写盘」的中间档；CLI 弹窗选项、VSCode 按钮、serve /api/approve 白名单三端同步。
- **子 agent 进度按 agent 分行（I-7）**：多 agent 并发时进度行不再互相踩——`subagent.progress` 事件带 `agentKey`（子会话 id，唯一）+ `name`（manifest 名），CLI/VSCode 各自维护 agentKey→行槽 Map，每 agent 一行独立更新、完成按 key 删行，渲染带 `⟨name⟩` 前缀可分辨。
- **结算单并列展示子 run 花费（Q12）**：receipt 结算单新增 `subCostYuan` 段（CLI「· 子任务 ¥x」/ VSCode 同步）——展示账（`subCostYuanAcc` 由 reportCost 同源增量喂入）与计量账（`costYuanAcc` 每 run 自身）刻意分账，预算圈与 usageLog 口径零变化，无重复计数。
- **挂机解释器×仓库脚本供应链闸门（N5，仅 batch 场景）**：`node ./scripts/x.js`、`python x.py`、裸 `tsc`/`make`/`cargo`/`go` 等「解释器直跑仓库内脚本」形态在挂机批处理默认拦截（与 npm 族同源的供应链风险，仓库作者代码=提交即执行）；交互场景零打扰（刻意不进 toolExecution 判定链，仍走分类器）；工单 `tools:` 加 `"interpreter"` 伪槽位即解锁。查询 flag（`node --version`）、内联代码（`python -c`）、外部程序绝对路径、包管理器族不误伤。
- **完整 diff 透传（I-6，core+VSCode）**：审批 meta 新增 `fullDetail`（截断前全文），webHost 以 `opts.includeFullDetail` 显式开启（HTTP SSE 保持 2000 字符截断口径），VSCode in-process 接入——diff 视图以全文渲染，弹窗预览维持截断不变；CLI 侧延后。
- **计划模式无提案提示（I-1）**：`/plan` 批准时若模型从未产出提案（plan==null），不再静默无响应，直接提示「本次计划模式未产生提案」。
- **架构不变式补钉（P2-14 ①② + P2-11）**：① 计划模式两态工具表逐字节恒定（不裁表保前缀缓存，P0-A 执行层门禁语义用行为测试钉住）；② nudge ephemeral 硬约束端到端断言（续跑轮推理入参含 `⟦DSC:⟧` 尾部副本可达模型 + transcript 落盘零痕迹，压缩输入=真实消息数组故机制传递成立）；P2-11 `ToolCallContext` 14 个可选字段全部改 `T | undefined` 必填（构造漏字段=编译错误，替代手工逐字段纪律）。**P2-10 拆 processToolUse 评估后置**：~470 行安全链纯移动重构，与大批行为改动同车会叠加回归面，留独立重构批。

## 1.0.70

Agent 内核审查报告（.ai-docs/Agent内核审查报告.md v3.3）第二批修复四项（2026-10-20）：子 agent 预算增量上报、计划拒绝熔断、窗口/校准按模型分维度、工具声明化收尾——守门测试 kernel-audit-secondbatch.test.ts 14 例 + core 全量 676 例绿，§8.0 五约束逐条核对无违反。

- **子 agent 预算增量上报（P1-5）**：子 run 烧的钱不再等 run 结束才一次性回灌——新增 `costRelay` 增量中继（只报正增量、幂等、六位小数舍入防浮点噪声），round.end×2 + finally 三处 `flush` 把 `costYuanAcc+toolCostYuanAcc+auxCostYuanAcc` 累计总额实时推给宿主 `costSink`；同时 `budgetCheck` 闭包三环贯通（runAgent 主 run 自武装「≥budgetYuan×1.2 即超」→ toolCallCtx → subagent subOptions，workflow subCtx spread 自动继承），子 run 在**轮边界**即时自检中止超支任务，挂机批处理的预算闸从此对子任务生效。
- **计划拒绝熔断（P1-7）**：计划模式下模型反复尝试写工具被拒不再无限空转——只计非 SAFE 写工具的拒绝（ask_question 等交互类被拒不计），连续 2 次推一次 `⟦DSC:PLAN_REJECT⟧` 转向 nudge（引导转只读或 exit_plan_mode，每 run 至多一次不重复念经），连续 4 次在轮边界强制收尾（`stopReason='limit'`，文案给中止/批准/退出计划三条出路）。
- **窗口/校准按模型维度（P1-4）**：新增 `MODEL_WINDOWS` 表 + `resolveModelWindow`，上下文窗口不再全体绑 `MAX_HISTORY_TOKENS` 一个值（三处在售模型刻意不填表，250K 甜点区产品决策不变；日后续接不同窗口模型填表即生效）；校准比 `calibRatio` 等按 `sessionId+modelId` 分键存取（`getCalibration`/`updateCalibration`），同会话换模型互不污染；盘上旧扁平字段作未命中兜底（旧会话不丢校准），写侧镜像回写扁平字段——fork 透传与旧读侧零改动继续工作。chatProcessing 主链 / compactSessionNow 手动压缩 / 子 agent manifest.model 三处接入。
- **声明化收尾（P1-6）**：`CustomTool` 新增五声明字段——`terminal`（三态：`'plan_exit'`/`'plan_enter'`/`true`=结果只给用户并终结本轮）、`parallelizable`（显式 `false` 否决并行；未声明按 SAFE+同步自动推导，现有 SAFE 并行不受影响）、`argKind`（`'command'`/`'path'`/`'text'`）、`subagentAllowed`、`batchAllowed`。四处按名特判退役为「声明优先 / 名单兜底」：调度层并行排除与终结分流、执行层终结拦截与命令语义（scriptRunner/只读免审/灾难闸门）、子 agent 工具收权、挂机 batch 过滤。验收场景：新增声明 terminal 的测试工具不改任何名单即正确终结 + 后续调用补占位 + 强制串行——以后新增此类工具零名单维护。
- **挂机 batch 过滤改读声明**：`batchRunner` 工具表过滤从「纯 denylist」改为「`batchAllowed !== false` 且不在 `BATCH_DEFAULT_DENYLIST`」，与子 agent 收权同一声明语义（fail-closed：未声明者仍按名单兜底拦截）。

## 1.0.69

Agent 内核审查报告（.ai-docs/Agent内核审查报告.md v3.3）第一批修复五项（2026-10-20）：审批快路径确定性化、辅助模型花费入账闭环、流式重试文本治理、后台任务收权——报告 §8 第一批验收五判据全过，守门测试 kernel-audit-firstbatch.test.ts 22 例 + core 全量 662 例绿。

- **firstPrompt 取「当前轮」输入（P0-1）**：新增 `resolveFirstPrompt`——宿主显式 `currentUserText`（serve/cli 定型传入）优先，缺省从消息数组**末尾**回退扫最近一条非空 user（旧实现 `find` 从头取首条），`depth!==0` 恒空串门禁保留（§8.0②：子 agent 工具表实有 enter_plan_mode，PLAN_FIRST 一调即被转终结信号提前收尾）。修复多轮病理：第 2 轮寒暄（"谢谢，先不用"）被当复杂首条 → 误注入 PLAN_FIRST + EARLY_FINAL 拦掉正常收尾。回归测试双向钉（寒暄零触发、复杂首条照常触发）。
- **辅助模型花费入账（P0-2）**：压缩摘要与工具风险分类器烧的 AUX 模型钱不再漏账——`onAuxUsage` 回调按 §8.0④ 三处定义全链贯通（`ensureOptions` 压缩链 6 函数逐层透传 / `ToolContext`+`ToolCallContext` 分类链 / runAgent 单一累加器），一律按 `AUX_MODEL_NAME` 价目折算（复用主模型单价=金额直接错）；无价/零花费缺失不计、不阻断。`auxCostYuan` 进预算圈（超限熔断把 aux 钱也算上）、receipt 结算单与 usageLog（无调用自动省略），CLI 结算行 / VSCode 事件行 / 挂机报告三端显「辅助 ¥x」。
- **400 降级压缩补漏**（实施后残留点）：streamInference 的 context_length 降级路径也调 `ensureFitsWindow`，初版漏接 onAuxUsage——已透传并入守门断言（主循环压缩与降级压缩同一本账）。
- **文件类审批二元化（P0-3，裁定 B 方案）**：`autoApproval='file'` 改纯确定性判定——工作区围栏 + 敏感文件 deny 清单照旧，其后三条件快路径（`safetyLevel!==DANGER && triggersUndo∈{overwrite,create}`，缺一不可，§8.0①）命中 → allow；其余（delete_path 的 DANGER、move_file 无 undo 兜底）恒 ask 转人工。**LLM 分类器对文件类整体退出**（分类器调用次数=0 进测试断言，不只验放行结果）；刻意不做「!triggersUndo → 分类器」回落（那会让 delete_path 漏进分类器）。快路径放行同样触发执行层 beforeMutationBackup（凡改必可回退，结构断言钉住备份门与审批解耦）。命令/aggressive 类照旧走分类器。注释同步：PermissionMode 两档语义澄清（快路径 default 亦生效，两档差异仅 aggressive/MCP 作用域）。
- **text.reset 宿主消费矩阵（N1）**：流式重试前 core 发的 text.reset 此前 CLI/webview/挂机三宿主漏消费，重试文本会拼在旧残影后——CLI 新增 case 按 §8.0③ 清干净（取消 pending flushTimer + 清 text/thinking buffer + 清流式行文本，重试从行原点重写）；webview/挂机消费点核验，四触点矩阵测试钉住。
- **run_in_background 收权（P1-8′）**：进 `SUBAGENT_DENYLIST`（父 run 收尾时后台任务成孤儿）与 `BATCH_DEFAULT_DENYLIST`（挂机 detached 进程无人观测）；工单 `tools:` 显式解锁语义不变（§8.0⑤：应答器放行集=编辑类∪解锁，无需动应答器）。
- **结算与台账修正（N4 顺手项）**：batch 子 run 花费聚合改 `__sub__` 前缀归拢（旧精确等值把子 run 花费全漏掉）；store.ts trace 文件名注释纠偏（`__sub__` 一律截到首段主会话 id、子 run 与主 run 共写同一 trace 文件系有意设计）。

## 1.0.68

DeepSeek Search & Fetch 接入（以现有 web_search / web_fetch 的「工具后端」形态补强联网能力，2026-10-19 随 V4.1-Flash-1017 开放的 /tools/search · /tools/fetch REST 端点）+ 价格表例行复核 + vision-exp 补价。

- **web_search 新增 deepseek 后端并设为缺省优先**（配 DEEP_SEEK_API_KEY 即自动启用，通常已配）：自家引擎、长摘要直出（summary 面向模型，实测中文/英文长尾显著优于 Bing 爬虫路径）；`SEARCH_PROVIDER=deepseek|tavily|bing|ddg` 可强制，失败不静默回退（报错附 `SEARCH_PROVIDER=bing` 一键回退指引）；原 bing/tavily/ddg 路径零改动。输出体积按 summary 长度做预算截断（整条丢弃），不再触发 16K 全局熔断拦腰。
- **web_fetch 新增可选 `backend:"deepseek"` 参数**（缺省 local 现状不动）：服务端返回 markdown 正文，套现有长度熔断；`allow_private` 对该后端无效（SSRF 防护是本机语义）。实测反爬/国际站同样受限，失败引导改走 web_search 的 `site:` 语法从索引侧拿正文，不做自动切换。
- **site: 误用防连环空转（A/B 实锤两轮修出）**：失败引导只写「可用 site: 语法」不给示例时，模型会把失败 URL 整条塞进 site:（`site:域名/路径`，坏语法恒 0 命中）→ 误判「索引里没有」连环空转（实测多烧 2 轮 5 个工具调用）。修法两处——web_fetch 失败文案现场用失败 URL 的 hostname 拼好 `site:域名` 可照抄前缀（示例形如 `site:zhuanlan.zhihu.com 页面标题或主题关键词`）；web_search 0 命中若带 `site:xxx/yyy` 误用签名，当场点破语法问题并给剥好路径的纠正模板（维持 success 语义；无 site: 或合法 site:域名 的 0 命中维持原文案）。
- **按次成本进结算单闭环**（¥0.005/次，官网 ¥5/1000 次）：新增 `toolCostSink` 通道（呼应 E1 reportCost），成功调用后按次上报——receipt 结算单与 usageLog 各加 `toolCostYuan` 字段（无调用自动省略）、E1 子 run 回灌与 E2 预算圈并入按次花费；CLI/VSCode 结算行加「联网 ¥x」段、挂机报告费用行同步聚合。`DEEP_SEEK_TOOL_COST=0` 可关上报（成本链异常时保结算单不脏）。
- **价格表例行复核无漂移**（2026-10-19 官网页面实拉逐项比对）：flash/pro 两模型共 12 项峰谷数字、峰谷时段定义（工作日 9–12/14–18 高峰、空闲减半）、扣费公式（token×单价）与本地 `MODEL_PRICES`/`isBeijingPeak`/`calcCostYuan` 全部一致；`PRICES_VERIFIED_AT` 刷新为 2026-10-19。
- **`deepseek-flash-vision-exp` 补表价**：官网脚注 (1) 明示旧模型名仍可调用、由 V4.1-Flash-1017 提供服务并**按 Flash 价格计费**——1.0.67 时「官网无公开报价→刻意无条目」的前提不再成立，补与 flash 同价条目（非猜价，官方口径）；此前选 vision-exp 时只显 token 不显钱，现在正常折算。prices.test.ts 三处断言随语义更新（无价模型样例改用 unknown-model）。
- **顺手核实 11 月按次收费边界**：官网 Search/Fetch API 5 元/千次（11-01 起计费）只覆盖官方搜索/抓取接口——模型调用仍按 token 计费不变，Search/Fetch 的按次花费已经上方 toolCostSink 通道独立入账，成本信任链计费根基不变。
- **刻意不做生成内 server-side tool**：那会绕过本地工具系统（审批/trace/侧车/结算全瞎，与成本信任链冲突）；与对标 CC 的差异是有意的。守门测试 web-deepseek.test.ts 10 例（count 字段钉死/钳位/映射/预算截断/失败指引/计费时机/site: 纠正两形态/local 零改动）。

## 1.0.67

价格信任地基修复（峰谷双档价 + 过期可见性）与挂机 setup 环境准备——均由 2026-10-16 挂机首跑实锤修出：官方账单收 ¥0.53 vs 本地折算 ¥0.19（token 计数与官方差 <0.3%，纯单价表错——旧表峰谷不分档、部分数字失真，少报 2.7 倍）。

- **价格表峰谷双档化**：`MODEL_PRICES` 改 `{ idle, peak }` 双档结构（官网 2026-10-16 核实，flash 高峰档并按官方账单对账验证：代入仪表盘 token 分毫不差得 ¥0.5279 ≈ ¥0.53）；`priceFor`/`calcCostYuan` 加可选 `ts` 判档（北京时间工作日 9:00–12:00、14:00–18:00 高峰，午间/晚间/周末空闲=半价；法定节假日本地判不了 → 按工作日处理，方向=高估、预算闸偏保守）。runAgent 逐轮折算即逐轮判档；历史记录折算（/usage 近 7 天、usage-report 脚本）传记录自身 ts 判档。
- **价格表过期可见性（防再犯）**：`PRICES_VERIFIED_AT` 日期戳 + `pricesAgeDays()`，超 30 天 `/usage` 显「价格表 N 天未复核」提示（zh/en 双语）——「价格表过期」必须可见，不允许静默错钱（本次事故根因即 10-13 核实过的表 3 天后已失真而无人知）。临时校准走 env 三键 `DEEP_SEEK_PRICE_*`（平价语义，覆盖两档）。
- **对账回归钉**：prices.test.ts 内建官方账单回归钉（batch 会话真实 usage 代入须得 ¥0.5279）与峰谷边界判档钉（12:00 整空闲 / 14:00 整高峰 / 周末高峰时段仍空闲）——峰谷测试全传显式 ts，任何时刻跑结果恒定。
- **挂机工单 `setup` 字段**：worktree 是干净 git 检出（无 node_modules），验收命令依赖环境时先跑 setup——agent 阶段前在 worktree 内执行（复用验收执行器：同 shell 形态/凭证剔除/超时护栏）；失败即任务失败（新终态 `setup-failed`，报告含输出尾部），不烧 agent 钱。首跑验收 `ERR_MODULE_NOT_FOUND` 的根治。
- 工程杂项：`.deepseeker-code/batch/` 运行时目录（done 报告存档等）入 .gitignore；CLAUDE.md batch 行补 setup 字段；batch `--wait-window` 注释更新（峰谷价已核实，空闲档半价）。
- **i18n 词表键集一致性闸门测试**：四张词表（webview strings.js / core inspect OBS / cli batchStrings / 宿主 i18n.ts）各自断言 zh/en 键集双向相等——各端都是「缺键回退 zh」的容错结构，单边加键运行时静默不报错，肉眼难发现；配提取下限（防正则失配空集假绿）与闸门自检（内存 fixture 证明单边加键必失败）两道防假绿闸。
- **CI 修复**：GitHub Actions install 步注入 `GITHUB_TOKEN`——vscode-ripgrep 的 postinstall 拉 rg 二进制被 api.github.com 未鉴权限流 403（2026-10-16 run 实锤：41s 挂在 install、代码判据未跑）；注入后限额 60→1000 次/时。

## 1.0.66

全插件 UI 与观测/挂机输出双语化（/lang zh|en 一键切换，此前仅 CLI/README/模型回复支持双语）。

- **webview 前端**：全部用户可见文案接入 `S` 词表代理（工具栏/输入区/斜杠菜单/审批/提问/方案/历史/分叉/检查点/diff/动作面板/事件行 ~190 键）；静态 DOM（工具栏 title、输入区模板、浮层骨架）靠 `ds-locale` 重建机制刷新，切换时草稿文本、待发贴图/引用 chip、阻塞中的审批/提问/方案条全量保留；历史 info/system 行属会话记录不追溯翻译（与 CC 行为一致）。
- **扩展宿主**：extension.ts（命令面板 QuickPick/通知/观测命令回显/导出与回滚对话框）/ host.ts（~25 条 info 行与错误抛出）/ ideBridge.ts（ide_* 工具结果）接入 `i18n.ts` 词表（makeT 闭包按访问时 locale 分发）；无 tab 语境（activate 期）按 VS Code 显示语言。
- **核心观测输出（CLI/VSCode 共用）**：`/usage` `/context` `/permissions` `/mcp` `/hooks` `/debug` 六命令双语化——inspect.ts 内建 OBS 词表（模板函数 + zh 缺省回退），尾参 locale 由调用方显式传入（CLI 取界面语言、VSCode 取页签语言），缺省 zh 向后兼容旧调用点。
- **CLI 本地命令回显补齐**：/trust /archive /plan /budget /auto /thinking 回显、`!` shell 直跑（用法/退出码头行/空输出）、引擎加载与未知命令提示、vision 降级与计划模式切换事件提示接入 strings.ts 词表（+22 键）。
- **挂机批处理全链路双语化**：`batch add|list|clean|help` 管理输出与 `batch run` 控制台进度/落盘报告接入 batchStrings.ts 词表（en 表按 typeof ZH 编译校验；报告按运行时刻语言生成，落盘属存档不追溯翻译——与历史会话记录同语义；报告 frontmatter 键名保持英文供 list 解析）；工单校验与运行锁错误文案在 core 侧加尾参 locale（ticket/queue，缺省 zh 向后兼容，同 inspect.ts 模式）；batchAdmin 在 main 语言初始化【前】派发，自行从 prefs 补读 locale（未设置保持 zh，headless 不弹首次询问）。
- **清单与设置**：package.json 的 description/10 条命令标题/17 项设置描述改 `%key%` 引用 + `package.nls.json`（英文默认）/`package.nls.zh-cn.json`（中文镜像）——命令面板与设置页随 VS Code 显示语言自动切换。
- **语言解析链**：`/lang` 选择持久化 workspaceState（重开页签/重载窗口不丢，与模型选择同模式）> 设置项 `deepseekerCode.locale` > VS Code 显示语言；`<html lang>` 随语言渲染，切换即时同步。
- **边界（有意保留中文）**：模型侧提示词（计划调研引导/方案批准重跑语）；core 审批 detail 的【减少】/【增加】标记（diff 解析锚点）；queue.ts 收尾落盘失败的 console.warn（诊断级，不面向用户）。

## 1.0.65

提问钉顶与逐消息撤回 UX + 成本信任链四环 + 检查点回滚/统一动作面板（本版起追平 09-17 ~ 10-14 全部未上架批次，即本地 1.0.72–1.0.100 累积更新；版本号按线上 +1 重排，避免与已上架 1.0.64 之间留空洞）。

### 提问钉顶与消息 UX（1.0.85–1.0.100）

- **用户提问块粘性置顶（对标 CC）**：长回答把提问顶出视野时，当前轮提问自动钉在消息区顶部——`.row-user` sticky top:0，滑行空间=消息区整列，下一条用户行滚上来自然顶掉前一条；钉住态收拢为 ~2 行钳高卡片、底部渐变溶入底色（`.stuck` 态才渲染渐变，自然流不加防吃掉下一条开头）；纯 CSS sticky 驱动，贴底跟随与历史回放不受影响。
- **卡片右上角时间戳**：HH:MM 淡显，live=发送时刻、回放=transcript ts；老会话缺 ts 不渲染（宁缺勿假）；时间行右留白即 ↺ 徽标位。
- **「展开」pill（对标 CC Show more）**：超过 2 行即挂（与钉住态钳高对齐——沿用 5 行/300 字门槛会漏掉「被截断却不给入口」的 3~4 行消息），点击 pill 或气泡弹全屏浮层读原文；气泡内滚动条隐藏，wheel/触控板仍可滚。
- **逐消息撤回 ↺ 徽标落位**：徽标从「块角 -9px 悬垂」收到时间线右端——钉住态行顶=滚动容器顶，负偏移部分被 overflow 裁成弧线残影（「看不见」的根因，top 必须 ≥0）；与「展开」pill 同为 hover 行显形。
- **钉顶关键坑修复**：① `.stuck` 多版不生效根因 = `getBoundingClientRect` 是视口坐标、`top <= 1` 永不满足（#toolbar 在消息区上方）——改为与 #messages 容器顶比对，MutationObserver 在行重建后回同步；② sticky 的约束矩形是滚动容器 padding 内缘，消息区顶部 padding 让块永远钉在缝下——去顶部 padding、提问行 margin-top 归零（自然流间距靠 margin 塌陷不变）；③ 透明 body 透出宿主绘制的底色随主题/停靠变——body 改自绘 sideBar-background，「遮挡色=面板底色」由构造保证任何主题不出补丁。

### 成本信任链（1.0.74–1.0.84，四环）

- **任务结算单**：官网价价格表（`DEEP_SEEK_PRICE_*` 可覆盖，无价模型 graceful 只显 token）+ run.receipt 结算行落盘（CLI+VSCode 双端）；statusline 花费两键 + `/usage` 近 7 天花费/缓存节省额/费用 top 会话；轮数浪费归因脚本 `scripts/round-attribution.ts`（同参重试/编辑切分/重复检索行为级打标）。
- **预算制运行**：`/budget` 设单任务花费上限，触顶先软提醒（BUDGET_FENCE nudge）+ 120% 轮边界硬截断（final 带截断提示、receipt 标 budgetTruncated）；子代理花费经 reportCost 回灌合并计账（不进落盘 costYuan，防 depth 拆分双重计量）。
- **上下文健康 HUD**：输入框旁水位环（UIEvent `context.usage`，口径与压缩判定同公式；填充 <50% 隐藏、70% 橙/90% 红），悬停显已用/窗口/阈值/压缩次数，点击手动压缩；旁边胶囊显会话累计花费 + 最近 run 缓存命中率（无价模型只显命中率）。
- **挂机批处理**：`deepseeker-code batch add|list|run|clean`——工单落 `<项目>/.deepseeker-code/batch/pending/`（frontmatter 标题 + accept 验收命令必填 + 预算/时限/工具白名单可选），batch run 串行执行（worktree 隔离 + 审批自动应答：编辑放行/高危拒绝记录 + 直跑验收），报告落 done/、改动 worktree 保留待人工处置；命令面板「查看挂机队列」+ 动作面板 Batch queue 项双入口。

### 检查点回滚与统一动作面板（1.0.72–1.0.73）

- **C1 对话级回滚**：每轮发送前自动记检查点，⏱ 面板选点原地截断回滚（字节级前缀重写 + 压缩态回落 + 水位失效），CC Checkpoints 同形态。
- **C2 文件级联动**：undo 记录按时间戳圈定写集合，每文件取最早未回退记录走 restoreForRewind（force 通道），modal 确认清单后先文件恢复、再截断对话；反向备份保手动改动可逆。
- **逐消息撤回（↺）**：检查点的单消息快捷形态——每条提问 hover 显 ↺，点击回滚到此消息发送前（对话与文件可选），原文自动回填输入框可改写重发。
- **统一动作面板**：输入框 "/" 按钮开面板（Context/Model/Commands 分组 + 模糊过滤 + 全键盘导航）；@ 文件提及全工作区模糊搜索；附件按大小自动分流（小文件全文内联、大文件转 read_file 引用）；`/bookmark` 常用 prompt 收藏；会话导出 Markdown。
- **性能**：子代理 system 段模板化（task/role/续跑说明挪首条 user 消息），同 manifest 派生与续跑首轮可命中历史前缀（前缀缓存逐字节匹配）。

## 1.0.63

工具系统重建 + 压缩/扩展面治理 + 召回增强（本版起追平 09-15 ~ 09-16 全部未上架批次，即本地 1.0.63–1.0.71 累积更新；版本号按线上 +1 重排，避免与已上架 1.0.62 之间留空洞）。

### 工具系统重建（路线 #8）

- **工具策略声明化**：triggersUndo / primaryArg / pathArgs / autoApproval / planAllowed 全部进工具协议声明，五处按名硬编码名单退役；漏声明 fail-closed 转人工审批，不再静默猜。
- **结构化工具结果**：成败判定唯一来源 `ToolExecuteResult.status`，按输出前缀嗅探成败退役——工具不再因输出文案碰巧含 "Error" 被误判失败。
- **运行时参数校验**：执行前按 JSON Schema（ajv v8）校验入参，畸形调用提前拦截并回结构化报错；MCP 工具按目标 schema 共享同一校验。

### 压缩与上下文治理（路线 #7 + 收尾批次）

- **压缩熔断单点治理**：超预算单元确定性预截断（保配对、去中段），超长工具结果不再把压缩打熔断、会话可续；熔断文案改指真实根因与自愈指引。
- **todo 完成度守卫**：收尾时清单仍有未完成项自动推一轮核对（全程生效、限 1 次预算，与 EARLY_FINAL 互补）。
- **超长输出侧车治理**：`完整原文已存档` 契约提为共享常量；侧车按会话总量 64MB 闸（mtime 最旧先淘汰）；postHook 截断输出同接侧车。

### 扩展面信任与记忆治理（路线 #9）

- **hooks 首跑审批门**：项目级 command/http/agent 规则首次执行强制人工确认，「总是允许」落盘 trusted_hooks.json 后直通；项目配置声明 `requireApproval: false` 摘不掉门；无审批通道 fail-closed 跳过。
- **记忆治理三件套**：memory_delete 升强制人工审批；memory_save 条数 200 / 索引 16KB 双上限；读写记 last-used 供日后淘汰与画像。

### 召回质量与多模态（路线 #10）

- **归档索引中文召回增强**：CJK 路径段、中文引号报错原文、错误码、URL、中文实体串入索，大小写归一去重——中文项目的旧上下文召回不再漏。
- **新工具 read_image**：图片视觉读取（vision 闸前置，base64 不进文本上下文）；read_file 命中图片扩展名自动转介。
- 跨 run 衰减折叠提示改指 recall（带确切 tool_call_id），被压缩原文可检索取回。

### VSCode 端

- **webview 防腐化拆分**：app.js 2236 行巨石拆为 9 个 ES 模块（state→markdown→diff→rows→toolbar→panels→modals→composer→events，bundle 入口与宿主零改动），顺手修 onMessage commands 分支调用闭包内 updateSlashMenu 的 ReferenceError。

### 工程质量

- **CI 守门上线**：GitHub Actions typecheck + 全量单测；失败时摘要进 run summary / artifact / 回推分支，无鉴权可诊断。
- **agent 热路径 14 项优化**（前缀缓存零影响）；**evals 三套成型**（任务级 16 题基线含成本折算列、压缩质量、风险分类器 + 扩展面行为级 eval）。
- **本地使用日志**：usageLog 落盘 + usage-report 三读口，真实使用数据回路。
- memory_save description 200 字符限长 + 持久记忆系统单测；读取工具失败文案统一 toolFailure 工厂出口；native realpath 统一修 Windows 8.3 短名误判越界。

## 1.0.61

工程质量与读代码体验修复（本版起追平此前本地打包、未上架的 1.0.64 / 1.0.65 全部内置更新，明细见本节末「本地 1.0.64 / 1.0.65」两个子节）。

- **修复：读代码被脱敏误伤**：内容脱敏此前把 `apiKey: process.env.XXX` 这类变量引用也打码成 `[MASKED_SECRET]`——agent 读自己项目代码只见掩码、看不到配置来源。现只打码引号包裹的字面量与 `Authorization: Bearer` 形态，变量引用原样放行（附 privacy-mask 回归测试）。
- **修复：无凭证环境测试/加载整崩**：OpenAI client 改 `getModel()` 懒构造，缺 `DEEP_SEEK_API_KEY` 不再在 import 期炸掉整条依赖链；`npm test` 无凭证 455/455 全绿，`npm run typecheck` 回绿（6 处 TS2775 清零）。
- **压缩落盘顺序铁律结构化**：「先写滚动状态、再写压缩事件」抽成 persistCompaction 单点，两份复制实现收敛为一处——崩溃恢复的方向性保证不再靠注释自觉。
- **nudge 行为锁死**：新增 27 条表驱动用例钉死六类守护（PLAN_FIRST / PHANTOM / EARLY_FINAL / TOOL_DIGEST / 周期自评 / 重复检索）的触发、预算与优先级，含两次事故回归钉（「你好」寒暄放行、实质长总结限长放行）。

### 本地 1.0.65（已并入 1.0.61 上架批次）

执行中动画（busy 指示）+ trace 记录生效模型。

- **全局状态栏指示**：任一页签 agent 执行中，VSCode 底部状态栏出现「⟳ DeepSeeker-Code」（CSS 自旋），点击直达聊天页签；面板被切走/最小化也能一眼看出「还在跑」，全部结束自动熄灭。
- **输入框上方 busy 条**：生成期间显示「⟳ 生成中… Ns」实时计时，结束即隐藏。
- **工具行转圈 + 已跑秒数**：running 状态的工具卡片右侧显示旋转 spinner 与逐秒计时（纯 CSS 动画 + 1s 定时器只改文本节点，不重建行，保留展开状态），工具结束被 ✓/✕ 状态替换。
- **trace 记录生效模型**：`llm.request` / `llm.response` 事件 metadata 新增 `model` 字段（streamInference 埋点），跨模型对账 / 按模型折算费用可直接分组，不再靠猜。

### 本地 1.0.64（已并入 1.0.61 上架批次）

模型名对齐官方在售清单 + 选择器清单实时化 + 修复死页签。

- **候选清单语义改为「非空 = 全量替换」**：设置项 `deepseekerCode.models` 配了什么选择器就只显示什么（此前是追加在内置之后，删不掉内置三项）；留空/未配回退内置 deepseek-flash / deepseek-v4-pro / deepseek-flash-vision-exp。
- **修复：未配置模型时选择器无「当前」标记、光标不落在生效模型上**。状态快照此前下发裸覆盖值（未配置时为空串，webview 匹配不到任何候选），现兜底为全局生效模型（core 默认 deepseek-flash）——标题「当前：…」、行内 ● 标记、预选光标三者一致。
- **修复：`/switch` 选择器显示已删除的候选模型**。聊天框 `/switch` 此前用 webview 缓存的快照清单直开（只在 state 消息时刷新），改了设置项后没有新快照落地就吃到旧清单。现一律经 host 回环现读设置（与命令面板入口同源），改动即时生效。
- **模型默认值更名**：`deepseek-v4-flash` → `deepseek-flash`（官方 API 当前在售名，2026-09-14 核对）。任何地方（env / 设置 / 记住的选择）都未配置模型时缺省 `deepseek-flash`；候选清单同步为 deepseek-flash / deepseek-v4-pro / deepseek-flash-vision-exp。此前手动配过旧名 `deepseek-v4.1-flash` / `deepseek-v4-flash` 的设置项需改为新名或清空走默认。
- 选择器预选：「切换模型」选择器打开时默认定位并预选当前使用中的模型。
- 修复：关闭最后一个聊天页签后再点「打开聊天」必报「Webview is disposed」，且不重载窗口永不自愈。
  - 根因：页签销毁清理时 `activeTab = latestTab()` 的求值顺序缺陷——`latestTab()` 优先读 `activeTab`，而此刻它仍指向正被销毁的面板，等于自己赋值给自己，死引用永久滞留。之后 openChat/newSession/selectModel 等命令经 `revealTab` 对已销毁面板 `reveal()` 直接抛错，且 `tabs` 为空也永远走不到新建分支。
  - 修法：`latestTab()` 只认活页签（跳过 `disposed`）；`onDidDispose` 里 `activeTab` 直接从过滤后的 `tabs` 取尾，不再经 `latestTab()` 自我引用。
  - 同类加固：`handleUploadImage` 在文件落盘 `await` 期间面板可能已销毁，回投 `imageSaved` 前补 `disposed` 守卫，消除同源未处理 rejection。
