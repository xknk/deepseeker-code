/**
 * @file cli/src/batchWatchdog.ts
 * @description 挂机批处理看门狗·动作政策层（进展感知，成本信任链补充环）：判定层已上收 core
 *  （agent/stallDetector.ts 的 StallDetector：状态+采样+R1-R6+健康短路+tick 循环），本文件消费
 *  每 tick 的 StallEvaluation——batch 特有的三级动作状态机（.ai-docs/Batch看门狗进展感知方案.md）。
 *
 *  两级判定：程序规则（detector 零成本每 tick 全量）→ 小模型裁决（有嫌疑才花钱，AUX 通道复用
 *  压缩辅助模型，非流式、不进主会话上下文；裁决任务书与输出解析在本层）。三级动作：nudge-1 纠偏
 *  → nudge-2 最后通牒（收尾汇报 + 冻结窗口）→ 第三次非 normal 才 abort（复用 timeout 的 abort
 *  路径）。R3 断流是唯一不经 nudge 直接杀的规则（卡死场景喊话听不见）——nudge 后经 setSuppressUntil
 *  映射为 detector 抑制窗（宽限期内不再判定）。
 *
 *  防误杀三重设计：起步/nudge 后宽限期；规则命中还须小模型确认（R3 除外）；任何降级
 *  （AUX 网络/超时/非法 JSON/自身异常）一律判 normal——看门狗自己坏，不能变成误杀器。
 *
 *  公开 API（opts 字段名与方法签名）是 batchRunner 装配的红线，一个不改。
 */
import { StallDetector, R1_WINDOW_MIN, R3_SILENCE_MIN, type StallEvaluation } from "@/agent/stallDetector.ts";

// ============ 动作层常量（判定层阈值常量在 stallDetector.ts） ============

const MIN = 60_000;
/** nudge 后宽限（分钟）：给模型纠正时间，期内不再判定（映射 detector 抑制窗）。 */
const NUDGE_GRACE_MIN = 5;
/** 收尾冻结窗口（分钟）：nudge-2 后动作冻结，防模型收尾汇报途中被杀（batch 方案 §6）。 */
const FREEZE_MIN = 5;
/** 杀令阈值（连续非 normal 次数）：1→nudge-1 纠偏、2→nudge-2 最后通牒、3→abort（nudge 上限 2，batch 方案 §6）。 */
const KILL_STRIKES = 3;
/** AUX 裁决超时（毫秒）：对齐 classifyRisk 形态，裁决不能悬着。 */
const AUX_TIMEOUT_MS = 60_000;
/** retry 次数上限（工单解析侧同步校验 0-3）：重试是双倍烧钱的口子，必须封顶。 */
export const RETRY_MAX = 3;

// ============ 模型可见文案（喂给模型的 nudge / 重试前置锚——模型双语皆可，此处从 batch 方案 §6 原文） ============

/** nudge-1【纠偏】：第一次非 normal。evidence 为自带时间状语的完整证据子句。 */
export const NUDGE_1 = (evidence: string): string =>
    `⚠️ [watchdog] ${evidence}。若在原地打转请换思路或收尾；若判断有误请继续并说明理由。`;
/** nudge-2【最后通牒·收尾汇报】：第二次非 normal，随后进入收尾冻结窗口。 */
export const NUDGE_2 = (clause: string): string =>
    `⛔ [watchdog] 再次判定：${clause}。请立即停止探索，在 2-3 轮内收尾：总结已完成 / 未完成 / 卡点与建议，作为最终答复。`;
/** 重试轮首条 task 前置锚：强制换思路（不换思路的重试是白烧，batch 方案 §6.1）。 */
export const RETRY_PREAMBLE = (verdict: string, evidence: string, finalDigest: string): string =>
    `【系统提示】上次尝试被 watchdog 终止（判定 ${verdict}：${evidence}）。上轮收尾前产出摘要：${finalDigest || "（无）"}。请换思路，勿重复上次路径。\n\n---\n\n`;
/** 二层裁决任务书（总量控制 ~3K token：轨迹只读类合并计数、args 摘要截 120 字）。 */
export const ADJUDICATE_PROMPT = (args: { title: string; accept: string; costLine: string; rules: string; trajectory: string }): string =>
    `你是批处理编码任务的看门狗。判断任务是否在空转（idle：反复读同一批文件/换姿势搜同一东西）或方向偏离（offtrack：写入落点与任务目标无关）；正常推进（含正当的长时间只读调研）判 normal。只输出严格 JSON：{"verdict":"normal|idle|offtrack","evidence":"一句话证据（引用轨迹中的具体事件）"}

[任务目标] ${args.title}
验收命令：${args.accept}
[消耗] ${args.costLine}
[规则信号]
${args.rules}
[最近轨迹（10 分钟）]
${args.trajectory}`;

/** 二层输出解析：容忍围栏/散文夹带，取首个 {...}；非法或缺字段 → null（调用方降级 normal）。 */
export const parseVerdictJson = (raw: string): { verdict: "normal" | "idle" | "offtrack"; evidence: string } | null => {
    const m = /\{[\s\S]*\}/.exec(raw ?? "");
    if (!m) return null;
    try {
        const j = JSON.parse(m[0]);
        const v = String(j?.verdict ?? "").trim().toLowerCase();
        if (v !== "normal" && v !== "idle" && v !== "offtrack") return null;
        return { verdict: v, evidence: String(j?.evidence ?? "").trim() };
    } catch { return null; }
};

// ============ 裁决与预算的缺省实现（可注入；测试注入 mock，不打真 API） ============

/** AUX 非流式裁决：复用压缩辅助模型通道（chatWithModelWithSummary，DEEP_SEEK_AUX_MODEL 可换档）。
 *  动态 import——测试注入 auxAdjudicate 时零 LLM 栈加载。任何异常上抛由调用方降级 normal。 */
const defaultAdjudicate = async (prompt: string, signal: AbortSignal): Promise<string> => {
    const { chatWithModelWithSummary } = await import("@/llm/model.ts");
    const resp = await chatWithModelWithSummary([{ role: "user", content: prompt }], [], { signal });
    return resp?.choices?.[0]?.message?.content ?? "";
};

/** 二级动作的总预算共享（batch 方案 §6.1）：budget-yuan 是工单级总额，重试轮传「剩余预算」续用现有 run 级熔断。 */
export const sharedBudgetYuan = (budgetYuan: number | undefined, spentYuan: number | null): number | undefined => {
    if (budgetYuan === undefined) return undefined;
    return Math.max(0, Math.round((budgetYuan - (spentYuan ?? 0)) * 10000) / 10000);
};

// ============ 看门狗本体（政策层：持 StallDetector + 消费 onEvaluation） ============

/** 终止证据（进报告与重试前置锚）。 */
export interface WatchdogKillInfo { verdict: string; rule: string; evidence: string }
/** 报告证据链条目（kind → batchStrings 对应渲染函数）。 */
export interface WatchdogRecord {
    kind: "suspicion" | "verdict" | "nudge" | "health" | "aux-fail" | "kill";
    at: number;
    level?: number;
    verdict?: string;
    evidence?: string;
    text?: string;
}
/** 快照：runner 聚合进报告（跨重试轮累计）。 */
export interface WatchdogSnapshot {
    kill: WatchdogKillInfo | null;
    records: WatchdogRecord[];
    roundsAtKill: number;
}

export interface BatchWatchdogOpts {
    sessionId: string;
    /** 工单标题（二层裁决任务书）。 */
    ticketTitle: string;
    /** accept 验收命令原文（二层裁决任务书）。 */
    acceptCmd: string;
    /** R5 目标路径提取源文本（工单标题+正文+accept+setup）。 */
    targetText: string;
    /** 任务 abort 控制器：kill 走 ac.abort（复用 timeout 路径），AUX 裁决信号联动。 */
    ac: AbortController;
    /** worktree 路径（R6 每 tick 跑 git diff --numstat）。 */
    worktreePath: string;
    /** 工单预算（R4 判据；undefined=不限，R4 关闭）。 */
    budgetYuan?: number;
    /** 成本采样（缺省不采样、R4 关闭）；runner 接 collectSessionCost。 */
    getCost?: () => Promise<{ costYuan: number | null; rounds: number } | null>;
    /** nudge 出口（runner 接 pushSessionInbox——inbox steering 既有通道，零新代码）。 */
    onNudge: (text: string) => void;
    /** 终止出口：runner 据此置 watchdog-killed 标志并 ac.abort(err)。 */
    onKill: (err: Error, info: WatchdogKillInfo) => void;
    /** 二层裁决（可注入 mock；缺省走 AUX 深度seek辅助模型）。 */
    auxAdjudicate?: (prompt: string, signal: AbortSignal) => Promise<string>;
    /** R6 diff 采样（可注入假采样；缺省 worktree 内真 git）。 */
    sampleDiff?: () => Promise<{ net: number; newFiles: string[] } | null>;
    /** 时钟（可注入假时钟；缺省 Date.now）。 */
    now?: () => number;
    /** 调度器（可注入；缺省 setInterval）。 */
    schedule?: (fn: () => void, ms: number) => () => void;
    /** 判定周期毫秒（缺省 60s）。 */
    intervalMs?: number;
}

export class BatchWatchdog {
    private readonly opts: BatchWatchdogOpts;
    private readonly now: () => number;
    private readonly detector: StallDetector;

    /** 连续非 normal 计数（normal 裁决/健康短路清零）。 */
    private streak = 0;
    /** 收尾冻结窗口截止（nudge-2 后 FREEZE_MIN 分钟内动作冻结——采样/R3 照常，二层不调）。 */
    private freezeUntil = 0;
    private readonly records: WatchdogRecord[] = [];
    private killInfo: WatchdogKillInfo | null = null;

    constructor(opts: BatchWatchdogOpts) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.detector = new StallDetector({
            worktreePath: opts.worktreePath,
            targetText: opts.targetText,
            budgetYuan: opts.budgetYuan,
            getCost: opts.getCost,
            sampleDiff: opts.sampleDiff,
            now: opts.now,
            schedule: opts.schedule,
            intervalMs: opts.intervalMs,
            onEvaluation: (e) => this.consume(e), // promise 会被 detector tick await（AUX 裁决 tick 内完成）
        });
    }

    /** 启动旁观者心跳。判定在解除暂停前不会真正开始（setup 执行期挂 PAUSED，batch 方案 §4）。 */
    start(): void { this.detector.start(); }

    stop(): void { this.detector.stop(); }

    /** 暂停判定（setup/accept 命令执行期豁免）；解除时对齐事件时钟并重置起步宽限。 */
    setPaused(p: boolean): void { this.detector.setPaused(p); }

    /** R6 基线：setup 完成后取首个读数（装依赖动 lockfile，故基线后置 + 排除 lockfile）。 */
    markBaseline(): Promise<void> { return this.detector.markBaseline(); }

    feed(evt: any): void { this.detector.feed(evt); }

    /** 判定一步（测试可直接驱动；生产由 scheduler 每 tick 调）。自身异常绝不外泄。 */
    async tick(): Promise<void> { return this.detector.tick(); }

    /** 终止证据快照（runner 据此置 watchdog-killed 与重试前置锚）。 */
    getKill(): WatchdogKillInfo | null { return this.killInfo; }

    /** 报告证据链快照（跨重试轮由 runner 聚合）。 */
    snapshot(): WatchdogSnapshot {
        return { kill: this.killInfo, records: [...this.records], roundsAtKill: this.detector.round };
    }

    // —— 求值消费：StallEvaluation → batch 动作（与影子政策是同一结果的两种消费，方案 §3） ——

    private async consume(e: StallEvaluation): Promise<void> {
        if (e.skipped) return; // 起步宽限 / nudge 抑制窗：不判定不采样不记录
        if (e.silenceMin !== null) {
            // R3 断流：唯一直杀（卡死场景 nudge 进不去——轮边界不来）
            this.kill({ verdict: "stall", rule: "R3", evidence: `断流：${R3_SILENCE_MIN} 分钟无任何事件（agent 可能已卡死）` });
            return;
        }
        if (e.health) {
            this.streak = 0;
            this.records.push({ kind: "health", at: e.t, text: e.health });
            return;
        }
        if (e.strong.length === 0) {
            if (e.weak.length > 0) this.records.push({ kind: "suspicion", at: e.t, text: e.weak.map((r) => `${r.rule} ${r.evidence}`).join("；") });
            return; // 弱信号单独命中：只记录不动作（纯调研工单本来就该长时间只读）
        }
        if (e.t < this.freezeUntil) {
            this.records.push({ kind: "suspicion", at: e.t, text: `收尾冻结窗口内（nudge-2 后 ${FREEZE_MIN} 分钟），仅记录：${e.strong.map((r) => r.rule).join("+")}` });
            return; // 冻结期跳过二层调用：防模型收尾汇报途中被杀
        }

        // 二层：小模型裁决（有嫌疑才花钱）；任何异常/非法输出降级 normal
        const verdict = await this.adjudicate(e);
        if (verdict === null) {
            this.records.push({ kind: "aux-fail", at: e.t });
            return;
        }
        if (verdict.verdict === "normal") {
            this.streak = 0;
            this.records.push({ kind: "verdict", at: e.t, verdict: "normal", evidence: verdict.evidence });
            return;
        }
        this.streak += 1;
        this.records.push({ kind: "verdict", at: e.t, verdict: verdict.verdict, evidence: verdict.evidence });
        if (this.streak >= KILL_STRIKES) {
            this.kill({
                verdict: verdict.verdict,
                rule: e.strong.map((r) => r.rule).join("+"),
                evidence: `${verdict.evidence}（连续 ${this.streak} 次非 normal）`,
            });
            return;
        }
        this.nudge(this.streak, verdict.verdict, verdict.evidence, e.t);
    }

    /** 二层裁决。返回 null = 调用失败/非法输出（降级 normal，绝不误杀）。 */
    private async adjudicate(e: StallEvaluation): Promise<{ verdict: string; evidence: string } | null> {
        const costLine = await this.costLine(e.t);
        const prompt = ADJUDICATE_PROMPT({
            title: this.opts.ticketTitle,
            accept: this.opts.acceptCmd,
            costLine,
            rules: [
                ...e.strong.map((r) => `${r.rule}（强）：${r.evidence}`),
                ...e.weak.map((r) => `${r.rule}（弱，仅参考）：${r.evidence}`),
            ].join("\n") || "（无）",
            trajectory: this.trajectory(e.t),
        });
        try {
            const raw = await (this.opts.auxAdjudicate ?? defaultAdjudicate)(prompt, this.auxSignal());
            return parseVerdictJson(raw);
        } catch {
            return null; // AUX 网络/超时/中止等任何异常 → 判 normal（看门狗自身故障不得变成误杀器，batch 方案 §12）
        }
    }

    /** AUX 调用信号：任务 abort 或 60s 超时，先到先停（对齐 classifyRisk 合并信号形态）。 */
    private auxSignal(): AbortSignal {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), AUX_TIMEOUT_MS);
        (timer as any).unref?.();
        this.opts.ac.signal.addEventListener("abort", () => { clearTimeout(timer); ac.abort(); }, { once: true });
        return ac.signal;
    }

    private async costLine(t: number): Promise<string> {
        const cost = await this.detector.sampleCost();
        const mins = Math.round((t - this.detector.activeAtMs) / MIN);
        const rounds = cost?.rounds ?? this.detector.round;
        const yuan = cost?.costYuan;
        return `已用时 ${mins} 分钟 · 轮数 ${rounds}` + (yuan != null ? ` · 花费 ¥${yuan.toFixed(4)}` : "");
    }

    /** 最近 10 分钟轨迹（二层任务书）：只读类按工具合并计数，写入类逐条带 args 摘要。 */
    private trajectory(t: number): string {
        const recent = this.detector.callsWithin(t, R1_WINDOW_MIN * MIN);
        if (recent.length === 0) return "（无工具调用）";
        const readonlyCounts = new Map<string, number>();
        const lines: string[] = [];
        for (const c of recent) {
            if (!c.isReadonly) {
                lines.push(`- ${c.toolName}${c.target ? ` → ${c.target}` : ""}（${c.argsDigest}）`);
                continue;
            }
            readonlyCounts.set(c.toolName, (readonlyCounts.get(c.toolName) ?? 0) + 1);
        }
        for (const [tool, n] of readonlyCounts) lines.push(`- ${tool} ×${n}（只读）`);
        return lines.join("\n").slice(0, 2400);
    }

    private nudge(streak: number, verdict: string, evidence: string, t: number): void {
        const text = streak === 1 ? NUDGE_1(evidence) : NUDGE_2(`${verdict}：${evidence}`);
        this.records.push({ kind: "nudge", at: t, level: streak, text });
        this.detector.setSuppressUntil(t + NUDGE_GRACE_MIN * MIN); // nudge 后宽限 = detector 抑制窗
        if (streak === 2) this.freezeUntil = t + FREEZE_MIN * MIN; // 收尾冻结窗口
        try { this.opts.onNudge(text); } catch { /* nudge 出口故障不影响判定循环 */ }
    }

    private kill(info: WatchdogKillInfo): void {
        if (this.killInfo) return; // 幂等：R3 与三级动作竞态时先到先杀
        this.killInfo = info;
        this.records.push({ kind: "kill", at: this.now(), verdict: info.verdict, evidence: `${info.rule} ${info.evidence}` });
        this.detector.stop();
        try { this.opts.onKill(new Error(`watchdog: ${info.verdict} — ${info.evidence}`), info); } catch { /* 出口异常不回灌 */ }
    }
}

// ============ 重试装配（batch 方案 §6.1，runner 消费；纯函数便于守门测试） ============

/** 重试轮首条 task：前置「上次被终止」证据段（强制换思路锚）+ 原任务正文。 */
export const buildRetryTaskContent = (body: string, kill: WatchdogKillInfo, finalText: string): string =>
    RETRY_PREAMBLE(kill.verdict, kill.evidence, finalText.trim().replace(/\s+/g, " ").slice(0, 400)) + body;
