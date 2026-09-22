---
name: browser-test
description: 浏览器自动化测前端。当用户要求打开页面验证、点一点看看、E2E 测试、界面交互测试、检查页面报错时激活。
version: 1
triggers: 浏览器测试, 打开页面, E2E, 界面测试, 点一下, 页面验证
---

# 浏览器自动化测试（browser-test）

经 MCP 的 playwright server 驱动真实浏览器验证前端界面。**没有** mcp__playwright__* 独立工具——统一走 `mcp_list_tools` 查目录、`mcp_call(server="playwright", tool=<名>, args={...})` 调用。

## 步骤

1. **前置确认**：目标页面可达的 baseURL（用户给的，或从 dev server 配置读）。服务没起先走 run-stack 流程。若 mcp_list_tools 里没有 playwright 目录：告知用户需在 ~/.deepseeker-code/mcp.json 配置 playwright server，不要硬调。

2. **打开页面**：`browser_navigate`（args: `{url}`）→ 立即 `browser_snapshot`。snapshot 是可访问性树（含每个可交互元素的 ref），**它是你唯一可靠的页面视图**。

3. **交互**：按最新 snapshot 里的 ref 做 `browser_click` / `browser_type` 等。每次动作后重新 snapshot——ref 在页面变化后会失效。
   - 表单类：先填完所有字段再做提交类动作，减少往返。
   - 断言依据 snapshot 里的文本内容，不是截图。

4. **取证**：
   - `browser_console_messages`：收 console error/warning，界面"看着正常"但脚本报错是最常见的隐藏问题。
   - `browser_network_requests`：找 4xx/5xx 失败请求，前端白屏常是接口挂了。

5. **汇总**：通过/失败结论、复现步骤（做了哪些动作）、console 错误清单、失败请求清单；失败时附 snapshot 相关片段。

## 硬约束
- mcp_call 每次调用都要用户审批：把动作合并到最少必要次数，禁止无意义的反复 snapshot 或重复 navigate。
- 禁止臆造 ref 或凭记忆引用旧 snapshot 的 ref；一切以最新 snapshot 为准。
- 禁止用 browser_take_screenshot 替代 snapshot 做断言（图片读不准 DOM 结构），截图只用于给用户看效果。
- 页面行为与预期不符时，如实报告差异，不要"再点几下试试"掩盖问题。
