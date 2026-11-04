/**
 * @file batch/sync/state.ts
 * @description 多入口工单流水线 P1：sync 去重状态（<batch>/sync-state.jsonl，§4.2）。
 *
 *  - 每行一条 {sourceId, ticketId?, seenAt, fingerprint, verdict, title?, updatedAt?, reason?}；
 *    同 sourceId 多行时以【最后一行】为准（append-only + last-wins，无需原地改写）。
 *  - fingerprint = sha256(标题 + "\n" + 正文)。P1 只认正文变化（§4.2 评审修订①）：
 *    新评论不改 issue 正文 → 指纹不变 → skip，续修永不在 P1 触发（P2 才把评论纳指纹）。
 *  - 三态判定（deduceVerdict）：未见 → new（候选）；已见未变 → skip；已见且变 → changed
 *    （P1 只记 state + 日志提示，不自动续修）。
 *  - verdict 还记录规则闸结论（reject / missing-accept），防同一灌水 issue 每次 sync 重复处理。
 *  - 并发：写侧只追加（append）；文件损坏行容忍（跳过）。P1 无重写场景；需要重写时走
 *    「临时文件 + rename」（§4.2 评审修订②，.sync.lock 在 sync.ts 另管单飞）。
 */
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { batchQueueRoot } from "../queue.ts";

/** 规则闸/Gatekeeper 结论 + 建票结果（state 的 verdict 段）。 */
export type SyncVerdict = "work" | "skip" | "changed" | "reject" | "missing-accept";

export interface SyncStateEntry {
    /** 身份键（平台:仓库:编号，如 github:owner/repo#42）。 */
    sourceId: string;
    /** verdict=work 时：建出的工单 id。 */
    ticketId?: string;
    /** 记录时刻（ISO）。 */
    seenAt: string;
    /** sha256(标题 + "\n" + 正文)。 */
    fingerprint: string;
    verdict: SyncVerdict;
    /** reject / missing-accept 的人话原因（规则闸结论），防重复处理时无从判断。 */
    reason?: string;
    /** 候选标题（同标题重复检测 + 摘要展示）。 */
    title?: string;
    /** 候选端最后更新时刻（ISO；GitLab 增量游标用）。 */
    updatedAt?: string;
}

export const syncStatePath = (): string => path.join(batchQueueRoot(), "sync-state.jsonl");

/** 指纹：只含标题+正文（P1 不含评论——评论不触发任何动作，§4.2 评审修订①）。 */
export const syncFingerprint = (title: string, body: string): string =>
    createHash("sha256").update(`${title}\n${body}`, "utf-8").digest("hex");

/** 读全部状态，按 sourceId last-wins 归并；损坏行跳过（手工改动不炸同步）。 */
export const loadSyncState = async (): Promise<Map<string, SyncStateEntry>> => {
    const map = new Map<string, SyncStateEntry>();
    let raw: string;
    try {
        raw = await fs.readFile(syncStatePath(), "utf-8");
    } catch {
        return map; // 文件不存在 = 全新状态
    }
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const e = JSON.parse(t) as SyncStateEntry;
            if (e && typeof e.sourceId === "string" && typeof e.fingerprint === "string" && typeof e.verdict === "string") {
                map.set(e.sourceId, e);
            }
        } catch { /* 损坏行跳过 */ }
    }
    return map;
};

/** 追加一条（O_APPEND 语义：mkdir 父目录后单行写入）。 */
export const appendSyncState = async (entry: SyncStateEntry): Promise<void> => {
    await fs.mkdir(path.dirname(syncStatePath()), { recursive: true });
    await fs.appendFile(syncStatePath(), `${JSON.stringify(entry)}\n`, "utf-8");
};

/** 三态判定：new（未见）/ skip（已见未变）/ changed（已见且变——P1 只日志不续修）。 */
export type DeduceVerdict = "new" | "skip" | "changed";
export const deduceVerdict = (existing: SyncStateEntry | undefined, fingerprint: string): DeduceVerdict => {
    if (!existing) return "new";
    return existing.fingerprint === fingerprint ? "skip" : "changed";
};

/** 本地时区当日（YYYY-MM-DD）——maxTicketsPerDay 的「天」以本机日历日计。 */
export const localDay = (d: Date = new Date()): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 今日已建票数（verdict=work 且 seenAt 是本机今天）——maxTicketsPerDay 的计数来源。 */
export const todayTicketCount = async (now: Date = new Date()): Promise<number> => {
    const today = localDay(now);
    let n = 0;
    for (const e of (await loadSyncState()).values()) {
        if (e.verdict === "work" && typeof e.seenAt === "string" && localDay(new Date(e.seenAt)) === today) n++;
    }
    return n;
};
