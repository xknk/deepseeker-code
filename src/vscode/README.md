# deepSeekCode for VS Code

DeepSeek 驱动的 AI 编程助手 **VS Code 插件入口**（`src/vscode/`，与 `src/cli/`、`src/core/` 平级）。

- **功能与 CLI 完全一致**：同一套 core agent 引擎（`handleUnifiedChat` / `agentTools` / `initEngine`），会话、流式输出、思考过程、工具调用、审批、结构化提问（ask_question）、计划模式两阶段、模型/思考等级/语言切换、历史会话续接、Undo 回退、MCP / hooks / permissions / skills / 声明式子 Agent / 项目指引全部继承。
- **交互贴合 Claude Code 插件**：活动栏图标 → 侧边栏聊天面板；内联按钮式审批（允许本次 / 总是允许 / 拒绝）；方案卡片（接受并自动执行 / 逐步审批 / 编辑 / 拒绝）；提问选项按钮；历史会话点选续接；流式打字 + 可折叠思考块 + 工具卡。
- **数据与 CLI 共享**：会话 transcript / Undo / trace 都落在 `~/.deepSeekCode/`（按工作区 key 分目录），同一工作区下 CLI 与插件可互续会话。

---

## 1. 目录迁移（⚠️ 首次必须执行）

> 本工程按最终位置 `src/vscode/` 编写 tsconfig paths（`@/* → ../core/src/*`），
> 因此**必须先迁移到与 `cli`、`core` 平级**，否则 `npm run build` 找不到 core 源码。

```powershell
# 在 src/ 目录下（core、cli 的同级）执行
cd D:/code/自研/deepSeekCode/src
mv cli/vscode vscode
```

## 2. 安装与构建

```powershell
cd D:/code/自研/deepSeekCode/src/vscode
npm install
npm run build
```

产物（`dist/`）：

| 文件 | 说明 |
|---|---|
| `dist/extension.js` | 扩展主进程（extension + host + **core 全部源码内联**；external `vscode` 与 node_modules） |
| `dist/webview.js` | webview 前端（零依赖，IIFE） |
| `dist/style.css` | 聊天面板样式 |
| `dist/builtin/` | core 内置 skills / agents / commands 资产（自动拷贝自 `../core/src/*/builtin`） |

## 3. 调试（F5）

用 VS Code 打开 `src/vscode/` 目录，按 `F5` 启动「Run Extension (deepSeekCode)」——
会先执行 `node build.mjs`（preLaunchTask），再打开 Extension Development Host 窗口。
在该窗口中打开任意项目文件夹 → 点击活动栏的 **✻ deepSeekCode** 图标即可聊天。

API Key 通过环境变量 `DEEP_SEEK_API_KEY` 传入（launch.json 已透传）。

## 4. 打包安装（vsix）

```powershell
npm run package
# 产物：deepseek-code-1.0.0.vsix，在 VS Code 扩展面板「从 VSIX 安装」即可
```

## 5. 配置

| 设置项 | 说明 |
|---|---|
| `deepseekCode.apiKey` | DeepSeek API Key（优先于环境变量 `DEEP_SEEK_API_KEY`） |
| `deepseekCode.model` | 默认模型（如 `deepseek-v4` / `deepseek-v4-flash`） |
| `deepseekCode.locale` | 界面/回复语言：`zh` / `en`（留空默认中文） |

也可以在聊天输入框用斜杠命令：`/plan`、`/auto`、`/model <名称>`、`/thinking <off|high|max>`、
`/lang <zh|en>`、`/sessions`、`/clear`、`/new`、`/help`。

## 6. 架构

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  webview（前端，零依赖 DOM）  │  ◄──►  │  extension host（Node 进程）  │
│  聊天流 / 审批条 / 方案卡 /     │ 消息   │  panel.ts 消息路由            │
│  提问 / 工具栏 / 历史会话       │ 协议   │  host.ts 会话编排（≈CLI 的     │
└─────────────────────────────┘        │  useChatState 非 React 版）    │
                                       │  extension.ts 激活/chdir/env  │
                                       └──────────────┬───────────────┘
                                                      │ handleUnifiedChat / agentTools / initEngine
                                              ┌───────▼───────┐
                                              │  core（复用）  │  runAgent / MCP / hooks / undo / skills…
                                              └───────────────┘
```

关键机制：

- **审批**：core 为异步 UI 宿主内置的 `createWebRequestApproval` 会把 `approval_request` 事件发给前端，
  前端弹按钮条，点按后 `resolveUserApprovalLock(sessionId, toolsId, decision)` 解锁挂起的工具调用。
- **cwd 注入**：`handleUnifiedChat` 与 `appConfig.userWorkspaceDir` 都基于 `process.cwd()`，因此扩展在
  **动态 import core 之前**先 `process.chdir(workspaceRoot)`、注入 `WORKSPACE_ROOT` 与 `DEEP_SEEK_API_KEY`。
- **计划两阶段**：`plan.proposed` 事件 → 前端方案卡 → 「接受并自动执行」走 `allow-once` 免审批实现轮，
  「接受并逐步审批」带最终方案重跑实现轮（编辑后的方案全文塞入实现轮 prompt，与 CLI 一致）。

## 7. 已知限制

- 多根工作区（multi-root）取 `workspaceFolders[0]` 为 agent 工作区。
- webview 前端零依赖，markdown 为最小渲染器（代码块/行内码/粗体/列表/链接/标题）。
- 打包 vsix 会携带 `vscode-ripgrep` 等运行时依赖，体积偏大属正常；调试模式无影响。
- 关闭侧边栏时若仍有挂起的审批/提问，重开面板后需重新触发（与 CLI 关闭中断等价）。
