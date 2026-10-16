/**
 * @file cli/src/batchStrings.ts
 * @description 挂机批处理（batch add|list|run|clean|help）的用户可见文案：控制台进度行 + 落盘报告模板。
 *
 *  独立于 strings.ts 主词表（交互 UI）：挂机是 headless 面，报告模板多行且长，混入主表会淹没交互键。
 *  en 表按 typeof ZH 校验（缺键编译报错）；batchT(locale) 非法 locale 回退 zh。
 *  报告是落盘存档：按运行时刻的语言生成，不追溯翻译（与历史会话记录同语义）。
 */
import type { Locale } from "@/common/index.ts";

/** 任务终态（batchRunner 与词表共用；setup-failed/timeout/error 不跑验收，其余必跑验收定 passed/accept-failed）。 */
export type BatchTaskStatus = "passed" | "accept-failed" | "timeout" | "error" | "setup-failed" | "rejected";

const ZH = {
    // —— batchAdmin（add / list / clean / help） ——
    usage: `deepseeker-code batch —— 挂机批处理（成本信任链第四环）

用法：deepseeker-code batch <子命令>
  add <工单.md> [...]              投递任务（可一次多个文件）
  list                             查看 pending / running / done 三态队列
  run [--wait-window HH:MM-HH:MM]  执行队列（串行，逐任务出报告；--wait-window 到点再开跑）
  clean                            清空 done/（已读过的报告与工单存档）

工单格式（Markdown，frontmatter 的 accept 必填——缺验收拒绝入队）：
  ---
  title: 修复日期解析 bug
  accept: npm test
  setup: pnpm install   # 可选：agent 前在 worktree 内备环境（干净检出无 node_modules，验收依赖环境时先装）
  budget-yuan: 0.5      # 可选：本任务花费上限（元）
  timeout-min: 30       # 可选：agent 阶段超时（分钟，缺省 30）
  tools: run_command    # 可选：显式解锁高危工具（缺省禁 run_command/delete_path）
  ---
  任务描述正文（Markdown）…

产物：<项目>/.deepseeker-code/batch/done/<id>.report.md（状态/结算单/验收输出/diff 摘要）；
改动收割在独立 git worktree（临时分支）上，保留待人工 merge 或丢弃。`,
    adminAddUsage: "用法：deepseeker-code batch add <工单.md> [...]（缺验收命令的工单会被拒绝）\n详情：deepseeker-code batch help",
    readFileFail: (e: string) => `读文件失败：${e}`,
    enqueued: (id: string, title: string) => `📥 已入队 [${id}] ${title}`,
    addRejected: (name: string, err: string) => `🚫 拒绝 ${name}：${err}`,
    nextStepRun: "\n跑批：deepseeker-code batch run",
    adminQueueEmpty: "队列空。投递：deepseeker-code batch add <工单.md>（格式见 batch help）",
    listRunningHead: "▶ 运行中：",
    listPendingHead: (n: number) => `⏳ 待跑 ${n}：`,
    listDoneHead: (n: number) => `✔ 已完成 ${n}：`,
    cleaned: (n: number) => `🧹 已清空 done/（${n} 个任务存档）。pending/running 不受影响。`,
    reportMissing: "（报告缺失）",

    // —— batchRunner 控制台进度 ——
    ticketRejected: (id: string, err: string) => `🚫 [${id}] 工单被拒：${err}`,
    taskMeta: (budget: number | undefined, timeoutMin: number, accept: string) => `   预算 ${budget !== undefined ? `¥${budget}` : "不限"} · 超时 ${timeoutMin}min · 验收 \`${accept}\``,
    setupLine: (cmd: string) => `🛠️  setup：\`${cmd}\`（worktree 内备环境）`,
    setupFail: (cmd: string, code: number | null) => `环境准备失败（setup \`${cmd}\` exit ${code ?? "null"}）——跳过 agent 阶段，任务记失败`,
    roundLine: (ts: string, round: number) => `   [${ts}] 轮 ${round}`,
    wtCreateFail: (e: string) => `创建 worktree 失败（需要主工作区是 git 仓库）：${e}`,
    agentErrorLine: (id: string, err: string) => `💥 [${id}] agent 异常：${err}`,
    timeoutLine: (id: string, min: number) => `⏱️ [${id}] 超时（${min}min），截断收尾（验收不跑）`,
    acceptLine: (passed: boolean, id: string, code: number | null) => `${passed ? "✅" : "❌"} [${id}] 验收 exit ${code}`,
    acceptKilledSuffix: "（超时被杀）",
    timeoutAbort: (min: number) => `任务超时（${min} 分钟）`,
    artifactLine: (p: string, branch: string) => `   产物：${p}（分支 ${branch}，保留待人工处置）`,
    inWindowNow: (hhmm: string) => `⏰ 当前 ${hhmm} 已在窗口内，立即开跑。`,
    waitWindowWait: (h: number, m: number) => `⏰ --wait-window：${h} 小时 ${m} 分后（窗口起点）开跑。挂机等待中，Ctrl+C 可取消。`,
    waitWindowInvalid: (s: string) => `❌ --wait-window 格式非法："${s}"（应为 HH:MM-HH:MM，如 23:30-06:30）`,
    runnerQueueEmpty: "队列空：pending/ 无任务。投递：deepseeker-code batch add <工单.md>",
    summaryDone: (total: number, passed: number, mins: string) => `🌙 挂机结束：${total} 任务 · ${passed} 过 · ${total - passed} 未过（耗时 ${mins}min）`,
    summaryCost: (sum: string, tasks: number) => `💰 总花费：¥${sum}（${tasks} 个任务计价）`,
    summaryCostFree: "💰 总花费：全部无价模型，未计钱",
    failedHead: "⚠️ 未过清单：",
    artifactsDir: "报告与改动：.deepseeker-code/batch/done/（worktree 均保留待人工处置）",

    // —— 状态标签（控制台与报告共用） ——
    statusLabel: (s: BatchTaskStatus) => ({
        passed: "✅ 通过验收",
        "accept-failed": "❌ 验收未过",
        timeout: "⏱️ 超时截断",
        error: "💥 agent 异常",
        "setup-failed": "🛠️ 环境准备失败",
        rejected: "🚫 工单被拒",
    })[s],

    // —— 验收命令执行（输出嵌入报告） ——
    spawnFail: (e: string) => `启动失败：${e}`,
    execFail: (e: string) => `执行失败：${e}`,
    tailOmitted: (n: number) => `（前 ${n} 行已省略）`,
    noOutput: "（无输出）",

    // —— 结算单聚合与 receipt 行（报告内嵌） ——
    costFree: "（无价模型，不计钱）",
    costSummary: (c: { rounds: number; promptTokens: number; cachedTokens: number; costYuan: number | null; partialPrice: boolean; durationMs: number; subRuns: number }) => {
        const money = c.costYuan !== null ? `¥${c.costYuan.toFixed(4)}` : "（无价模型，不计钱）";
        const hit = c.promptTokens > 0 ? Math.round((c.cachedTokens / c.promptTokens) * 100) : 0;
        const mins = Math.round(c.durationMs / 6000) / 10;
        return `${c.rounds} 轮 · ${money} · 缓存命中 ${hit}% · ${mins}min${c.partialPrice ? "（部分记录无价，钱为部分和）" : ""}${c.subRuns > 0 ? ` · 子 run ${c.subRuns} 个已计入` : ""}`;
    },
    noReceipt: "（无结算单——run 未到收尾即被截断，花费以上方 usageLog 聚合为准）",
    receiptLine: (r: { rounds: number; costYuan: number | null; cacheHitRate: number; durationMs: number }) =>
        `${r.rounds} 轮 · ${r.costYuan !== null ? `¥${r.costYuan.toFixed(4)}` : "无价"} · 缓存命中 ${Math.round(r.cacheHitRate * 100)}% · ${(r.durationMs / 1000).toFixed(0)}s`,

    // —— 报告骨架 ——
    rejectedTitle: "# 挂机任务被拒",
    reportTitle: (title: string) => `# 挂机任务报告：${title}`,
    statusEntry: (v: string) => `- 状态：${v}`,
    budgetTruncNote: "（⚠️ 预算截断后收尾）",
    costEntry: (v: string) => `- 结算单：${v}`,
    receiptEntry: (v: string) => `- 本轮 receipt：${v}`,
    errorEntry: (v: string) => `- 异常：${v}\n`,
    notCreated: "（未创建）",
    taskH: "## 任务",
    finalH: "## 模型收尾汇报",
    noFinal: "（无输出——run 在产出正文前被截断/异常）",
    acceptH: "## 验收",
    acceptCmdLine: (cmd: string, code: number | null) => `命令：\`${cmd}\` → exit ${code}`,
    acceptTimeoutSuffix: "（⏱️ 验收超时被杀）",
    acceptTail: "输出尾部：",
    noAccept: "\n（未执行验收——改动不完整，跑了也是噪声）",
    deniedH: "## 被拒工具调用（fail-closed 记录）",
    deniedNone: "无。",
    diffH: "## Diff 摘要（worktree 相对基座，未提交，待人工处置）",
    diffNote: (branch: string, p: string) => `改动在独立 worktree（分支 \`${branch}\`，路径 ${p}）。处置：检查满意 → 在 worktree 内 commit 并合回主仓；丢弃 → 删除该 worktree 目录 + \`git worktree prune\` + \`git branch -D <分支>\`。`,
    diffNone: "（无）",
};

const EN: typeof ZH = {
    usage: `deepseeker-code batch — unattended batch runs (cost trust chain)

Usage: deepseeker-code batch <subcommand>
  add <ticket.md> [...]              Enqueue tasks (multiple files at once)
  list                               Show the pending / running / done queue
  run [--wait-window HH:MM-HH:MM]    Run the queue (serial, one report per task; --wait-window waits for the window)
  clean                              Clear done/ (reports and ticket archives you've read)

Ticket format (Markdown; frontmatter \`accept\` is required — no acceptance, no enqueue):
---
  title: Fix date parsing bug
  accept: npm test            # required: acceptance command (exit 0 = pass)
  setup: pnpm install   # optional: prep env inside the worktree before the agent (fresh checkout has no node_modules)
  budget-yuan: 0.5      # optional: per-task cost cap (yuan)
  timeout-min: 30       # optional: agent-phase timeout (minutes, default 30)
  tools: run_command    # optional: unlock risky tools (run_command/delete_path denied by default)
---

  Task description body (Markdown)…

Artifacts: <project>/.deepseeker-code/batch/done/<id>.report.md (status / receipt / acceptance output / diff summary);
changes are harvested onto an isolated git worktree (temp branch), kept for manual merge or disposal.`,
    adminAddUsage: "Usage: deepseeker-code batch add <ticket.md> [...] (tickets without an acceptance command are rejected)\nDetails: deepseeker-code batch help",
    readFileFail: (e) => `Failed to read file: ${e}`,
    enqueued: (id, title) => `📥 Enqueued [${id}] ${title}`,
    addRejected: (name, err) => `🚫 Rejected ${name}: ${err}`,
    nextStepRun: "\nRun the queue: deepseeker-code batch run",
    adminQueueEmpty: "Queue is empty. Enqueue: deepseeker-code batch add <ticket.md> (format: batch help)",
    listRunningHead: "▶ Running:",
    listPendingHead: (n) => `⏳ Pending ${n}:`,
    listDoneHead: (n) => `✔ Done ${n}:`,
    cleaned: (n) => `🧹 Cleared done/ (${n} task archives). pending/running untouched.`,
    reportMissing: "(report missing)",

    ticketRejected: (id, err) => `🚫 [${id}] Ticket rejected: ${err}`,
    taskMeta: (budget, timeoutMin, accept) => `   Budget ${budget !== undefined ? `¥${budget}` : "uncapped"} · timeout ${timeoutMin}min · accept \`${accept}\``,
    setupLine: (cmd) => `🛠️  setup: \`${cmd}\` (preparing the environment inside the worktree)`,
    setupFail: (cmd, code) => `Setup failed (\`${cmd}\` exit ${code ?? "null"}) — agent phase skipped, task marked failed`,
    roundLine: (ts, round) => `   [${ts}] round ${round}`,
    wtCreateFail: (e) => `Failed to create worktree (the main workspace must be a git repo): ${e}`,
    agentErrorLine: (id, err) => `💥 [${id}] agent error: ${err}`,
    timeoutLine: (id, min) => `⏱️ [${id}] Timed out (${min}min); wrapped up truncated (acceptance skipped)`,
    acceptLine: (passed, id, code) => `${passed ? "✅" : "❌"} [${id}] acceptance exit ${code}`,
    acceptKilledSuffix: " (killed on timeout)",
    timeoutAbort: (min) => `Task timed out (${min} minutes)`,
    artifactLine: (p, branch) => `   Artifact: ${p} (branch ${branch}, kept for manual handling)`,
    inWindowNow: (hhmm) => `⏰ It's ${hhmm}, already inside the window — starting now.`,
    waitWindowWait: (h, m) => `⏰ --wait-window: starting in ${h}h ${m}m (at the window start). Waiting — Ctrl+C to cancel.`,
    waitWindowInvalid: (s) => `❌ Invalid --wait-window: "${s}" (expected HH:MM-HH:MM, e.g. 23:30-06:30)`,
    runnerQueueEmpty: "Queue empty: no tasks in pending/. Enqueue: deepseeker-code batch add <ticket.md>",
    summaryDone: (total, passed, mins) => `🌙 Batch finished: ${total} tasks · ${passed} passed · ${total - passed} failed (${mins}min)`,
    summaryCost: (sum, tasks) => `💰 Total cost: ¥${sum} (${tasks} tasks priced)`,
    summaryCostFree: "💰 Total cost: all records unpriced, no money counted",
    failedHead: "⚠️ Failed tasks:",
    artifactsDir: "Reports and changes: .deepseeker-code/batch/done/ (worktrees kept for manual handling)",

    statusLabel: (s) => ({
        passed: "✅ acceptance passed",
        "accept-failed": "❌ acceptance failed",
        timeout: "⏱️ timed out",
        error: "💥 agent error",
        "setup-failed": "🛠️ setup failed",
        rejected: "🚫 ticket rejected",
    })[s],

    spawnFail: (e) => `Spawn failed: ${e}`,
    execFail: (e) => `Execution failed: ${e}`,
    tailOmitted: (n) => `(first ${n} lines omitted)`,
    noOutput: "(no output)",

    costFree: "(unpriced model, no money counted)",
    costSummary: (c) => {
        const money = c.costYuan !== null ? `¥${c.costYuan.toFixed(4)}` : "(unpriced model, no money counted)";
        const hit = c.promptTokens > 0 ? Math.round((c.cachedTokens / c.promptTokens) * 100) : 0;
        const mins = Math.round(c.durationMs / 6000) / 10;
        return `${c.rounds} rounds · ${money} · cache hit ${hit}% · ${mins}min${c.partialPrice ? " (some records unpriced; money is a partial sum)" : ""}${c.subRuns > 0 ? ` · ${c.subRuns} sub-runs included` : ""}`;
    },
    noReceipt: "(no receipt — the run was truncated before finishing; cost per the usageLog aggregate above)",
    receiptLine: (r) =>
        `${r.rounds} rounds · ${r.costYuan !== null ? `¥${r.costYuan.toFixed(4)}` : "unpriced"} · cache hit ${Math.round(r.cacheHitRate * 100)}% · ${(r.durationMs / 1000).toFixed(0)}s`,

    rejectedTitle: "# Batch task rejected",
    reportTitle: (title) => `# Batch task report: ${title}`,
    statusEntry: (v) => `- Status: ${v}`,
    budgetTruncNote: " (⚠️ wrapped up after budget truncation)",
    costEntry: (v) => `- Receipt: ${v}`,
    receiptEntry: (v) => `- This run's receipt: ${v}`,
    errorEntry: (v) => `- Error: ${v}\n`,
    notCreated: "(not created)",
    taskH: "## Task",
    finalH: "## Model final report",
    noFinal: "(no output — the run was truncated/errored before producing any text)",
    acceptH: "## Acceptance",
    acceptCmdLine: (cmd, code) => `Command: \`${cmd}\` → exit ${code}`,
    acceptTimeoutSuffix: " (⏱️ acceptance timed out, killed)",
    acceptTail: "Output tail:",
    noAccept: "\n(Acceptance not run — changes incomplete, running it would be noise.)",
    deniedH: "## Denied tool calls (fail-closed log)",
    deniedNone: "None.",
    diffH: "## Diff summary (worktree vs base, uncommitted, awaiting manual handling)",
    diffNote: (branch, p) => `Changes live in an isolated worktree (branch \`${branch}\`, path ${p}). To keep: commit inside the worktree and merge back. To discard: delete the worktree directory + \`git worktree prune\` + \`git branch -D <branch>\`.`,
    diffNone: "(none)",
};

const DICT: Record<Locale, typeof ZH> = { zh: ZH, en: EN };

/** 取挂机面词表（locale 非法回退 zh）。报告与控制台同一 locale——一次 run 内语言一致。 */
export const batchT = (locale: Locale): typeof ZH => DICT[locale] ?? ZH;
