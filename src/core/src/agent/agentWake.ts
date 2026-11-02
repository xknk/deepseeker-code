/**
 * @file agent/agentWake.ts
 * @description ★ 子代理完成唤醒（路径 B，方案《子代理异步化与完成唤醒》§4.2-4.3）：
 *  spawn_agent / run_workflow 异步化后，子代理完成事件经本模块回流主会话——
 *  - 结构化汇报推入主会话 inbox（主 run 在跑 → 轮边界 claim 自然消化，零新代码）；
 *  - 主 run 已结束（idle）→ 程序化启动新一轮唤醒 run（经宿主注册的 in-process 驱动函数）。
 *
 *  核心不变式（测试钉死于 tests/agent-async-wake.test.ts）：
 *  - 风暴防护：同主会话唤醒排队串行（busyRuns 单飞 + wakeQueued 合并）——多个子代理同时完成
 *    → 多条 inbox 消息合并进同一次唤醒 run（claimSessionInbox 整队取走）；
 *  - 空转防护：唤醒 run 纯确认无动作不产生新完成事件 → wakeQueued 不再非空 → 链路自然收敛；
 *  - 中止语义：用户中止唤醒 run 只断本轮交付（子代理产物以磁盘态为准）；完成回调挂在 spawn
 *    工具的 generator 尾部，宿主中止时执行层 gen.return() 拦在 await 前 → 不产生唤醒；
 *  - 缓存纪律：唤醒 run 首条消息（sentinel）与 inbox 注入都是「既有前缀之后追加」，不重排历史。
 *
 *  设计边界（有意取舍，勿当缺口）：
 *  - 唤醒驱动是宿主职责：CLI/VSCode/batch 各自 registerWakeDriver 注入自己的 runOnce 形态
 *    （继承审批通道/预算/UI 标识）；core 只在 serve 场景兜底注册 headless 驱动（见 chatProcessing）；
 *  - busyRuns 只统计 handleUnifiedChat 驱动的主 run（子 run 由 runSubagent 内核驱动，不经宿主入口）；
 *  - 无驱动时唤醒丢弃、inbox 保留（下一条用户消息的 run 第一轮 claim，永不丢失）。
 */
import { pushSessionInbox } from "./inbox.ts";
import { appendMessage } from "@/session/transcript.ts";

/** 唤醒哨兵：唤醒 run 的首条 user 消息（回放可读性准绳——transcript 里一眼看懂「主 agent 为何自己开始说话」）。
 *  ★ 措辞刻意避开 nudge 启发式的实现动词/对象词表（agentNudges.looksComplex）——哨兵不该诱导 PLAN_FIRST。 */
export const AGENT_DONE_SENTINEL =
    "⟦DSC:AGENT-DONE⟧ 子代理完成唤醒：本会话刚注入了子代理完成汇报（见相邻消息），请逐条消化汇报内容并继续推进主任务；若无待续事项，简要确认即可。";

/** 子代理完成汇报的正文截断上限（方案 §4.2：~4KB；超长截断 + 追问提示）。 */
export const SUBAGENT_REPORT_MAX_CHARS = 4096;

/** 唤醒驱动：宿主注入的「程序化续 run」入口（如 CLI/VSCode 的 runOnce(SENTINEL)、batch 的带自动应答器续跑）。
 *  契约：调用即启动一轮 run；busy/串行判定由本模块 pumpWake 负责，驱动内不必自查。 */
export type WakeDriver = () => Promise<void>;

const wakeDrivers = new Map<string, WakeDriver>();
const wakeQueued = new Set<string>();
const busyRuns = new Set<string>();
/** 在飞子代理归属表（parent sessionId → 子会话 id 集）：waitSessionQuiescent 的收敛判据之一。 */
const inFlightByParent = new Map<string, Set<string>>();
/** quiescence 等待者（batch 轮末等唤醒链收敛用）。 */
const quiesceWaiters = new Map<string, Set<() => void>>();

// ============ 宿主驱动注册 ============

/** 注册/刷新会话的唤醒驱动（宿主每轮 run 注册一次，闭包持有最新 opts 引用形态）。 */
export const registerWakeDriver = (sessionId: string, driver: WakeDriver): void => {
    if (!sessionId) return;
    wakeDrivers.set(sessionId, driver);
};

/** 仅当未注册时注册（serve 等 core 兜底驱动用；不覆盖宿主显式驱动）。 */
export const registerWakeDriverIfAbsent = (sessionId: string, driver: WakeDriver): void => {
    if (!sessionId || wakeDrivers.has(sessionId)) return;
    wakeDrivers.set(sessionId, driver);
};

/** 摘除驱动（batch 任务定态后调用：此后完成的在飞子代理不再唤醒，inbox 保留备查）。 */
export const unregisterWakeDriver = (sessionId: string): void => {
    wakeDrivers.delete(sessionId);
};

// ============ run 生命周期 busy 标记（handleUnifiedChat 入口/出口调用） ============

export const markRunStart = (sessionId: string): void => {
    if (!sessionId) return;
    busyRuns.add(sessionId);
};

/** run 结束：摘 busy + 泵一次唤醒（排队中的完成事件在此兑付）。 */
export const markRunEnd = (sessionId: string): void => {
    if (!sessionId) return;
    busyRuns.delete(sessionId);
    pumpWake(sessionId);
    notifyQuiesceWaiters(sessionId);
};

export const isRunBusy = (sessionId: string): boolean => busyRuns.has(sessionId);

// ============ 唤醒泵（串行队列 + 合并） ============

/**
 * 泵唤醒：queued 且 idle 且有驱动 → 同步占用 busyRuns（先于任何 await——封死「驱动已派发、
 * run 未标记 busy」窗口内的二次并发唤醒）→ 异步驱动（fire-and-forget，异常仅告警）。
 * 在跑 → 不动（轮边界自然消化 inbox；run 结束 markRunEnd 再泵）。
 */
const pumpWake = (sessionId: string): void => {
    if (!wakeQueued.has(sessionId)) return;
    if (busyRuns.has(sessionId)) return;
    wakeQueued.delete(sessionId);
    const driver = wakeDrivers.get(sessionId);
    if (!driver) return; // 无驱动：唤醒丢弃，inbox 保留待下次 run
    busyRuns.add(sessionId);
    void (async () => {
        try {
            await driver();
        } catch (e: any) {
            console.warn(`⚠️ [agentWake] 唤醒 run 异常（已忽略，链路继续收敛）: ${e?.message ?? e}`);
        } finally {
            busyRuns.delete(sessionId);
            notifyQuiesceWaiters(sessionId);
            pumpWake(sessionId); // 串行队列：驱动期间新排队的完成事件在此接续（一次一个）
        }
    })();
};

/** 排一次唤醒（wakeQueued 合并去重；立即尝试泵）。 */
const scheduleWake = (sessionId: string): void => {
    if (!sessionId || wakeQueued.has(sessionId)) return;
    wakeQueued.add(sessionId);
    pumpWake(sessionId);
    notifyQuiesceWaiters(sessionId);
};

/**
 * 撤销挂起的唤醒（runAgent 轮边界 claim 到非空 inbox 后调用）：完成汇报已由**本 run 在跑消化**，
 * run 结束时不得再泵一次空唤醒（否则每个派过子代理的 run 尾部都会多一次「纯确认」空轮）。
 * claim 之后新到达的完成事件经 notifySubagentDone 重新排队，互不干扰。
 */
export const clearQueuedWake = (sessionId: string): void => {
    wakeQueued.delete(sessionId);
};

// ============ 完成事件回流（§4.2） ============

/**
 * 子代理/工作流完成 → 结构化汇报推入主会话 + 唤醒编排。
 * 传输通道：优先 inbox（主 run 在跑 → 轮边界 claim；inbox steering 关闭/队满 → 回退直落 transcript，
 * 下轮 buildContextMessages 自然带入——两通道都不重排既有前缀，缓存纪律不破）。
 */
export const notifySubagentDone = async (parentSessionId: string, report: string): Promise<void> => {
    if (!parentSessionId || !report) return;
    const delivered = pushSessionInbox(parentSessionId, report);
    if (!delivered) {
        try {
            await appendMessage({ sessionId: parentSessionId, role: "user", content: report } as any);
        } catch { /* transcript 落盘失败不击垮唤醒编排（inbox 通道在时本分支不走） */ }
    }
    scheduleWake(parentSessionId);
};

/**
 * 完成汇报文案（方案 §4.2 形态；测试钉死）。status 来自 SubagentResult.status（subagent.ts）。
 */
export const buildSubagentDoneReport = (
    agentId: string,
    taskBrief: string,
    result: { status?: "final" | "aborted" | "error"; output: string },
): string => {
    const status = result.status ?? (result.output ? "final" : "error");
    const statusLabel = status === "final" ? "final（正常完成）" : status === "aborted" ? "aborted（被中止）" : "error（异常）";
    const over = result.output.length > SUBAGENT_REPORT_MAX_CHARS;
    const body = over ? result.output.slice(0, SUBAGENT_REPORT_MAX_CHARS) : result.output;
    return [
        `🤖 [子代理完成] 🆔 ${agentId}${taskBrief ? `（${taskBrief}）` : ""}`,
        `状态：${statusLabel}`,
        `汇报：`,
        body,
        over ? `\n（⚠️ 汇报超长已截断至 ${SUBAGENT_REPORT_MAX_CHARS} 字符；完整内容可 spawn_agent 传 resume_session_id="${agentId}" 追问。）` : "",
    ].filter((s) => s !== "").join("\n");
};

// ============ 在飞子代理归属 + quiescence 原语（batch 轮末等唤醒链收敛） ============

export const trackSubagentInFlight = (parentSessionId: string, subSessionId: string): void => {
    if (!parentSessionId) return;
    let set = inFlightByParent.get(parentSessionId);
    if (!set) { set = new Set(); inFlightByParent.set(parentSessionId, set); }
    set.add(subSessionId);
};

/** 在飞子代理完成（runPreparedSubagent 的 finally 调用）：撤归属表 + 唤醒 quiescence 等待者。 */
export const releaseSubagentInFlight = (parentSessionId: string, subSessionId: string): void => {
    const set = inFlightByParent.get(parentSessionId);
    if (!set) return;
    set.delete(subSessionId);
    if (set.size === 0) inFlightByParent.delete(parentSessionId);
    notifyQuiesceWaiters(parentSessionId);
};

const notifyQuiesceWaiters = (sessionId: string): void => {
    const waiters = quiesceWaiters.get(sessionId);
    if (!waiters || waiters.size === 0) return;
    for (const w of [...waiters]) w();
};

/** 会话是否已安静（无在飞子代理、无在跑 run、无排队唤醒）。 */
const isQuiescent = (sessionId: string): boolean =>
    !(inFlightByParent.get(sessionId)?.size) && !busyRuns.has(sessionId) && !wakeQueued.has(sessionId);

/**
 * 等待会话唤醒链收敛（batch 用）：在飞子代理 → 完成唤醒 → 唤醒 run → （可能再派生）……直至安静。
 * 超时/中止 → resolve(false)（调用方按现状继续，绝不挂死无人值守队列）。
 * @returns true=已安静；false=超时或中止
 */
export const waitSessionQuiescent = (sessionId: string, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> => {
    if (isQuiescent(sessionId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (onAbort) signal?.removeEventListener("abort", onAbort);
            const set = quiesceWaiters.get(sessionId);
            if (set) { set.delete(check); if (set.size === 0) quiesceWaiters.delete(sessionId); }
            resolve(ok);
        };
        const check = () => { if (isQuiescent(sessionId)) finish(true); };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => finish(false);
        if (!quiesceWaiters.has(sessionId)) quiesceWaiters.set(sessionId, new Set());
        quiesceWaiters.get(sessionId)!.add(check);
        if (signal) {
            if (signal.aborted) { finish(false); return; }
            signal.addEventListener("abort", onAbort, { once: true });
        }
        if (timeoutMs != null && timeoutMs > 0) timer = setTimeout(() => finish(false), timeoutMs);
        check(); // 等待者注册与状态变更之间的竞态兜底（同步复查一次）
    });
};

// ============ 测试辅助 ============

/** 清空全部编排状态（仅测试用：进程级 Map/Set 跨用例隔离）。 */
export const resetWakeStateForTest = (): void => {
    wakeDrivers.clear();
    wakeQueued.clear();
    busyRuns.clear();
    inFlightByParent.clear();
    quiesceWaiters.clear();
};
