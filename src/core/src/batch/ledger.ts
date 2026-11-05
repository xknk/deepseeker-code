/**
 * @file batch/ledger.ts
 * @description 多入口工单流水线 P2：挂机账本（§5.2.3 注）——`batch run` 每次执行追加一行，
 *  `batch status` 汇总最近 7 天。
 *
 *  形态：<batch>/ledger.jsonl，每行 {at, tickets, green, red, costYuan}：
 *  - tickets = 本 run 取跑的任务数；green = passed 数；red = 其余（green/red 之外还有
 *    rejected/baseline-broken 等不烧钱态，red 只是「没过」的粗粒度——账本是给人看趋势的，
 *    精细对账看逐票报告与 usageLog）；costYuan = 本 run 合计（无价模型记 0）。
 *  - 零任务的 run 也落一行（定时器节奏可见）；append-only，损坏行读取侧跳过。
 *  - 轻模块：fs/path 级依赖，零 LLM。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot } from "./queue.ts";
import { localDay } from "./sync/state.ts";

export interface LedgerEntry {
    /** 追加时刻（ISO）。 */
    at: string;
    /** 本 run 跑的任务数。 */
    tickets: number;
    /** 验收通过数。 */
    green: number;
    /** 未过数（tickets - green）。 */
    red: number;
    /** 本 run 合计花费（元；无价模型计 0）。 */
    costYuan: number;
}

export const ledgerPath = (): string => path.join(batchQueueRoot(), "ledger.jsonl");

/** 追加一行（mkdir 父目录后 append）。 */
export const appendLedgerEntry = async (entry: LedgerEntry): Promise<void> => {
    await fs.mkdir(path.dirname(ledgerPath()), { recursive: true });
    await fs.appendFile(ledgerPath(), `${JSON.stringify(entry)}\n`, "utf-8");
};

export interface LedgerSummary {
    /** 窗口内 run 数。 */
    runs: number;
    /** 窗口内任务总数。 */
    tickets: number;
    green: number;
    red: number;
    /** 窗口内花费合计（元）。 */
    costYuan: number;
    /** 窗口起点（ISO，含）。 */
    since: string;
    /** 损坏行数（诊断用；正常为 0）。 */
    badLines: number;
}

/**
 * 汇总最近 N 天（滚动窗口 [now - N*24h, now]，默认 7 天）。损坏行跳过计数。
 * @param lines 测试注入（缺省读 ledgerPath()）。
 */
export const summarizeLedger = async (now: Date = new Date(), days = 7, lines?: string[]): Promise<LedgerSummary> => {
    let raw: string[] = lines ?? [];
    if (!lines) {
        try {
            raw = (await fs.readFile(ledgerPath(), "utf-8")).split("\n");
        } catch {
            raw = [];
        }
    }
    const sinceMs = now.getTime() - days * 24 * 60 * 60 * 1000;
    const sum: LedgerSummary = { runs: 0, tickets: 0, green: 0, red: 0, costYuan: 0, since: new Date(sinceMs).toISOString(), badLines: 0 };
    for (const line of raw) {
        const t = line.trim();
        if (!t) continue;
        try {
            const e = JSON.parse(t) as LedgerEntry;
            const at = new Date(e.at).getTime();
            if (!Number.isFinite(at) || at < sinceMs || at > now.getTime() + 60_000) continue; // 窗口外/未来时钟偏差容忍 1 分钟
            sum.runs++;
            sum.tickets += e.tickets || 0;
            sum.green += e.green || 0;
            sum.red += e.red || 0;
            sum.costYuan += e.costYuan || 0;
        } catch {
            sum.badLines++;
        }
    }
    return sum;
};

/** localDay 再导出（batch status 按本机日历日渲染窗口说明用）。 */
export { localDay };
