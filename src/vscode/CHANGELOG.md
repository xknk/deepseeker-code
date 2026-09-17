# Changelog

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

## 1.0.65

执行中动画（busy 指示）+ trace 记录生效模型。

- **全局状态栏指示**：任一页签 agent 执行中，VSCode 底部状态栏出现「⟳ DeepSeeker-Code」（CSS 自旋），点击直达聊天页签；面板被切走/最小化也能一眼看出「还在跑」，全部结束自动熄灭。
- **输入框上方 busy 条**：生成期间显示「⟳ 生成中… Ns」实时计时，结束即隐藏。
- **工具行转圈 + 已跑秒数**：running 状态的工具卡片右侧显示旋转 spinner 与逐秒计时（纯 CSS 动画 + 1s 定时器只改文本节点，不重建行，保留展开状态），工具结束被 ✓/✕ 状态替换。
- **trace 记录生效模型**：`llm.request` / `llm.response` 事件 metadata 新增 `model` 字段（streamInference 埋点），跨模型对账 / 按模型折算费用可直接分组，不再靠猜。

## 1.0.64

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
