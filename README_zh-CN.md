# DeepSeeker-Code

[English](./README.md) | 简体中文

> 基于 DeepSeek 的 AI 编码助手（自研 agentic 架构）：agent 主循环 + 工具系统 + MCP + Hooks + Skills + 声明式子 Agent + 计划模式 + Undo 回退。

DeepSeeker-Code 是一套自研的 agentic 编码引擎，外加三个共享同一 core 的入口。core 是一个流式 agent 主循环，配备完整的工具链（读写文件 / 跑命令 / 搜索 / 网页抓取）、审批网关、上下文压缩、会话持久化，以及 MCP / Hooks / Skills / 子 Agent 四套扩展机制。三个入口——VS Code 插件、终端 CLI、HTTP 服务——共享同一引擎和 `~/.deepseeker-code/` 数据目录，同一项目下会话可互续。

## 产品定位

DeepSeeker-Code 是 **单人本地 AI coding 工具**——运行在开发者本机、由 DeepSeek 驱动，不面向公网部署或多租户场景。下方「HTTP 服务」仅作为本地程序化 API（默认 `127.0.0.1`），不作为多用户服务端。

---

## 三种使用方式

| 入口 | 适用场景 | 详细文档 |
| --- | --- | --- |
| **VS Code 插件** | 日常编码，IDE 内聊天面板 | [src/vscode/README.md](./src/vscode/README.md) |
| **终端 CLI** | 终端原生体验（React Ink） | [src/cli/README.md](./src/cli/README.md) |
| **HTTP 服务** | 程序化对接 / 远程访问 / 多并发会话 / SSE 流式 | 见下方「HTTP 服务」 |

三者功能等价（同一 core 引擎、同一套工具/审批/计划模式/Undo/MCP/Hooks/Skills），区别仅在交互形态。

### VS Code 插件

```bash
# 安装 .vsix（或上架后从市场装）
code --install-extension deepseeker-code-<version>.vsix
```

在设置里填 `deepseekerCode.apiKey`，命令面板 `DeepSeeker-Code: 打开聊天`（或 `Ctrl+Esc`）。**自包含，无需另装 CLI**——core 引擎已内联进插件。详见 [插件 README](./src/vscode/README.md)。

### 终端 CLI

```bash
npm install -g deepseeker-code
export DEEP_SEEK_API_KEY=sk-你的key
cd 你的项目 && deepseeker-code
```

in-process 直驱引擎，工具审批走 Ink 原生模态。详见 [CLI README](./src/cli/README.md)。

### HTTP 服务

```bash
npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts
```

默认监听 `127.0.0.1:3000`；鉴权 token 见启动日志（设 `DEEPSEEKER_CODE_TOKEN` 可跨重启固定，`DEEPSEEKER_CODE_TOKEN_FILE` 可落盘到文件避免 stdout 泄露）。`HOST` / `PORT` 环境变量可覆盖监听地址。

---

## 核心能力

- **流式 agent 主循环**：逐字输出 + 可折叠思考过程，自动上下文压缩（重复检索检测 + token 估算校准，针对 DeepSeek-V4 调过甜点区）。
- **压缩归档可召回**：摘要槽双段结构（实体索引无损 + 叙述可压）；被归档的原始消息/工具结果经 `recall` 工具按需检索取回（文件类结果带 mtime staleness 校验，防过期盲改），超长工具结果脱敏后侧车存档、分页取回——长任务压缩后细节不丢、免重跑工具。
- **图片附件多模态**（需 `DEEP_SEEK_VISION=1` 开启）：聊天消息可直接贴图提问（单张 ≤8MB），随消息进入模型上下文；无附件消息行为逐字节不变，token 估算对图片固定计价，base64 绝不进估算/索引/摘要链路。
- **完整工具链**：读/写/编辑/移动/删除文件 + 符号大纲（AST）、运行命令（前台/后台进程，前台超时自动转后台看门狗）、ripgrep 内容搜索 + glob 文件名搜索、Git 操作集（status/log/diff/commit）、网页抓取与搜索、全方法 HTTP 客户端（本地联调）、TypeScript/JS 代码导航与类型诊断、Word/PDF/Excel 文档阅读、依赖清单检查、worktree 管理、子 agent 编排（run_workflow）。
- **审批网关**：SAFE 只读免审、MUTATION/DANGER 弹审；「总是允许」智能落成 glob 权限规则持久化。
- **两阶段计划模式**：只读调研 →「准备开始编码？」方案审批（是并自动接受编辑 / 是并手动审批编辑 / 编辑方案 / 否——留在计划模式继续迭代修订）→ 落地实现。
- **代码变更 diff 视图**：文件修改工具内联展示变更对比（CLI 红绿上下文式 / VS Code 左右对比栅格），VS Code 端可点击放大全屏阅读，亦可一键打开原生 `vscode.diff` 编辑器长期对照。
- **Undo 回退**：写操作前自动备份，可按操作回退；敏感文件策略可配（skip/deny/allow）。
- **Composer 工具箱（VS Code）**：输入框 "/" 按钮开统一动作面板（Context / Model / Commands 分组 + 模糊过滤 + 全键盘导航）；`@` 文件提及全工作区模糊搜索；附件按大小自动分流（小文件全文内联、大文件转 `read_file` 引用）；`/bookmark` 收藏常用 prompt；会话导出 Markdown。
- **检查点回滚（VS Code）**：每次提问发送前自动记检查点；⏱ 面板原地回滚到「此消息发送前」，可选联动恢复此后被改过的文件（modal 文件清单确认；先文件恢复、再截断对话；反向备份保手动改动可逆）。
- **提问钉顶（VS Code）**：长回答滚过时，当前轮提问钉在消息区顶部——CC 同款紧凑卡片 + HH:MM 时间戳，超 2 行钳高、底部渐变溶入底色；悬浮显「展开」（全屏浮层读原文）与逐消息 ↺ 撤回（对话与文件可选回滚，原文回填输入框可改写重发）。
- **成本信任链**：任务完成落「结算单」，按官网价折算（峰谷双档价，经官方账单对账核实；价格表超 30 天未复核显可见性提示；`DEEP_SEEK_PRICE_*` 可覆盖，无价模型只显 token）；`/budget` 设单任务花费上限（触顶软提醒、120% 轮边界硬截断，子代理花费经 reportCost 合并计账）；输入框旁上下文健康水位环（<50% 隐藏、70% 橙 / 90% 红，悬停看窗口/阈值/压缩次数，点击手动压缩）+ 会话花费/缓存命中率胶囊；`deepseeker-code batch` 挂机批处理（worktree 隔离 + setup 环境准备 + 审批自动应答 + 验收命令把关，报告落 `done/`）。
- **持久记忆**：跨会话记忆系统（user/feedback/project/reference 四类），agent 可主动保存与召回事实，启动时注入记忆索引辅助决策。
- **四套扩展机制**：MCP（外部工具）、Hooks（6 类生命周期事件）、Skills（按需技能包）、声明式子 Agent / 斜杠命令 / 输出风格。
- **会话持久化**：按工作区隔离的 transcript，可 `/sessions` 续接。
- **双语界面（zh/en）**：全部用户可见文案——CLI 本地命令回显、`/usage` 族观测输出、挂机批处理的管理/进度/报告、VSCode 插件 webview 与宿主 UI（命令标题/设置描述/对话框）——`/lang zh|en` 一键切换，选择跨重启记住，未覆盖词条回退中文。

---

## 配置（三层）

配置由三层拼成，CLI 与 VS Code 插件完全一致（详见各入口 README）：

1. **环境变量**：模型/API（`DEEP_SEEK_*`）、产品行为（`DEEPSEEKER_CODE_DATA_DIR`、并行/workflow、搜索后端等）、HTTP 服务（`HOST`/`PORT`/`DEEPSEEKER_CODE_TOKEN`）。完整清单见 [CLI README](./src/cli/README.md#配置)。
2. **声明式配置文件** `settings.json`：`engine`（引擎偏好白名单）/ `hooks` / `permissions` / `statusLine`；MCP 走独立的 `mcp.json`。从 `~/.deepseeker-code/`（全局）+ `<项目>/.deepseeker-code/`（项目）读取。
3. **目录发现的扩展**：`skills/` / `agents/` / `commands/` / `output-styles/`（builtin → global → project，同名后者覆盖）。

数据目录默认 `~/.deepseeker-code/`（`DEEPSEEKER_CODE_DATA_DIR` 可改）。

---

## 挂机批处理与定时同步

`deepseeker-code batch` 挂机跑工单队列；`batch sync` 把 GitHub/GitLab 上打了 label 的 issue 拉成本地工单（多入口流水线）。一次性配置：

```bash
# 1. 把示例配置复制进项目，删掉用不到的源（GitHub 源两行即好）
cp sync.json.example <项目>/.deepseeker-code/batch/sync.json
# 2. 先自检：配置 / gh 登录 / 仓库 / label / token，逐项 ✓/✗ + 怎么修
deepseeker-code batch sync --check
# 3. 首次拉取（--dry-run 只预演，零落盘）
deepseeker-code batch sync
# 4. 跑队列（--max-total-yuan 本批总花费上限；--wait-window 到点再开跑）
deepseeker-code batch run --max-total-yuan 5
```

定时**检测与开工分两个钟**（方案 §2.3）：sync 钟跑得勤，run 钟对准电价谷期。`sync` 自带单飞锁——定时器重叠时后一个直接退出；`batch run --wait-window 01:00-07:00` 也可以只配一个钟、把延迟交给 run 自己。

**`defaultSetup`**（sync.json，可选）——`batch sync` 建票时自动写进票 frontmatter `setup:` 的默认环境准备命令。定时建票没人手工补 setup，需要 `pnpm install` 的仓库会每晚因装不上环境被缓存成 `baseline-broken`——流水线空转还占当日建票额度。续修票不受影响（本来就继承前票 setup）。

**Linux（cron）**——`crontab -e`：

```cron
# 检测钟：每 30 分钟拉一次票
*/30 * * * * cd /path/to/project && deepseeker-code batch sync >> /tmp/dsc-sync.log 2>&1
# 开工钟：每晚 01:00（谷期）跑队列，单批花费上限 ¥5
0 1 * * * cd /path/to/project && deepseeker-code batch run --max-total-yuan 5 >> /tmp/dsc-run.log 2>&1
```

**macOS（launchd）**——`~/Library/LaunchAgents/com.deepseeker-code.sync.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.deepseeker-code.sync</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd /path/to/project &amp;&amp; deepseeker-code batch sync</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardOutPath</key><string>/tmp/dsc-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/dsc-sync.log</string>
</dict></plist>
```

加载：`launchctl load ~/Library/LaunchAgents/com.deepseeker-code.sync.plist`。开工钟复制一份改名 `com.deepseeker-code.run.plist`，命令换成 `batch run --max-total-yuan 5`，并把 `StartInterval` 换成日历触发：`<key>StartCalendarInterval</key><dict><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>`。

**Windows（任务计划程序）**——管理员 PowerShell：

```powershell
# 检测钟：每 30 分钟
schtasks /Create /TN "DeepSeeker sync" /SC MINUTE /MO 30 `
  /TR "cmd /c cd /d D:\path\to\project && deepseeker-code batch sync"
# 开工钟：每晚 01:00；--wait-window 在 run 内部再加一道延迟闸
schtasks /Create /TN "DeepSeeker run" /SC DAILY /ST 01:00 `
  /TR "cmd /c cd /d D:\path\to\project && deepseeker-code batch run --max-total-yuan 5"
```

> 要让机器到点自动唤醒跑夜间窗口：任务计划程序 → 该任务 → 属性 → 条件 → 勾选**「唤醒计算机运行此任务」**。「只在用户登录时运行」保持默认即可；`batch run` 需要与你普通 shell 相同的环境变量（API key）。

### 交付与 PR（`batch pr`）、账本（`batch status`）与续修

- **`deepseeker-code batch pr <票id>`**——交付一张验收通过的票。从产物分支重建审查 worktree，核对最新主干（强制 `git fetch` + 落后/冲突预检），把分支推为 `agent/<票id>` 并开**草稿** PR（GitHub：`gh pr create --draft` 带 `fixes #N`；GitLab：Draft MR 带 `Closes #iid`）。显式命令 = 显式审批，任何东西都不会被自动外发。拒绝交付的情形：票未通过验收、带 `needs-review` 标记（改过测试 / 含图附件 / 仓库不一致——无豁免）、已交付过（幂等标记 `done/<id>.pr.json`）、落后主干（首版**不自动 rebase**——打印手工 rebase 命令并给票打标）、存在合并冲突。
- **`deepseeker-code batch status`**——汇总最近 7 天的追加式账本（`.deepseeker-code/batch/ledger.jsonl`，每 run 一行：票数 / 通过 / 失败 / 花费）与当前队列实况。
- **续修链**——同步过的 issue 在票跑完后又变了（新评论、重开、正文编辑），下一次 `batch sync` 会生成续修票（`continues: <前票id>`）：继承前票的 accept/setup/budget，并以前次产物分支为代码基座检出（不从 main 重做）。票内嵌前次报告摘要，外部内容仍以引用块当数据。指纹 v2 覆盖标题 + 正文 + 最近 5 条评论；P1 时代的旧状态首见自动迁移到 v2、不生成续修票（无升级洪水）。
- **`testPathPatterns`**（sync.json，可选）——在内置测试路径启发式（`tests?/`、`__tests__/`、`*.test.*`、`*.spec.*`）之上追加自定义正则；验收通过但改过测试路径的票会被标 `needs-review`，`batch pr` 拒绝交付。
- **代理**：`batch pr` 的 push 走你的**本地 git 配置**。网络需要代理访问远端时自行配置，如 `git config http.proxy http://127.0.0.1:7897`（或 `https.proxy`）——工具绝不默认往命令里拼代理参数。

### webhook 入口（L2 高级）

内网 CI 失败钩子 / 测试流程可以直接 POST 到本地 serve 的 `/hooks/:channel` 端点建票（走与 `batch sync` 完全同一建票管线：accept 四档同闸、引用块边界、附件三态、`.sync.lock` 临界区、sync-state 去重、`maxTicketsPerDay` 日上限）。**端点只在 serve 进程运行时活着**，默认监听 `127.0.0.1:3000`：

```bash
# 1) 在目标项目根目录启动 serve，并固定鉴权 token（跨重启稳定）
export DEEPSEEKER_CODE_TOKEN=换成一串你自己的随机值
npx tsx --tsconfig src/core/tsconfig.json src/core/src/serve/index.ts

# 2) CI 侧两行示例（同项目根；created/duplicate 都回 200，票 id 在响应 ticketId 里）
curl -s -X POST http://127.0.0.1:3000/hooks/ci-alert -H "Authorization: Bearer $DEEPSEEKER_CODE_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"login 套件挂了","body":"3 例红，重试同样红，日志见附件","accept":"npm test","source-url":"https://ci.example.com/runs/42"}'
```

- **响应语义**：`200 {ok:true,status:"created"|"duplicate",ticketId}`；`400` 字段形态错/缺验收（附一句怎么补——**格式错是明确的 400 报错，不是静默忽略**）；`401` 鉴权失败；`429` 限流（每 channel 每分钟 5 票，环境变量 `DEEPSEEKER_CODE_WEBHOOK_RATE` 可调）/超 `maxTicketsPerDay`/sync 锁忙（稍后重试）。
- **复用 sync.json 既有配置键**（`defaultAccept`/`defaultSetup`/`defaultBudgetYuan`/`maxTicketsPerDay`/`allowExternalAccept`/`maxBodyLength`/`testPathPatterns`），**不新增键**；不配 GitHub/GitLab 源也能用。请求体里的 `accept` 字段默认忽略（与 issue 内 accept 块同闸），需 sync.json 显式 `"allowExternalAccept": true` 才采信（且强制 `needs-review`）。
- **附件**：请求体 `attachments: [{url, name?}]`（最多 10 个），无鉴权头普通 HTTP GET 下载；文本内联（保尾 8KB）/落盘 `batch/attachments/<票id>/` 给绝对路径/读不了标「未读取 + 原因」三态；含图票强制 `needs-review`。
- **交付**：`batch pr` 只认 GitHub/GitLab 来源的票——webhook 票验收通过后走**人工 push**（`batch pr` 会拒绝并说明）。
- 零协议备选：手工往 `.deepseeker-code/batch/pending/` 放工单文件（格式见 `batch add` 帮助）依旧可用，不需要 serve 与 token。

### 飞书入口（L2 高级：手机上发消息建票 + 卡片点审批）

不想开电脑时，直接在飞书里 @机器人 说一句「修复登录页日期解析」就能建票；跑批遇到高危操作（如 `run_command`）会推一张审批卡到你私聊，**手机上点「批准」才放行**（30 分钟不点 = 自动拒绝，fail-closed）。走 `batch listen feishu` 常驻长连接，配置独立在 `feishu.json`（**不动 sync.json**——旧版全局 CLI 的定时器还共读它）。跟着点：

```bash
# 1) 建企业自建应用：https://open.feishu.cn/app → 创建企业自建应用，拿到 App ID / App Secret
# 2) 设环境变量（用户级），密钥只走环境变量，绝不写进文件
setx FEISHU_APP_ID "cli_xxx" & setx FEISHU_APP_SECRET "你的secret"

# 3) 开权限（最小集）：「获取与发送单聊、群组消息」（im:message）+ 「读取用户发给机器人的单聊消息」
#    + 「上传/下载图片或文件资源」；订阅方式选【长连接】（无需公网回调地址）
# 4) 事件订阅：添加 im.message.receive_v1（收消息）；卡片回调 v4.0：启用自己的卡片并回调（card.action.trigger）
# 5) 发布应用版本（不发布收不到任何事件）；把机器人拉进目标群
# 6) 全局装 SDK（可选依赖，不随主包装、不进 vsix）
npm install -g @larksuiteoapi/node-sdk

# 7) 配置白名单：复制仓库根 feishu.json.example 到 <项目>/.deepseeker-code/batch/feishu.json，
#    填 chats（群 chat_id）与 users（你的 open_id）。群白名单默认仅 @机器人 出票；
#    预算强制取 min(budgetYuan, sync.defaultBudgetYuan)，IM 票默认小额 0.5 元
# 8) 启动常驻监听（建议再配一条 schtasks 开机自启）
deepseeker-code batch listen feishu
```

- **⚠️ 单客户端限制（硬约束）**：同一应用多条长连接**不广播**——消息只会随机送达一个连接。全系统只允许**一个** `batch listen feishu` 进程；启动时检测到心跳新鲜会拒绝二开并提示 pid。
- **白名单闸**：群消息须 chat_id ∈ `chats` 且 @机器人（`mentionOnlyInGroup`，默认 true）；私聊须发送者 open_id ∈ `users`。名单外消息一律拒收（原因留日志，改好配置重发即可）。`users` 同时是**审批点卡人白名单**——不在名单的人点卡片不会生效。
- **建票同闸**：与 sync/webhook 完全同一管线——内容哈希去重（同内容重发 = duplicate）、accept 四档同闸（IM 票没配 `defaultAccept` 就建不了票，宁可不猜）、`maxTicketsPerDay` 日上限、附件三态（图片/文件经机器人资源 API 落盘，绝不静默）、引用块数据边界。纯图片/文件消息没有一句话说明会被拒（不猜任务）。
- **卡片审批**：runner 检测到监听存活（90s 心跳保鲜 + `users` 非空）才走卡片等待；监听不在 = 维持现状自动拒绝 + 记录（零行为变化）。批准 = **allow-once 单次生效**，不改工具白名单；卡片内容不含 diff 与验收输出。
- **对账兜底**：长连接断线窗口内的事件平台不补推——监听维护时间游标（`feishu-cursor.json`）周期增量拉消息补漏票（已见过的幂等跳过）。缺「读历史消息」权限时降级为明示提示（教你怎么补票），不影响实时收消息。日志落 `.deepseeker-code/batch/feishu-listen.log`。
- **可选 LLM 把关**（`feishu.json` 的 `gatekeeper: true`）：每条消息先经一次 LLM 判定 work/reject 再过规则闸（需 `DEEP_SEEK_API_KEY`；判定失败按放行处理并留日志）。默认关。
- **停机检查**：监听进程应随机器常驻；`tasklist /FI "IMAGENAME eq node.exe"` 看进程，日志尾部看存活（每 30s 心跳 + 周期对账行）。

---

## 架构（Monorepo）

```text
deepseeker-code/                 # pnpm workspace（src/*）
├── src/core/                    # 引擎：agent 主循环 + 工具 + MCP + hooks + skills + serve
│                                #   private（不单独发布），经 tsconfig @/* 别名内联进 cli/vscode 产物
├── src/cli/                     # 终端 CLI（React Ink）→ 发布为 npm 包 deepseeker-code
│   └── README.md                #   npm 展示页
├── src/vscode/                  # VS Code 插件（独立用 npm，打 vsix）
│   └── README.md                #   商城展示页
└── .ai-docs/                    # 引擎计划 / 子代理委派指南等设计文档
```

- **core 不发布**：它是引擎源码，被 cli 和 vscode 的 esbuild 构建**内联**进各自产物（`dist/cli.mjs` / `dist/extension.js`），靠 tsconfig 路径别名 `@/* → core/src/*` 引用，不是 npm 依赖。
- **发布面**：只发布 cli 包（`npm publish` 在 `src/cli/`）；VS Code 插件打 `.vsix`（`src/vscode/` 内 `npm run package`）。

### 配置注入流向

```text
CLI argv / VS Code settings  ──▶  process.env + chdir  ──▶  core（appConfig 冻结 + 文件沙箱）
settings.json / mcp.json      ──▶  core 各 loader（bootstrap 期加载）
```

---

## 开发

### 环境要求

- Node.js ≥ 20
- pnpm（workspace 管理 core + cli）；VS Code 插件目录用 npm

### 常用脚本（根目录）

```bash
pnpm install              # 装 core + cli 依赖（workspace）
pnpm typecheck            # tsc -p src/core/tsconfig.json && tsc -p src/cli/tsconfig.json
pnpm test                 # cd src/core && node --import tsx --test tests/*.test.ts

pnpm cli:dev              # 终端 CLI 开发态（tsx 直跑）
pnpm cli:build            # 终端 CLI 打包（esbuild → dist/cli.mjs）
```

VS Code 插件：`cd src/vscode && npm install && npm run build`（或 `npm run dev` 监听、`npm run package` 打 vsix）。

> ⚠️ **core tsconfig 必须显式指定**：`@/` 路径别名只在 `src/core/tsconfig.json` 配了，根 `tsconfig.json` 没有。跑 core 相关命令必须带 `--tsconfig src/core/tsconfig.json`，否则报 `Cannot find package '@/tool'`。

### 开发规则

- **优先箭头函数**（`const fn = (...) => {...}`），少用 `function` / `class`（仅 hoisting / `this` / 构造语义时才用）。
- agent 主循环硬约定：`message[0]=system`、`message[1]=summary 槽`，被 `ensureSummarySlot`/`ensureFitsWindow` 强依赖——**勿改前两个下标**，提示词注入一律追加到 `message[0].content`。
- 完整架构要点见 [CLAUDE.md](./CLAUDE.md)。

---

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [CLAUDE.md](./CLAUDE.md) | 项目指令：架构要点、运行调试、开发规则 |
| [src/cli/README.md](./src/cli/README.md) | 终端 CLI 使用与配置（npm 发布档） |
| [src/vscode/README.md](./src/vscode/README.md) | VS Code 插件使用与配置（商城发布档） |
| [.ai-docs/下一步计划.md](./.ai-docs/下一步计划.md) | 引擎能力盘点与字段时机 |
| [.ai-docs/子代理委派指南.md](./.ai-docs/子代理委派指南.md) | 子 Agent 委派模式与声明式配置 |

## License

MIT
