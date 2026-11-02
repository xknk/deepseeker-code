/**
 * @file core/src/agent/stallDetector.ts
 * @description 空转判定层（看门狗与政策层分离，.ai-docs/交互空转影子模式方案.md §3/§4）：自
 *  cli/batchWatchdog.ts 抽取的状态 + 采样 + R1-R6 规则 + 健康短路 + tick 循环——每 tick 产出
 *  StallEvaluation 交 onEvaluation 回调（政策层）。batch 三级动作（cli/batchWatchdog.ts）与
 *  交互影子日志（shadowWatchdog.ts）是同一求值结果的两种消费。
 *
 *  判定两件事：时间过了、钱花了，事推进了吗？规则维度：R1 同参重复 / R2 只读空转（弱）/
 *  R3 事件断流 / R4 烧钱无产出（弱）/ R5 写入方向偏差（弱）/ R6 净进展停滞（强）；健康短路
 *  （diff 显著增长或新文件）是 R2/R4 的反证。R3 是否直杀、R1/R6 是否升级二层裁决均归政策层——
 *  detector 只出「面」，不出「动作」。
 *
 *  独立性：tick 是独立 interval 回调，不 await agent 的 promise——agent 卡死在单轮工具上时
 *  事件流停更，「断流」面靠 tick 触发（外部控制回路在单进程内的最小实现）。刻意不做独立
 *  进程 / 文件 tail（batch 方案 §2 边界）。时钟/调度器可注入，测试零真 sleep。
 */
import { execFile } from "child_process";

// ============ 常量（先跑数据再谈调参——刻意不做成工单可配项，batch 方案 §8） ============

/** 判定周期（秒）：每 tick 采样一次 diff/成本 + 全量规则评估。 */
export const CHECK_INTERVAL_SEC = 60;
/** 起步宽限（分钟）：任务开跑后前 5 分钟不判定（起步读码阶段天然「无产出」）。 */
export const GRACE_MIN = 5;
/** R1 重复模式窗口（分钟）：同 (tool, 规范化 args) 出现次数计数窗口。 */
export const R1_WINDOW_MIN = 10;
/** R1 触发阈值：窗口内同形调用 ≥3 次。 */
const R1_MIN_HITS = 3;
/** R2 只读空转窗口（分钟）。 */
const R2_WINDOW_MIN = 15;
/** R2 触发下限：窗口内工具调用数（少于该数不构成「空转」）。 */
const R2_MIN_CALLS = 3;
/** R2 相似判定：窗口内朴素规范化后的 args 变体 ≤2 种才算「相似度高」（args 持续变化=调研，防误伤）。 */
const R2_MAX_DISTINCT_SIG = 2;
/** R3 断流阈值（分钟）：距最近事件（含 text.delta）≥5 分钟。 */
export const R3_SILENCE_MIN = 5;
/** R4 烧钱观察窗口（分钟）。 */
const R4_WINDOW_MIN = 5;
/** R4 成本增速阈值分母：窗口内增量 > 任务预算的 1/4。 */
const R4_COST_DIVISOR = 4;
/** R6 停滞判定带（行）：相邻两次采样净变更差 ±3 行内视为「≈0」。 */
const R6_STALL_BAND = 3;
/** 健康短路阈值（行）：连续窗口净变更增长 >20 行 → 直接 normal、跳过二层调用。 */
const HEALTH_GROWTH_LINES = 20;
/** diff 采样序列长度上限（防长任务内存缓涨）。 */
const SERIES_CAP = 64;
/** R6 diff 采样排除的 lockfile（setup 装依赖会动它们，与「净产出」无关）。 */
const LOCKFILE_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|bun\.lock|composer\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/i;

/** 编辑类工具（写入方向/产出的判定面）：与 batchRunner 的 BATCH_EDIT_TOOLS 同一清单。 */
export const EDIT_TOOLS = new Set(["edit_file", "create_file", "write_file", "move_file", "notebook_edit"]);
/** 只读类工具（R2 空转判定面）：read/grep/glob/list 类。 */
export const READONLY_TOOLS = new Set([
    "read_file", "list_dir", "glob", "search_grep", "read_image", "read_docx", "read_xlsx",
    "read_project_guide", "recall", "get_git_diff", "git_status", "git_log", "find_references",
    "get_diagnostics", "goto_definition", "view_symbol_outline", "web_search", "web_fetch",
]);

// ============ 路径 / args 规范化（纯函数，batch 方案 §12：朴素就够，不引相似度算法） ============

/** 路径归一：小写、反斜杠转正斜杠、去 ./ 前缀与盘符（R5 集合交并用）。 */
export const normPath = (p: string): string =>
    p.trim().replace(/\\/g, "/").replace(/^[A-Za-z]:/, "").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase();

/** 判定 a、b 是否指向同一路径：相等或互为后缀（worktree 绝对路径 vs 工单相对路径的对齐）。 */
const samePath = (a: string, b: string): boolean => a === b || a.endsWith("/" + b) || b.endsWith("/" + a);

/** args 稳定序列化：键递归排序（同参不同序视为同形，R1 用）。 */
const sortKeysDeep = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (v && typeof v === "object") {
        const out: Record<string, any> = {};
        for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
        return out;
    }
    return v;
};

/** R1 的「同参」键：稳定 JSON 截 200 字（不做去数字等模糊化——重复循环的 args 本就逐字相同）。 */
const argsKeyOf = (args: any): string => {
    try { return JSON.stringify(sortKeysDeep(args ?? {})).slice(0, 200); } catch { return String(args); }
};

/** R2 的朴素相似签名：去数字 + 去首个路径尾段（batch 方案 §12 原文口径——同文件/同搜索词的变体归一）。 */
const similarSigOf = (args: any): string => {
    let s: string;
    try { s = JSON.stringify(sortKeysDeep(args ?? {})); } catch { return String(args); }
    return s.replace(/\d+/g, "").replace(/\/[^/"]+(?=")/, "");
};

/** edit 类调用目标路径提取：覆盖 registry 实际参数名（path / move_file 的 source|destination）。 */
const editTargetOf = (args: any): string => normPath(String(args?.path ?? args?.source ?? args?.destination ?? args?.file_path ?? ""));

/**
 * R5 任务目标路径集合提取（batch：从工单正文 + accept/setup 命令文本；交互无工单 → 空集整条关闭）：
 * 路径线索正则，提取不到 → 返回空集，R5 整条关闭（缺省保守，batch 方案 §4）。
 * 正则口径同 truncate.ts extractArchiveEntities 的路径类。
 */
export const extractTargetPaths = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const m of text.match(/(?:[A-Za-z]:)?[\w.\-一-鿿]+(?:[/\\][\w.\-一-鿿]+)+\.[A-Za-z0-9]{1,6}/g) ?? []) {
        out.add(normPath(m));
    }
    return out;
};

/**
 * R6 diff 采样解析（纯函数）：git diff --numstat 输出 → 净变更行数（排除 lockfile）。
 * 每行形态「added<TAB>deleted<TAB>path」；二进制行 added/deleted 为 "-"，按 0 计（不出现在净行数里）。
 */
export const parseNumstatNet = (stdout: string): number => {
    let net = 0;
    for (const line of stdout.split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
        if (!m) continue;
        if (LOCKFILE_RE.test(m[3])) continue; // lockfile 变更不计入（setup 装依赖噪声）
        net += (m[1] === "-" ? 0 : parseInt(m[1], 10)) + (m[2] === "-" ? 0 : parseInt(m[2], 10));
    }
    return net;
};

// ============ 判定层本体 ============

const MIN = 60_000;

/** 单次工具调用的判定记录（feed(tool.start) 产出，规则与轨迹拼装共用）。 */
export interface CallRec {
    toolCallId: string;
    toolName: string;
    argsKey: string;
    sig: string;
    isEdit: boolean;
    isReadonly: boolean;
    target: string;
    argsDigest: string;
    t: number;
    round: number;
}

/** 每 tick 求值结果（detector 产出，政策层据此行动）。各「面」互斥产出：skipped / silenceMin /
 *  health 非空时 strong+weak 恒为空；strong 与 weak 可同时非空（弱信号作强信号的二层证据）。 */
export interface StallEvaluation {
    t: number;
    /** 宽限/抑制期内（政策层经 setSuppressUntil 设抑制窗）：本 tick 未做任何判定与采样。 */
    skipped: "grace-start" | "suppressed" | null;
    /** R3 面：距最近事件分钟数（≥阈值时非 null；batch 政策层据此直杀，影子仅记录）。 */
    silenceMin: number | null;
    /** 健康短路文案（R2/R4 反证：正在产出的慢任务）。 */
    health: string | null;
    /** 强规则命中（R1/R6）：batch 据此升级二层裁决。 */
    strong: { rule: string; evidence: string }[];
    /** 弱规则命中（R2/R4/R5）：仅作证据，不单独触发动作。 */
    weak: { rule: string; evidence: string }[];
}

export interface StallDetectorOpts {
    /** diff 采样根（batch=worktree；交互=会话主根 process.cwd()）。 */
    worktreePath: string;
    /** R5 目标路径提取源文本（batch=工单标题+正文+accept+setup；缺省空 → R5 整条自动关）。 */
    targetText?: string;
    /** 任务预算（R4 判据；缺省 undefined=R4 关——交互 run 无工单预算语义即缺省关）。 */
    budgetYuan?: number;
    /** 成本采样（缺省不采样、R4 关）；batch runner 接 collectSessionCost。 */
    getCost?: () => Promise<{ costYuan: number | null; rounds: number } | null>;
    /** 每 tick 求值结果出口。返回 promise 会被 tick await（batch 的 AUX 裁决保持 tick 内完成语义）。 */
    onEvaluation: (e: StallEvaluation) => void | Promise<void>;
    /** R6 diff 采样（可注入假采样；缺省 worktreePath 内真 git）。 */
    sampleDiff?: () => Promise<{ net: number; newFiles: string[] } | null>;
    /** 时钟（可注入假时钟；缺省 Date.now）。 */
    now?: () => number;
    /** 调度器（可注入；缺省 setInterval + unref）。 */
    schedule?: (fn: () => void, ms: number) => () => void;
    /** 判定周期毫秒（缺省 CHECK_INTERVAL_SEC*1000）。 */
    intervalMs?: number;
}

export class StallDetector {
    private readonly opts: StallDetectorOpts;
    private readonly now: () => number;
    private readonly intervalMs: number;
    private readonly targetPaths: Set<string>;

    private stopFn: (() => void) | null = null;
    private started = false;
    private stopped = false;
    private paused = false;
    private ticking = false;

    /** 宽限期基准（豁免解除时重置——豁免期不该吃掉 agent 的起步宽限）。字段名与同名 getter 刻意区分
     *  （tsconfig 为 set 语义，私有字段与只读 getter 同名会在字段初始化时炸 "only a getter"）。 */
    private activeAt = 0;
    private lastEventAt = 0;
    /** 抑制窗截止（政策层经 setSuppressUntil 设置：batch=nudge 后宽限；影子=强命中去重）。 */
    private suppressUntil = 0;

    private roundNo = 0;
    private readonly calls: CallRec[] = [];
    private finalSeen = false;

    /** R6 净变更行数时间序列（batch 基线 = setup 完成后首读；交互 run 首 tick 采样即基线）。 */
    private series: { net: number; newFiles: string[]; t: number }[] = [];
    /** R4 成本采样序列。 */
    private costSeries: { costYuan: number | null; t: number }[] = [];

    constructor(opts: StallDetectorOpts) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.intervalMs = opts.intervalMs ?? CHECK_INTERVAL_SEC * 1000;
        this.targetPaths = extractTargetPaths(opts.targetText ?? "");
        this.lastEventAt = this.now();
    }

    /** 启动旁观者心跳。判定在解除暂停前不会真正开始（batch setup 执行期挂 PAUSED）。 */
    start(): void {
        if (this.started || this.stopped) return;
        this.started = true;
        this.activeAt = this.now();
        const schedule = this.opts.schedule ?? ((fn: () => void, ms: number) => {
            const h = setInterval(fn, ms);
            (h as any).unref?.(); // 进程退出不被看门狗自身挂住（防异常逃逸路径泄漏定时器）
            return () => clearInterval(h);
        });
        this.stopFn = schedule(() => void this.tick(), this.intervalMs);
    }

    stop(): void {
        this.stopped = true;
        this.stopFn?.();
        this.stopFn = null;
    }

    /** 暂停判定（batch setup/accept 执行期；交互审批/提问挂起期）；解除时对齐事件时钟并重置起步宽限。 */
    setPaused(p: boolean): void {
        if (p === this.paused || this.stopped) return;
        this.paused = p;
        if (!p) {
            const t = this.now();
            this.lastEventAt = Math.max(this.lastEventAt, t); // 豁免期静默不计入 R3 断流
            this.activeAt = t;
        }
    }

    /** 抑制窗（政策层动作语义映射：batch nudge 后宽限 / 影子强命中 5 分钟去重）。 */
    setSuppressUntil(t: number): void {
        this.suppressUntil = t;
    }

    /** R6 基线：batch 在 setup 完成后取首个读数（装依赖动 lockfile，故基线后置 + 排除 lockfile）。 */
    async markBaseline(): Promise<void> {
        const s = await this.sampleDiffSafe();
        this.series = s ? [{ ...s, t: this.now() }] : [];
    }

    /**
     * 事件喂入口：tool.start/tool.end/round.start/text.delta/thinking.delta/final 全喂。
     * 任何事件都刷新 lastEventAt（R3 断流的对面）；豁免期不喂不计时（resume 时对齐）。
     * 白名单外的事件类型静默忽略（VSCode sink 混流 UIEvent，挂起交互事件天然无害）。
     */
    feed(evt: any): void {
        if (this.stopped || this.paused || !evt?.type) return;
        const t = this.now();
        this.lastEventAt = t;
        if (evt.type === "round.start") {
            this.roundNo = Number(evt.round) || this.roundNo;
            return;
        }
        if (evt.type === "final") {
            this.finalSeen = true;
            return;
        }
        if (evt.type === "tool.start") {
            const toolName = String(evt.toolName ?? "");
            const args = evt.args ?? {};
            let digest = "";
            try { digest = JSON.stringify(args); } catch { digest = String(args); }
            this.calls.push({
                toolCallId: String(evt.toolCallId ?? ""),
                toolName,
                argsKey: argsKeyOf(args),
                sig: similarSigOf(args),
                isEdit: EDIT_TOOLS.has(toolName),
                isReadonly: READONLY_TOOLS.has(toolName),
                target: editTargetOf(args),
                argsDigest: digest.slice(0, 120),
                t,
                round: this.roundNo,
            });
            if (this.calls.length > 512) this.calls.splice(0, this.calls.length - 512);
        }
        // tool.end：无需单独存储——ok 信息仅证据链打磨用，start 记录已含判定所需全部字段
    }

    /** 判定一步（测试可直接驱动；生产由 scheduler 每 tick 调）。自身异常绝不外泄。 */
    async tick(): Promise<void> {
        if (!this.started || this.stopped || this.paused || this.ticking) return;
        this.ticking = true;
        try {
            await this.evaluate();
        } catch { /* 看门狗自身故障不得外泄为任务失败，更不得变成误杀器 */ } finally {
            this.ticking = false;
        }
    }

    // —— 政策层访问器（拼 AUX 任务书 / 日志行用；不含动作语义） ——

    get round(): number { return this.roundNo; }
    get activeAtMs(): number { return this.activeAt; }
    /** 最近一次 diff 采样（影子日志 netLines 字段；无采样返回 null）。 */
    get lastNetSample(): { net: number; newFiles: string[]; t: number } | null {
        return this.series.length > 0 ? this.series[this.series.length - 1] : null;
    }
    /** 成本采样（不进序列——evaluate 每 tick 的采样才进，batch costLine 的即时读数与原实现同形）。 */
    sampleCost(): Promise<{ costYuan: number | null; rounds: number } | null> {
        return this.sampleCostSafe();
    }
    /** 时间窗内调用记录（batch 轨迹拼装：只读合并计数、写入逐条）。 */
    callsWithin(t: number, windowMs: number): readonly CallRec[] {
        return this.calls.filter((c) => t - c.t <= windowMs);
    }

    // —— 评估主体：产出 StallEvaluation 交政策层 ——

    private async evaluate(): Promise<void> {
        const t = this.now();
        // 宽限期：起步 5 分钟不判定（起步读码阶段天然「无产出」）；抑制窗内不再判定
        if (t - this.activeAt < GRACE_MIN * MIN) {
            await this.opts.onEvaluation({ t, skipped: "grace-start", silenceMin: null, health: null, strong: [], weak: [] });
            return;
        }
        if (t < this.suppressUntil) {
            await this.opts.onEvaluation({ t, skipped: "suppressed", silenceMin: null, health: null, strong: [], weak: [] });
            return;
        }

        // R6 / R4 采样先行（时间序列按 tick 维护）
        const sample = await this.sampleDiffSafe();
        if (sample) {
            this.series.push({ ...sample, t });
            if (this.series.length > SERIES_CAP) this.series.splice(0, this.series.length - SERIES_CAP);
        }
        const cost = await this.sampleCostSafe();
        if (cost) {
            this.costSeries.push({ costYuan: cost.costYuan, t });
            if (this.costSeries.length > SERIES_CAP) this.costSeries.splice(0, this.costSeries.length - SERIES_CAP);
        }

        // R3 断流面：距最近事件 ≥ 阈值（batch 政策层唯一直杀；影子仅记录）
        const silenceMs = t - this.lastEventAt;
        if (silenceMs >= R3_SILENCE_MIN * MIN) {
            await this.opts.onEvaluation({ t, skipped: null, silenceMin: silenceMs / MIN, health: null, strong: [], weak: [] });
            return;
        }

        // 健康信号短路：正在干活的慢任务（R2/R4 的反证）
        const health = this.healthCheck();
        if (health) {
            await this.opts.onEvaluation({ t, skipped: null, silenceMin: null, health, strong: [], weak: [] });
            return;
        }

        // 程序规则评估（R1/R6 强信号；R2/R4/R5 弱信号仅作证据）
        const strong = [this.r1Check(t), this.r6Check()].filter((r) => r !== null) as { rule: string; evidence: string }[];
        const weak = [this.r2Check(t), this.r4Check(t), this.r5Check(t)].filter((r) => r !== null) as { rule: string; evidence: string }[];
        await this.opts.onEvaluation({ t, skipped: null, silenceMin: null, health: null, strong, weak });
    }

    // —— 规则实现 ——

    /** R1 重复模式：同 (tool, 规范化 args) 窗口内 ≥3 次且跨轮（轮内重复 repeatBreaker 已管）。 */
    private r1Check(t: number): { rule: string; evidence: string } | null {
        const groups = new Map<string, { tool: string; n: number; rounds: Set<number> }>();
        for (const c of this.calls) {
            if (t - c.t > R1_WINDOW_MIN * MIN) continue;
            const key = `${c.toolName} ${c.argsKey}`;
            const g = groups.get(key) ?? { tool: c.toolName, n: 0, rounds: new Set<number>() };
            g.n += 1;
            g.rounds.add(c.round);
            groups.set(key, g);
        }
        for (const g of groups.values()) {
            if (g.n >= R1_MIN_HITS && g.rounds.size >= 2) {
                return { rule: "R1", evidence: `近 ${R1_WINDOW_MIN} 分钟 ${g.tool} 同参数调用 ${g.n} 次（跨 ${g.rounds.size} 轮）` };
            }
        }
        return null;
    }

    /** R2 只读空转（弱）：窗口内调用全只读且朴素规范化后变体 ≤2 种（args 持续变化=调研，防误伤）。 */
    private r2Check(t: number): { rule: string; evidence: string } | null {
        const recent = this.calls.filter((c) => t - c.t <= R2_WINDOW_MIN * MIN);
        if (recent.length < R2_MIN_CALLS || recent.some((c) => !c.isReadonly)) return null;
        const sigs = new Set(recent.map((c) => c.sig));
        if (sigs.size > R2_MAX_DISTINCT_SIG) return null;
        return { rule: "R2", evidence: `近 ${R2_WINDOW_MIN} 分钟 ${recent.length} 次调用全为只读且同形（${sigs.size} 种变体）` };
    }

    /** R4 烧钱无产出（弱）：窗口成本增量 > 预算 1/4 且期间零 edit、零 final。 */
    private r4Check(t: number): { rule: string; evidence: string } | null {
        if (this.opts.budgetYuan === undefined) return null;
        const win = this.costSeries.filter((s) => t - s.t <= R4_WINDOW_MIN * MIN);
        if (win.length < 2) return null;
        const first = win[0];
        const last = win[win.length - 1];
        if (first.costYuan == null || last.costYuan == null) return null;
        const delta = last.costYuan - first.costYuan;
        if (delta <= this.opts.budgetYuan / R4_COST_DIVISOR) return null;
        if (this.calls.some((c) => c.isEdit && t - c.t <= R4_WINDOW_MIN * MIN) || this.finalSeen) return null;
        return { rule: "R4", evidence: `近 ${R4_WINDOW_MIN} 分钟花费 ¥${delta.toFixed(4)}（> 预算 1/4），期间零 edit 零 final` };
    }

    /** R5 写入方向偏差（弱）：窗口内 edit 目标与任务目标集合全无交集；提取不到目标集合 → 整条关闭。 */
    private r5Check(t: number): { rule: string; evidence: string } | null {
        if (this.targetPaths.size === 0) return null;
        const edits = this.calls.filter((c) => c.isEdit && t - c.t <= R2_WINDOW_MIN * MIN);
        if (edits.length === 0) return null;
        const hit = edits.some((c) => c.target && [...this.targetPaths].some((p) => samePath(c.target, p)));
        if (hit) return null;
        return { rule: "R5", evidence: `近 ${R2_WINDOW_MIN} 分钟 ${edits.length} 次 edit 全部落在任务目标路径之外（如 ${edits[0].target || "?"}）` };
    }

    /** R6 净进展停滞（强）：连续 2 窗口净变更 ≈0（±3 行）且同期 edit 调用 >0——写了又改、没沉淀。 */
    private r6Check(): { rule: string; evidence: string } | null {
        const s = this.series;
        if (s.length < 3) return null;
        const a = s[s.length - 3];
        const b = s[s.length - 2];
        const c = s[s.length - 1];
        if (Math.abs(b.net - a.net) > R6_STALL_BAND || Math.abs(c.net - b.net) > R6_STALL_BAND) return null;
        const edits = this.calls.filter((e) => e.isEdit && e.t >= a.t).length;
        if (edits === 0) return null;
        return { rule: "R6", evidence: `净变更 ${a.net}→${b.net}→${c.net} 行（连续 2 窗口 ±${R6_STALL_BAND} 内）期间 ${edits} 次 edit` };
    }

    /** 健康短路：净变更显著增长或新文件出现 → 直接 normal（R2/R4 弱信号的反证）。 */
    private healthCheck(): string | null {
        const s = this.series;
        if (s.length < 2) return null;
        const prev = s[s.length - 2];
        const last = s[s.length - 1];
        if (last.newFiles.length > 0) return `新文件出现：${last.newFiles.slice(0, 3).join("、")}`;
        const delta = last.net - prev.net;
        if (delta > HEALTH_GROWTH_LINES) return `净变更增长 +${delta} 行（> ${HEALTH_GROWTH_LINES}）`;
        return null;
    }

    // —— 采样 ——

    private async sampleDiffSafe(): Promise<{ net: number; newFiles: string[] } | null> {
        if (this.opts.sampleDiff) return this.opts.sampleDiff();
        try {
            const run = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
                execFile("git", ["-C", this.opts.worktreePath, ...args], { maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
            });
            const [numstat, others] = await Promise.all([
                run(["diff", "--numstat", "HEAD"]),
                run(["ls-files", "--others", "--exclude-standard"]),
            ]);
            const newFiles = others.split("\n").map((s) => s.trim()).filter(Boolean);
            return { net: parseNumstatNet(numstat), newFiles };
        } catch {
            return null; // git 不可用/非仓库：R6 与健康短路本轮静默关闭（缺省保守）
        }
    }

    private async sampleCostSafe(): Promise<{ costYuan: number | null; rounds: number } | null> {
        if (!this.opts.getCost) return null;
        try { return await this.opts.getCost(); } catch { return null; }
    }
}
