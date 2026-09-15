/**
 * @file observability/usageLog.ts
 * @description 本地使用日志（后续路线 #6「真实使用数据回路」）：每个 agent run 结束时追加一行 JSONL，
 *  记录轮数 / token / 工具分布 / 停止原因 / 时长，按月分片落 `<dataDir>/usage/usage-YYYY-MM.jsonl`。
 *  定位：纯本地计量资产，绝不上报；一行 ~300B，量级远低于 trace，故不设清理闸（与 trace 3 天/50MB 双闸互补——
 *  trace 是短期运维源、transcript run.end 是单会话审计源，本日志是跨会话长期聚合源）。
 *  evals 测「能不能」（合成考卷），使用日志测「日常省不省」（真实负载），二者互补构成测量优先地基。
 *  停用开关：DEEPSEEKER_CODE_USAGE_LOG=0（缺省开）。
 *  读侧约定：selftest- 与 eval- 前缀的受控实验会话不代表真实负载，readUsageRecords 一律剔除（同 cache-by-round 惯例）。
 */
import fs from "fs/promises";
import path from "path";
import { appConfig } from "@/config/index.ts";
import type { TranscriptEvent } from "@/session/transcript.ts";

/** stopReason 与 transcript run.end 事件同枚举（单一数据源，不重列） */
type RunEndEvent = Extract<TranscriptEvent, { dscEvent: "run.end" }>;
export type UsageStopReason = RunEndEvent["stopReason"];

/** 单 run 使用记录（一行一条；字段平铺便于 jq/脚本消费；v=1 结构演进判别） */
export type UsageRunRecord = {
    v: 1;
    ts: string;                    // run 结束时刻（ISO；分片月 = ts 前 7 位）
    sessionId: string;
    runId: string;
    depth: number;                 // 0=主 agent run，>0=子 agent run（run 数/轮数口径在展示层拆分，token 恒全量）
    model: string;                 // 生效模型 id（options.model 覆盖优先，回退全局 MODEL_NAME）
    stopReason: UsageStopReason;
    rounds: number;                // 本 run 推理轮数（与 transcript run.end 同源）
    durationMs: number;
    promptTokens?: number;         // 本 run 多轮累计（usageSum）
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;         // 前缀缓存命中（DeepSeek prompt_cache_hit_tokens 口径）
    tools: Record<string, number>; // 工具分布：模型请求的 tool_calls 按名计数（含被拒/校验失败——反映模型行为而非仅执行面）
    workspace: string;             // 项目键（appConfig.userWorkspaceDir，由本模块统一盖章，调用方不传）
};

const USAGE_DISABLED = process.env.DEEPSEEKER_CODE_USAGE_LOG === "0";
const usageDir = (): string => path.join(appConfig.dataDir, "usage");
let ensuredDir: string | null = null; // 进程内已 mkdir 标记（每 run 一次的写频无需更细的水位管理）

/** 月分片文件路径：usage-YYYY-MM.jsonl */
export const getUsageLogPath = (month: string): string => path.join(usageDir(), `usage-${month}.jsonl`);

/**
 * 追加一条 run 记录（每 run 一次的收尾路径，非热路径；全容错——旁路计量绝不击垮 run 收尾链路）。
 * workspace 由本模块统一盖章（appConfig 读侧单点），调用方不传。
 */
export const recordUsageRun = async (rec: Omit<UsageRunRecord, "workspace"> & { workspace?: string }): Promise<void> => {
    if (USAGE_DISABLED) return;
    try {
        const full = { workspace: appConfig.userWorkspaceDir, ...rec } as UsageRunRecord;
        const month = (full.ts || new Date().toISOString()).slice(0, 7);
        const dir = usageDir();
        if (ensuredDir !== dir) {
            await fs.mkdir(dir, { recursive: true });
            ensuredDir = dir;
        }
        await fs.appendFile(getUsageLogPath(month), JSON.stringify(full) + "\n", "utf-8");
    } catch (e) {
        console.warn("⚠️ [usageLog] 使用日志落盘失败（不影响主业务）:", e instanceof Error ? e.message : e);
    }
}

const USAGE_FILE_RE = /^usage-\d{4}-\d{2}\.jsonl$/;
/** 受控实验会话前缀：selftest-*（scripts/selftest-*）与 eval-*（evals 任务池），混入会污染「日常省不省」口径 */
const SYNTHETIC_SESSION_RE = /^(selftest-|eval-)/;

/**
 * 读取使用日志全部记录（跨月分片合并，按 ts 升序）。
 * @param days 只保留最近 N 天（按本地自然日切，含今天）；缺省全量。
 * 容错：目录不存在 → []（从未产生记录属正常态）；坏行/缺关键字段的行跳过（与 trace/transcript 同语义）。
 */
export const readUsageRecords = async (days?: number): Promise<UsageRunRecord[]> => {
    let files: string[];
    try {
        files = (await fs.readdir(usageDir())).filter((f) => USAGE_FILE_RE.test(f)).sort();
    } catch {
        return [];
    }
    let cutoff: Date | null = null;
    if (days && days > 0) {
        cutoff = new Date();
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setDate(cutoff.getDate() - (days - 1));
    }
    const out: UsageRunRecord[] = [];
    for (const f of files) {
        let text: string;
        try { text = await fs.readFile(path.join(usageDir(), f), "utf-8"); } catch { continue; }
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let rec: UsageRunRecord;
            try { rec = JSON.parse(line); } catch { continue; }
            if (!rec || typeof rec !== "object" || !rec.sessionId || !rec.ts) continue;
            if (SYNTHETIC_SESSION_RE.test(rec.sessionId)) continue;
            if (cutoff && new Date(rec.ts) < cutoff) continue;
            out.push(rec);
        }
    }
    return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/** 聚合快照：纯累加口径（不除零、不取整），比率/均值/主子拆分的展示在调用方做 */
export type UsageSummary = {
    runs: number;
    mainRuns: number;   // depth=0 的 run 数（用户可感知的回合数）
    subRuns: number;    // 子 agent run 数（spawn_agent / workflow）
    stopReasons: Record<UsageStopReason, number>;
    rounds: number;     // 全部 run 轮数合计（token 同口径恒全量）
    mainRounds: number; // 仅主 run 轮数合计（轮数经济学的主指标）
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    toolCalls: number;
    tools: Record<string, number>;
    firstTs?: string;
    lastTs?: string;
};

export const summarizeUsage = (records: UsageRunRecord[]): UsageSummary => {
    const s: UsageSummary = {
        runs: 0, mainRuns: 0, subRuns: 0,
        stopReasons: { normal: 0, aborted: 0, error: 0, repeat: 0, limit: 0 },
        rounds: 0, mainRounds: 0, durationMs: 0,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
        toolCalls: 0, tools: {},
    };
    for (const r of records) {
        s.runs++;
        if (r.depth > 0) s.subRuns++; else s.mainRuns++;
        if (r.stopReason in s.stopReasons) s.stopReasons[r.stopReason]++;
        s.rounds += r.rounds || 0;
        if (r.depth === 0) s.mainRounds += r.rounds || 0;
        s.durationMs += r.durationMs || 0;
        s.promptTokens += r.promptTokens ?? 0;
        s.completionTokens += r.completionTokens ?? 0;
        s.totalTokens += r.totalTokens ?? 0;
        s.cachedTokens += r.cachedTokens ?? 0;
        for (const [name, n] of Object.entries(r.tools ?? {})) {
            s.tools[name] = (s.tools[name] ?? 0) + (n || 0);
            s.toolCalls += n || 0;
        }
        if (!s.firstTs || r.ts < s.firstTs) s.firstTs = r.ts;
        if (!s.lastTs || r.ts > s.lastTs) s.lastTs = r.ts;
    }
    return s;
}

/** 工具分布 topN（次数降序，同次数按名字典序稳定排序） */
export const topTools = (tools: Record<string, number>, n: number): [string, number][] =>
    Object.entries(tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
