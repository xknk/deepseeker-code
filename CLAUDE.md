<!--
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-08-10 12:35:39
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-08-10 14:05:10
 * @FilePath: \deepSeekCode\CLAUDE.md
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
-->
# DeepSeeker-Code

基于 DeepSeek 的 AI 编码助手（自研 agentic 架构）：agent 主循环 + 工具系统 + MCP + Hooks + Skills。

## 产品定位（评估 / 规划基准）

DeepSeeker-Code 的定位是 **单人本地 AI coding 工具**，由 DeepSeek 大模型驱动，供开发者在自己的机器上完成编码工作。

**明确不做**（非本项目范围，评估/对标时勿当缺口）：
- 不做公网部署 / 多租户 / SaaS / 团队协作服务端。
- 不追求强制 TLS、多租户隔离、OS 级沙箱、多进程锁协调、headless 自动审批防护等服务端或重型产品才需要的特性。

**评估准则**：判断"是否满足上线 / 发布"时，以「**单人本地能否稳定完成 AI coding**」为唯一标准，勿套用公网 SaaS 产品的安全 / 规模标准——那是不同产品形态的门槛，不属于本项目。HTTP 服务（`src/core/src/serve/`）仅作为**本地程序化 API 入口**保留（默认 `127.0.0.1`），不是多用户服务端。

## 开发规则

- **优先使用箭头函数**（`const fn = (...) => {...}`），减少 `function` 关键字和 `class` 的使用频率。仅当确实需要 hoisting、`this` 绑定或构造函数语义时才用 `function`/`class`；对象方法可用简写（`execute(args){}`，不算 `function` 关键字）。

## 运行与调试

- 服务启动**必须**指定 core tsconfig（`@/` 路径别名只在 `src/core/tsconfig.json` 配置，根 tsconfig.json 没有，否则报 `Cannot find package '@/tool'`）：
  ```
  npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts
  ```
- 默认监听 `127.0.0.1:3000`；`HOST`/`PORT` 环境变量可覆盖。鉴权：设 `DEEPSEEKER_CODE_TOKEN` 跨重启稳定，否则启动时随机生成并打印到 stdout。
- 配置位置：声明式 hooks → `~/.deepseeker-code/settings.json` 或 `<项目>/.deepseeker-code/settings.json`；skills → 对应目录下的 `skills/<name>/SKILL.md`；输出风格（output-styles）→ `~/.deepseeker-code/output-styles/<name>.md` 或 `<项目>/.deepseeker-code/output-styles/<name>.md`（frontmatter `name`+`description` + persona 正文，`/output-style <name>` 选用）；状态栏（statusline）→ settings.json 的 `statusLine` 段：`{"statusLine":{"command":"<shell 命令>","padding":0}}`，命令经 stdin 收 JSON 上下文、stdout 首行作底部状态栏。

## 架构要点

- **agent 主循环**：`src/core/src/agent/runAgent.ts`（流式 `AsyncGenerator`）。硬约定：`message[0]=system`、`message[1]=summary 槽`，被 `ensureSummarySlot`/`ensureFitsWindow` 强依赖——**勿改前两个下标**，提示词注入一律追加到 `message[0].content`。
- **工具注册**：`src/core/src/tool/index.ts` 聚合 `agentTools`；新增工具在 `tool/registry/` 加文件并 `push`；工具协议见 `tool/type.ts`（`CustomTool`，含 safetyLevel/审批/锁/环境断言等）。
- **扩展机制**：
  - Hooks：`src/core/src/hooks/`，6 类生命周期事件（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd），声明式配置 + 程序化注册。
  - Skills：`src/core/src/skills/`，目录发现（builtin/global/project）+ `load_skill` 按需加载；内置 skill 放 `skills/builtin/<name>/SKILL.md`。
  - MCP：`src/core/src/tool/mcp/`，动态发现外部工具。
- **文档索引**：架构与计划见 `.ai-docs/`（下一步计划 / 子代理委派指南）+ `src/core/src/memory/`（持久记忆系统：loader/inject/registry）。
