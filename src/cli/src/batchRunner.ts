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
import { isInterpreterRepoScript } from "@/tool/autoPermission.ts";
import { createWorktree, harvestDiff, commitWorktreeChanges, type WorktreeHandle, type WorktreeCommit } from "@/tool/worktree/manager.ts";
import { setSessionWorktree, clearSessionWorktree } from "@/tool/worktree/sessionRegistry.ts";
import { killBackgroundTasksUnder, resolveWinShell } from "@/tool/registry/background.ts";
import { scrubCommandEnv } from "@/tool/guard.ts";
import { decodeProcessOutput } from "@/common/index.ts";
import { readUsageRecords } from "@/observability/usageLog.ts";
import type { UIEvent } from "@/observability/type.ts";
import type { BatchTicket } from "@/batch/ticket.ts";
import { parseBatchTicket } from "@/batch/ticket.ts";
import { acquireRunLock, releaseRunLock, takeNextTicket, peekNextTicket, finishTicket } from "@/batch/queue.ts";
import { baselineKey, readBaselineCache, writeBaselineCache, classifyProbe, baselineVerdictLabel } from "@/batch/sync/baseline.ts";
import { batchT, type BatchTaskStatus } from "./batchStrings.ts";
import { getLocale } from "./strings.ts";
import {
    BatchWatchdog, buildRetryTaskContent, sharedBudgetYuan, RETRY_MAX,
    type WatchdogKillInfo, type WatchdogRecord, type WatchdogSnapshot,
} from "./batchWatchdog.ts";
import { pushSessionInbox } from "@/agent/inbox.ts";
import { registerWakeDriver, unregisterWakeDriver, waitSessionQuiescent, AGENT_DONE_SENTINEL } from "@/agent/agentWake.ts";

// ============ 白名单与缺省禁用（审批自动应答器的判定表） ============

/** 编辑类白名单：挂机任务的核心动作（MUTATION 级文件编辑），自动 allow-once。 */
const BATCH_EDIT_TOOLS = new Set(["edit_file", "create_file", "write_file", "move_file", "notebook_edit"]);
/** 缺省禁用清单（对模型不可见，同 SUBAGENT_DENYLIST）：工单 tools: 字段可显式解锁。
 *  run_in_background 同步收权（审查报告 P1-8′）：挂机是无人值守场景，后台孤儿任务产物无人验收。 */
const BATCH_DEFAULT_DENYLIST = new Set(["run_command", "delete_path", "run_in_background"]);
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
                env: { ...scrubCommandEnv(), CI: "1" }, // 剔除 agent 凭证（同 run_command 红线）；CI=1 抑制 test runner 的 watch（跨平台，不靠 shell 前缀）
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

// ============ 基线三态校验辅助（§5.2.1，仅外部源工单；git 直调零 shell） ============

/** 测试文件路径启发式（§9.8 P1 信息标注，不参与状态判定）。 */
const TEST_PATH_RE = /(^|[\\/])(tests?|__tests__)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;

/** git 只跑短命令（shell:false，无注入面）；失败返回 null（探测/列举失败不致命）。 */
const gitSimple = (args: string[], cwd: string): Promise<string | null> =>
    new Promise((resolve) => {
        const child = spawn("git", args, { cwd, windowsHide: true, shell: false });
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => chunks.push(d));
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code === 0 ? decodeProcessOutput(Buffer.concat(chunks)).trim() || null : null));
    });

/** 主仓库根（缓存键的「仓库」维度）：从 worktree 反查 common dir 的父目录。 */
const mainRepoRootOf = async (wtPath: string): Promise<string> => {
    const common = await gitSimple(["rev-parse", "--git-common-dir"], wtPath);
    return common ? path.dirname(path.resolve(wtPath, common)) : process.cwd();
};

/** diff 相对 baseSha 的已改动文件清单（harvestDiff 同口径：全量已暂存）→ 过滤测试路径。 */
const touchedTestFiles = async (wtPath: string, baseSha: string): Promise<string[]> => {
    const out = await gitSimple(["diff", "--cached", "--name-only", baseSha], wtPath);
    if (!out) return [];
    return out.split("\n").map((s) => s.trim()).filter(Boolean).filter((f) => TEST_PATH_RE.test(f));
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
    /** 按次计费工具花费合计（元，DeepSeek Search/Fetch；0=本任务无按次调用）。 */
    toolCostYuan: number;
    /** 辅助模型花费合计（元，压缩摘要+风险分类器；0=本任务无 aux 调用）。 */
    auxCostYuan: number;
    partialPrice: boolean;
    durationMs: number;
}

/** 读 usageLog 聚合本任务会话（主 run + 子 run 按记录求和；batch- 前缀不被读侧剔除。
 *  子 run 的 sessionId 带 `__sub__` 后缀，按前缀归拢——精确等值会把子 run 全漏掉，
 *  结算单恒显 subRuns=0（审查报告 N4，2026-10-20）。 */
const collectSessionCost = async (sessionId: string): Promise<SessionCost> => {
    const recs = (await readUsageRecords(2)).filter((r) => r.sessionId === sessionId || r.sessionId.startsWith(sessionId + "__sub__"));
    const c: SessionCost = { rounds: 0, mainRounds: 0, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: null, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 0 };
    for (const r of recs) {
        c.rounds += r.rounds || 0;
        if (r.depth === 0) c.mainRounds += r.rounds || 0; else c.subRuns++;
        c.promptTokens += r.promptTokens ?? 0;
        c.completionTokens += r.completionTokens ?? 0;
        c.cachedTokens += r.cachedTokens ?? 0;
        c.durationMs += r.durationMs || 0;
        c.toolCostYuan += r.toolCostYuan ?? 0;
        c.auxCostYuan += r.auxCostYuan ?? 0;
        if (typeof r.costYuan === "number") c.costYuan = (c.costYuan ?? 0) + r.costYuan;
        else c.partialPrice = true;
    }
    if (c.costYuan === null) c.partialPrice = false; // 全无价：不是"部分"
    return c;
};

// ============ 报告生成 ============

/** 收尾提交状态 → 报告一行（无提交记录时显式说「未执行」，不留空白让人猜）。 */
const commitText = (c: WorktreeCommit | undefined): string => {
    const T = batchT(getLocale());
    if (!c) return T.commitSkipped;
    if (c.error) return T.commitFail(c.error);
    if (c.committed) return T.commitDone(c.sha);
    if (c.noChanges) return T.commitNone;
    return T.commitPre(c.sha);
};

/** 看门狗证据链 → 报告行（方案 §7：证据链是硬要求——用户早上复核时能独立判断杀得对不对）。 */
const buildWatchdogLines = (snaps: WatchdogSnapshot[], costYuan: number | null): string[] | null => {
    if (snaps.length === 0) return null;
    const T = batchT(getLocale());
    const render = (r: WatchdogRecord): string => {
        switch (r.kind) {
            case "suspicion": return T.wdSuspicionRec(r.text ?? "");
            case "verdict": return T.wdVerdictRec(r.verdict ?? "", r.evidence ?? "");
            case "nudge": return T.wdNudgeRec(r.level ?? 0, r.text ?? "");
            case "health": return T.wdHealthRec(r.text ?? "");
            case "aux-fail": return T.wdAuxFailRec();
            case "kill": return T.wdKillRec(r.verdict ?? "", r.evidence ?? "");
        }
    };
    const lines: string[] = [];
    for (const snap of snaps) {
        lines.push(...snap.records.map(render));
        if (snap.kill) lines.push(T.wdAtKillRec(snap.roundsAtKill, costYuan !== null ? costYuan.toFixed(4) : "-"));
    }
    if (snaps.length > 1) lines.push(T.wdRetryRec(snaps.length - 1));
    return lines;
};


/** 导出供守门测试直接渲染验证（纯函数，无 IO）。 */
export const buildReport = (args: {
    id: string; ticket: BatchTicket; status: TaskStatus; budgetTruncated: boolean;
    cost: SessionCost; receipt: Extract<UIEvent, { type: "run.receipt" }> | undefined;
    finalText: string; accept: { cmd: string; code: number | null; output: string; timedOut: boolean } | null;
    deniedTools: { tool: string; detail: string }[]; diff: string; wt: WorktreeHandle | null;
    /** 收尾快照提交结果（worktree 未创建时不传）。 */
    commit?: WorktreeCommit | null;
    errorMessage?: string;
    /** 看门狗证据链（方案 §7：触发规则/verdict/evidence/nudge 记录/终止时刻轮数与花费/重试轮次）。 */
    watchdogLines?: string[];
    /** 本次 diff 触碰的测试文件（§9.8 P1 信息标注；空/缺省不渲染该段）。 */
    touchedTestFiles?: string[];
    /** 本任务 read_image 调用次数（§5.2.2 落地要求 6：图片读取可见性——人要能判断该翻案还是换模型）。 */
    imagesRead?: number;
}): string => {
    const { id, ticket, status, budgetTruncated, cost, receipt, finalText, accept, deniedTools, diff, wt } = args;
    const T = batchT(getLocale());
    const budgetNote = budgetTruncated ? T.budgetTruncNote : "";
    const testFilesSection = args.touchedTestFiles?.length
        ? `\n${T.testFilesH}\n\n${T.testFilesNote(args.touchedTestFiles.length)}\n${args.touchedTestFiles.map((f) => `- \`${f}\``).join("\n")}\n`
        : "";
    return `---
id: ${id}
title: ${ticket.title}
status: ${status}
cost-yuan: ${cost.costYuan !== null ? cost.costYuan.toFixed(4) : "null"}
rounds: ${cost.rounds}
budget-truncated: ${budgetTruncated}
${ticket.needsReview ? "needs-review: true\n" : ""}session: batch-${id}
worktree: ${wt?.path ?? T.notCreated}
branch: ${wt?.branch ?? T.notCreated}
---

${T.reportTitle(ticket.title)}

${T.statusEntry(`${T.statusLabel(status)}${budgetNote}`)}
${T.costEntry(T.costSummary(cost))}
${T.receiptEntry(receipt ? T.receiptLine(receipt) : T.noReceipt)}
${T.imgReadEntry(args.imagesRead ?? 0)}
${T.commitEntry(args.commit ? commitText(args.commit) : (wt ? T.commitNotReached : T.commitSkipped))}
${args.errorMessage ? T.errorEntry(args.errorMessage) : ""}
${args.watchdogLines?.length ? `${T.wdH}\n\n${args.watchdogLines.map(T.wdRecord).join("\n")}\n\n` : ""}${T.taskH}

${ticket.body}

${T.finalH}

${finalText.trim() || T.noFinal}

${T.acceptH}
${accept
        ? `\n${T.acceptCmdLine(accept.cmd, accept.code)}${accept.timedOut ? T.acceptTimeoutSuffix : ""}\n\n${T.acceptTail}\n\n\`\`\`\n${accept.output}\n\`\`\`\n`
        : T.noAccept}
${testFilesSection}
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
        const cost: SessionCost = { rounds: 0, mainRounds: 0, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 0 };
        await finishTicket(task.id, `---\nid: ${task.id}\ntitle: ${task.id}\nstatus: rejected\n---\n\n${T.rejectedTitle}\n\n${parsed.error}`);
        emit(T.ticketRejected(task.id, parsed.error));
        return { status: "rejected", cost, budgetTruncated: false };
    }
    const t = parsed.ticket;
    const sessionId = `batch-${task.id}`;
    const timeoutMin = t.timeoutMin ?? 30;
    emit(`▶ [${task.id}] ${t.title}`);
    emit(T.taskMeta(t.budgetYuan, timeoutMin, t.accept));

    // 工具表裁剪：缺省禁高危（对模型不可见），工单 tools: 显式解锁。
    // ★ P1-6 声明化：工具声明 batchAllowed:false 同样收权（与名单任一命中即拒），未声明者回退名单兜底。
    const unlocked = new Set(t.tools ?? []);
    const toolSchemas = agentTools.filter((x: any) =>
        unlocked.has(x?.function?.name)
        || ((x?.function?.batchAllowed !== false) && !BATCH_DEFAULT_DENYLIST.has(x?.function?.name)));

    // 审批自动应答器：编辑类 ∪ 工单解锁 → allow-once；其余 deny + 记录（fail-closed，绝不无限等）
    const allowApproval = new Set([...BATCH_EDIT_TOOLS, ...unlocked]);
    const deniedTools: { tool: string; detail: string }[] = [];

    // ★ N5 供应链闸门（内核审查报告第三批，2026-10-20，维护者拍板：仅 batch 场景纳入）：解释器直跑
    //   仓库内脚本（node ./x.js / python x.py / 裸 tsc / make / cargo / go…）与 npm 族风险同源，历史上
    //   只走分类器、判 SAFE 即放行——挂机无人值守即静默执行。交互场景有人工在场兜底，维持零打扰
    //   （isInterpreterRepoScript 刻意不进 toolExecution 判定链）；此处包在 execute 外——只读免审/
    //   分类器放行/审批放行最终都落 execute，全路径必经零漏。命中即拒并记 deniedTools；拒绝文案回模型
    //   （可改道，但闸门一直在）。逃生门：工单 tools: 加伪槽位 "interpreter"（非真实工具，仅作为
    //   授权标记被 unlocked 集合记住；混入 allowApproval 无害——解释器命令不走 requireApproval 文案）。
    const wrapInterpreterGate = (x: any): any => {
        const name = x?.function?.name;
        if (name !== "run_command" && name !== "run_in_background") return x;
        const innerExecute = x.function.execute.bind(x.function);
        return {
            ...x,
            function: {
                ...x.function,
                execute: async (args: any, ctx: any) => {
                    const cmd = typeof args?.command === "string" ? args.command : "";
                    if (cmd && isInterpreterRepoScript(cmd) && !unlocked.has("interpreter")) {
                        const why = `🚫 [batch 供应链闸门] 解释器直跑仓库内脚本已拦截：${cmd.slice(0, 120)}。执行仓库作者提交的代码与 npm 族同源风险，挂机场景默认拒绝；确需执行请在本工单 tools: 中加 "interpreter" 解锁。`;
                        deniedTools.push({ tool: name, detail: why.replace(/\n+/g, " ").slice(0, 140) });
                        emit(`🚫 [${task.id}] 拦截解释器脚本：${cmd.slice(0, 80)}`);
                        return why;
                    }
                    return innerExecute(args, ctx);
                },
            },
        };
    };
    const gatedSchemas = toolSchemas.map(wrapInterpreterGate);

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
    // ============ 基线三态校验（§5.2.1，仅外部源工单；manual 票零改动） ============
    // setup-broken（瞬态，不缓存——重试可能就好）与 baseline-broken（当日缓存，同基座免重跑）分开报；
    // 基线红的仓库不产生任何 agent 花费——判定完成于 agent 阶段之前（结构性保证，不靠纪律）。
    // 缓存键 = 仓库根 + HEAD SHA + accept 命令：代码或验收一变即失效，不拿旧结论盖新代码。
    let setupDoneByProbe = false;
    if (t.source !== "manual") {
        emit(`🧪 [${task.id}] ${T.baselineGateNote}`);
        const repoRoot = await mainRepoRootOf(wt.path);
        const key = baselineKey(repoRoot, wt.baseSha, t.accept);
        const finishBaselineBroken = async (verdict: "baseline-broken" | "watch-suspect", probe: { code: number | null; output: string; timedOut: boolean } | null) => {
            await killBackgroundTasksUnder(wt.path).catch(() => { });
            const cost = await collectSessionCost(sessionId);
            await finishTicket(task.id, buildReport({
                id: task.id, ticket: t, status: "baseline-broken", budgetTruncated: false, cost, receipt: undefined,
                finalText: "", accept: probe ? { cmd: t.accept, code: probe.code, output: probe.output, timedOut: probe.timedOut } : null,
                deniedTools: [], diff: T.diffNone, wt, errorMessage: baselineVerdictLabel(verdict, getLocale()),
            }));
            emit(`🧪 [${task.id}] ${T.statusLabel("baseline-broken")}`);
            return { status: "baseline-broken" as const, cost, budgetTruncated: false };
        };
        const cached = await readBaselineCache(key, new Date());
        if (cached && cached.verdict !== "ok") {
            // 缓存命中且非 ok：连 setup 都不装（装了也白装），直接终止——零花费
            emit(T.baselineCachedBroken(baselineVerdictLabel(cached.verdict, getLocale())));
            return await finishBaselineBroken(cached.verdict, null);
        }
        if (!cached) {
            // 先备环境再探测（复用验收执行器：同 shell 形态/凭证剔除/超时护栏）
            if (t.setup) {
                emit(T.setupLine(t.setup));
                const s = await runAcceptCommand(t.setup, wt.path);
                if (s.code !== 0 || s.timedOut) {
                    await killBackgroundTasksUnder(wt.path).catch(() => { });
                    const msg = `${T.setupFail(t.setup, s.code)}${s.timedOut ? T.acceptTimeoutSuffix : ""}\n\n\`\`\`\n${s.output}\n\`\`\``;
                    const cost = await collectSessionCost(sessionId);
                    await finishTicket(task.id, buildReport({
                        id: task.id, ticket: t, status: "setup-failed", budgetTruncated: false, cost, receipt: undefined,
                        finalText: "", accept: null, deniedTools: [], diff: T.diffNone, wt, errorMessage: msg,
                    }));
                    emit(`🛠️ [${task.id}] ${T.setupFail(t.setup, s.code)}`);
                    return { status: "setup-failed", cost, budgetTruncated: false };
                }
                setupDoneByProbe = true; // 环境已备好，agent 阶段首轮不重跑 setup
            }
            emit(T.baselineProbeLine(t.accept));
            const probe = await runAcceptCommand(t.accept, wt.path);
            const verdict = classifyProbe({ code: probe.code ?? 1, timedOut: probe.timedOut });
            await writeBaselineCache(key, verdict, new Date());
            if (verdict !== "ok") {
                // 超时 → watch-suspect（疑似 watch/常驻，修法与普通验收失败不同），与 baseline-broken 分开报
                emit(T.baselineProbeFail(baselineVerdictLabel(verdict, getLocale())));
                return await finishBaselineBroken(verdict, { code: probe.code, output: probe.output, timedOut: probe.timedOut });
            }
            // 探测通过：撤掉测试运行弄脏的已跟踪文件（untracked 不动——node_modules 必须活着供正式验收）
            await gitSimple(["reset", "--hard"], wt.path);
            emit(T.baselineProbePass);
        } else {
            emit(T.baselineCachedOk);
        }
    }

    // ============ agent 阶段（看门狗装配 + 可选带证据重试循环，方案 §3/§6/§6.1） ============
    // 每轮独立 ac/timer（timeout-min 每轮重计）；watchdog 逐轮新建（宽限/阶梯/采样序列各自归零），
    // 证据链快照跨轮累计进 wdSnapshots。工单 retry 字段（默认 0）控制被杀后的带证据重试轮数。
    const watchdogEnabled = process.env.DEEP_SEEK_BATCH_WATCHDOG !== "0";
    const wdSnapshots: WatchdogSnapshot[] = [];
    const maxRounds = 1 + Math.min(Math.max(0, Math.floor(t.retry ?? 0)), RETRY_MAX);
    let content = t.body;
    let roundBudget = t.budgetYuan;
    let receipt: Extract<UIEvent, { type: "run.receipt" }> | undefined;
    // ★ final 全文自采：handleUnifiedChat 的契约是「正文已流式推过 delta 时 final.text 置空」（交互场景防
    //   重复显示），挂机报告要全文——累积 text.delta，final.text 仅作「首字符前终结」路径的兜底。
    let finalText = "";
    let agentError: string | undefined;
    let budgetTruncated = false;
    let wdKill: WatchdogKillInfo | null = null;
    let status: TaskStatus;
    let accept: { cmd: string; code: number | null; output: string; timedOut: boolean } | null = null;
    let imagesRead = 0; // §5.2.2 落地要求 6：read_image 调用统计进报告（人要能判断该翻案还是换模型）

    for (let round = 1; ; round++) {
        wdKill = null;
        finalText = "";
        receipt = undefined as typeof receipt; // 断言防 CFA 收窄：receipt 由 onUIEvent 回调在 try 内赋值
        agentError = undefined;
        let nudgeCount = 0;

        const roundAc = new AbortController();
        // 看门狗与 ac/timer 并排初始化（方案 §3）：nudge 复用 pushSessionInbox（inbox steering 既有
        // 通道，轮边界 claim）；kill 走 ac.abort 复用 timeout 路径，finally 清理全部照走。
        const wd = watchdogEnabled ? new BatchWatchdog({
            sessionId,
            ticketTitle: t.title,
            acceptCmd: t.accept,
            targetText: `${t.title}\n${t.body}\n${t.accept}${t.setup ? `\n${t.setup}` : ""}`,
            ac: roundAc,
            worktreePath: wt.path,
            budgetYuan: roundBudget,
            getCost: () => collectSessionCost(sessionId),
            onNudge: (text) => {
                nudgeCount++;
                pushSessionInbox(sessionId, text);
                emit(T.wdNudgeNote(task.id, nudgeCount));
            },
            onKill: (err, info) => {
                wdKill = info;
                emit(T.wdKillNote(task.id, `${info.verdict} — ${info.evidence}`));
                roundAc.abort(err);
            },
        }) : null;
        wd?.start();
        wd?.setPaused(true); // setup 命令执行期挂 PAUSED 豁免判定（事件流静默不算断流）

        // ★ 环境 setup（可选，2026-10-16 首跑教训）：worktree 是干净检出（无 node_modules 等），验收命令
        //   依赖环境时先在此备好（复用验收执行器：同 shell 形态/凭证剔除/超时护栏/输出尾部截取）。
        //   setup 失败 → 任务直接失败，不进 agent 阶段（跑了也过不了验收，白烧钱）。仅首轮（重试轮同
        //   worktree 续跑，环境已在）。外部源工单若基线探测已备好环境则不重跑（setupDoneByProbe，M4）。
        if (round === 1 && t.setup && !setupDoneByProbe) {
            emit(T.setupLine(t.setup));
            const s = await runAcceptCommand(t.setup, wt.path);
            if (s.code !== 0 || s.timedOut) {
                wd?.stop();
                const msg = `${T.setupFail(t.setup, s.code)}${s.timedOut ? T.acceptTimeoutSuffix : ""}\n\n\`\`\`\n${s.output}\n\`\`\``;
                await killBackgroundTasksUnder(wt.path).catch(() => { });
                const cost = await collectSessionCost(sessionId);
                await finishTicket(task.id, buildReport({
                    id: task.id, ticket: t, status: "setup-failed", budgetTruncated: false, cost, receipt: undefined,
                    finalText: "", accept: null, deniedTools: [], diff: T.diffNone, wt, errorMessage: msg,
                }));
                emit(`🛠️ [${task.id}] ${T.setupFail(t.setup, s.code)}`);
                return { status: "setup-failed", cost, budgetTruncated: false };
            }
        }
        wd?.setPaused(false);
        await wd?.markBaseline(); // R6 基线：setup 完成后首读（装依赖动 lockfile，基线必须后置）

        const timer = setTimeout(() => roundAc.abort(new Error(T.timeoutAbort(timeoutMin))), timeoutMin * 60_000);
        setSessionWorktree(sessionId, wt); // 重试轮重挂（上轮 finally 已摘）
        // ★ 子代理完成唤醒（agentWake，方案 §7 batch 联动）：每轮注册本任务的唤醒驱动——
        //   继承审批自动应答器 / 剩余预算 / 工单工具表（含解释器闸门）；worktree 重挂（上轮 finally 已摘）
        //   + 独立 ac/timer（round 的 timer/注册表在 finally 已清，唤醒 run 是 round 收尾后的续跑，自备环境）。
        //   汇报/结算照常进 finalText/receipt（报告与验收口径完整）；不喂看门狗（已 stop，timer+预算兜底）。
        registerWakeDriver(sessionId, async () => {
            emit(`🤖 [${task.id}] 子代理完成，唤醒 run 续跑…`);
            setSessionWorktree(sessionId, wt);
            const wakeAc = new AbortController();
            const wakeTimer = setTimeout(() => wakeAc.abort(new Error(T.timeoutAbort(timeoutMin))), timeoutMin * 60_000);
            try {
                await handleUnifiedChat(
                    { sessionId, content: AGENT_DONE_SENTINEL },
                    async () => { /* sendOutbound：sseWrite 已给，不会走到 */ },
                    (evt: any) => {
                        if (evt?.type === "text.delta") finalText += evt.text;
                        else if (evt?.type === "text.reset") finalText = "";
                        else if (evt?.type === "final") finalText = evt.text || finalText;
                        else if (evt?.type === "tool.start" && evt?.toolName === "read_image") imagesRead++;
                    },
                    wakeAc.signal,
                    {
                        requestApproval: async (detail, meta) => {
                            if (allowApproval.has(meta.toolName)) return "allow-once";
                            deniedTools.push({ tool: meta.toolName, detail: detail.replace(/\n+/g, " ").slice(0, 140) });
                            return "deny";
                        },
                        onUIEvent: (evt: UIEvent) => {
                            if (evt.type === "run.receipt") receipt = evt;
                        },
                        budgetYuan: roundBudget,
                        toolSchemas: gatedSchemas,
                    },
                );
            } finally {
                clearTimeout(wakeTimer);
                clearSessionWorktree(sessionId);
            }
        });
        try {
            await handleUnifiedChat(
                { sessionId, content },
                async () => { /* sendOutbound：sseWrite 已给，不会走到 */ },
                (evt: any) => {
                    wd?.feed(evt); // tool.start/tool.end/round.start/text.delta/thinking.delta/final 全喂
                    if (evt?.type === "text.delta") finalText += evt.text;
                    else if (evt?.type === "text.reset") finalText = ""; // 流式 stall 重试：同轮从零重生成，丢弃已累积
                    else if (evt?.type === "final") finalText = evt.text || finalText;
                    else if (evt?.type === "round.start") emit(T.roundLine(ts(), evt.round));
                    else if (evt?.type === "tool.start" && evt?.toolName === "read_image") imagesRead++;
                },
                roundAc.signal,
                {
                    requestApproval: async (detail, meta) => {
                        if (allowApproval.has(meta.toolName)) return "allow-once";
                        deniedTools.push({ tool: meta.toolName, detail: detail.replace(/\n+/g, " ").slice(0, 140) });
                        return "deny";
                    },
                    onUIEvent: (evt: UIEvent) => {
                        if (evt.type === "run.receipt") receipt = evt;
                    },
                    budgetYuan: roundBudget,
                    toolSchemas: gatedSchemas,
                },
            );
        } catch (e: any) {
            agentError = e instanceof Error ? e.message : String(e);
        } finally {
            clearTimeout(timer);
            wd?.stop();
            // ★ 立即摘 session 注册表：engine dispose 会清注册表内全部 worktree，不摘则产物 worktree 被误删
            clearSessionWorktree(sessionId);
        }
        if (wd) wdSnapshots.push(wd.snapshot());
        budgetTruncated = receipt?.budgetTruncated === true;

        // 状态判定：error/watchdog-killed/timeout 不跑验收（被杀/超时改动不完整，跑了也是噪声）；
        // 其余跑验收定 passed/accept-failed（预算截断不豁免验收——过了就是过了）。
        // watchdog 终止与 timeout 同走 abort 路径，靠 onKill 标志区分。
        if (agentError) {
            status = "error";
            emit(T.agentErrorLine(task.id, agentError));
            break;
        }
        if (wdKill) {
            // §6.1 带证据重试（工单 retry 显式 opt-in，默认杀 = 终态、worktree 保留待人工处置）：
            // 同 worktree 续跑（磁盘现状 + 半成品都在）；budget-yuan 跨轮累计共享（传剩余预算）。
            const spent = await collectSessionCost(sessionId);
            const nextBudget = sharedBudgetYuan(t.budgetYuan, spent.costYuan);
            if (round < maxRounds && (nextBudget === undefined || nextBudget > 0)) {
                emit(T.wdRetryNote(task.id, round + 1));
                content = buildRetryTaskContent(t.body, wdKill, finalText);
                roundBudget = nextBudget;
                continue;
            }
            if (round < maxRounds) emit(T.wdBudgetStopNote(task.id));
            status = "watchdog-killed";
            break;
        }
        if (roundAc.signal.aborted) {
            status = "timeout";
            emit(T.timeoutLine(task.id, timeoutMin));
            break;
        }
        // 软着陆归途：经 nudge-2 收尾汇报正常 final 的任务走正常验收判定（按成果判定，不算被杀，§7）
        // ★ agentWake 唤醒链收敛（子代理异步化）：主 round 结束后若有在飞子代理，须等「完成 → 唤醒 run
        //   →（可能再派生）……」整链安静再验收——否则验收跑到半途，唤醒 run 还在改文件，判定失真。
        //   超时（timeout-min 每轮重计语义）→ resolve(false)，按现状继续（无人值守绝不挂死）。
        const quiet = await waitSessionQuiescent(sessionId, undefined, timeoutMin * 60_000);
        if (!quiet) emit(`⏳ [${task.id}] 唤醒链未在时限内收敛，按现状验收`);
        wd?.setPaused(true); // accept 命令执行期豁免判定（§4；看门狗已 stop，防御性对齐）
        const r = await runAcceptCommand(t.accept, wt.path);
        accept = { cmd: t.accept, code: r.code, output: r.output, timedOut: r.timedOut };
        status = r.code === 0 && !r.timedOut ? "passed" : "accept-failed";
        emit(T.acceptLine(status === "passed", task.id, r.code) + (r.timedOut ? T.acceptKilledSuffix : ""));
        break;
    }

    // 善后：摘唤醒驱动（任务定态——此后完成的在飞子代理不再唤醒，inbox 保留备查；先于一切 await，
    //  防 wdKill/timeout 路径状态判定期间的完成事件在 teardown 中途拉起唤醒 run 改文件）
    unregisterWakeDriver(sessionId);
    // 杀本任务在 worktree 下遗留的后台进程（dev server 等，防跨任务端口冲突）
    // → 收尾快照提交（把改动固化到分支，跨重启不丢）→ 收割 diff → 报告
    await killBackgroundTasksUnder(wt.path).catch(() => { });
    const commit = await commitWorktreeChanges(wt, T.commitMsg(task.id, t.title));
    if (commit.committed) emit(T.commitLine(wt.branch, commit.sha));
    else if (commit.error) emit(T.commitFail(commit.error));
    const diff = await harvestDiff(wt);
    const touched = await touchedTestFiles(wt.path, wt.baseSha); // §9.8：报告列触碰的测试文件（P1 信息标注）
    const cost = await collectSessionCost(sessionId);
    await finishTicket(task.id, buildReport({
        id: task.id, ticket: t, status, budgetTruncated, cost, receipt, finalText,
        accept, deniedTools, diff, wt, commit, errorMessage: agentError,
        watchdogLines: buildWatchdogLines(wdSnapshots, cost.costYuan) ?? undefined,
        touchedTestFiles: touched.length > 0 ? touched : undefined,
        imagesRead,
    }));
    emit(`   ${T.statusLabel(status)} · ${T.costSummary(cost)}`);
    emit(T.artifactLine(wt.path, wt.branch));
    return { status, cost, budgetTruncated };
};

// ============ 等待窗口（--wait-window HH:MM-HH:MM：仅延迟启动语义；峰谷价已核实——空闲档半价，窗口对准空闲时段即半价跑批） ============

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
export const runBatchQueue = async (opts?: { waitWindow?: string; maxTotalYuan?: number }): Promise<void> => {
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
    let budgetStopped = false;
    const failedIds: string[] = [];
    try {
        for (;;) {
            // M6 总量硬闸（§5.2.3）：每票开始【前】检查——超限停在下一张票之前，绝不开跑半张票
            // （不允许跑到 accept 中途才砍）。peek 只窥视不取走：票原样留在 pending/，下批继续。
            if (opts?.maxTotalYuan !== undefined && costSum >= opts.maxTotalYuan) {
                const next = await peekNextTicket();
                if (next) {
                    emit(T.budgetStop(costSum.toFixed(4), String(opts.maxTotalYuan), next.id));
                    budgetStopped = true;
                }
                break;
            }
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
        if (!budgetStopped) emit(T.runnerQueueEmpty); // 超限首查即停：budgetStop 文案已说明，勿再报「队列空」误导
        return;
    }
    emit("");
    emit("━".repeat(56));
    emit(T.summaryDone(total, passed, `${Math.round((Date.now() - startedAt) / 6000) / 10}`));
    emit(costTasks > 0 ? T.summaryCost(costSum.toFixed(4), costTasks) : T.summaryCostFree);
    if (failedIds.length > 0) emit(`${T.failedHead}\n  ${failedIds.join("\n  ")}`);
    emit(T.artifactsDir);
};
