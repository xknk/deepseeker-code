/**
 * @file batch/sync/baseline.ts
 * @description 多入口工单流水线 P1-M4：基线三态校验的缓存与归类（§5.2.1）——纯逻辑，零 LLM、零执行。
 *
 *  ★ 三态分离：setup-broken（环境装不上，瞬态，不缓存——重试可能就好）与 baseline-broken
 *  （干净树上验收就红，当天再票也不必再花安装+测试的时间，缓存）分开报。
 *  ★ 缓存键 = sha256(仓库根|HEAD SHA|accept 命令)：命令或代码一变即失效，不会拿旧结论盖新代码。
 *  ★ 缓存只存探测结论（ok / baseline-broken / watch-suspect），当天有效（本地日历日），写时顺手清旧。
 *  ★ 基线红的仓库不产生任何 agent 花费——这条由 runner 在 agent 阶段之前完成缓存检查来保证（结构性，
 *  不靠纪律）。
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { batchQueueRoot } from "../queue.ts";
import { localDay } from "./state.ts";
import type { SyncLocale } from "./config.ts";

/** 探测结论（缓存值）。watch-suspect = 超时被杀，疑似 watch/常驻进程（§3.5：与普通验收失败分开报）。 */
export type BaselineVerdict = "ok" | "baseline-broken" | "watch-suspect";

export interface BaselineProbeResult {
    /** accept 进程退出码（timedOut 时无意义）。 */
    code: number;
    /** 超时被杀 → 归类 watch-suspect（疑似 watch/常驻），不当作普通验收失败。 */
    timedOut: boolean;
}

/** 探测结果 → 三态结论（超时 ≠ 验收失败：几乎总是 watch/常驻，修法完全不同）。 */
export const classifyProbe = (r: BaselineProbeResult): BaselineVerdict => (r.timedOut ? "watch-suspect" : r.code === 0 ? "ok" : "baseline-broken");

/** 缓存键（同一天的「同仓库」由缓存文件随 batchQueueRoot 分项目桶天然满足）。 */
export const baselineKey = (repoRoot: string, baseSha: string, accept: string): string =>
    crypto.createHash("sha256").update(`${repoRoot}|${baseSha}|${accept}`).digest("hex");

interface BaselineCacheFile {
    entries: Record<string, { verdict: BaselineVerdict; at: string }>;
}

export const baselineCachePath = (): string => path.join(batchQueueRoot(), "baseline-cache.json");

const readCache = async (): Promise<BaselineCacheFile> => {
    try {
        const raw = JSON.parse(await fs.readFile(baselineCachePath(), "utf-8")) as BaselineCacheFile;
        return raw && typeof raw.entries === "object" && raw.entries !== null ? raw : { entries: {} };
    } catch {
        return { entries: {} };
    }
};

/**
 * 查缓存：同键 + 同一本地日历日才命中（隔天代码可能已变，旧结论不可信）。未命中/过期返回 null。
 */
export const readBaselineCache = async (key: string, now: Date): Promise<{ verdict: BaselineVerdict; at: string } | null> => {
    const cache = await readCache();
    const e = cache.entries[key];
    if (!e) return null;
    if (localDay(new Date(e.at)) !== localDay(now)) return null;
    return { verdict: e.verdict, at: e.at };
};

/** 写缓存（写时顺手清掉非当天的旧条目，文件不无限膨胀）。 */
export const writeBaselineCache = async (key: string, verdict: BaselineVerdict, now: Date): Promise<void> => {
    const cache = await readCache();
    const today = localDay(now);
    const entries: BaselineCacheFile["entries"] = {};
    for (const [k, v] of Object.entries(cache.entries)) {
        if (localDay(new Date(v.at)) === today) entries[k] = v;
    }
    entries[key] = { verdict, at: now.toISOString() };
    await fs.mkdir(path.dirname(baselineCachePath()), { recursive: true });
    await fs.writeFile(baselineCachePath(), JSON.stringify({ entries }, null, 2), "utf-8");
};

/** 报告/控制台用语（zh/en）：基线三态的人话。 */
export const baselineVerdictLabel = (verdict: BaselineVerdict, locale: SyncLocale = "zh"): string => {
    const zh: Record<BaselineVerdict, string> = {
        ok: "基线通过",
        "baseline-broken": "仓库当前验收不通过，本票未执行",
        "watch-suspect": "疑似 watch/常驻进程（验收探测超时被杀），本票未执行——请检查 accept 是否进入 watch 模式",
    };
    const en: Record<BaselineVerdict, string> = {
        ok: "baseline passed",
        "baseline-broken": "repo acceptance currently failing; ticket not executed",
        "watch-suspect": "suspected watch/resident process (accept probe timed out and was killed); ticket not executed — check whether accept enters watch mode",
    };
    return (locale === "en" ? en : zh)[verdict];
};
