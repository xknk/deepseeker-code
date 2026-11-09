# Changelog

## 1.0.73

飞书反馈闭环真可用（真机联调实锤：不回消息 = 不可用；零新配置键）：

- **即时回执**——过白名单闸的消息必回：建票带票号与排队位（「已建票 xxx…前面还有 N 张」）、重复/未建票（配额上限等拒因留痕）/异常各有回执；白名单外保持静默（防探测），群聊回执 @ 发送者。1.0.72 及之前全程静默，发消息后无从知道建没建票、排第几。
- **完成推送**——`finishTicket` 单一咽喉：飞书票跑完（成功失败都）落通知文件，监听器扫描发送「状态/改动文件数/花费/分支」+ 续修指引；监听器不在线文件原地等（重试上限 5 次），不再依赖人盯控制台。
- **回复即续修**——回复原消息/回执/完成推送 → 消息映射表路由：原票排队中 = 追加段并入正文（引用块边界 + 运行锁）；已完成 = 自动建续修票（`continues:` 继承 accept/setup/budget，base 分支取前次报告）；跑着/查无 = 回落普通建票。回复免 @ 但发送者必须 ∈ 白名单。
- **外发红线不变**：回执/推送只含状态与元信息，无 diff、无验收输出。

真机验收当日连带修出的三个生产缺陷（全部实锤复现后修复）：

- **基线探测迟滞复测**——测试套件在白天用机负载下偶发单用例红（间歇 ~40%，红用例每次不同），一红就写「今日已验不通过」当天缓存会把**全天票堵死**（实锤：08:36 一轮 flake 毒化一整天，票零花费全拒）。现探测红隔 30s 复测一次，二次红才定罪缓存；真红仓库两连红只晚 30 秒。
- **worktree 同名残分支堵死重跑**——上次失败尝试留下的残分支（worktree 目录已被清）会让 `worktree add -b` 撞 "branch already exists"，该票**永远跑不起来**（实锤一早连咬三次）；现自愈：清目录 → `worktree prune` → 删同名残分支（只可能是本槽位上一次尝试的尸体）→ 重建，守门测试钉死。
- **finishTicket 读空窗口**——`rename(running→done)` 在 Windows 高负载下存在「源已去、目标未现」的可见窗口，双侧读空时完成通知文件不落盘、推送静默丢失；现读空退避重试（900ms）。
- 测试加固：listen 系等待预算 8s→20s（满载假超时实锤）、notify 咽喉测试改串行取跑与生产同构（连取两张会被残留回收语义退回一张——随机 id 排序决定谁被退，50% 硬币，取证实锤）。

## 1.0.72

飞书断线补票真打通（断线三连验收腿暴露的三连修，全部真机探针实锤）：

- **对账拉取时间单位是秒，不是毫秒**——`im/v1/messages` 的 `start_time/end_time` 传毫秒 = 公元 3 万年的未来窗、查询恒空：游标照常推进、补票功能此前**从未工作过**（实时建票正常掩盖了它）。现查询边界换算秒（内部游标仍统一毫秒），守门测试钉死 10 位秒形态。
- **list item 类型字段是 `msg_type`**——归一只认事件路 `message_type` 与想当然的 `type`，真实列表 item 的 `msg_type` 两头不匹配 → 恒判「形态异常」跳过；补 `deleted` 消息拒收，守门测试逐字段复刻真机 item。
- **补票拒因必须留痕**——非建票结果（日上限/闸门拒绝/锁忙）原先静默计入跳过计数（真机实锤：日上限拒补票零日志，只能靠探针定位）；现 `补票跳过：<原因>` 一行见原因。

## 1.0.71

飞书对账逐腿隔离 + 原子写 tmp 自净（1.0.70 真机联调实锤）：

- **对账单腿失败不再连坐整轮**——群腿缺 `im:message.group_msg` 权限时拉取报 400（飞书错码 230027），旧代码任一会话腿失败即整轮 return 失败：私聊腿被连坐，每轮对账死在第一条腿、游标冻结。现单腿失败降级明示（legSkip 日志点名会话 + 权限归因）并跳过，其余腿照常拉取；只有**全部腿失败**才整轮失败（游标不动下轮重试，语义不变）。
- **SDK 吞错误体修复**——larksuite SDK 把 HTTP 4xx 抛成 Error 且 message 只有状态码，飞书 code/msg 藏在 `response.data`；现提取错误体并把 99991672/230027 归一为权限缺失（原正则永远探测不到 230027）。
- **原子写 tmp 自净**——`saveCursor`/`recordKnownChat` 的 temp+rename 在 rename 失败时残留 tmp 文件（开发期曾累积 1 万+个垃圾文件）；现失败即 unlink，tmp 不再过夜。

## 1.0.70

飞书断线对账盲区修复（1.0.69 真机联调实锤）：**群聊自动学习**。

- **缺口**：群 @ 建票走实时通道（WS 全量事件 + 闸门过滤），不依赖 `feishu.json chats` 配置；但断线对账翻页只认 `chats` + 已登记会话——只 @ 过一次的群两边都不在，**该群断线窗口内的消息永远补不回来**（与「断网重连不丢票」验收项冲突）。
- **修法**：群聊与私聊对称——首个过白名单发送者的实时消息登记 chat_id 纳入对账（登记文件改名 `feishu-known-chats.json`，≤1.0.69 的 `feishu-p2p-chats.json` 自动迁移继承，首次登记即搬入新文件）；对账拉回的消息仍走完整闸门，无白名单绕行。从未给机器人发过消息的会话依然无法覆盖（无从得知 chat_id，降级文案明示）。

## 1.0.69

飞书监听停机语义补刀（1.0.68 真机冒烟暴露的潜伏缺陷——旧版被 start() 首轮自杀 bug 掩盖）：

- **停机必须打断长睡**：`requestStop` 原先只设标志位，对账循环睡满 `reconcileMs`（缺省 **10 分钟**）才收尾——真机后果：Ctrl+C / 长连接终态失败后进程最长滞留 10 分钟才退出（心跳停写、锁仍占、WS 还活着）。现 `requestStop` 同时唤醒所有可打断睡眠，信号/终态失败即刻收尾。守门测试以缺省真实 sleep 钉死：终态失败必须 5 秒内退出。
- **多路唤醒**：扫描/对账两循环并发睡眠，单槽唤醒回调会互相覆盖（唤醒丢失）；改集合制——每个睡眠者注册自己的回调、在自己的 finally 里摘除（race 双边结算都清，防悬挂回调漏进下一轮）。
- **睡眠定时器 unref**：打断后 race 输家的定时器不许拖住进程退出。

## 1.0.68

飞书入口真机联调修复线（SDK 1.76 实锤三连修，全部经真机 API/监听复现定位）：

- **致命：长连接生命周期语义修正**——SDK 的 `wsClient.start()` 校验完凭证后**立即 resolve**（连接由内部重连循环持有），返回值不是连接生命周期；1.0.67 把它当「关闭信号」用（`.then(stop)`）导致扫描/对账循环首轮即退、进程在 `start + 对账间隔` 准时自杀（心跳只写一次 → runner 判死 → 卡片审批静默回退 deny）。改为生命周期信号走 WSClient **构造器回调**：`onReady` = 连接建立（🟢 started 日志恢复，1.0.67 该日志从未出现即同根因）；`onError` = 终态失败（重试耗尽/不可重试）才停机；运行期断线由 SDK 自动重连，进程不因断线自杀（runner 侧心跳过期判定仍是外部看门狗）。守门测试复刻立即 resolve 语义钉死。
- **审批卡在真机 API 上整卡被拒（230099）**——卡片 JSON 2.0 下 `tag:"action"` 容器与 `tag:"note"` 组件均不再支持（ErrCode 200861），`config.update_multi` 也被拒（300302）；按真机实测定型重写：**按钮直接作为 `body.elements` 元素**（实测 code 0），提示语并入 markdown。behaviors callback 回调值与点卡白名单闸不变。
- **机器人 open_id 获取修复**——SDK 未暴露 `client.bot` 命名空间（`bot.info is not a function`），改走通用 `request` 直打 `/open-apis/bot/v3/info`（v4 路径 404 是旧文档误导）；`mentionOnlyInGroup=true` 下群 @建票恢复正常。

## 1.0.67

多入口工单流水线 P4——飞书入口（`batch listen feishu` 长连接 + 卡片审批），遥控入口延伸到手机：

- **飞书长连接监听**：企业自建应用经官方 SDK WSClient 建立出站长连接（免公网 IP/域名/内网穿透，不开任何监听端口）；群里 @机器人一句话 / 白名单私聊直接建挂机票，与 sync/webhook 完全同一条建票管线（引用块边界、accept 四档同闸、附件三态经 `im.message.resource` 下载、`.sync.lock` 互斥、内容哈希去重、`maxTicketsPerDay` 共享配额）。text/post/图片/文件四类消息支持，@提及占位符剔除不污染标题。
- **卡片审批**：`batch run` 撞高危操作 → 交互卡推到私聊（新版卡片 JSON，behaviors callback）→ **手机点批准 = allow-once 单次生效**（不改工具白名单），30 分钟没点 = 自动拒绝（fail-closed）；点卡人必须在 `users` 白名单；回调 3 秒内 toast 应答；卡片不含 diff 与验收输出。跨进程文件协议（pending→decision 原子写 + approvalId 比对 + 一个 pending 只决定一次），runner 按心跳判活——listen 不存活时行为与旧版完全一致（deny + 记录，零回归），卡片等待期看门狗挂 PAUSED 防断流误杀。
- **断线对账**：时间游标（`feishu-cursor.json`）+ 周期增量拉取补漏票（验收硬项「断网重连不丢票」）；私聊 chat_id 从首条消息学习登记（`feishu-p2p-chats.json`）；缺历史权限时明示降级文案，不静默。**单实例约束**：飞书同应用多客户端不广播（消息随机送达一条连接），全系统只允许一个 listen 进程（`.listen.lock` 原子锁 + 心跳双重防护）。
- **配置面零 sync.json 触碰**：飞书配置走独立 `feishu.json`（白名单 chats/users、`mentionOnlyInGroup` 缺省 true、`budgetYuan` 缺省 0.5 元 IM 强制小额、`gatekeeper` LLM 准入缺省关），凭证只走 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 环境变量；SDK 为可选依赖**不随主包装**（首次使用按提示 `npm install -g @larksuiteoapi/node-sdk`）。README 双语「飞书入口」跟着点。真机联调进行中，问题走后续小版本。
- **顺手修一个 P1 起潜伏真 bug**：sync.json 未知键校验原为字符串子串匹配——`defaultBudget`/`maxTickets` 等合法键前缀错字能静默漏过（预算帽/日上限静默失效），改数组精确匹配并守门测试钉死前缀错字形态；`batch pr` 补边界口径（只认 github/gitlab 来源票，feishu/webhook 票验收后人工交付）。

## 1.0.66

挂机流水线打磨第一批 + 多入口工单流水线 P3（webhook 入口）——定时形态上线后暴露的缺口全收（与 VSCode 端 1.0.76 同批 core，流水线代码由 CLI 包承载）：

- **P3 webhook 入口（`POST /hooks/:channel`）**：内网 CI 失败钩子 / 测试流程 POST 即建票，与 `batch sync` 走完全同一条管线（引用块边界、accept 四档同闸、附件三态、`.sync.lock` 互斥、sync-state 去重、每日上限）。鉴权复用 `DEEPSEEKER_CODE_TOKEN`；去重键=内容哈希（CI 同内容重推幂等 duplicate）；每 channel 固定窗口限流缺省 5 票/分钟（环境变量 `DEEPSEEKER_CODE_WEBHOOK_RATE` 可调）+ `maxTicketsPerDay` 共享配额；被忽略的外部 accept 字段票内注记不静默。配置面**零新键**（sync.json 被旧版 CLI 定时器共读，未知键=拒载停摆——webhook 经 `loadSyncConfig {allowNoSource}` 复用既有键，webhook-only 用户可不配拉模式源）。守门 batch-webhook.test.ts 21 例（含路由级 401→建票→重推 duplicate 冒烟与 import 白名单源码扫描）。
- **sync 建票 `defaultSetup`**：sync.json 新键——定时自动建票没人补 `setup: pnpm install` 的票，每晚必因装不上依赖被缓存成 baseline-broken 空转，现建票自动附带；`defaultAccept` 同口径 fail-closed 校验，`--check` doctor 加「未配置」⚠ 非阻断提示。★时序：本地 sync.json 补此键必须晚于本版 CLI 装机（旧版读到未知键会拒载整份配置）。
- **改动清单交接**：任务收尾把 `git diff --cached --numstat` 固化进报告 frontmatter（`changed-file: <path> (+N/-M)`，封顶 30 条带余量省略行，二进制标 (binary)、改名按 git 原样），续修票摘要自动注入【前次改动文件】段——续修不用重新探索上票改了什么；「每票新会话 / 预算隔离 / 不续接旧对话」红线不动。
- **PR 正文小修**：外发文件清单剥掉 name-status 状态前缀（试点 PR #4 实证 `M⇥README.md` 漏进正文），控制台预览保留状态列；numstat/name-status 两处 diff 加 `core.quotepath=false`——中文路径不再被 git 转成八进制串进报告与 PR 正文（守门测试以中文文件名端到端钉死）。

## 1.0.65

多入口工单流水线全量上车（issue → 修复 → 验收 → PR；与 VSCode 端 1.0.75 同批 core，流水线代码由 CLI 包承载）：

- **P1 `batch sync`（拉单）**：打了准入 label 的 GitHub/GitLab issue 自动拉成本地挂机工单。零 LLM 轻模块（不配 API key 也能同步/体检）：三态去重 sync-state.jsonl + 规则闸（作者白名单/屏蔽关键词/正文超长/同标题重复）+ accept 四档（本地配置 > issue 的 accept 块默认完全忽略、显式开启也只收单命令+强制人工复核 > 自动探测 package.json/Makefile/go.mod > 拒建票）+ **基线三态**（agent 开跑前干净树先跑验收：环境装不上=setup-failed 不缓存、基线红=baseline-broken 当日缓存、超时=疑似 watch 单列——**基线红的仓库零 agent 花费**）+ GitHub 附件链三态（内联/落盘+绝对路径/标未读取，含图强制 needs-review）+ 总量硬闸（`batch run --max-total-yuan` 停在票前；sync.json `maxTicketsPerDay`）+ `.sync.lock` 单飞 + `--check` 逐项体检 + `--dry-run` 预演 + 注入边界双层（issue 正文引用块 + batch 会话 system「数据非指令」段）+ 仓库一致性标注（fork 工作流任一 remote 匹配不误报）。README 双语三平台（cron/launchd/任务计划）双时钟定时示例 + sync.json.example。
- **P2 `batch pr`（交付）与续修链**：验收通过的票经显式命令交付为**草稿 PR**——预检（报告+passed → needs-review 闸无豁免 → 幂等标记 `done/<id>.pr.json`）→ 产物分支重建审查 worktree → 强制 fetch 主干 + 落后/merge-tree 冲突预检（首版**不自动 rebase**：拒付+手工命令+打标）→ diff 预览 → push `agent/<票id>` → GitHub `gh pr create --draft`（fixes #N）/ GitLab Draft MR（Closes #iid）；**PR 正文四要素脱敏**（标题/状态与成本/改动文件清单/花费——diff 与验收输出永不外发）。**改测试即降级**：测试路径启发式（`tests?/`、`__tests__/`、`*.test.*`、`*.spec.*`）+ sync.json `testPathPatterns` 可扩展 → needs-review → 拒交付。**续修链**：指纹 v2=标题+正文+近 5 条评论 (id,updatedAt)，issue 变化 → 续修票（continues 前票、继承 accept/setup/budget、以前次产物分支为代码基座；旧状态首见迁移 v2 无升级洪水）。**账本**：`batch/ledger.jsonl` 每 run 追加，`batch status` 汇总近 7 天 + 队列实况。**GitLab 补齐**：附件链与仓库一致性标注。`batch clean` 同步回收附件目录（孤儿 10 分钟宽限防误删在途 sync）。
- **随带**：batch worktree 收尾 commit 快照（改动固化为 dsc-wt-* 分支 commit，跨重启不丢——原「保留待处置」只活到下次进程启动）；sync 票 id 统一按注入时钟预生成（修双源排序随 CI 时区漂移翻车）。
- **真仓实证**：issue #2（¥0.38，26 轮，修复经人工 cherry-pick 采纳关单）与 issue #3 → 草稿 PR #4（¥0.028，4 轮，batch pr 全流程含四要素脱敏/幂等标记）两单全链路闭环。

## 1.0.60

随 core 重打包（2026-10-22）：携带 Agent 内核打磨 A/B 两批（与 VSCode 端 1.0.70 同源）——runLedger 成本账本收拢（runAgent 六个跨轮账目状态 + 子 run 成本中继收拢为每 run 一实例的闭包模块，纯结构收拢零控制流变化，runAgent 净瘦身 62 行；预算硬线 1.2× 单点化为 BUDGET_HARD_LIMIT_RATIO；结算单金额/usage.jsonl 行/预算截断文案经回放驱动对照与改前逐字节同形）+ 成功路径 [DSC-DIAG] 日志治理（streamInference 每轮统计行与 trace 事件全量重复，长会话纯刷屏，删除；错误路径保留并改写为「❌ 推理失败（round N）」风格，run 死因 stdout 可观测性不丢）。**CLI 自身代码无改动**，行为与文案均无变化；本版仅重打 dist 以携带更新后的 core（用户可见效果：长会话不再每轮刷诊断统计行，失败时 stdout 直显死因）。

## 1.0.59

随 core 重打包（2026-10-21）：同步内核审查报告第 17 项（`move_file` 的 `primaryArg` 从误写的 `'src'` 改为真实参数名 `'source'`、`list_dir` 删除无对应参数的 `primaryArg:'path'`、`permissions.ts` 退役 `'src'` 死分支 + 全表声明防漂移守门）+ 守护轮 reasoning_content 400 修复（收尾 nudge 轮改调工具的「相邻 assistant」形状误走宽松档被 DS 严格档拒 400）+ 工作区隔离键切根重导 / 会话盖章 projectRoot 等 core 侧修复。**CLI 自身代码无改动**，行为与文案均无变化；本版仅重打 dist 以携带更新后的 core（用户可见效果：对 `move_file` 选「总是允许」从此真正生效，作用域为精确源路径；曾命中 400 的会话续聊恢复正常）。

## 1.0.58

DeepSeek Search & Fetch 接入（与 VSCode 端 1.0.68 同源）：web_search 缺省升级 DeepSeek 自家搜索后端（长摘要直出，`SEARCH_PROVIDER` 可切回 bing/tavily/ddg）；web_fetch 可选 `backend:"deepseek"`；按次成本（¥0.005/次）经 toolCostSink 进 receipt/usageLog/E1/E2，结算行加「联网 ¥x」段、挂机报告费用行同步聚合；`DEEP_SEEK_TOOL_COST=0` 关上报。守门测试 web-deepseek.test.ts 10 例（含 0 命中+site:带路径误用签名纠正模板——0 命中若带误用签名当场给「site: 只接域名」纠正示例，不再给「未找到相关结果」过强结论）。

## 1.0.56

CLI 双语化收口（此前仅 README/模型回复双语）。

- **观测输出双语化**：`/usage` `/context` `/permissions` `/mcp` `/hooks` `/debug` 六命令输出接入 inspect.ts OBS 词表（zh/en 双表，缺省 zh 向后兼容），尾参 locale 由调用方显式传入。
- **本地命令回显双语化**：/trust 列表与撤销、/archive、/plan、/budget 查看·关闭·设置、/auto、/thinking 三态、引擎加载、未知命令、`!` shell 直跑（用法/退出码头行/空输出）、vision 降级与计划模式切换事件提示接入 strings.ts 词表（+22 键）。
- **挂机批处理全链路双语化**：`batch add|list|clean|help` 管理输出与 `batch run` 控制台进度/落盘报告接入 batchStrings.ts 词表（en 表按 typeof ZH 编译校验，非法 locale 回退 zh）；报告按运行时刻语言生成，属存档不追溯翻译，frontmatter 键名保持英文供 list 解析；core 侧工单校验/运行锁错误文案同批加 locale 尾参。batchAdmin 在 main 语言初始化前派发，自行从 prefs 补读 locale（headless 不弹首次询问）。
- 工程修复：package.json 补 ajv 运行时依赖（工具运行时参数校验此前缺装，干净环境 dist 报 Cannot find package 'ajv'）；新增 i18n 词表键集一致性闸门测试（四张词表 zh/en 键集双向相等 + 提取下限/闸门自检两道防假绿闸）。

## 1.0.55

成本信任链 CLI 面 + 挂机批处理（10-13 ~ 10-16 批次，与 VSCode 端 1.0.65 同源）。

- **任务结算单**：每个任务完成落一行结算（run.receipt，按官网价折算 `DEEP_SEEK_PRICE_*` 可覆盖，无价模型只显 token）；usage-report 脚本切单一价格源显 ¥。
- **/usage 花费聚合**：近 7 天总花费 / 缓存节省额 / 费用 top 会话；statusline 上下文新增花费两键（`last_run_cache_hit_rate`、context，undefined 自动省略）。
- **/budget 预算制**：`/budget 0.5` 设单任务花费上限（触顶软提醒 nudge + 120% 轮边界硬截断，receipt 标 budgetTruncated），子代理花费经 reportCost 回灌合并计账；`/budget off` 关闭。
- **/context 增强**：追加归档实体数 / 召回命中 / 侧车存档计数三行。
- **挂机批处理**：`deepseeker-code batch add|list|run|clean [--wait-window HH:MM-HH:MM]`——工单落 `<项目>/.deepseeker-code/batch/pending/`（frontmatter：title + accept 验收命令必填，setup 环境准备/budget-yuan/timeout-min/tools 可选），batch run 串行执行（worktree 隔离 + setup 备环境 + 审批自动应答：编辑类放行/高危拒绝记录 + 直跑验收），报告落 `done/<id>.report.md`，改动 worktree 保留待人工处置。
- 归因脚本 `scripts/round-attribution.ts`：按行为信号（同参重试/编辑切分/重复检索）给每轮打标，输出浪费轮占比与肇事样本。
- **价格表峰谷双档化**（10-16 对账修正）：官方账单实锤旧表少报 2.7 倍——`MODEL_PRICES` 改 `{ idle, peak }` 双档（北京时间工作日高峰全价、其余半价，按记录 ts 判档），`PRICES_VERIFIED_AT` 超 30 天 `/usage` 显复核提示；官方账单回归钉入 prices.test.ts。

## 1.0.54

09-17 ~ 10-08 批次追平（发布时未补条目，此处按交付内容补记）。

- **子代理进度跟踪与限制**：run_workflow 执行期实时进度回显，任务异常退出有通知与摘要，收尾不再静默。
- **压缩完成显示行**：上下文压缩后消息流插淡色提示行「已压缩上下文 · 自动 · 释放 Nk tokens」（对标 CC Compacted 行，UIEvent compact.done）。
- **ask_question Other 自由输入档**：提问模态恒有 Other 行，可自由键入 token/路径等资料回灌工具结果。
- **运行/验证四技能**：build-fix 编译闭环 / browser-test 浏览器测试（MCP playwright）/ run-stack 服务编排 / api-test 接口测试（目录即注册）。
- 性能：消息批量落盘（减少逐条写盘开销）+ 上下文用量估算优化截断预算。

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
