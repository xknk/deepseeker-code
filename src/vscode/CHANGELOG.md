# Changelog

## 1.0.66

全插件 UI 双语化（/lang zh|en 一键切换，此前仅 CLI/README/模型回复支持双语）。

- **webview 前端**：全部用户可见文案接入 `S` 词表代理（工具栏/输入区/斜杠菜单/审批/提问/方案/历史/分叉/检查点/diff/动作面板/事件行 ~190 键）；静态 DOM（工具栏 title、输入区模板、浮层骨架）靠 `ds-locale` 重建机制刷新，切换时草稿文本、待发贴图/引用 chip、阻塞中的审批/提问/方案条全量保留；历史 info/system 行属会话记录不追溯翻译（与 CC 行为一致）。
- **扩展宿主**：extension.ts（命令面板 QuickPick/通知/观测命令回显/导出与回滚对话框）/ host.ts（~25 条 info 行与错误抛出）/ ideBridge.ts（ide_* 工具结果）接入 `i18n.ts` 词表（makeT 闭包按访问时 locale 分发）；无 tab 语境（activate 期）按 VS Code 显示语言。
- **清单与设置**：package.json 的 description/10 条命令标题/17 项设置描述改 `%key%` 引用 + `package.nls.json`（英文默认）/`package.nls.zh-cn.json`（中文镜像）——命令面板与设置页随 VS Code 显示语言自动切换。
- **语言解析链**：`/lang` 选择持久化 workspaceState（重开页签/重载窗口不丢，与模型选择同模式）> 设置项 `deepseekerCode.locale` > VS Code 显示语言；`<html lang>` 随语言渲染，切换即时同步。
- **边界（有意保留中文）**：模型侧提示词（计划调研引导/方案批准重跑语）；core 审批 detail 的【减少】/【增加】标记（diff 解析锚点）；core 观测输出（/usage 等，CLI/VSCode 共用，另行处理）。

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

工程质量与读代码体验修复（本版起追平此前本地打包、未上架的 1.0.64 / 1.0.65 全部内置更新）。

- **修复：读代码被脱敏误伤**：内容脱敏此前把 `apiKey: process.env.XXX` 这类变量引用也打码成 `[MASKED_SECRET]`——agent 读自己项目代码只见掩码、看不到配置来源。现只打码引号包裹的字面量与 `Authorization: Bearer` 形态，变量引用原样放行（附 privacy-mask 回归测试）。
- **修复：无凭证环境测试/加载整崩**：OpenAI client 改 `getModel()` 懒构造，缺 `DEEP_SEEK_API_KEY` 不再在 import 期炸掉整条依赖链；`npm test` 无凭证 455/455 全绿，`npm run typecheck` 回绿（6 处 TS2775 清零）。
- **压缩落盘顺序铁律结构化**：「先写滚动状态、再写压缩事件」抽成 persistCompaction 单点，两份复制实现收敛为一处——崩溃恢复的方向性保证不再靠注释自觉。
- **nudge 行为锁死**：新增 27 条表驱动用例钉死六类守护（PLAN_FIRST / PHANTOM / EARLY_FINAL / TOOL_DIGEST / 周期自评 / 重复检索）的触发、预算与优先级，含两次事故回归钉（「你好」寒暄放行、实质长总结限长放行）。

## 本地 1.0.65（已并入上架批次）

执行中动画（busy 指示）+ trace 记录生效模型。

- **全局状态栏指示**：任一页签 agent 执行中，VSCode 底部状态栏出现「⟳ DeepSeeker-Code」（CSS 自旋），点击直达聊天页签；面板被切走/最小化也能一眼看出「还在跑」，全部结束自动熄灭。
- **输入框上方 busy 条**：生成期间显示「⟳ 生成中… Ns」实时计时，结束即隐藏。
- **工具行转圈 + 已跑秒数**：running 状态的工具卡片右侧显示旋转 spinner 与逐秒计时（纯 CSS 动画 + 1s 定时器只改文本节点，不重建行，保留展开状态），工具结束被 ✓/✕ 状态替换。
- **trace 记录生效模型**：`llm.request` / `llm.response` 事件 metadata 新增 `model` 字段（streamInference 埋点），跨模型对账 / 按模型折算费用可直接分组，不再靠猜。

## 本地 1.0.64（已并入上架批次）

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
