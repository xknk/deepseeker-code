## 1.0.77

**飞书入口打磨：对账重放确认语不再重复回执 + 完成推送花费归一；「完成推送双发」排查定案（代码无罪）**——流水线代码由 CLI npm 包承载，扩展侧无行为变化，本条为对齐记录：

- **「完成推送双发」排查定案（今日 B 组验收腿四票手机各收两条）**：飞书服务端历史消息硬对账实证每票完成推送【仅一条】（消息 id 与 listen 日志/映射表逐一吻合），代码侧单点发送、零重试零重发——手机端第二条为飞书客户端渲染/通知层现象，非本产品缺陷。排查期间钉死的两个真缺陷一并修复（下两条）。
- **对账重放确认语不重复回执**：确认语闸（B3）在一切内容去重上游且不登记状态，而对账游标按【归一成功的消息】推进（bot 消息不占游标）+ 毫秒游标 floor 成秒查询边界——旧确认语每轮被重拉、实时路已回过的「知道了」被对账连回 2–3 次「👍 收到」（真机实证）。修后对账重放路静默跳过（留痕日志），对齐「对账重拉 duplicate 不回话」既有原则。
- **完成推送花费 ¥null 归一**：无价模型报告 frontmatter 曾字面写 `cost-yuan: null`，推送显示「花费 ¥null」——写点改 `"?"`（与报告正文「无价模型，不计钱」口径一致），推送侧对旧报告字面 null 兜底归一。
- 守门：listen 确认语重放静默结构断言 + notify cost 归一各 +1 例。

## 1.0.76

**多入口流水线 P3（webhook 入口）+ 挂机打磨第一批（defaultSetup / 改动清单交接 / PR 正文小修），随 CLI 1.0.66 同批 core 发版**——流水线代码由 CLI npm 包承载，扩展侧无行为变化，本条为对齐记录：

- **P3 `POST /hooks/:channel`**：内网 CI 钩子 POST 即建票入挂机队列，与 `batch sync` 同闸同管线（引用块边界 / accept 四档 / 附件三态 / 锁互斥 / 内容哈希去重 / 每 channel 限流 + 每日上限共享配额），鉴权复用 serve token，配置面零新键。
- **`defaultSetup` 配置键**：定时建票自动附带环境准备命令——没人补 setup 的票不再每晚 baseline-broken 空转。
- **改动清单交接**：报告固化 `changed-file:` 清单、续修票注入【前次改动文件】段，续修免重新探索上票改动。
- **PR 正文**：剥 name-status 状态前缀 + 中文路径 quotepath 修复（八进制串不再进正文）。

## 1.0.75

**多入口工单流水线 P1+P2：`batch sync` 拉单 + `batch pr` 交付——GitHub/GitLab issue → 挂机票 → agent 修复 → 验收 → 草稿 PR**。真仓闭环实证两单：本仓库 issue #2（dogfood，修的正是流水线自己的遗留「batch clean 不清附件目录」）一单走通——sync 建票 → 基线校验（setup 装依赖 + 干净树探针）→ agent 26 轮 ¥0.38 缓存命中 96% → 验收 exit 0 → 产物分支 → 人工采纳关单：

- **多入口工单流水线 P1（`batch sync`：issue → 修复 → 验收 → 产物分支）**：把打了准入 label 的 GitHub/GitLab issue 自动拉成本地挂机工单。sync 是**零 LLM 轻模块**（不配 API key 也能同步/体检）：三态去重（sync-state.jsonl，正文变化记 changed 续修留 P2）+ 规则闸（作者白名单/屏蔽关键词/正文超长/同标题重复，纯规则无 LLM）+ **accept 四档**（本地配置 > issue 的 accept 块默认完全忽略、显式开启也只收单命令形态并强制人工复核 > 自动探测 package.json/Makefile/go.mod > 拒绝建票；watch 抑制由 runner 注入 CI=1 环境变量，跨平台）+ **基线三态校验**（agent 开跑前在干净树上先跑验收：环境装不上=setup-failed 不缓存、基线红=baseline-broken 当日缓存、超时=疑似 watch 单列——**基线红的仓库零 agent 花费**）+ 附件链 GitHub 单平台（下载落盘到保护段、正文给绝对路径、文本内联尾部、图片/未知类型三态标注，含图强制 needs-review，报告统计 read_image 次数）+ **总量硬闸**（`batch run --max-total-yuan` 每票开工前检查、超限停在票前；sync.json `maxTicketsPerDay` 每日建票上限）+ `.sync.lock` 单飞 + `--check` doctor 逐项体检（每项 ✓/✗+怎么修，失败退出码 1）+ `--dry-run` 零副作用预演 + **注入边界双层**（issue 正文引用块包裹 + 仅 batch-* 会话的 system「数据非指令」段）+ **仓库一致性标注**（多 repo 配置下本地 remote 与 issue 来源不一致→控制台警示+票内注记+强制 needs-review，fork 工作流任一 remote 匹配即不报）+ CLI 退出码透传（定时器/CI 能看见失败）；README 双语三平台（cron/launchd/任务计划）双时钟示例 + sync.json.example。新工单字段 source/source-url/source-id/needs-review/continues/attachments 全部不进模型上下文、非法值 fail-closed 拒收。
- **多入口工单流水线 P2（交付与续修）**：`batch pr <票id>` 把验收通过的票交付为**草稿 PR**——前置预检（报告+passed → needs-review 闸无豁免 → 幂等标记 done/<id>.pr.json 防重复交付）→ 从产物分支重建审查 worktree → 强制 fetch 主干 + 落后/merge-tree 冲突预检（首版**不自动 rebase**：拒付 + 手工命令 + 打标）→ diff 预览 → push `agent/<票id>` → GitHub `gh pr create --draft`（fixes #N）/ GitLab Draft MR（Closes #iid）；**PR 正文四要素脱敏**（标题/状态与成本/改动文件清单封顶 20/花费——diff 与验收输出永不外发）。**改测试即降级**：路径启发式（tests?/、__tests__/、*.test.*、*.spec.*）+ sync.json `testPathPatterns` 可扩展 → needs-review → 拒交付（「改测试过验收」靠结构检测不靠提示词）。**续修链**：指纹 v2=标题+正文+近 5 条评论 (id,updatedAt)，issue 变化 → 续修票（continues 前票、继承 accept/setup/budget、以前次产物分支为代码基座，不从 main 重做；P1 旧状态首见迁移 v2 无升级洪水）。**账本**：`batch/ledger.jsonl` 每 run 追加 {at,tickets,green,red,costYuan}，`batch status` 汇总近 7 天 + 队列实况。**GitLab 补齐**：附件链三态与仓库一致性标注（P1 只落了 GitHub 侧）。真仓试点实证：issue #3 → 票 20261105-130304-fr7x → agent 4 轮 ¥0.028 → 草稿 PR #4（正文四要素、diff 未外发、幂等标记落盘全验证）。
- **P1 前置：batch worktree 收尾 commit 快照**：任务收尾把全部改动固化为 dsc-wt-* 分支上的 commit（`--no-verify`/关签名/显式身份兜底无人值守机器，失败不抛错带回报告）——原「改动保留待人工处置」实际只活到下次进程启动（启动清扫 tmpdir worktree），现在跨重启不丢、`batch pr`（P2）才有可交付物。守门 worktree-commit.test.ts 5 例（有改动/无改动/agent 自提交/提交失败/无 git 身份）。
- **sync 票 id 统一按注入时钟预生成**：github 票走附件分支先占 id（注入 now()），gitlab 票曾落到队列默认真实墙钟——队列按文件名字典序当 FIFO，同 run 多源建票的排序随现实时刻漂移：CI runner（UTC）上午跑时 gitlab 票排到 github 票前，双源测试读「最后一张」读错票断言炸，本地 UTC+8 下午跑恒绿（典型「我机器上没问题」）。修后两票 id 同源，排序确定性成立，原断言成为回归锚。
- **`batch clean` 回收附件目录（L0 dogfood 产物，agent 修复采纳）**：清 done 存档时同步回收 `attachments/<票id>/`——本次清掉的票直接删；无票可依的真孤儿按 10 分钟宽限期删（防误删在途 sync 的下载目录，clean 与 sync 可并发）；pending/running 的票及附件一律不动。守门测试进 batch-ticket.test.ts。
## 1.0.74

**版本口径重置后首个发版（版本号按 Marketplace 线上+1 重编；原本地号链 1.0.75–1.0.77 作废未发布）**，批量携带四组已合入主干但从未单独发版的修复 + 本轮 D5 四轮收尾 + 缓存塌方治理：

- **缓存塌方治理（M1 观测 + M2 记忆冻结 + M3-1 单次破规则）**：11-04 全天 trace 实证三处前缀缓存塌方（合计 ≈¥1.0/天；miss 单价是 hit 的 50 倍）。**M1 观测先行**：trace 新增 `context.check` / `context.decay` / `llm.contextDowngraded` 事件，`llm.request` 增补 estReal / thresholdAtSend / correctionRatioUsed 三值——「当时为什么触发」焊进 trace，事后可回算；sumHash 定义钉死 = sha1short(摘要槽)，据此排除 r54 两个候选根因（写槽必变 sumHash，全天恒空 = 槽全程字面空串）。**M2 记忆索引会话级冻结**：会话中途 memory_write / memory_forget 不再改写 message[0]（前缀缓存不被击穿，实测该项损失 ¥0.58/天量级），新记忆下一会话生效；serve SessionEnd 释放快照防长驻进程无界增长。**M3-1 单次破规则**：decay 改写历史后不再「降回阈值内就早退」，无条件续走同一次调用里的 LLM 压缩——消灭「衰减破一次 → 下轮压缩再破一次」的双破形态（r53→r54 实锤），压缩红利当次兑现；compactRatio / cacheFactor / 硬顶 0.82 参数零改动，调参等 M1 埋点攒 1–2 周真实分布数据（M3-2）。守门 window-check-events / prefix-fingerprint / memory 契约测试共 +13 例。
- **调度层落盘降级并入 run 级 degraded（D5 四轮，本轮新增）**：ScheduleResult 增加 degraded 字段回传调度层 6 个落盘点（终结/中止占位、并行批、终结工具、串行工具、图片跟随）的失败——工具结果丢失 = 上下文永久残缺（恢复补占位、原始结果不可逆），比边界事件丢失重一个量级，此前完全静默；appendMessages 返回 {written, failed}（批内回落路径的二次失败也计数）；重复熔断占位落盘失败可观测；trace 中途丢批粘性计数（定时器/阈值档 flush 失败不再无人接收——粘性留标记，run 收尾全量 drain 报一次即清；swap-and-clear + 串行化防「在途写」误判为「没货」）；聚合告警措辞改为「具体后果见组件名」（degraded 现含收尾旁路/消息落盘/emptyAssistantSkip 三类性质不同的信号，旧措辞只覆盖第一类）。守门 audit-fixes-d5-round4-2026-11-03.test.ts（单元/集成/反向三档）。
- **空断流毒化会话三层设防（生产 0d245bd0 实证）**：DS 服务故障期流 126s 0 chunk 0 usage「干净」结束被当 ok 完成，content:null 的 assistant 消息进历史并落盘，此后每轮请求必 400（Invalid assistant message），会话永久报废。三层：streamInference 空断流按 stall 同款重试（共享 idle 预算、让位中止信号）+ emptyStream trace 标记；runAgent 空 assistant 不 push 不落盘（PHANTOM nudge 接管 + markDegraded）；出口 stripHistoricalReasoning 整条丢弃存量毒消息（受害会话免迁移自愈，不受 PASSTHROUGH 门控）。守门 empty-assistant-poison.test.ts 8 例；replay PHANTOM 剧本与 async-wake 门控桩补 usage 末包（对齐真实 wire）。
- **收尾降级观测从「外层猜」改为「内层如实回报」（D5 二轮）**：appendEvent / appendMessage / recordUsageRun 返回 boolean、flushTraceBuffer 返回失败会话数、flushLeftoverToTranscript 返回 {flushed, failed}——吞错照旧（旁路不击垮收尾）但调用方拿得到真话；runAgent 收尾按返回值聚合 degraded[]，结算单新增可选 degraded 字段（用户可见通道）。EISDIR 毒化法守门打通真实落盘失败路径。
- **主循环盲区消费返回值（D5 三轮）**：round.end 两条闭合路径与 appendMessage(assistant/user) 的写失败接入 markDegraded；degraded/markDegraded 上提至函数体顶部；receipt 快照边界前移（updateCalibration 前置于结算单，其降级进用户可见通道）。
- **运维与成本审查五项（D6→D3→D5→D2→D1）**：PreCompact/PostCompact 三条中途退出路径强制配对（try/finally）；收尾旁路降级聚合可见（degraded[] 雏形）；崩溃恢复文案中性化（unclosed/cause unknown，不再硬编码「崩溃」伪结论）；压缩自收敛判据只量叙述段（索引段满编长会话不再白付不可能有收益的辅助模型调用）；注释纠偏。

## 1.0.73

**修复：VSCode 端存储分桶键错挂（会话/trace/undo/usage 全部落错桶）**——扩展文件顶部的静态 import 链会在主根 chdir **之前**求值 core config，存储隔离键被钉死成扩展宿主 cwd（即 VSCode 安装目录，「App-Microsoft VS Code」桶）。2026-10-21 的切根修复只覆盖了**显式切换**路径，首次挂载仍错——真实数据实锤 10 月 78/98 个 run 归因错位。现 activate 注入重导钩子后**无条件按已解析主根重导一次**（幂等，CLI 形态零行为差异），守门测试源码扫描钉死该兜底调用。注意：历史 VSCode 会话仍留在旧桶（磁盘不迁移），修复后新会话按项目正确分桶。

---

子代理异步化与完成唤醒（路径 B）：**spawn_agent / run_workflow 异步启动**——首个工具结果即返回 agent_id / 工作流概要，子代理在后台执行；完成后**结构化汇报自动送达主会话并程序化唤醒新一轮 run**（主会话在跑 → 轮边界自然消化，idle → 自动续跑）——模型不再同步长阻塞等待，对标 CC 的后台 agent 体验。（版本号按线上迭代：Marketplace 线上 1.0.72，本版 1.0.73。）

- **异步启动 + 完成自动唤醒**：两工具改 `isSync:false`（执行层首个 yield 即回、generator 挂起期间后台 drain）；完成回调推三态汇报（final/aborted/error），正文超 **4096** 字符截断并附 resume 追问提示，工作流只回流终态汇总（截断 **18000**，中间态不回流）；主 run 还在跑 → inbox 轮边界 claim 消化，已结束 → 哨兵 user 消息（`⟦DSC:AGENT-DONE⟧`，transcript 回放一眼看懂「主 agent 为何自己开始说话」）+ 程序化唤醒 run，CLI/VSCode 端有清晰唤醒标识。
- **风暴防护与链路收敛**：同会话唤醒串行单飞（busy 泵），多个子代理同时完成**合并进同一次唤醒 run**（一次 claim 整队兑付）；唤醒 run 纯确认不再产生新唤醒；无宿主驱动时唤醒丢弃、inbox 保留永不丢失。
- **缓存纪律（红线）**：唤醒 run 首条消息与 inbox 注入都是「既有前缀之后追加」，不重排/不改写历史——DS 前缀缓存跨轮照常命中；完成回调先于在飞释放，`waitSessionQuiescent` 真正意味着「无在跑 run、无待发唤醒」（batch 验收不与唤醒 run 赛跑）；子会话 trace 共文件设计不变。
- **既有护栏原样 + 中止语义**：同 ID 在飞拒续跑（transcript 单写者）保留并加回归；子代理禁 `run_in_background` 名单不动；不新增轮询式取结果工具（wait 仍是长阻塞，路径 A 明确否决）。宿主中止只断本轮交付——执行层 `gen.return()` 拦在完成回调前，无中止后唤醒；唤醒 run 被中止则汇报产物保留、不引发新唤醒。
- **三端接线 + batch 继承**：serve（headless 兜底驱动）/ CLI / VSCode 各自注册唤醒驱动（VSCode 代际守卫：旧轮 finally 不误清唤醒轮的中止柄与 busy 态）；batch 的唤醒 run **继承工单自动应答器与预算**、worktree 重挂，验收前等唤醒链收敛，任务定态先摘驱动防 teardown 竞态。
- **守门**：新增 core `agent-async-wake.test.ts` **11 例**（异步返回零 LLM 调用/run 在跑回流/idle 唤醒/合并唤醒/截断/工具表语义钉死/中止双路/级联收敛/护栏回归/batch 继承），线路路由门控假 LLM 全链路驱动、零 API 成本零真 sleep；core 全量 **789 例** + cli **23 例**绿，三端 typecheck 绿。

---

看门狗双闭环：**挂机批处理看门狗（进展感知）** + **交互空转影子模式（影子先行）**。batch 侧给无人值守任务装上烧钱闸门——默认开启，`DEEP_SEEK_BATCH_WATCHDOG=0` 一键关闭（关闭路径与现状逐字节一致，守门钉死）；交互侧判定层照进真实 VSCode 会话，只记日志不干预，为黄灯版（2b）攒误报率数据——默认开启，`DEEP_SEEK_WATCHDOG_SHADOW=0` 关闭（零实例零文件）。

- **batch·六条规则 + 健康信号短路**：R1 同参数重复调用（强）/ R2 只读空转（弱）/ R3 事件流断流（**唯一直杀**，5 分钟无任何事件）/ R4 烧钱无产出（弱）/ R5 写入方向偏差（弱，工单正文提取不到目标路径则整条自关）/ R6 净进展停滞（强，每 tick 在 worktree 跑 `git diff --numstat` 维护净变更行数时间序列，排除 lockfile、基线取 setup 完成后）；连续窗口 diff 增长 >20 行或新文件出现 → 健康短路直接判 normal（对 R2/R4 的反证，跳过二层调用）。
- **batch·二级仲裁**：程序规则只出「疑似」，强规则疑似才升级 AUX 小模型非流式复核（normal/idle/offtrack 三值 + 证据）；AUX 调用任何异常（网络/超时/非法 JSON）一律降级 normal——看门狗自己坏，不能变成误杀器。
- **batch·三级动作闭环**：nudge-1（inbox 改道提示）→ nudge-2（最后通牒 + 收尾汇报 + 5 分钟冻结窗）→ 第三次连续非 normal 才 abort；nudge 走 `pushSessionInbox` 不新造通道；经收尾汇报正常 final 的任务照常走 accept 验收，不标 watchdog-killed。判定循环用可注入 scheduler（缺省 setInterval，测试假时钟零真 sleep）；setup/accept 命令执行期 PAUSED 豁免。
- **batch·工单可选 `retry` 字段（默认 0，上限 3）**：被终止后同 worktree 带证据重试——上轮 verdict/evidence/收尾摘要注入二轮首条任务（强制换思路锚点），budget-yuan 跨轮累计共享、timeout-min 每轮重计；二轮再挂即终态，报告记两轮证据。解析封顶 0-3（双倍烧钱口子须关）。
- **batch·报告新增「看门狗」段**：判定/疑似/宽限/杀令/重试全程证据落 `batch/done/<id>.report.md`；`status: watchdog-killed` 的报告**不跑验收**（工单已被杀，accept 无意义），watchdog-killed 终态报告与重试二轮报告均含看门狗段，普通报告零新增段。
- **判定层上收 core（StallDetector）**：状态 + 采样 + R1-R6 + 健康短路 + tick 循环（可注入时钟/调度器）收进 `core/agent/stallDetector.ts`，每 tick 产出 StallEvaluation 交政策层——batch 三级动作与交互影子日志是**同一求值结果的两种消费**；batch 特有字段（nudge/杀令/AUX 裁决）留在 cli 政策层，BatchWatchdog 公开 API 一个不改、23 例守门断言不变（搬迁零回归双保险）。
- **影子政策零干预零成本（shadowWatchdog.ts）**：只追加写 `<项目>/.deepseeker-code/watchdog-shadow.jsonl`（JSONL 每行 ts/sessionId/kind/rules/evidence/runMin/round/netLines），不亮灯不 nudge 不 abort、**永不调 AUX 小模型**（守门测试注入 auxAdjudicate 断言零调用）；强命中记日志后 5 分钟抑制窗（同一空转 episode 去重），弱信号不抑制；健康行作复核时的对照组。
- **交互规则适配（不是照搬）**：R3 断流降级为仅记录——交互端静默常态是等审批/等提问（走 PAUSED 豁免），PAUSED 外静默才记；R4 关（交互 run 无工单预算语义）；R5 自动关（无工单 → 目标路径集合空集）。判定周期 60s、起步宽限 5 分钟——短问答 run 全程在宽限期内零求值零采样；R6 diff 采样固定跑会话主根（process.cwd()）。
- **VSCode host 接线（~15 行）**：sink 尾部 feed（白名单五类事件，其余静默忽略）、审批/提问挂起 `setPaused(true)` 与解锁恢复、runOnce 创建 start / finally stop（run 生命周期 = detector 生命周期）；开关关零实例零文件；`.gitignore` 同粒度补日志行。
- **守门**：新增 core `stall-detector.test.ts` 14 例（规则触发/防误杀/宽限/抑制窗/silence 面/PAUSED/结构化输出）+ `shadow-watchdog.test.ts` 8 例（零 AUX 红线/抑制窗/schema/默认落盘/开关/host 接线源码扫描）；cli 23 例断言不变只换 import；ticket retry 解析 1 例；npm test 链路扩展进 cli 测试套件（根 package.json `test` 串联、新增 `test:cli`），三端 typecheck 绿。

---

外部记忆桥接（External Memory Bridge）：把其他 agent 的规则/指令文件——全局 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`，项目级 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`、`.cursor/rules/*.md`、`.github/copilot-instructions.md`——以**只读条目**纳入记忆索引，多 agent 并行工作流里「别人踩过的坑」不再从零再踩。默认关闭，settings.json `engine.memoryExternal: true` 显式开启（关闭时记忆行为与旧版逐字节一致，守门钉死）。

- **只读红线**：外部条目 `ext-` 前缀、type=reference，索引行带 `[外部:xx]` 来源标注（二手信息可打折看待）；`memory_save` 拒 ext- 开头名称（保留字）、`memory_delete` 拒执行并提示到来源文件处修改——绝不回写外部文件。
- **缓存纪律（生命线）**：外部文件仅进程启动时读盘一次，此后 run 间/会话间绝不重读，变更生效粒度 = 进程重启（CLI 每命令新进程自然刷新；VSCode 重启窗口生效）；索引行稳定性靠「description 定长截 120 字符 + 固定前缀 + 正文不进索引」，同组文件二次加载索引逐字节相等有守门钉死。
- **预算双闸**：外部条目计入既有共享池（200 条 / 16KB 索引字节，越界单项拒载、自有记忆优先保住），另设外部独立软上限 **12 条**（超限按 mtime 丢最旧 + warn 一次），防 `.cursor/rules` 规则大户无界侵蚀索引预算。
- **隐私边界**：开启即意味着同意来源文件内容随请求发送给 DeepSeek API——首次接入时 console 提示一次；项目层来源与项目记忆同受工作区信任闸门（未信任不加载）。
- **守门**：新增 core `memory-external.test.ts` **11 例**（扫描发现/缺省静默/开关关/name 保留字/delete 拒绝/超限丢弃/共享预算/索引稳定/覆盖语义/body 截断 + cursor 文件名清洗）；core 全量 **800 例** + cli **23 例**绿，三端 typecheck 绿。

## 1.0.72

IDE 选区注入（对标 Claude Code 的 ide_selection）：编辑器里选中代码后，**composer 上方自动出现选区 chip**（`file.py#L22-23`，× 可忽略），随下一条消息发送——**标签块拼进模型可见正文尾部**（照抄 CC 文案含 "may or may not be related"，相关性判断交模型），消息行内以折叠块展示选区原文，历史回放经反解还原同构。

（版本号说明：一律按线上迭代——Marketplace 线上 1.0.71，本版 1.0.72；本地曾以 1.0.72/1.0.73 打包未上架，号位让回线上序列。）

- **判断纯机械**：活动编辑器非空且含非空白字符的选区即快照（150ms 尾沿去抖）；切编辑器立即作废旧快照，防把 A 文件的选区附到看 B 文件的消息上；纯空白选区（拖过空行）不注入。
- **webview 聚焦不清快照**：聚焦聊天面板时 activeTextEditor 变 undefined 且事件照发——此刻正值发送前，清了等于自废选区；只切到另一个文本编辑器才作废重取。
- **一次性附带**：发送即消费（同贴图/引用），选区未变不自动重发，避免陈旧选区逐轮重背；`!` 直执行轮与 busy 排队轮不带选区（排队协议纯文本，如实提示不静默丢）。
- **缓存零损伤**：标签块只进当前消息尾部，system+历史前缀逐字节不变；选区原文超 4000 字符截断标注。
- **纯逻辑模块 selection.ts** + 守门 7 例（round-trip 闭合、冒号/换行误切、截断、入站校验）；两条消息通道（sink/handleEvent 与顶层 onMessage）的 row 均透传 sel。

## 1.0.71

两天修复总包（相对线上 1.0.70 的全部增量）：Agent 并行工具批与可观测性六批次 + 四项用户可感知修复。core 全量 755 例绿 + core/cli typecheck 绿。

- **并行批批级上下文预算（A）**：并行批按「距压缩阈值剩余窗口」50% 设批级输出上限、按批均分，治 read_file 128K × 并行 N 个一次注入十余万 token 直击压缩阈值——降压缩触发频率省 token；单工具/串行路径截断行为逐字节不变；tool.batch.budget 校准埋点随包（真实分布 ≥50 批后回调 CHAR_PER_TOKEN）。
- **异常隔离（B）+ 重试解耦（C）+ trace 治理（D）+ 日志截断（E）+ 子 agent 一屏汇报（F2）**：单个工具未预期异常收敛成隔离 outcome，不再炸整批留孤儿 tool_calls；idle/API 重试计数解耦（限流不再吃掉 stall 预算）；trace 批量落盘 + 超长截断 + 错误即时 flush（黑匣子尾巴不丢）；工具调用日志 >200 字符截断（DSC_DEBUG_TOOL_ARGS 还原全量）；顺手修 collectToolResult 定时器泄漏（promise 拒绝时挂住进程退出 122s→2s）。
- **run_command 中止语义收敛**：「■ 终止无效」根治——abort 不再只杀最外层（孙进程攥住继承管道令 close 永不触发），killTree 整树剿灭 + 中止退出码恒归一 ⟦DSC_EXIT:-1⟧（与命令自身失败可区分，verifyResult -1 专用提示生效）；新增中止链路集成守门（单进程基线 + tsx 多层进程树生产挂死形状）。
- **后台等待不再空转**：get_background_output wait_seconds 上限 120s→90s——旧上限与调度层 120s 工具熔断同时钟响，wait 调用真实结果被超时文案吞掉、模型原样重试再熔断（会话历史 7 连挂实锤，每轮空烧 2–4 分钟）；schema 文案同步改写：预计更久就传 90，返回仍 running 再调一次接着等。
- **嵌套围栏渲染修复（webview + CLI）**：4+ 反引号包整份可复制文档（交接汇总等）不再被内层 ``` 误切碎成散段——闭栏反引号数 ≥ 开栏才算闭合（CommonMark），未闭合到 EOF 回落纯文本。
- **webview 钉顶提问卡空白根治**：钉住态行盒退出布局、改零高 sticky 占位卡悬挂卡片克隆——钉住与否都不占布局、不动 scrollHeight，~254px 悬空空白由构造消失；钉住判定/折叠/重建三路同步随迁。

## 1.0.70

Agent 内核打磨（runAgent 主循环 + 四协作模块走查后两批收拢）：成本账本收拢成 runLedger 模块（主项）+ [DSC-DIAG] 日志治理。core 全量 729 例绿（711 基线 + 18 新增）+ 三端 typecheck 绿；改前/改后以回放驱动对照：结算单金额、usage.jsonl 落盘行、预算截断 final 文案逐字节同形（剔除时间戳类易变字段）。

- **成本账本收拢（runLedger）**：runAgent 平铺的六个跨轮账目状态（主模型 token 账 / 按次工具账 / 辅助模型账 / 子 run 展示账 / 预算圈 / 用量合计）+ 子 run 成本中继收拢为每 run 一实例的 runLedger 闭包模块——分账/并账关系、flush 基数=子树完整口径（防 depth≥2 孙代花费困在中继层以下）、精度红线（入账点裸浮点累加、快照输出点才六位舍入，防 1.2× 截断轮次漂移）由代码结构与文件头单一论证钉死；纯结构收拢零控制流变化，runAgent 净瘦身 62 行。
- **预算硬线单点化**：1.2× 硬截断倍率提为 BUDGET_HARD_LIMIT_RATIO 常量，子任务自武装探测与轮边界硬截断共用同一判定（overHardLimit，>= 语义与改前逐字节等价）；预算圈武装条件在调用处收窄（仅主 run 且 >0，保留 != null 判定链）。
- **校准 EMA 权重常量化**：历史 0.6 / 新观测 0.4 提为 CALIB_EMA_KEEP / CALIB_EMA_NEW 文件顶常量。
- **新守门**：run-ledger.test.ts 18 例——分/并账矩阵（五笔入账各进正确落盘账且全部进预算圈、子账绝不进 usageLog 防双重计量）、入账守卫（NaN/0/负数/Infinity 忽略，防 NaN 毒化预算圈致硬截断静默失效）、观察者转发（usage 缺省仍转发 + 抛错被吞）、无价模型 costYuan=null 不编数、硬线 >= 边界、中继幂等 + depth=2 子树口径模拟、结构断言（中继基数钉在预算圈变量 + budgetYuan 调用处收窄）；既有内核审查守门等价改写 2 处（flush 计数换 ledger.flushRelay 目标、子账扫描随迁 runLedger.ts，意图不减）。
- **日志治理**：删除 streamInference 成功路径 [DSC-DIAG] 行（与 trace llm.response 事件全量重复 + stdout 刷屏）；错误路径保留但改写为 console.error ❌ 风格（stdout 对「run 为什么死了」的可观测性保留）。

## 1.0.69

线上 1.0.68 后的全部积累一次发布（本地曾以 1.0.69–1.0.78 十个版本迭代、均未上架；现按线上版本序列收敛重排为 1.0.69，十个细分条目全文见 git 历史）。core 全量 706 例绿 + 三端 typecheck 绿。

- **Agent 内核审查报告四批修复**：P0 firstPrompt 取当前轮 / 辅助模型花费入账 / 文件类二元快路径；子 agent 预算增量上报（costRelay 增量中继 + budgetCheck 闭包三环贯通，轮边界即时中止超支子任务）；计划拒绝熔断（2 次转向 nudge / 4 次强制收尾）；窗口/校准按模型维度（MODEL_WINDOWS + per-model 校准分键）；工具声明化收尾（CustomTool 五声明字段，四处按名特判退役为声明优先+名单兜底）；allow-session 真会话级（Map<sessionId,规则桶> 容量 64 + 双会话隔离守门）；processToolCall 四阶段纯移动拆分（安全链 9 环节顺序零变化）。
- **CLI 后置命令**：/undo（restoreLast 同链路 LIFO 可逆）、/rewind（listUndoable 分页 + restoreByUndoId 选择性回退，creation_marker 回退=删新建）、/diff（本 run 时间窗 undo 记录 vs 磁盘净变化红绿汇总）、审批按 f 展开截断前全文（meta.fullDetail 透传，400 行绝对上限）。
- **审批与可见性**：审批四态（allow-once / allow-session / allow-always / deny）CLI/VSCode/serve 三端同步；命令安全分类器全程可观测（判定中进度 + 结论回报 + fail-closed 来由入审批 detail）；子 agent 进度按 agentKey 分行互不踩；结算单并列展示子任务花费（展示账/计量账分账零重复计数）。
- **挂机批处理**：batch 工具过滤改读声明（batchAllowed 优先、fail-closed 兜底）；解释器×仓库脚本供应链闸门（node/python/裸构建工具直跑仓库内脚本默认拦截，工单 tools: 加 interpreter 伪槽位解锁，交互链零打扰）。
- **收尾回复治理**：【回答形式】新增说人话（先效果后手段、术语跟白话）与收尾自然简短（原则化对标 Claude Code，无硬模板/行数上限）；EARLY_FINAL/TOOL_DIGEST nudge 文案收紧，完成判据与四类收尾守护逻辑零改动。
- **工具声明漂移收尾（审查报告第 17 项）**：move_file primaryArg 'src'→'source'（「总是允许」从不生效→生效，作用域宁窄不放大）；list_dir 删幽灵主参数；permissions.ts 退役 'src' 死分支；tool-declaration-drift.test.ts 全表断言 + 防假绿 + 回潮锚点（反向验证过）。
- **守护轮 400 修复（reasoning_content）**：收尾 nudge 轮模型改调工具 → 历史出现「相邻 assistant 且后者带 tool_calls」，出口剥离器误走宽松档全剥思考记录被 DS 严格档 400、run 以 error 终止；stripHistoricalReasoning 新增该形状判定回退全量回传（纯文本相邻不触发，~25% 瘦身收益保留；探针 W7/W8/W9 真实 API 实证 + 守门 14 例）。
- **多根工作区隔离键**：deriveWorkspaceKey 纯函数 + VSCode 切根后重导隔离键（会话/trace/undo/worktree/用量五桶跟随新主根）；切根即开新会话（旧对话保留可切回续接）；会话 state.json 盖章 projectRoot——修历史面板跨项目串显。
- **webview 交互**：assistant 回复与围栏代码块一键复制（复制原始 Markdown 保真、capture 委托与点击放大互不干扰、剪贴板降级原语 + ✓ 反馈）；钉顶提问块穿模修复（独立不透明垫板 + 双层背景，纯 CSS）。

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
