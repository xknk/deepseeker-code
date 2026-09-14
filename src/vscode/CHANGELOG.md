# Changelog

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
