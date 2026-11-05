/**
 * @file batch/sync/state.ts
 * @description 多入口工单流水线 P1：sync 去重状态（<batch>/sync-state.jsonl，§4.2）。
 *
 *  - 每行一条 {sourceId, ticketId?, seenAt, fingerprint, verdict, title?, updatedAt?, reason?}；
 *    同 sourceId 多行时以【最后一行】为准（append-only + last-wins，无需原地改写）。
 *  - fingerprint（P2 v2）= "v2:" + sha256(标题 + "\n" + 正文 + "\n" + 评论轨迹)——评论轨迹为
 *    最近 N 条 (id, updatedAt) 的 canonical JSON（§6.2：新评论/重开触发续修）。
 *    ★ 迁移：P1 存量指纹无 "v2:" 前缀（且评论轨迹未知）——needsFingerprintMigration 判出后，
 *      sync 只刷新指纹不触发续修（否则升级后首跑会把所有已见 issue 误判 changed，续修票洪水）。
 *    P1 只认正文变化的历史语义由 v1 指纹（无前缀）天然承载，读取侧不再区分。
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

/** 纳入指纹的评论轨迹条数（§6.2「最近 N 条」；N=5：翻页成本与触发灵敏度折中）。 */
export const COMMENTS_IN_FINGERPRINT = 5;

/** 指纹版本前缀：v2 = 标题+正文+评论轨迹。无前缀 = P1 存量（升级迁移判定用）。 */
const FP_V2_PREFIX = "v2:";

/** 评论轨迹条目（适配器归一输出；id 取字符串，updatedAt ISO 或空串）。 */
export interface SyncCommentRef {
    id: string;
    updatedAt: string;
}

/** canonical 评论轨迹序列化（缺省空数组——无评论也是稳定形态）。 */
export const commentsTrail = (comments?: SyncCommentRef[]): string =>
    JSON.stringify((comments ?? []).slice(-COMMENTS_IN_FINGERPRINT));

export interface SyncStateEntry {
    /** 身份键（平台:仓库:编号，如 github:owner/repo#42）。 */
    sourceId: string;
    /** verdict=work 时：建出的工单 id。 */
    ticketId?: string;
    /** 记录时刻（ISO）。 */
    seenAt: string;
    /** "v2:" + sha256(标题+"\n"+正文+"\n"+评论轨迹)；P1 存量条目无前缀（迁移判定 needsFingerprintMigration）。 */
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

/** 指纹（P2 v2）：标题+正文+评论轨迹（新评论/编辑评论 → 指纹变化 → 续修，§6.2）。 */
export const syncFingerprint = (title: string, body: string, comments?: SyncCommentRef[]): string =>
    FP_V2_PREFIX + createHash("sha256").update(`${title}\n${body}\n${commentsTrail(comments)}`, "utf-8").digest("hex");

/** P1 存量指纹（无 v2 前缀）：评论轨迹未知——sync 只刷新指纹，不触发续修（防升级洪水）。 */
export const needsFingerprintMigration = (entry: SyncStateEntry | undefined): boolean =>
    !!entry && !entry.fingerprint.startsWith(FP_V2_PREFIX);

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
