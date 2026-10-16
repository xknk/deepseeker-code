/**
 * @file vscode/src/i18n.ts
 * @description 扩展宿主侧（extension.ts / host.ts / ideBridge.ts）用户可见文案集中管理，
 *  与 webview/strings.js、cli/src/strings.ts 同思路但各自独立（三端渲染层互不共享）。
 *  t 为即时查表函数：按 locale getter 分发，缺键回退 zh、再缺回退键名（显式可辨，绝不静默错文案）。
 *  ★ 模型侧提示词（如 ENTER_PLAN_RESEARCH_PROMPT）不走这里——模型指令保持既定语言，仅 UI 文案双语。
 */
export type UiLocale = "zh" | "en";

/** 宿主侧文案表：zh/en 键集一致（新增文案两表都要加，漏英文键会回退中文——功能不破但可见不一致）。 */
const STRINGS: Record<UiLocale, Record<string, any>> = {
  zh: {
    // —— 通用 ——
    engineNotLoaded: "（引擎尚未加载）",
    busyTooltip: "DeepSeeker-Code 正在执行…（点击打开聊天面板）",
    // —— activate / 命令面板 ——
    noWorkspace: "DeepSeeker-Code：请先打开一个项目文件夹（工作区）再使用。",
    noWorkspaceShort: "DeepSeeker-Code：当前没有打开的工作区文件夹。",
    initErrorNoKey:
      "未配置 DeepSeek API Key：请在设置中填写 deepseekerCode.apiKey（或环境变量 DEEP_SEEK_API_KEY），保存后重载窗口。",
    pickRootPlaceholder: "选择 DeepSeeker-Code agent 工作的项目根目录",
    pickRootTitle: "DeepSeeker-Code：选择项目根",
    rootSwitched: (label: string) => `DeepSeeker-Code：主根已切换为 ${label}`,
    rootSwitchFail: (root: string, err: string) => `DeepSeeker-Code：无法切换到项目目录（${root}）：${err}`,
    trustNone: "DeepSeeker-Code：暂无已信任目录。",
    trustPickPlaceholder: "选择要撤销信任的目录（按 Esc 取消）",
    trustPickTitle: "DeepSeeker-Code：管理信任目录",
    trustRevoked: (d: string) => `DeepSeeker-Code：已撤销信任 ${d}（重载窗口后生效）`,
    trustNotFound: "DeepSeeker-Code：该目录不在信任列表。",
    batchEmpty: "DeepSeeker-Code：挂机队列为空。投递走 CLI：deepseeker-code batch add <工单.md>（格式见 batch help）。",
    batchRunning: "运行中",
    batchPending: "待跑",
    batchDone: "已完成——回车看报告",
    batchPlaceholder: "挂机批处理队列（投递/清理走 CLI：batch add / batch clean）",
    batchTitle: "DeepSeeker-Code：挂机队列",
    batchReportMissing: "DeepSeeker-Code：报告缺失（任务可能刚收尾或已被 batch clean）。",
    engineInitFail: (msg: string) => `DeepSeeker-Code 引擎初始化失败（面板仍可用，但 MCP/skills 等工具缺失）：${msg}`,
    hostNotLoaded: "DeepSeeker-Code：会话宿主尚未加载（activate 未完成，不应到达）",
    // —— webview 消息处理 ——
    engineLoading: "⏳ 引擎加载中（MCP/skills/commands）…完成后自动继续。",
    newSessionNewTab: "🆕 新会话已在新的编辑器页签打开；当前对话保留在本页，可切回继续。",
    styleCurrent: (name: string) => `当前输出风格：${name}`,
    styleDefault: "默认",
    styleListEmpty: "（未安装任何风格）",
    styleUsage: "切换：/output-style <name>，恢复默认：/output-style off",
    styleOff: "已恢复默认输出风格。",
    styleSwitched: (name: string) => `输出风格已切换：${name}`,
    styleUnknown: (name: string) => `未知风格：${name}`,
    budgetView: (b: number | null, last: number | null) =>
      `💰 预算：${b != null ? `¥${b}/run` : "未设置（/budget 0.5 设置每个 run 的花费上限）"}${last != null ? ` · 上个 run 已花 ¥${last.toFixed(3)}` : " · 尚无完成 run"}`,
    budgetOff: "💰 预算已关闭（不限花费）。",
    budgetUsage: "用法：/budget 0.5（元/run）· /budget off · /budget 查看",
    budgetSet: (n: number) => `💰 预算已设置：每 run ¥${n}（超限先提醒收敛，仍超 120% 将截断本 run）。`,
    trustListEmpty: "已信任目录：（无）。",
    trustList: (lines: string) => `已信任目录（撤销用 /trust <序号 或 路径>）：\n${lines}\n\n撤销后需重载窗口生效（项目级配置仅在激活时加载）。`,
    trustRemoved: (t: string) => `已撤销信任：${t}\n（重载窗口后生效——项目级配置仅在激活时加载）`,
    trustMiss: (t: string) => `未找到该信任目录：${t}`,
    obsUnknown: (cmd: string) => `未知观测命令：${cmd}`,
    obsFail: (msg: string) => `读取失败：${msg}`,
    exportNone: "📄 当前无会话可导出（先发一条消息创建会话）。",
    exportDialogTitle: "DeepSeeker-Code：导出会话为 Markdown",
    exportCancelled: "📄 已取消导出。",
    exportDone: (p: string) => `📄 会话已导出：${p}`,
    exportFail: (msg: string) => `导出失败：${msg}`,
    attachDialogTitle: "DeepSeeker-Code：附加文件（小文件全文入消息，大文件自动转引用）",
    attachReadFail: (msg: string) => `📎 读取文件失败：${msg}`,
    rewindKindText: (k: string) => (k === "creation_marker" ? "删除新建" : k === "directory_tree" ? "恢复目录树" : "恢复内容"),
    rewindMissingBackup: (n: number) => `⚠️ 另有 ${n} 个文件备份已清理、无法恢复（保持现状）`,
    rewindTitle: (n: number) => `回滚到发送前：将把 ${n} 个文件一并恢复到该时点。`,
    rewindBoth: "对话 + 文件回滚",
    rewindChatOnly: "仅回滚对话",
    rewindFail: (msg: string) => `⏪ 回滚失败：${msg}`,
    bookmarkSaved: (n: number) => `🔖 已收藏（共 ${n} 条）——动作面板 Bookmarks 组一键插入输入框。`,
    forkFail: (msg: string) => `分叉失败：${msg}`,
    renameFail: (msg: string) => `重命名失败：${msg}`,
    deleteFail: (msg: string) => `删除失败：${msg}`,
    diffNoSnapshot:
      "DeepSeeker-Code：该修改的「修改前」快照不可用（历史会话回放 / 窗口重载后失效），请查看聊天内的对比视图。",
    diffTitle: (name: string) => `${name} · 修改前 → 修改后`,
    // —— host.ts info 行 ——
    inboxDelivered: (n: number) => `📬 已送达模型（${n} 条补充输入）`,
    inboxCarryover: (n: number) => `📬 本轮结束时 ${n} 条补充输入未在回合边界送达，已写入会话历史，下轮对话自动带入。`,
    autoExecuteOn: "⚡ 已进入自动执行：实现阶段工具将免审批直接运行。",
    planStayed: "✋ 已留在计划模式：继续输入补充要求，模型将修订方案后再次提交（/plan 或模式面板可退出）。",
    bangUsage: "用法：!<shell 命令>（如 !git status）；输出会带入下轮对话上下文。",
    bangHead: (r: { timedOut: boolean; ok: boolean; exitCode: number | null }) =>
      r.timedOut ? "⏱ 超时中止" : r.ok ? "✅ 退出码 0" : r.exitCode != null ? `❌ 退出码 ${r.exitCode}` : "❌ 已中止",
    bangNoOutput: "(无输出)",
    imgQueuedBusy: "🖼 生成中贴图无法随排队消息送达，请本轮结束后重新发送图片。",
    queuedAck: "📮 已排队，将在回合边界送达模型（停止按钮仍可中止）。",
    busyBlocked: "⏳ 生成中，输入未发送。",
    planNoImage: "🖼 计划模式暂不支持随调研轮贴图：图片未进入本轮上下文（退出计划模式后可直接发送）。",
    planEnterSwitched: (reason: string) => `📋 模型请求进入计划模式${reason ? `：${reason}` : ""}，已切换…`,
    sessionLoaded: "📂 已载入会话（继续对话将续接此会话）",
    noSessionFork: "当前无活动会话，无可分叉",
    forked: "🌿 已分叉为新会话（源会话不变），继续对话将写入新会话。",
    rewindBusy: "生成中无法回滚，请先停止当前轮",
    noSessionRewind: "当前无活动会话，无可回滚",
    checkpointMissing: (id: string) => `检查点不存在：${id}`,
    rewound: (n: number, fileNote: string) => `⏪ 已回滚到发送前（移除其后 ${n} 行转录）。改写消息后重发即可。${fileNote}`,
    compactBusy: "⏳ 生成中无法手动压缩，请先停止当前轮。",
    compactNoSession: "当前无活动会话，无需压缩。",
    compactNothing: "当前没有可压缩的历史消息。",
    compactHealthy: "✅ 上下文本就健康（免费折叠旧工具结果后已回到阈值内），无需摘要压缩。",
    compactFail: (msg: string) => `⚠️ 手动压缩失败：${msg}`,
    imgFallbackName: (i: number) => `图片${i + 1}`,
    imgFallbackNameSingle: "图片",
    imgMsgLabel: "[图片消息]",
    // —— ideBridge.ts 工具结果 ——
    ideFileMiss: (p: string) => `未找到文件 ${p}（相对工作区根解析失败，可用绝对路径重试）`,
    ideOpened: (rel: string, at: string) => `已在编辑器打开 ${rel}${at}`,
    ideTasksAvail: (names: string[]) => `可用任务：${names.join("、")}。用 name 参数触发其一。`,
    ideTasksNone: "未找到可用任务（当前工作区没有 .vscode/tasks.json 或其中未定义任务）。",
    ideTaskMiss: (name: string, names: string[]) => `未找到任务「${name}」${names.length ? `，可用：${names.join("、")}` : "（当前工作区未定义任何任务）"}`,
    ideTaskRunning: (name: string) => `任务「${name}」已在运行（IDE 终端面板可见），勿重复触发。`,
    ideTaskFired: (name: string) => `任务「${name}」已发出启动请求（10s 内未确认进程启动，请到 IDE 终端面板确认输出）。`,
    ideTaskStarted: (name: string) => `任务「${name}」已在 IDE 终端启动（不等待完成；要看输出请到 IDE 终端面板，或改用 run_command 程序化执行）。`,
  },
  en: {
    // —— common ——
    engineNotLoaded: "(engine not loaded yet)",
    busyTooltip: "DeepSeeker-Code is working… (click to open the chat panel)",
    // —— activate / command palette ——
    noWorkspace: "DeepSeeker-Code: open a project folder (workspace) first.",
    noWorkspaceShort: "DeepSeeker-Code: no workspace folder is open.",
    initErrorNoKey:
      "DeepSeek API Key not configured: set deepseekerCode.apiKey (or the DEEP_SEEK_API_KEY environment variable), then reload the window.",
    pickRootPlaceholder: "Pick the project root the DeepSeeker-Code agent works in",
    pickRootTitle: "DeepSeeker-Code: select project root",
    rootSwitched: (label: string) => `DeepSeeker-Code: project root switched to ${label}`,
    rootSwitchFail: (root: string, err: string) => `DeepSeeker-Code: cannot chdir to project root (${root}): ${err}`,
    trustNone: "DeepSeeker-Code: no trusted directories yet.",
    trustPickPlaceholder: "Pick a directory to untrust (Esc to cancel)",
    trustPickTitle: "DeepSeeker-Code: manage trusted directories",
    trustRevoked: (d: string) => `DeepSeeker-Code: untrusted ${d} (reload the window to take effect)`,
    trustNotFound: "DeepSeeker-Code: that directory is not in the trust list.",
    batchEmpty: "DeepSeeker-Code: batch queue is empty. Submit via CLI: deepseeker-code batch add <ticket.md> (see batch help).",
    batchRunning: "running",
    batchPending: "pending",
    batchDone: "done — Enter to view report",
    batchPlaceholder: "Batch queue (submit/clean via CLI: batch add / batch clean)",
    batchTitle: "DeepSeeker-Code: batch queue",
    batchReportMissing: "DeepSeeker-Code: report missing (task may have just finished, or batch clean removed it).",
    engineInitFail: (msg: string) => `DeepSeeker-Code engine init failed (panel still works, but MCP/skills tools are missing): ${msg}`,
    hostNotLoaded: "DeepSeeker-Code: chat host not loaded yet (activate incomplete — should not happen)",
    // —— webview message handling ——
    engineLoading: "⏳ Loading engine (MCP/skills/commands)… will continue automatically.",
    newSessionNewTab: "🆕 New chat opened in a new editor tab; this conversation stays here, switch back to continue.",
    styleCurrent: (name: string) => `Current output style: ${name}`,
    styleDefault: "default",
    styleListEmpty: "(no styles installed)",
    styleUsage: "Switch: /output-style <name>, reset: /output-style off",
    styleOff: "Output style reset to default.",
    styleSwitched: (name: string) => `Output style switched: ${name}`,
    styleUnknown: (name: string) => `Unknown style: ${name}`,
    budgetView: (b: number | null, last: number | null) =>
      `💰 Budget: ${b != null ? `¥${b}/run` : "not set (set one with /budget 0.5 — per-run spending cap)"}${last != null ? ` · last run cost ¥${last.toFixed(3)}` : " · no completed run yet"}`,
    budgetOff: "💰 Budget disabled (no spending cap).",
    budgetUsage: "Usage: /budget 0.5 (yuan/run) · /budget off · /budget to view",
    budgetSet: (n: number) => `💰 Budget set: ¥${n} per run (nudged to wrap up at the cap; hard-stops at 120%).`,
    trustListEmpty: "Trusted directories: (none).",
    trustList: (lines: string) => `Trusted directories (untrust via /trust <index or path>):\n${lines}\n\nReload the window after untrusting (project config loads only at activation).`,
    trustRemoved: (t: string) => `Untrusted: ${t}\n(reload the window to take effect — project config loads only at activation)`,
    trustMiss: (t: string) => `Trust directory not found: ${t}`,
    obsUnknown: (cmd: string) => `Unknown observation command: ${cmd}`,
    obsFail: (msg: string) => `Read failed: ${msg}`,
    exportNone: "📄 No conversation to export (send a message first).",
    exportDialogTitle: "DeepSeeker-Code: export conversation as Markdown",
    exportCancelled: "📄 Export cancelled.",
    exportDone: (p: string) => `📄 Conversation exported: ${p}`,
    exportFail: (msg: string) => `Export failed: ${msg}`,
    attachDialogTitle: "DeepSeeker-Code: attach file (small files inlined; large files become references)",
    attachReadFail: (msg: string) => `📎 Failed to read file: ${msg}`,
    rewindKindText: (k: string) => (k === "creation_marker" ? "delete created" : k === "directory_tree" ? "restore tree" : "restore content"),
    rewindMissingBackup: (n: number) => `⚠️ ${n} more file backups were already cleaned and cannot be restored (left as-is)`,
    rewindTitle: (n: number) => `Rewind to before sending: ${n} files will be restored to that point.`,
    rewindBoth: "Chat + files",
    rewindChatOnly: "Chat only",
    rewindFail: (msg: string) => `⏪ Rewind failed: ${msg}`,
    bookmarkSaved: (n: number) => `🔖 Saved (${n} total) — insert from the Bookmarks group in the action panel.`,
    forkFail: (msg: string) => `Fork failed: ${msg}`,
    renameFail: (msg: string) => `Rename failed: ${msg}`,
    deleteFail: (msg: string) => `Delete failed: ${msg}`,
    diffNoSnapshot:
      'DeepSeeker-Code: the "before" snapshot for this edit is unavailable (history replay / window reload invalidates it) — use the inline diff in the chat instead.',
    diffTitle: (name: string) => `${name} · before → after`,
    // —— host.ts info lines ——
    inboxDelivered: (n: number) => `📬 Delivered to the model (${n} queued input${n > 1 ? "s" : ""})`,
    inboxCarryover: (n: number) => `📬 ${n} queued input${n > 1 ? "s" : ""} not claimed at the turn boundary; written to session history, carried into the next turn.`,
    autoExecuteOn: "⚡ Auto-execute on: implementation-phase tools run without approval.",
    planStayed: "✋ Staying in plan mode: keep typing requirements and the model will revise the plan (/plan or the mode panel exits).",
    bangUsage: "Usage: !<shell command> (e.g. !git status); output joins the next turn's context.",
    bangHead: (r: { timedOut: boolean; ok: boolean; exitCode: number | null }) =>
      r.timedOut ? "⏱ timed out" : r.ok ? "✅ exit 0" : r.exitCode != null ? `❌ exit ${r.exitCode}` : "❌ aborted",
    bangNoOutput: "(no output)",
    imgQueuedBusy: "🖼 Images can't ride queued messages while generating — resend after this turn finishes.",
    queuedAck: "📮 Queued — delivered to the model at the next turn boundary (stop button still works).",
    busyBlocked: "⏳ Busy — input not sent.",
    planNoImage: "🖼 Images aren't supported on research turns in plan mode (not added to this turn's context); send after exiting plan mode.",
    planEnterSwitched: (reason: string) => `📋 Model requested plan mode${reason ? `: ${reason}` : ""} — switched…`,
    sessionLoaded: "📂 Session loaded (the conversation continues in it)",
    noSessionFork: "No active session to fork",
    forked: "🌿 Forked into a new session (source untouched); the conversation now writes to the new one.",
    rewindBusy: "Cannot rewind while generating — stop the current turn first",
    noSessionRewind: "No active session to rewind",
    checkpointMissing: (id: string) => `Checkpoint not found: ${id}`,
    rewound: (n: number, fileNote: string) => `⏪ Rewound to before sending (${n} transcript lines removed). Edit and resend to proceed. ${fileNote}`,
    compactBusy: "⏳ Cannot compact manually while generating — stop the current turn first.",
    compactNoSession: "No active session — nothing to compact.",
    compactNothing: "No history to compact yet.",
    compactHealthy: "✅ Context already healthy (free folding of old tool results brought it back under the threshold) — no summarization needed.",
    compactFail: (msg: string) => `⚠️ Manual compaction failed: ${msg}`,
    imgFallbackName: (i: number) => `image${i + 1}`,
    imgFallbackNameSingle: "image",
    imgMsgLabel: "[image message]",
    // —— ideBridge.ts tool results ——
    ideFileMiss: (p: string) => `File not found: ${p} (failed to resolve against the workspace root; try an absolute path)`,
    ideOpened: (rel: string, at: string) => `Opened ${rel}${at} in the editor`,
    ideTasksAvail: (names: string[]) => `Available tasks: ${names.join(", ")}. Use the name argument to trigger one.`,
    ideTasksNone: "No tasks available (no .vscode/tasks.json in this workspace, or it defines none).",
    ideTaskMiss: (name: string, names: string[]) => `Task "${name}" not found${names.length ? `; available: ${names.join(", ")}` : " (no tasks defined in this workspace)"}`,
    ideTaskRunning: (name: string) => `Task "${name}" is already running (visible in the IDE terminal panel) — don't trigger it twice.`,
    ideTaskFired: (name: string) => `Task "${name}" start requested (process start not confirmed within 10s — check the IDE terminal panel).`,
    ideTaskStarted: (name: string) => `Task "${name}" started in the IDE terminal (not awaited; see the terminal panel for output, or use run_command instead).`,
  },
};

/** 取表函数工厂：闭包捕获 locale getter（host 实例 / per-tab 回调各自传入）。 */
export const makeT = (getLocale: () => UiLocale) => {
  const t = (key: string): any => {
    const dict = STRINGS[getLocale()] ?? STRINGS.zh;
    return dict[key] ?? STRINGS.zh[key] ?? key;
  };
  return t;
};

/** 无 tab 语境（activate 期/全局提示）：按 VS Code 显示语言；未注入/非英文一律 zh（产品默认中文）。 */
export const envLocale = (): UiLocale => {
  const s = typeof vscodeLanguage === "string" ? vscodeLanguage.toLowerCase() : "";
  return s.startsWith("en") ? "en" : "zh";
};

/** 由 extension.ts 在激活时注入 vscode.env.language（本模块不 import vscode，保持可被纯逻辑测试）。 */
export let vscodeLanguage = "";
export const setVscodeLanguage = (lang: string): void => {
  vscodeLanguage = lang;
};
