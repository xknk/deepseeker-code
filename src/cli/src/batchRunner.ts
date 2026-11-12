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
import { acquireRunLock, releaseRunLock, takeNextTicket, peekNextTicket, finishTicket, markTicketNeedsReview, readStopRequest, writeTicketProgress } from "@/batch/queue.ts";
import { continuationBaseBranch, continuationRepoRoot, doneTicketPath } from "@/batch/continuation.ts";
import { readRecentTickets, type RecentTicketEntry } from "@/batch/recent.ts"; // 记忆策略窄口径 ②（2026-11-12）
import { loadRepoMap, type RepoMapSection } from "@/batch/repoMap.ts"; // 记忆策略窄口径 ③（2026-11-12 定案：开工时生成或读缓存）
import { loadRepoIndex, routeRepoByRules } from "@/batch/repoRoute.ts";
import { detectAccept } from "@/batch/sync/accept.ts";
import { appendLedgerEntry } from "@/batch/ledger.ts";
import { compileTestPatterns, isTestPath } from "@/batch/sync/testpaths.ts";
import { loadSyncConfig } from "@/batch/sync/config.ts";
import { requestCardApproval } from "@/batch/feishu/approval.ts"; // P4 卡片审批（轻模块：纯 fs 协议零 SDK/LLM）
import { reportSummary } from "@/batch/feishu/notify.ts"; // C3 结论回传闸（剥代码块/封顶——推送唯一出站形态，轻模块同 approval.ts）
import { baselineKey, readBaselineCache, writeBaselineCache, classifyProbe, baselineVerdictLabel } from "@/batch/sync/baseline.ts";
import { isNonCodeDiff } from "@/batch/sync/accept.ts"; // 轻量验收（2026-11-11）：改动仅含非代码文件时跳过机器换上的整仓编译
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

/** 工单 tools: 解锁匹配（2026-11-10）：条目带尾缀 `*` 按前缀匹配——`mcp__playwright__*` 一条覆盖
 *  整个 MCP 服务的工具集（MCP 工具逐个点名=打地鼠，浏览器票实锤 8 卡）；无 `*` 条目精确匹配
 *  （`interpreter` 伪槽位语义不变）。只有尾缀 `*` 触发通配，条目中间的 `*` 仍按字面处理。 */
export const matchUnlockedTool = (name: string | undefined, entries: Iterable<string>): boolean => {
    if (!name) return false;
    for (const e of entries) {
        if (e.endsWith("*")) { if (name.startsWith(e.slice(0, -1))) return true; }
        else if (e === name) return true;
    }
    return false;
};

/** N5 供应链闸门包装工厂（runOneTask 内 wrapInterpreterGate 的实现体，独立导出配协议单测）：
 *  拦截分支 yield 拒绝文案后 return；放行分支 yield* 委托原 execute。run_command/run_in_background
 *  的 execute 是 async generator——包装若用普通 async 函数返回 generator 对象，执行器判非流式把
 *  generator JSON.stringify（{}），命令明明执行成功模型只见空壳+假「缺少退出码哨兵」失败
 *  （2026-11-10 w7ez 真机 3 连试全空壳实锤；同 9bda588 直答 wrapReadOnlyRunCommand 的教训）。 */
export const makeInterpreterGateWrapper = (opts: {
    unlocked: Set<string>;
    onDeny: (tool: string, cmd: string, why: string) => void;
}) => (x: any): any => {
    const name = x?.function?.name;
    if (name !== "run_command" && name !== "run_in_background") return x;
    const innerExecute = x.function.execute.bind(x.function);
    return {
        ...x,
        function: {
            ...x.function,
            execute: async function* (args: any, ctx: any) {
                const cmd = typeof args?.command === "string" ? args.command : "";
                if (cmd && isInterpreterRepoScript(cmd) && !opts.unlocked.has("interpreter")) {
                    const why = `🚫 [batch 供应链闸门] 解释器直跑仓库内脚本已拦截：${cmd.slice(0, 120)}。执行仓库作者提交的代码与 npm 族风险同源，挂机场景默认拒绝；确需执行请在本工单 tools: 中加 "interpreter" 解锁。`;
                    opts.onDeny(name, cmd, why);
                    yield why;
                    return;
                }
                yield* innerExecute(args, ctx);
            },
        },
    };
};

/** batch 工具策略单一真相源（runOneTask 装配与全量矩阵测试共用，2026-11-10）：
 *  可见性 = 精确/通配解锁 ∪（声明未收权 batchAllowed≠false 且 不在缺省禁用清单）；
 *  审批自动放行 = 编辑类白名单 ∪ 精确/通配解锁（放行者不问，其余按 SAFETY 等级走卡片/夜间自动拒）。 */
export const buildBatchToolPolicy = (unlockedEntries: Iterable<string>): {
    unlocked: Set<string>;
    isVisible: (schema: any) => boolean;
    isApprovalAllowed: (name: string) => boolean;
} => {
    const unlocked = new Set(unlockedEntries);
    return {
        unlocked,
        isVisible: (schema: any): boolean =>
            matchUnlockedTool(schema?.function?.name, unlocked)
            || ((schema?.function?.batchAllowed !== false) && !BATCH_DEFAULT_DENYLIST.has(schema?.function?.name)),
        isApprovalAllowed: (name: string): boolean =>
            BATCH_EDIT_TOOLS.has(name) || matchUnlockedTool(name, unlocked),
    };
};
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

/**
 * 测试路径启发式扩展（§9-8 P2）：sync.json testPathPatterns 编译结果，每 run 由 runBatchQueue
 * 装载一次（sync.json 不存在/非法时为空 = 只用内建启发式，降级安全）。模块级传递——runOneTask
 * 签名保持稳定，批内所有任务共用同一配置快照（一次 run 内不漂移）。
 */
let extraTestPatterns: RegExp[] = [];

/** git 只跑短命令（shell:false，无注入面）；失败返回 null（探测/列举失败不致命）。 */
const gitSimple = (args: string[], cwd: string): Promise<string | null> =>
    new Promise((resolve) => {
        const child = spawn("git", args, { cwd, windowsHide: true, shell: false });
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => chunks.push(d));
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code === 0 ? decodeProcessOutput(Buffer.concat(chunks)).trim() || null : null));
    });

// ============ 跨仓路由 accept/setup 适配（纯函数，守门测试直接验证） ============

/** npm 族命令形状（含 Windows 可执行后缀变体）：首 token 是 npm/pnpm/yarn/npx/node/bun 才算。 */
const NPM_FAMILY_CMD = /^(?:npm|pnpm|yarn|npx|node|bun)(?:\.cmd|\.exe)?(?:\s|$)/;

/**
 * 跨仓票的 accept/setup 适配（2026-11-10）：只动「在目标仓结构性必失败」的命令——目标仓没有
 * package.json 时 npm 族命令必失败（ij9q 实锤：npm run typecheck + pnpm install 落在 Java 仓）。
 * accept 换成目标仓探测结果（探测不出则保留原样，基线三态校验会诚实报告）；setup 直接丢弃
 * （白装依赖）。目标仓有 package.json（同为 node 仓）或命令本就不是 npm 族（mvn / test -f /
 * make…外部或手写的显式命令）→ 一律原样保留，绝不擅自替换。
 */
export const adaptCommandsForTargetRepo = (args: {
    accept: string; setup?: string; targetHasPackageJson: boolean; detectedAccept?: string;
}): { accept: string; setup?: string; acceptAdaptedFrom?: string; setupDropped?: string } => {
    const npmShaped = (cmd?: string): boolean => !!cmd && NPM_FAMILY_CMD.test(cmd.trim());
    let accept = args.accept;
    let setup = args.setup;
    let acceptAdaptedFrom: string | undefined;
    let setupDropped: string | undefined;
    if (!args.targetHasPackageJson) {
        if (npmShaped(args.accept) && args.detectedAccept && args.detectedAccept !== args.accept) {
            acceptAdaptedFrom = args.accept;
            accept = args.detectedAccept;
        }
        if (npmShaped(setup)) {
            setupDropped = setup;
            setup = undefined;
        }
    }
    return { accept, setup, acceptAdaptedFrom, setupDropped };
};

/** 主仓库根（缓存键的「仓库」维度）：从 worktree 反查 common dir 的父目录。 */
const mainRepoRootOf = async (wtPath: string): Promise<string> => {
    const common = await gitSimple(["rev-parse", "--git-common-dir"], wtPath);
    return common ? path.dirname(path.resolve(wtPath, common)) : process.cwd();
};

/** diff 相对 baseSha 的已改动文件清单（harvestDiff 同口径：全量已暂存）→ 过滤测试路径（内建 ∪ sync.json 扩展，与 sync 共用 core 事实源）。 */
const touchedTestFiles = async (wtPath: string, baseSha: string): Promise<string[]> => {
    const out = await gitSimple(["diff", "--cached", "--name-only", baseSha], wtPath);
    if (!out) return [];
    return out.split("\n").map((s) => s.trim()).filter(Boolean).filter((f) => isTestPath(f, extraTestPatterns));
};

/** 报告 frontmatter changed-file 清单封顶：超出部分不丢信息——末尾一条省略行带余量。 */
const CHANGED_FILE_CAP = 30;

/** 报告 frontmatter denied-tool 清单封顶（B2 完成推送拒清单的数据源）：同 changed-file 口径，末尾省略行带余量。
 *  行形态 `denied-tool: <tool> — <detail>`（detail 已在留痕时拍平换行）；notify 侧解析按「 — 」分隔符识别，
 *  省略行不含分隔符自然滤除。 */
const DENIED_FM_CAP = 20;

/**
 * `git diff --cached --numstat <baseSha>` 原始输出 → changed-file 行（改动清单交接，2026-11-05 打磨第一批）。
 * 行形态 `<+N>\t<-M>\t<path>`；二进制行是 `-	-	<path>` → 渲染 `(binary)`；改名 `{old => new}` 按 git 原样。
 * 纯函数（无 IO），导出供守门测试直接验证。
 */
export const numstatToChangedFiles = (raw: string): string[] =>
    raw.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
        const cols = line.split("\t");
        const file = cols.pop() ?? "?";
        const added = cols[0] ?? "-";
        const removed = cols[1] ?? "-";
        const counts = added === "-" && removed === "-" ? "(binary)" : `(+${added}/-${removed})`;
        return `${file} ${counts}`;
    });

/**
 * 票 body 尾部附录（记忆策略窄口径 ①+②+③，2026-11-12，纯函数——守门测试直接验证）：
 *  段序钉死：③ 仓库地图（稳定结构事实）→ ② 同仓近况（近期事件）→ ① 蒸馏引导（收尾指令恒为最末段）。
 *  - ③ 仓库地图段（map 非空才渲染，缺省 null = 整段省略、零注入幂等）：repoMap 缓存正文
 *    （白名单数据行 pkg:/scripts:/…，确定性提取——零主观总结）+ batchStrings 散文包装；
 *  - ② 同仓近况段（有历史票才渲染，零历史 = 整段省略）：done/ 报告 frontmatter 摘录
 *    （id/标题/状态/分支四字段，readRecentTickets 所得——报告正文/diff/文件清单永不进此段）；
 *  - ① 蒸馏引导段（每票必有）：收尾前判断「跨票可复用」的坑/事实 → memory_save 沉淀一条。
 *    只是提示词引导，不强制、无任何强制机制（没写不算失败）。
 *
 * 红线：本函数产物只准追加在票 body 尾部（repoBodyNote 之后、恒为 body 最末段），绝不进
 * system 首槽——首槽逐字节稳定是跨 run 前缀缓存命中的硬约束（守门测试按字面扫描本文件，
 * 故本注释也不得出现该槽位的代码字面）。
 */
export const buildBodyAppendix = (recent: RecentTicketEntry[], map: RepoMapSection | null = null): string => {
    const T = batchT(getLocale());
    const parts: string[] = [];
    if (map) {
        parts.push(T.repoMapNoteH(map.repoName, map.sha8));
        parts.push(map.body);
    }
    if (recent.length > 0) {
        parts.push(T.recentNoteH(recent.length));
        parts.push(...recent.map((e) => T.recentLine(e.id, e.title, e.status, e.branch)));
    }
    parts.push(T.distillNote);
    return parts.join("\n");
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
    finalText: string; accept: { cmd: string; code: number | null; output: string; timedOut: boolean; skipped?: boolean } | null;
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
    /** 改动清单（numstatToChangedFiles 所得；写进报告 frontmatter changed-file:，续修票注入用。空/缺省不写行）。 */
    changedFiles?: string[];
    /** 跨仓路由的目标仓库根（2026-11-10）：非空 → 落 frontmatter repo:（续修票经 continuationRepoRoot 继承——
     *  前次产物分支只在该仓库存在，落回基座 = 成果丢失）。基座票缺省不写行（旧报告无此行 = 基座，兼容）。 */
    repoRoot?: string | null;
}): string => {
    const { id, ticket, status, budgetTruncated, cost, receipt, finalText, accept, deniedTools, diff, wt } = args;
    const T = batchT(getLocale());
    const budgetNote = budgetTruncated ? T.budgetTruncNote : "";
    const testFilesSection = args.touchedTestFiles?.length
        ? `\n${T.testFilesH}\n\n${T.testFilesNote(args.touchedTestFiles.length)}\n${args.touchedTestFiles.map((f) => `- \`${f}\``).join("\n")}\n`
        : "";
    // 改动清单 frontmatter 段（封顶 30，超出末尾省略行带余量——清单是 git 产出的事实，不丢只截）。
    const changed = args.changedFiles ?? [];
    const changedFm = changed.length === 0 ? "" : changed.slice(0, CHANGED_FILE_CAP).map((f) => `changed-file: ${f}\n`).join("")
        + (changed.length > CHANGED_FILE_CAP ? `changed-file: ${T.changedMore(changed.length - CHANGED_FILE_CAP)}\n` : "");
    // 被拒清单 frontmatter 段（B2，2026-11-09）：deniedTools 此前只进报告正文——手机推送拿不到，
    // 「票为什么没干完」在飞书上无着落。落 frontmatter 供 writeFinishNotification 解析进推送。
    const denied = args.deniedTools ?? [];
    const deniedFm = denied.length === 0 ? "" : denied.slice(0, DENIED_FM_CAP).map((d) => `denied-tool: ${d.tool} — ${d.detail}\n`).join("")
        + (denied.length > DENIED_FM_CAP ? `denied-tool: ${T.deniedMore(denied.length - DENIED_FM_CAP)}\n` : "");
    // C3 结论回传（2026-11-10「指挥台」）：finalText 经外发摘要闸（剥代码块/内联反引号、折叠空白、
    // 200 封顶）落 frontmatter summary: —— writeFinishNotification 解析进完成推送，手机直接看结论；
    // 红线不动：diff/代码体/凭证/验收原始输出照旧只留报告里（reportSummary 是结论唯一出站形态）。
    const summaryText = reportSummary(finalText ?? "", 200);
    const summaryFm = summaryText ? `summary: ${summaryText}\n` : "";
    return `---
id: ${id}
title: ${ticket.title}
status: ${status}
cost-yuan: ${cost.costYuan !== null ? cost.costYuan.toFixed(4) : "?"}
rounds: ${cost.rounds}
budget-truncated: ${budgetTruncated}
${ticket.needsReview ? "needs-review: true\n" : ""}session: batch-${id}
worktree: ${wt?.path ?? T.notCreated}
branch: ${wt?.branch ?? T.notCreated}
${args.repoRoot ? `repo: ${args.repoRoot.replace(/\\/g, "/")}\n` : ""}${ticket.continues ? `continues: ${ticket.continues}\n` : ""}${deniedFm}${changedFm}${summaryFm}---

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
        ? accept.skipped
            ? `\n${T.acceptSkippedLine(accept.cmd)}\n`
            : `\n${T.acceptCmdLine(accept.cmd, accept.code)}${accept.timedOut ? T.acceptTimeoutSuffix : ""}\n\n${T.acceptTail}\n\n\`\`\`\n${accept.output}\n\`\`\`\n`
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

    // C4 早停检查（2026-11-10「指挥台」）：点火竞态——listen 的「停」可能在 runner 起跑前已落盘
    //（票刚被取走转 running，人看到「跑批中」就喊停）。此处命中 → 不建 worktree 不进 agent，
    // 零花费 stopped 收尾（finishTicket 会顺手清走 stop/progress 协议文件）。
    if (await readStopRequest(task.id)) {
        emit(`🛑 [${task.id}] ${T.stopRequestNote}`);
        const cost: SessionCost = { rounds: 0, mainRounds: 0, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 0 };
        await finishTicket(task.id, buildReport({
            id: task.id, ticket: t, status: "stopped", budgetTruncated: false, cost, receipt: undefined,
            finalText: "", accept: null, deniedTools: [], diff: T.diffNone, wt: null,
            errorMessage: T.stoppedEarlyNote,
        }));
        emit(`   ${T.statusLabel("stopped")}`);
        return { status: "stopped", cost, budgetTruncated: false };
    }

    // 工具表裁剪：缺省禁高危（对模型不可见），工单 tools: 显式解锁。
    // ★ P1-6 声明化：工具声明 batchAllowed:false 同样收权（与名单任一命中即拒），未声明者回退名单兜底。
    // ★ 通配解锁（2026-11-10 b00s 实锤）：MCP 工具逐个点名=打地鼠——浏览器一张票实际调
    //   navigate/snapshot/click/wait_for/resize… 多种，票面只解 4 个名字 → 手机 72 秒连弹 8 张
    //   审批卡。tools: 条目带尾缀 * 按前缀匹配（`mcp__playwright__*` 一条解锁整个 playwright
    //   服务），语义=「这张票允许用这个 MCP 服务」；无 * 条目保持精确匹配（含 interpreter 伪槽位）。
    const unlocked = new Set(t.tools ?? []);
    const policy = buildBatchToolPolicy(unlocked);
    const toolSchemas = agentTools.filter((x: any) => policy.isVisible(x));
    const deniedTools: { tool: string; detail: string }[] = [];
    // ★ 同票同工具审批记忆（2026-11-10 b00s 实锤）：卡片路径每次调用一张卡——browser_click 连点 5 次
    //   = 5 张卡，是磨损式轰炸。人在卡片上点过一次 allow/deny 即票内终身生效：allow → 后续同工具
    //   直接放行；deny → 后续直接拒（同时堵死「反复弹卡把人磨到随手批准」）。只记卡片路径的人工
    //   决定，窗口期 auto-deny 不入册；跨重试轮共享（与 deniedTools 同款任务级作用域）。
    const cardDecisions = new Map<string, "allow-once" | "deny">();

    // ★ N5 供应链闸门（内核审查报告第三批，2026-10-20，维护者拍板：仅 batch 场景纳入）：解释器直跑
    //   仓库内脚本（node ./x.js / python x.py / 裸 tsc / make / cargo / go…）与 npm 族风险同源，历史上
    //   只走分类器、判 SAFE 即放行——挂机无人值守即静默执行。交互场景有人工在场兜底，维持零打扰
    //   （isInterpreterRepoScript 刻意不进 toolExecution 判定链）；此处包在 execute 外——只读免审/
    //   分类器放行/审批放行最终都落 execute，全路径必经零漏。命中即拒并记 deniedTools；拒绝文案回模型
    //   （可改道，但闸门一直在）。逃生门：工单 tools: 加伪槽位 "interpreter"（非真实工具，仅作为
    //   授权标记被 unlocked 集合记住；混入 allowApproval 无害——解释器命令不走 requireApproval 文案）。
    // ★ 流式协议透传（2026-11-10 w7ez 实锤，同 9bda588 直答教训）：run_command/run_in_background 的
    //   execute 是 async generator，包装必须同为 async generator + yield* 委托——此前普通 async 函数
    //   返回 generator 对象，执行器判非流式把 generator JSON.stringify（{}），命令明明执行成功模型
    //   只见空壳+假「缺少退出码哨兵」失败（真机 3 连试全空壳）。工厂独立导出配协议单测
    //   （wrapReadOnlyRunCommand 同款形态）。
    const wrapInterpreterGate = makeInterpreterGateWrapper({
        unlocked,
        onDeny: (tool, cmd, why) => {
            deniedTools.push({ tool, detail: why.replace(/\n+/g, " ").slice(0, 140) });
            emit(`🚫 [${task.id}] 拦截解释器脚本：${cmd.slice(0, 80)}`);
        },
    });
    const gatedSchemas = toolSchemas.map(wrapInterpreterGate);

    // ============ 跨仓路由（2026-11-10 真机实锤 ij9q 引发） ============
    // 工单指向基座之外的仓库（「在 lg-pms 项目生成 test 文件」）时，从目标仓库（而非基座）开
    // worktree——agent 工作区围栏随 worktree 走，目标仓文件天然可写、验收也在目标仓跑。两层判定：
    //  1) 续修票：继承前票报告 repo:（前次产物分支只存在于那仓库，落回基座 = 前次修复成果丢失）；
    //  2) 规则路由（repoRoute.ts，零 LLM）：仓库索引 + 复合标识符 + 邻近词护栏，任一不过 → 基座
    //     （现行为 fail-safe——ij9q 之前所有票都是这么跑的，路由失败不比现状差）。
    // 路由命中外部仓时顺手适配 accept/setup（只动目标仓结构性必失败的 npm 族命令，见
    // adaptCommandsForTargetRepo），并在 body 尾部补跨仓执行说明（agent 需知道工作区即目标仓）。
    let repoRoot: string | null = null;
    let routedRepoName = "";
    let acceptAdapted = false;
    if (t.continues) {
        const prevRepo = await continuationRepoRoot(t.continues);
        if (prevRepo && path.resolve(prevRepo) !== path.resolve(process.cwd())) {
            repoRoot = prevRepo;
            routedRepoName = path.basename(prevRepo);
            emit(`🧭 [${task.id}] ${T.repoInherit(t.continues, prevRepo)}`);
        }
    } else {
        try {
            const index = await loadRepoIndex();
            const r = routeRepoByRules(`${t.title}\n${t.body}`, index, process.cwd());
            if (r.repo) {
                repoRoot = r.repo.dir;
                routedRepoName = r.repo.name;
                emit(`🧭 [${task.id}] ${T.repoRouted(r.repo.name, r.matchedIdent ?? "?", r.repo.dir)}`);
            }
        } catch (e: any) {
            emit(`⚠️ [${task.id}] 跨仓路由索引构建失败（回退基座仓执行）：${e?.message ?? e}`);
        }
    }
    if (repoRoot) {
        const targetHasPkg = fs.existsSync(path.join(repoRoot, "package.json"));
        let detectedAccept: string | undefined;
        if (!targetHasPkg) {
            const d = await detectAccept(repoRoot, getLocale());
            if (d.ok && d.accept) detectedAccept = d.accept;
        }
        const adapted = adaptCommandsForTargetRepo({ accept: t.accept, setup: t.setup, targetHasPackageJson: targetHasPkg, detectedAccept });
        if (adapted.acceptAdaptedFrom) {
            emit(`🧭 [${task.id}] ${T.repoAcceptAdapted(adapted.acceptAdaptedFrom, adapted.accept)}`);
            t.accept = adapted.accept;
            t.needsReview = true; // 验收命令被 runner 换过（本地探测来源）→ 与探测票同口径强制人工复核
            acceptAdapted = true;
        }
        if (adapted.setupDropped) {
            emit(`🧭 [${task.id}] ${T.repoSetupDropped(adapted.setupDropped)}`);
            t.setup = undefined;
        }
        t.body = t.body + T.repoBodyNote(routedRepoName);
    }

    // ③ 仓库地图（2026-11-12 定案修订：取票开工时生成或读缓存——原方案「某 SHA 首张票跑完时
    // 收尾生成」有算术问题：地图按 SHA 键控而仓库提交频繁，绝大多数票都是该 SHA 的第一张，
    // 收尾生成等于绝大多数票享受不到；开工时生成则首票即受益。确定性提取是纯 fs/git 读，
    // 毫秒级，不拖慢开工）。★ 位置红线：路由定型【后】才读——repoRoot 决定读哪个仓（基座票
    // = 基座仓 process.cwd()）；fail-safe：非 git 仓 / HEAD 取不到 / 提取失败 → null 零注入不拦票。
    let repoMap: RepoMapSection | null = null;
    try {
        repoMap = await loadRepoMap({ repoRoot: repoRoot ?? process.cwd() });
    } catch { /* fail-safe：地图缺失零注入，成本回到现状 */ }
    if (repoMap) emit(`🗺️ [${task.id}] ${T.mapInjected(repoMap.sha8, repoMap.fromCache)}`);

    // ①+② 记忆策略窄口径（2026-11-12）：同仓近况注入 + 蒸馏引导，一并追加在 body 尾部
    //（repoBodyNote 之后，附录恒为 body 最末段；附录内段序钉死：③地图 → ②近况 → ①蒸馏）。
    // ★ 位置红线：必须在路由定型【后】执行——
    // 近况段含历史票标题（可能提到其他仓名），若拼在路由前会被 routeRepoByRules 的标识符
    // 匹配扫到，历史票标题就能把本票误路由。★ 桶回落（方案 ① 的 ★ 坑）经查证无须 runner 迁移：
    // memory_save 的落盘路径（memoryFilePath）钉在全局目录/进程启动目录（= 基座仓，批处理全程
    // 不 chdir），不经活动工作区（getActiveCwd）——worktree 激活时写记忆也落在基座桶/全局，
    // worktree 删除零损失；该不变量由 core/tests/batch-memory-bucket.test.ts 钉死防回归。
    let recentTickets: RecentTicketEntry[] = [];
    try {
        recentTickets = await readRecentTickets({ repoRoot }); // done/ 报告 frontmatter 确定性提取（零检索零 LLM）
    } catch { /* fail-safe：近况缺失不致命，零注入回落现状 */ }
    t.body = t.body + buildBodyAppendix(recentTickets, repoMap);
    if (recentTickets.length > 0) emit(`📰 [${task.id}] ${T.recentInjected(recentTickets.length)}`);

    // worktree：改动隔离 + 产物载体（非 git 项目在此失败 → error 报告，继续下一任务）。
    // ★ stepId 用任务全局唯一 id（不用 "batch" 常量）：worktree 保留策略下分支常驻，而 manager 的
    //   分支名 = dsc-wt-<sessionId 前 8>-<stepId>，batch-* 会话前 8 位全是 "batch-20"——常量 stepId
    //   会让第二个任务必撞名（冒烟已抓到）。任务 id 含时间戳+随机 → 分支唯一且可溯源。
    let wt: WorktreeHandle | null = null;
    try {
        // P2 续修链（§6.2）：代码基座 = 前票产物分支（前次修复已在树里，不从 main 重做）。
        // 分支解析不出（前票未跑完/报告丢失/分支已被删）→ 回退 HEAD 并在控制台注明——宁可基座退化，
        // 不能让续修票卡死在建 worktree 这一步。分支解析锚定仓 = 跨仓路由仓（前次分支在那仓库）。
        let baseRef = "HEAD";
        if (t.continues) {
            const prevBranch = await continuationBaseBranch(t.continues);
            if (prevBranch) {
                const verify = await gitSimple(["rev-parse", "--verify", "--quiet", `refs/heads/${prevBranch}`], repoRoot ?? process.cwd());
                if (verify !== null) {
                    baseRef = prevBranch;
                    emit(`🌿 [${task.id}] ${T.contBaseNote(prevBranch)}`);
                } else {
                    emit(`⚠️ [${task.id}] ${T.contBaseFallback(t.continues, T.contBaseBranchGone(prevBranch))}`);
                }
            } else {
                emit(`⚠️ [${task.id}] ${T.contBaseFallback(t.continues, T.contBaseNoBranch)}`);
            }
        }
        wt = await createWorktree(sessionId, task.id, baseRef, repoRoot ?? undefined);
    } catch (e: any) {
        const msg = T.wtCreateFail(e?.message ?? e);
        const cost = await collectSessionCost(sessionId);
        await finishTicket(task.id, buildReport({
            id: task.id, ticket: t, status: "error", budgetTruncated: false, cost, receipt: undefined,
            finalText: "", accept: null, deniedTools: [], diff: T.diffNone, wt: null, errorMessage: msg, repoRoot,
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
        const baselineRepoRoot = await mainRepoRootOf(wt.path); // worktree 顶层（跨仓票=目标仓检出，键随仓隔离）
        const key = baselineKey(baselineRepoRoot, wt.baseSha, t.accept);
        const finishBaselineBroken = async (verdict: "baseline-broken" | "watch-suspect", probe: { code: number | null; output: string; timedOut: boolean } | null) => {
            await killBackgroundTasksUnder(wt.path).catch(() => { });
            const cost = await collectSessionCost(sessionId);
            await finishTicket(task.id, buildReport({
                id: task.id, ticket: t, status: "baseline-broken", budgetTruncated: false, cost, receipt: undefined,
                finalText: "", accept: probe ? { cmd: t.accept, code: probe.code, output: probe.output, timedOut: probe.timedOut } : null,
                deniedTools: [], diff: T.diffNone, wt, errorMessage: baselineVerdictLabel(verdict, getLocale()), repoRoot,
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
                        finalText: "", accept: null, deniedTools: [], diff: T.diffNone, wt, errorMessage: msg, repoRoot,
                    }));
                    emit(`🛠️ [${task.id}] ${T.setupFail(t.setup, s.code)}`);
                    return { status: "setup-failed", cost, budgetTruncated: false };
                }
                setupDoneByProbe = true; // 环境已备好，agent 阶段首轮不重跑 setup
            }
            emit(T.baselineProbeLine(t.accept));
            let probe = await runAcceptCommand(t.accept, wt.path);
            let verdict = classifyProbe({ code: probe.code ?? 1, timedOut: probe.timedOut });
            if (verdict !== "ok") {
                // 迟滞复测：单轮红可能是测试负载 flake（白天用机实锤，间歇性 ~40%，红用例每次还不同）；
                // 一红就写「今日已验不通过」缓存会把全天票全部堵死（真机踩过：08:36 一轮 flake 毒化一整天）。
                // 隔 30s 复测一次，二次红才定罪——真红仓库两连红只是晚 30s，flake 误伤被吸收。
                emit(T.baselineProbeRetrying);
                await new Promise((r) => setTimeout(r, 30_000));
                probe = await runAcceptCommand(t.accept, wt.path);
                verdict = classifyProbe({ code: probe.code ?? 1, timedOut: probe.timedOut });
            }
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
    let userStop = false; // C4 软停标志：listen「停」→ stop 文件 → 工具/轮边界查获 → abort 干净收尾（不杀进程）
    let status: TaskStatus;
    let accept: { cmd: string; code: number | null; output: string; timedOut: boolean; skipped?: boolean } | null = null;
    let imagesRead = 0; // §5.2.2 落地要求 6：read_image 调用统计进报告（人要能判断该翻案还是换模型）
    const agentStartedAt = new Date().toISOString(); // C4 进度心跳 startedAt（「进度」算已跑时长用）

    for (let round = 1; ; round++) {
        wdKill = null;
        finalText = "";
        receipt = undefined as typeof receipt; // 断言防 CFA 收窄：receipt 由 onUIEvent 回调在 try 内赋值
        agentError = undefined;
        let nudgeCount = 0;

        const roundAc = new AbortController();
        // C4 软停巡检 + 进度心跳（2026-11-10「指挥台」）：stop 文件 = 跨进程协议文件（listen 的「停」
        //  写、runner 读），在 round.start/tool 边界查获——软停不杀进程：roundAc.abort 走 runAgent
        //  轮边界干净收尾（结算照走、改动照提交，分支保全）。重试轮不摘 stop 文件：停就是停，重试也停。
        const checkStop = (): void => {
            if (userStop) return;
            void readStopRequest(task.id).then((req) => {
                if (!req || userStop) return;
                userStop = true;
                emit(`🛑 [${task.id}] ${T.stopRequestNote}`);
                roundAc.abort(new Error(T.stopAbortReason));
            }).catch(() => { });
        };
        const writeProgress = (roundNo: number, activity: string): void => {
            const nowIso = new Date().toISOString();
            void writeTicketProgress({
                ticketId: task.id, pid: process.pid, round: roundNo, activity,
                since: nowIso, startedAt: agentStartedAt, updatedAt: nowIso,
            }).catch(() => { });
        };
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
        // ★ P4 飞书卡片审批叠加（§5）：白名单外的高危审批先试卡片路径——listen 存活（心跳保鲜 +
        //   canApprove）才落 pending 等点卡（30min 超时 = deny，fail-closed）；不存活 → 立即 deny +
        //   记录（现状路径，零输出零回归）。等待期挂看门狗 PAUSED（同 setup 语义：卡片等待最长
        //   30min 无事件，R3 断流判定会误杀）。批准 = allow-once 单次生效，不改 allowApproval 白名单。
        // ★ B1（2026-11-09 飞书拆软闸门）：挂机窗口内不推卡——半夜无人点卡，30min 空等 = 注定拒绝；
        //   直接走自动应答器（deny + deniedTools 留痕 + 会话继续、票不死，agent 绕路）。判定与
        //   分叉收在 batchApprovalRoute 纯函数（守门测试钉窗口内外两形态）。
        const requestApprovalWithCard = async (detail: string, meta: { toolName: string }): Promise<"allow-once" | "deny"> => {
            const route = batchApprovalRoute({ unlocked: policy.isApprovalAllowed(meta.toolName), windowActive: inWaitWindow(activeWaitWindow, nowMinutes()) });
            if (route === "auto-deny") {
                deniedTools.push({ tool: meta.toolName, detail: detail.replace(/\n+/g, " ").slice(0, 140) }); // 与卡片拒绝同一留痕口径，绝不静默吞
                emit(`🌙 [${task.id}] ${T.windowAutoDeny(meta.toolName)}`);
                return "deny";
            }
            if (route === "allow-once") return "allow-once";
            // ★ 同票同工具记忆命中：卡片批过/拒过一次的工具不再重复弹卡（b00s 8 卡教训的第二刀）。
            const remembered = cardDecisions.get(meta.toolName);
            if (remembered === "allow-once") {
                emit(`♻️ [${task.id}] ${T.cardRememberedAllow(meta.toolName)}`);
                return "allow-once";
            }
            if (remembered === "deny") {
                deniedTools.push({ tool: meta.toolName, detail: detail.replace(/\n+/g, " ").slice(0, 140) });
                emit(`♻️ [${task.id}] ${T.cardRememberedDeny(meta.toolName)}`);
                return "deny";
            }
            wd?.setPaused(true);
            let card: "allow-once" | "deny";
            try {
                card = await requestCardApproval({
                    tool: meta.toolName,
                    detail,
                    ticketId: task.id,
                    ticketTitle: t.title,
                    locale: getLocale(),
                    out: (l) => emit(`📮 [${task.id}] ${l}`),
                });
            } finally {
                wd?.setPaused(false);
            }
            cardDecisions.set(meta.toolName, card); // 人工决定入册：同票后续调用直接按此执行
            if (card === "allow-once") return "allow-once";
            deniedTools.push({ tool: meta.toolName, detail: detail.replace(/\n+/g, " ").slice(0, 140) });
            return "deny";
        };
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
                    finalText: "", accept: null, deniedTools: [], diff: T.diffNone, wt, errorMessage: msg, repoRoot,
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
                        else if (evt?.type === "round.start" || evt?.type === "tool.end") {
                            // C4 唤醒 run 同受软停管束（stop 文件查获 → 置标志 + 断唤醒 ac；
                            // 主 roundAc 已停，状态判定统一走 userStop 分支）
                            if (!userStop) {
                                void readStopRequest(task.id).then((req) => {
                                    if (!req || userStop) return;
                                    userStop = true;
                                    emit(`🛑 [${task.id}] ${T.stopRequestNote}`);
                                    wakeAc.abort(new Error(T.stopAbortReason));
                                }).catch(() => { });
                            }
                        }
                    },
                    wakeAc.signal,
                    {
                        requestApproval: requestApprovalWithCard, // 唤醒续跑同款：wd 已 stop，setPaused 为无害空转
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
                    else if (evt?.type === "round.start") {
                        emit(T.roundLine(ts(), evt.round));
                        writeProgress(evt.round, T.progressThinking); // C4 进度心跳（「进度」控制词读）
                        checkStop();
                    } else if (evt?.type === "tool.start") {
                        if (evt?.toolName === "read_image") imagesRead++;
                        writeProgress(typeof evt?.round === "number" ? evt.round : round, String(evt?.toolName ?? ""));
                        checkStop();
                    } else if (evt?.type === "tool.end") {
                        checkStop(); // 工具边界查停：工具执行完再断（不打断半截工具，软停约定）
                    }
                },
                roundAc.signal,
                {
                    requestApproval: requestApprovalWithCard,
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
        // C4 软停判定（置于 wdKill 之前：人喊停优先于看门狗带证据重试——停了就不再续跑烧钱；
        // 与 timeout 同族不跑验收，改动不完整，分支照提交保全，报告照出）。
        if (userStop) {
            status = "stopped";
            emit(T.stopAcceptedLine(task.id));
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
        // 轻量验收（2026-11-11「建个 txt 也等 20 分钟编译」）：仅当验收命令是跨仓适配机器换上的
        //（acceptAdapted——票面/配置显式写的验收永不豁免）且实际改动仅含非代码文件时跳过整仓编译。
        // 以实际 diff 为准不信票面文本：agent 跑偏动了代码 → 照常全量验收。白名单方向性见 accept.ts
        //（未知扩展名按代码处理——漏放行只是多跑编译，误放行是漏验）。
        let acceptSkipped = false;
        let r: { code: number | null; output: string; timedOut: boolean };
        if (acceptAdapted) {
            // ★ 先 add -A 再 --cached numstat（harvestDiff 同口径，manager.ts「确保新文件也被纳入」）：
            //   门在收尾提交【前】跑，agent 新建的 test.txt 这类文件还是 untracked——裸 diff 看不见 →
            //   空清单 → 分类器 false → 门关死照跑全量编译（028v 真机实锤：报告 exit 0、门没开、
            //   target 10:15:12 指纹=验收期第二次编译）。add -A 幂等：收尾提交随后自己再 add -A。
            await gitSimple(["add", "-A"], wt.path);
            const preNumstat = await gitSimple(["-c", "core.quotepath=false", "diff", "--cached", "--numstat", wt.baseSha], wt.path);
            const changedPaths = (preNumstat ?? "").split("\n").map((l) => l.split("\t")[2]).filter(Boolean);
            if (isNonCodeDiff(changedPaths)) {
                acceptSkipped = true;
                r = { code: 0, output: "", timedOut: false };
                emit(`⚡ [${task.id}] ${T.acceptLightLine}`);
            } else {
                r = await runAcceptCommand(t.accept, wt.path);
            }
        } else {
            r = await runAcceptCommand(t.accept, wt.path);
        }
        // 迟滞复测：与基线探测同款。单轮红可能是测试负载 flake（真机实锤 2026-11-09：README 已修好，
        // 却被 listen 家族 flake 的单轮红判「验收未通过」，假阴性推给了用户手机）——二次红才定罪。
        // （轻量放行路径 code=0 恒真，天然不进复测。）
        if (!acceptSkipped && ((r.code ?? 1) !== 0 || r.timedOut)) {
            emit(T.acceptProbeRetrying);
            await new Promise((resolve) => setTimeout(resolve, 30_000));
            r = await runAcceptCommand(t.accept, wt.path);
        }
        accept = { cmd: t.accept, code: r.code, output: r.output, timedOut: r.timedOut, skipped: acceptSkipped || undefined };
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
    // 改动清单采集（2026-11-05 打磨第一批）：收尾提交已入索引，diff --cached 对 baseSha 仍见全量
    // （与 touchedTestFiles 同位置同口径）；固化进报告 frontmatter changed-file:，续修票免重新探索。
    // core.quotepath=false：中文等非 ASCII 路径不被 git 转成 \344\270\255 八进制转义串（清单要人可读）。
    const changedNumstat = await gitSimple(["-c", "core.quotepath=false", "diff", "--cached", "--numstat", wt.baseSha], wt.path);
    const changedFiles = changedNumstat ? numstatToChangedFiles(changedNumstat) : undefined;
    // §9-8 P2 动作半边（长牙齿）：验收通过但触碰了测试路径 → 票标 needs-review（报告 fm + 票档
    // 双写）——`batch pr` 见标记一律拒绝。报告侧由 ticket.needsReview 渲染 fm，票档在 finishTicket
    // 搬入 done/ 之后补标（markTicketNeedsReview 只动 frontmatter，幂等）。
    let downgraded = false;
    if (status === "passed" && touched.length > 0 && !t.needsReview) {
        t.needsReview = true;
        downgraded = true;
    }
    const cost = await collectSessionCost(sessionId);
    await finishTicket(task.id, buildReport({
        id: task.id, ticket: t, status, budgetTruncated, cost, receipt, finalText,
        accept, deniedTools, diff, wt, commit, errorMessage: agentError,
        watchdogLines: buildWatchdogLines(wdSnapshots, cost.costYuan) ?? undefined,
        touchedTestFiles: touched.length > 0 ? touched : undefined,
        imagesRead,
        changedFiles,
        repoRoot,
    }));
    if (downgraded || acceptAdapted) {
        // 票档同步补标 needs-review（报告 fm 由 t.needsReview 渲染；此处把搬入 done/ 的票档也对齐，
        // 供 batch pr 拒绝与人工复核看到同一体征——与测试触碰降级同款补标路径）。
        await markTicketNeedsReview(doneTicketPath(task.id)).catch(() => { });
    }
    if (downgraded) {
        emit(`⚠️ [${task.id}] ${T.downgradedNote(touched.length)}`);
    }
    emit(`   ${T.statusLabel(status)} · ${T.costSummary(cost)}`);
    emit(T.artifactLine(wt.path, wt.branch));
    return { status, cost, budgetTruncated };
};

// ============ 等待窗口（--wait-window HH:MM-HH:MM：延迟启动语义 + B1 卡片压制；峰谷价已核实——空闲档半价，窗口对准空闲时段即半价跑批） ============

/**
 * 当前时刻是否在挂机窗口内（B1 卡片压制的判定核心）。窗口可跨午夜（23:00-07:00 → startMin > endMin）：
 * waitUntilWindow 只管「等下一起点」不判窗内时刻，本判定必须判对——跨段窗的凌晨时刻要落在窗内。
 * 边界：起点含、终点不含（与 waitUntilWindow 的 now >= startMin && now < endMin 同口径）。
 */
export const inWaitWindow = (w: { startMin: number; endMin: number } | null, nowMin: number): boolean => {
    if (!w) return false;
    return w.startMin < w.endMin
        ? nowMin >= w.startMin && nowMin < w.endMin
        : nowMin >= w.startMin || nowMin < w.endMin;
};

/**
 * 审批路由三分叉（B1，2026-11-09 飞书拆软闸门）。纯函数——判定与 IO 分离，守门测试直接验证：
 *  - unlocked（编辑类 ∪ 工单 tools 显式解锁）→ allow-once（既有自动应答器语义，一个字不改）；
 *  - 窗口生效（--wait-window 已配且当前时刻在窗内）→ auto-deny：半夜无人点卡，卡片路径 30min 超时
 *    等于「注定拒绝的空等」（5 张高危票/晚 ≈ 2.5h 吞吐损失，占 6h 窗口 40%）——直接 deny +
 *    deniedTools 留痕（同卡片拒绝的记录口径，绝不静默吞），会话继续、票不死，agent 绕路；
 *  - 其余 → card（既有卡片路径，白天/人在场的运行）。
 */
export const batchApprovalRoute = (args: { unlocked: boolean; windowActive: boolean }): "allow-once" | "auto-deny" | "card" =>
    args.unlocked ? "allow-once" : args.windowActive ? "auto-deny" : "card";

/** runBatchQueue 写入、runOneTask→requestApprovalWithCard 读取（模块级：与 extraTestPatterns 同款装配态）。 */
let activeWaitWindow: { startMin: number; endMin: number } | null = null;

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
    activeWaitWindow = window; // B1：窗口态供 requestApprovalWithCard 压卡（finally 复位防跨 run 残留）

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
    // §9-8：测试路径启发式扩展装载（每 run 一次快照；sync.json 不存在/非法 → 只用内建清单）
    try {
        const cfg = await loadSyncConfig({ locale: getLocale() });
        if (cfg.ok && cfg.config.testPathPatterns?.length) {
            extraTestPatterns = compileTestPatterns(cfg.config.testPathPatterns);
            emit(T.testPatternsNote(cfg.config.testPathPatterns.length));
        }
    } catch { /* 无 sync.json：纯 manual 用法，正常态 */ }
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
        activeWaitWindow = null; // B1：run 结束即复位（同进程再 run 不带 --wait-window 时不得继承压卡态）
        await releaseRunLock();
        // P2 账本（§5.2.3 注）：每 run 一行（零任务也落——定时器节奏可见）；账本失败只提示不影响结果。
        try {
            await appendLedgerEntry({ at: new Date().toISOString(), tickets: total, green: passed, red: total - passed, costYuan: Number(costSum.toFixed(4)) });
        } catch (e: any) {
            emit(`⚠️ ${T.ledgerFail(String(e?.message ?? e))}`);
        }
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
