/**
 * @file cli/src/batchRunner.ts
 * @description 挂机批处理执行器（成本信任链第四环 F2）：`deepseeker-code batch run`。
 *
 *  串行取队列（并发=0，单人本地+速率+预算可控），每任务：
 *    1. createWorktree（sessionId=batch-<id>，usageLog 不误剔、真实消费进真实画像）；
 *    2. in-process 驱动 handleUnifiedChat（同 CLI 客户端形态，不走 HTTP）；审批自动应答器：
 *       白名单（编辑类 + 工单 tools 显式解锁）自动 allow-once，白名单外自动 deny 并记入报告——
 *       fail-closed 跳过，绝不无限等（不改审批网关本体，会话级注入应答策略）；
 *    3. 跑完在 worktree 内直接执行 accept 验收命令（不经模型），exit 0 = 过；
 *    4. harvestDiff 收割改动 → 报告落 batch/done/<id>.report.md；worktree 保留待人工处置
 *       （session 注册表即刻摘除——engine dispose 会清注册表内全部 worktree，摘除才能保住产物）；
 *    5. 失败/超时/预算截断照常出报告标状态，继续下一任务。
 *
 *  红线：预算/结算走 receipt + usageLog 真实回传数字（钱的数字可对账）；模型经 isProtectedWrite
 *  改不了 .deepseeker-code/batch 下的工单与报告（防自改预算/自过验收）。
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { handleUnifiedChat } from "@/serve/chatProcessing.ts";
import { agentTools } from "@/tool/index.ts";
import { createWorktree, harvestDiff, type WorktreeHandle } from "@/tool/worktree/manager.ts";
import { setSessionWorktree, clearSessionWorktree } from "@/tool/worktree/sessionRegistry.ts";
import { killBackgroundTasksUnder, resolveWinShell } from "@/tool/registry/background.ts";
import { scrubCommandEnv } from "@/tool/guard.ts";
import { decodeProcessOutput } from "@/common/index.ts";
import { readUsageRecords } from "@/observability/usageLog.ts";
import type { UIEvent } from "@/observability/type.ts";
import type { BatchTicket } from "@/batch/ticket.ts";
import { parseBatchTicket } from "@/batch/ticket.ts";
import { acquireRunLock, releaseRunLock, takeNextTicket, finishTicket } from "@/batch/queue.ts";
import { batchT, type BatchTaskStatus } from "./batchStrings.ts";
import { getLocale } from "./strings.ts";

// ============ 白名单与缺省禁用（审批自动应答器的判定表） ============

/** 编辑类白名单：挂机任务的核心动作（MUTATION 级文件编辑），自动 allow-once。 */
const BATCH_EDIT_TOOLS = new Set(["edit_file", "create_file", "write_file", "move_file", "notebook_edit"]);
/** 缺省禁用清单（对模型不可见，同 SUBAGENT_DENYLIST）：工单 tools: 字段可显式解锁。 */
const BATCH_DEFAULT_DENYLIST = new Set(["run_command", "delete_path"]);
/** 验收命令自身超时（分钟）：验收挂死不能拖垮整队。 */
const ACCEPT_TIMEOUT_MIN = 10;
/** 验收输出进报告的尾部长度（行）。 */
const ACCEPT_TAIL_LINES = 60;

/** 输出助手（main 已静默 console.*，直接写 stdout；headless 下 Ink 未启动无光标问题）。 */
const emit = (s: string = ""): void => {
    process.stdout.write(s + "\n");
};
const ts = (): string => new Date().toLocaleTimeString("zh-CN", { hour12: false });

/** 任务终态（状态标签词表在 batchStrings.statusLabel）。timeout/error 不跑验收（改动不完整，跑了也是噪声）；其余必跑验收定 passed/accept-failed。 */
type TaskStatus = BatchTaskStatus;

// ============ 验收命令执行（不经模型，runner 直接 exec） ============

/** shell 执行验收命令：复用 run_command 的 shell 形态（Win 优先 Git Bash / POSIX sh）与 GBK 兜底解码。 */
const runAcceptCommand = async (cmd: string, cwd: string): Promise<{ code: number | null; output: string; timedOut: boolean }> => {
    const T = batchT(getLocale());
    const isWin = process.platform === "win32";
    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(cmd, {
                shell: isWin ? (resolveWinShell() ?? true) : true,
                cwd,
                windowsHide: true,
                env: scrubCommandEnv(), // 剔除 agent 自身凭证（同 run_command 红线）
            });
        } catch (e: any) {
            resolve({ code: null, output: T.spawnFail(e?.message ?? e), timedOut: false });
            return;
        }
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => chunks.push(d));
        child.stderr?.on("data", (d: Buffer) => chunks.push(d));
        let timedOut = false;
        const killer = setTimeout(() => {
            timedOut = true;
            try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        }, ACCEPT_TIMEOUT_MIN * 60_000);
        child.on("error", (e: any) => {
            clearTimeout(killer);
            resolve({ code: null, output: T.execFail(e?.message ?? e), timedOut });
        });
        child.on("close", (code) => {
            clearTimeout(killer);
            const text = decodeProcessOutput(Buffer.concat(chunks)).trim();
            const lines = text.split("\n");
            const tail = lines.length > ACCEPT_TAIL_LINES ? `${T.tailOmitted(lines.length - ACCEPT_TAIL_LINES)}\n${lines.slice(-ACCEPT_TAIL_LINES).join("\n")}` : text;
            resolve({ code, output: tail || T.noOutput, timedOut });
        });
    });
};

// ============ 结算单聚合（usageLog 真实回传数字，可对账） ============

interface SessionCost {
    rounds: number;
    mainRounds: number;
    subRuns: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    /** 合计花费（元）；null=全部记录无价（无价模型）；部分无价时 partialPrice=true。 */
    costYuan: number | null;
    partialPrice: boolean;
    durationMs: number;
}

/** 读 usageLog 聚合本任务会话（主 run + 子 run 按记录求和；batch- 前缀不被读侧剔除）。 */
const collectSessionCost = async (sessionId: string): Promise<SessionCost> => {
    const recs = (await readUsageRecords(2)).filter((r) => r.sessionId === sessionId);
    const c: SessionCost = { rounds: 0, mainRounds: 0, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: null, partialPrice: false, durationMs: 0 };
    for (const r of recs) {
        c.rounds += r.rounds || 0;
        if (r.depth === 0) c.mainRounds += r.rounds || 0; else c.subRuns++;
        c.promptTokens += r.promptTokens ?? 0;
        c.completionTokens += r.completionTokens ?? 0;
        c.cachedTokens += r.cachedTokens ?? 0;
        c.durationMs += r.durationMs || 0;
        if (typeof r.costYuan === "number") c.costYuan = (c.costYuan ?? 0) + r.costYuan;
        else c.partialPrice = true;
    }
    if (c.costYuan === null) c.partialPrice = false; // 全无价：不是"部分"
    return c;
};

// ============ 报告生成 ============

const buildReport = (args: {
    id: string; ticket: BatchTicket; status: TaskStatus; budgetTruncated: boolean;
    cost: SessionCost; receipt: Extract<UIEvent, { type: "run.receipt" }> | undefined;
    finalText: string; accept: { cmd: string; code: number | null; output: string; timedOut: boolean } | null;
    deniedTools: { tool: string; detail: string }[]; diff: string; wt: WorktreeHandle | null;
    errorMessage?: string;
}): string => {
    const { id, ticket, status, budgetTruncated, cost, receipt, finalText, accept, deniedTools, diff, wt } = args;
    const T = batchT(getLocale());
    const budgetNote = budgetTruncated ? T.budgetTruncNote : "";
    return `---
id: ${id}
title: ${ticket.title}
status: ${status}
cost-yuan: ${cost.costYuan !== null ? cost.costYuan.toFixed(4) : "null"}
rounds: ${cost.rounds}
budget-truncated: ${budgetTruncated}
session: batch-${id}
worktree: ${wt?.path ?? T.notCreated}
branch: ${wt?.branch ?? T.notCreated}
---

${T.reportTitle(ticket.title)}

${T.statusEntry(`${T.statusLabel(status)}${budgetNote}`)}
${T.costEntry(T.costSummary(cost))}
${T.receiptEntry(receipt ? T.receiptLine(receipt) : T.noReceipt)}
${args.errorMessage ? T.errorEntry(args.errorMessage) : ""}
${T.taskH}

${ticket.body}

${T.finalH}

${finalText.trim() || T.noFinal}

${T.acceptH}
${accept
        ? `\n${T.acceptCmdLine(accept.cmd, accept.code)}${accept.timedOut ? T.acceptTimeoutSuffix : ""}\n\n${T.acceptTail}\n\n\`\`\`\n${accept.output}\n\`\`\`\n`
        : T.noAccept}

${T.deniedH}

${deniedTools.length === 0
        ? T.deniedNone
        : deniedTools.map((d) => `- **${d.tool}** — ${d.detail}`).join("\n")}

${T.diffH}

${T.diffNote(wt?.branch ?? "?", wt?.path ?? "?")}

\`\`\`\`\`diff
${diff}
\`\`\`\`\`
`;
};

// ============ 单任务执行 ============

const runOneTask = async (task: { id: string; path: string }): Promise<{ status: TaskStatus; cost: SessionCost; budgetTruncated: boolean }> => {
    const T = batchT(getLocale());
    const source = await fs.promises.readFile(task.path, "utf-8");
    const parsed = parseBatchTicket(source, getLocale());
    if (!parsed.ok) {
        // 工单格式问题：不入 worktree 直接出报告（running/ 里工单收尾回 done/）
        const cost: SessionCost = { rounds: 0, mainRounds: 0, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0, partialPrice: false, durationMs: 0 };
        await finishTicket(task.id, `---\nid: ${task.id}\ntitle: ${task.id}\nstatus: rejected\n---\n\n${T.rejectedTitle}\n\n${parsed.error}`);
        emit(T.ticketRejected(task.id, parsed.error));
        return { status: "rejected", cost, budgetTruncated: false };
    }
    const t = parsed.ticket;
    const sessionId = `batch-${task.id}`;
    const timeoutMin = t.timeoutMin ?? 30;
    emit(`▶ [${task.id}] ${t.title}`);
    emit(T.taskMeta(t.budgetYuan, timeoutMin, t.accept));

    // 工具表裁剪：缺省禁高危（对模型不可见），工单 tools: 显式解锁
    const unlocked = new Set(t.tools ?? []);
    const denySchemas = new Set([...BATCH_DEFAULT_DENYLIST].filter((n) => !unlocked.has(n)));
    const toolSchemas = agentTools.filter((x: any) => !denySchemas.has(x?.function?.name));

    // 审批自动应答器：编辑类 ∪ 工单解锁 → allow-once；其余 deny + 记录（fail-closed，绝不无限等）
    const allowApproval = new Set([...BATCH_EDIT_TOOLS, ...unlocked]);
    const deniedTools: { tool: string; detail: string }[] = [];

    // worktree：改动隔离 + 产物载体（非 git 项目在此失败 → error 报告，继续下一任务）。
    // ★ stepId 用任务全局唯一 id（不用 "batch" 常量）：worktree 保留策略下分支常驻，而 manager 的
    //   分支名 = dsc-wt-<sessionId 前 8>-<stepId>，batch-* 会话前 8 位全是 "batch-20"——常量 stepId
    //   会让第二个任务必撞名（冒烟已抓到）。任务 id 含时间戳+随机 → 分支唯一且可溯源。
    let wt: WorktreeHandle | null = null;
    try {
        wt = await createWorktree(sessionId, task.id);
    } catch (e: any) {
        const msg = T.wtCreateFail(e?.message ?? e);
        const cost = await collectSessionCost(sessionId);
        await finishTicket(task.id, buildReport({
            id: task.id, ticket: t, status: "error", budgetTruncated: false, cost, receipt: undefined,
            finalText: "", accept: null, deniedTools: [], diff: T.diffNone, wt: null, errorMessage: msg,
        }));
        emit(`💥 [${task.id}] ${msg}`);
        return { status: "error", cost, budgetTruncated: false };
    }
    setSessionWorktree(sessionId, wt);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(T.timeoutAbort(timeoutMin))), timeoutMin * 60_000);
    let receipt: Extract<UIEvent, { type: "run.receipt" }> | undefined;
    // ★ final 全文自采：handleUnifiedChat 的契约是「正文已流式推过 delta 时 final.text 置空」（交互场景防
    //   重复显示），挂机报告要全文——累积 text.delta，final.text 仅作「首字符前终结」路径的兜底。
    let finalText = "";
    let agentError: string | undefined;
    try {
        await handleUnifiedChat(
            { sessionId, content: t.body },
            async () => { /* sendOutbound：sseWrite 已给，不会走到 */ },
            (evt: any) => {
                if (evt?.type === "text.delta") finalText += evt.text;
                else if (evt?.type === "text.reset") finalText = ""; // 流式 stall 重试：同轮从零重生成，丢弃已累积
                else if (evt?.type === "final") finalText = evt.text || finalText;
                else if (evt?.type === "round.start") emit(T.roundLine(ts(), evt.round));
            },
            ac.signal,
            {
                requestApproval: async (detail, meta) => {
                    if (allowApproval.has(meta.toolName)) return "allow-once";
                    deniedTools.push({ tool: meta.toolName, detail: detail.replace(/\n+/g, " ").slice(0, 140) });
                    return "deny";
                },
                onUIEvent: (evt: UIEvent) => {
                    if (evt.type === "run.receipt") receipt = evt;
                },
                budgetYuan: t.budgetYuan,
                toolSchemas,
            },
        );
    } catch (e: any) {
        agentError = e instanceof Error ? e.message : String(e);
    } finally {
        clearTimeout(timer);
        // ★ 立即摘 session 注册表：engine dispose 会清注册表内全部 worktree，不摘则产物 worktree 被误删
        clearSessionWorktree(sessionId);
    }

    // 状态判定：error/timeout 不跑验收；其余跑验收定 passed/accept-failed（预算截断不豁免验收——过了就是过了）
    const timedOut = ac.signal.aborted;
    const budgetTruncated = receipt?.budgetTruncated === true;
    let status: TaskStatus;
    let accept: { cmd: string; code: number | null; output: string; timedOut: boolean } | null = null;
    if (agentError) {
        status = "error";
        emit(T.agentErrorLine(task.id, agentError));
    } else if (timedOut) {
        status = "timeout";
        emit(T.timeoutLine(task.id, timeoutMin));
    } else {
        const r = await runAcceptCommand(t.accept, wt.path);
        accept = { cmd: t.accept, code: r.code, output: r.output, timedOut: r.timedOut };
        status = r.code === 0 && !r.timedOut ? "passed" : "accept-failed";
        emit(T.acceptLine(status === "passed", task.id, r.code) + (r.timedOut ? T.acceptKilledSuffix : ""));
    }

    // 善后：杀本任务在 worktree 下遗留的后台进程（dev server 等，防跨任务端口冲突）→ 收割 diff → 报告
    await killBackgroundTasksUnder(wt.path).catch(() => { });
    const diff = await harvestDiff(wt);
    const cost = await collectSessionCost(sessionId);
    await finishTicket(task.id, buildReport({
        id: task.id, ticket: t, status, budgetTruncated, cost, receipt, finalText,
        accept, deniedTools, diff, wt, errorMessage: agentError,
    }));
    emit(`   ${T.statusLabel(status)} · ${T.costSummary(cost)}`);
    emit(T.artifactLine(wt.path, wt.branch));
    return { status, cost, budgetTruncated };
};

// ============ 等待窗口（--wait-window HH:MM-HH:MM：仅延迟启动语义，错峰价是否存在未核实） ============

export const parseWaitWindow = (s?: string): { startMin: number; endMin: number } | null => {
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const startMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const endMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    if (startMin === endMin) return null;
    return { startMin, endMin };
};

const nowMinutes = (): number => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 睡到窗口起点：已过起点但在窗口内 → 立即开跑；已过终点 → 等明天起点。分段睡（防 setTimeout 2^31 溢出）。 */
const waitUntilWindow = async (w: { startMin: number; endMin: number }): Promise<void> => {
    const T = batchT(getLocale());
    const now = nowMinutes();
    let waitMin = 0;
    if (now >= w.startMin && now < w.endMin) {
        emit(T.inWindowNow(`${Math.floor(now / 60)}:${String(now % 60).padStart(2, "0")}`));
        return;
    }
    waitMin = now < w.startMin ? w.startMin - now : 24 * 60 - now + w.startMin;
    emit(T.waitWindowWait(Math.floor(waitMin / 60), waitMin % 60));
    while (waitMin > 0) {
        const chunkMin = Math.min(waitMin, 30);
        await sleep(chunkMin * 60_000);
        waitMin -= chunkMin;
    }
};

// ============ 队列主循环 ============

/**
 * 执行挂机队列（engine 已就绪后由 main 派发）。全程持锁（并发=0）；崩溃残留 running/ 工单自动重排队。
 */
export const runBatchQueue = async (opts?: { waitWindow?: string }): Promise<void> => {
    const T = batchT(getLocale());
    const window = parseWaitWindow(opts?.waitWindow);
    if (opts?.waitWindow && !window) {
        emit(T.waitWindowInvalid(opts.waitWindow));
        process.exitCode = 2;
        return;
    }
    if (window) await waitUntilWindow(window);

    const lock = await acquireRunLock(getLocale());
    if (!lock.ok) {
        emit(`🚫 ${lock.error}`);
        process.exitCode = 1;
        return;
    }

    const startedAt = Date.now();
    let total = 0;
    let passed = 0;
    let costSum = 0;
    let costTasks = 0;
    const failedIds: string[] = [];
    try {
        for (;;) {
            const task = await takeNextTicket();
            if (!task) break;
            total++;
            const r = await runOneTask(task);
            if (r.status === "passed") passed++;
            else failedIds.push(`[${task.id}] ${T.statusLabel(r.status)}`);
            if (r.cost.costYuan !== null) {
                costSum += r.cost.costYuan;
                costTasks++;
            }
        }
    } finally {
        await releaseRunLock();
    }

    if (total === 0) {
        emit(T.runnerQueueEmpty);
        return;
    }
    emit("");
    emit("━".repeat(56));
    emit(T.summaryDone(total, passed, `${Math.round((Date.now() - startedAt) / 6000) / 10}`));
    emit(costTasks > 0 ? T.summaryCost(costSum.toFixed(4), costTasks) : T.summaryCostFree);
    if (failedIds.length > 0) emit(`${T.failedHead}\n  ${failedIds.join("\n  ")}`);
    emit(T.artifactsDir);
};
