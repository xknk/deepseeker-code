/**
 * @file core/src/agent/shadowWatchdog.ts
 * @description 交互空转影子看门狗（看门狗二期·影子先行，.ai-docs/交互空转影子模式方案.md）：
 *  包 StallDetector 消费每 tick 求值结果，只追加写 <项目>/.deepseeker-code/watchdog-shadow.jsonl。
 *  跑几天后人工复核日志（强命中行当时会话是否真空转），误报率过关再开黄灯（§11 阶段 2b 换出口
 *  复用本管线）。
 *
 *  零干预零成本红线（§2）：不亮灯、不 nudge、不 abort、**永不调 AUX 小模型**——强命中记日志后
 *  5 分钟抑制窗（同一 episode 去重），弱信号不抑制（弱信号本就只作证据）。规则适配（§5）：
 *  R3 断流降级为仅记录（交互端静默常态——等审批/等提问走 PAUSED 豁免，PAUSED 外的静默才记录）；
 *  R4 关（无 budgetYuan）；R5 自动关（无工单 → targetText 空 → 目标集合空集）。
 *
 *  生命周期 = run 生命周期（§5）：每次 run 一个实例（VSCode host runOnce 创建 start、finally stop）；
 *  短问答 run 全程在宽限期内，零求值零采样。diff 采样固定跑在会话根（process.cwd()=主根，
 *  extension.ts activate 时 chdir 的既有事实）。
 */
import fs from "fs";
import path from "path";
import { StallDetector, R3_SILENCE_MIN, type StallDetectorOpts, type StallEvaluation } from "@/agent/stallDetector.ts";

const MIN = 60_000;
/** 强命中抑制窗（分钟）：同一空转 episode 只记一行，防每分钟重复记（§6）。 */
const STRONG_SUPPRESS_MIN = 5;

/** 日志行（JSONL 每行一个；schema 见方案 §6）。 */
export interface ShadowLogLine {
    /** 本地时区 ISO 时间（+08:00 形态）。 */
    ts: string;
    sessionId: string;
    kind: "strong" | "weak" | "silence" | "health";
    rules: string[];
    evidence: string;
    /** run 已进行分钟数（detector 起步时刻起算）。 */
    runMin: number;
    round: number;
    /** 最近一次 diff 采样净变更行数（无采样为 null）。 */
    netLines: number | null;
}

export interface ShadowWatchdogOpts {
    sessionId: string;
    /** 项目根（diff 采样 git -C 与日志落盘基目录；缺省 process.cwd()=主根）。 */
    rootDir?: string;
    /** 日志路径（可注入；缺省 <rootDir>/.deepseeker-code/watchdog-shadow.jsonl）。 */
    logPath?: string;
    /** 日志写出口（可注入捕获断言行内容；缺省追加写文件，单行 <300B 一次 write 原子落盘）。 */
    writeLine?: (line: ShadowLogLine) => void;
    /** diff 采样（可注入假采样；缺省 rootDir 内真 git）。 */
    sampleDiff?: StallDetectorOpts["sampleDiff"];
    /** 时钟（可注入假时钟；缺省 Date.now）。 */
    now?: () => number;
    /** 调度器（可注入；缺省 setInterval + unref）。 */
    schedule?: (fn: () => void, ms: number) => () => void;
    /** 判定周期毫秒（缺省 60s）。 */
    intervalMs?: number;
    /** 刻意不接线的口子：影子期零 API 成本是硬承诺（§2）——字段存在仅为守门测试钉死「注入也不得被调」，实现绝不消费。 */
    auxAdjudicate?: (prompt: string, signal: AbortSignal) => Promise<string>;
}

/** 开关（§8，形态对齐 DEEP_SEEK_BATCH_WATCHDOG 的读取位置与形态）：缺省开，值 "0" 关闭。
 *  关闭时 host 不创建实例，零行为零文件。 */
export const shadowEnabled = (): boolean => process.env.DEEP_SEEK_WATCHDOG_SHADOW !== "0";

/** 本地时区 ISO（Date.toISOString 是 Z 形态，日志给人复核用本地偏移更友好）。 */
const isoLocal = (ms: number): string => {
    const d = new Date(ms);
    const off = -d.getTimezoneOffset();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const abs = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

export class ShadowWatchdog {
    private readonly opts: ShadowWatchdogOpts;
    private readonly detector: StallDetector;

    constructor(opts: ShadowWatchdogOpts) {
        this.opts = opts;
        this.detector = new StallDetector({
            worktreePath: opts.rootDir ?? process.cwd(),
            targetText: "", // 交互无工单 → R5 目标集合空集 → 整条自动关（缺省保守，§5）
            sampleDiff: opts.sampleDiff,
            now: opts.now,
            schedule: opts.schedule,
            intervalMs: opts.intervalMs,
            onEvaluation: (e) => this.consume(e),
        });
    }

    start(): void { this.detector.start(); }
    stop(): void { this.detector.stop(); }
    /** 审批/提问挂起期暂停判定（交互端静默常态的豁免，§5/§7）；解除时时钟对齐。 */
    setPaused(p: boolean): void { this.detector.setPaused(p); }
    /** 事件喂入口（host sink 尾部全量转发；白名单外类型静默忽略）。 */
    feed(evt: any): void { this.detector.feed(evt); }

    /** 判定一步（生产由 detector 自持 scheduler 驱动；测试手动驱动）。自身异常绝不外泄。 */
    tick(): Promise<void> { return this.detector.tick(); }

    // —— 影子政策：求值结果 → 只记日志（§6 分支顺序；各面互斥产出） ——

    private consume(e: StallEvaluation): void {
        if (e.skipped) return; // 宽限/抑制期内：不记
        if (e.health) {
            this.write(e, { kind: "health", rules: [], evidence: e.health }); // 健康时间线是复核时的对照组
            return;
        }
        if (e.strong.length > 0) {
            this.write(e, { kind: "strong", rules: e.strong.map((r) => r.rule), evidence: e.strong.map((r) => r.evidence).join("；") });
            this.detector.setSuppressUntil(e.t + STRONG_SUPPRESS_MIN * MIN); // 强命中后 5 分钟抑制窗（episode 去重）
            return;
        }
        if (e.weak.length > 0) {
            this.write(e, { kind: "weak", rules: e.weak.map((r) => r.rule), evidence: e.weak.map((r) => r.evidence).join("；") }); // 弱信号不抑制
            return;
        }
        if (e.silenceMin !== null) {
            // R3 断流降级为仅记录（§5）：交互端 PAUSED 外的静默（长思考/用户离开）永不动作用
            this.write(e, { kind: "silence", rules: ["R3"], evidence: `断流：${Math.round(e.silenceMin)} 分钟无任何事件（agent 可能已卡死）` });
        }
    }

    private write(e: StallEvaluation, part: { kind: ShadowLogLine["kind"]; rules: string[]; evidence: string }): void {
        const line: ShadowLogLine = {
            ts: isoLocal(e.t),
            sessionId: this.opts.sessionId,
            kind: part.kind,
            rules: part.rules,
            evidence: part.evidence,
            runMin: Math.max(0, Math.round((e.t - this.detector.activeAtMs) / MIN)),
            round: this.detector.round,
            netLines: this.detector.lastNetSample?.net ?? null,
        };
        try {
            if (this.opts.writeLine) {
                this.opts.writeLine(line);
                return;
            }
            const p = this.opts.logPath ?? path.join(this.opts.rootDir ?? process.cwd(), ".deepseeker-code", "watchdog-shadow.jsonl");
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.appendFileSync(p, JSON.stringify(line) + "\n", "utf-8");
        } catch { /* 日志失败绝不外泄（影子是旁观者，自身故障零影响） */ }
    }
}
