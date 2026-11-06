/**
 * @file batch/feishu/reconcile.ts
 * @description 多入口工单流水线 P4：对账兜底（P4 方案 §6，P4 验收硬项「断网重连不丢票」）。
 *
 *  飞书长连接断线窗口内的事件平台不补推——listen 维护「最后事件时间游标」
 *  （.deepseeker-code/batch/feishu-cursor.json），重连/周期对账按游标增量拉消息
 *  （im/v1/messages），逐条过 handleFeishuMessage（白名单闸 + 内容哈希去重天然幂等：
 *  已建过的票 duplicate 跳过，漏的补建）。
 *
 *  - 游标推进语义：拉取窗口内【见过】的消息（无论建票/跳过）都推进游标——否则未命中白名单的
 *    消息会让每次对账重拉同一窗口。拉取失败（网络/权限）不推进（下轮重试），
 *    唯独「缺历史权限」推进 + 明示降级文案（fail-visible：不推进会对账风暴）。
 *  - 首跑窗口缺省 60 分钟：首次安装不做全量历史回灌（想补旧票手动 batch add）。
 *  - 拉取经注入 pull（listen 给 SDK 实现；测试给假剧本）——本文件零 SDK 零网络。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot } from "../queue.ts";
import type { SyncLocale } from "../sync/config.ts";
import type { FeishuMessageCandidate, FeishuTicketResult } from "./message.ts";

/** 对账拉取注入面：按 [startMs, endMs) 时间窗拉候选（升序）。 */
export type FeishuPull = (startMs: string, endMs: string) => Promise<
    { ok: true; messages: FeishuMessageCandidate[] }
    | { ok: false; reason: string; permissionDenied?: boolean }
>;

export interface FeishuCursor {
    /** 最后处理到的消息 create_time（毫秒字符串；下轮对账 start）。 */
    cursor: string;
    updatedAt: string;
}

export const cursorPath = (): string => path.join(batchQueueRoot(), "feishu-cursor.json");
/** 首跑对账回看窗口（毫秒）：首次无游标时只回看 60 分钟。 */
export const FIRST_RUN_WINDOW_MS = 60 * 60_000;

export const loadCursor = async (): Promise<FeishuCursor | null> => {
    try {
        const raw = JSON.parse(await fs.readFile(cursorPath(), "utf-8")) as FeishuCursor;
        if (raw && typeof raw.cursor === "string") return raw;
        return null;
    } catch {
        return null; // 无文件/损坏 = 无游标（首跑窗口语义）
    }
};

/** 写游标（temp + rename 原子；调用频率低，不做节流）。 */
export const saveCursor = async (cursor: string, now: Date = new Date()): Promise<void> => {
    const value: FeishuCursor = { cursor, updatedAt: now.toISOString() };
    await fs.mkdir(path.dirname(cursorPath()), { recursive: true });
    const tmp = `${cursorPath()}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    await fs.rename(tmp, cursorPath());
};

// ============ 私聊会话登记（白名单私聊纳入对账拉取：群白名单是配置态 chat_id，私聊只有 open_id，
// chat_id 必须从首条实时消息学习——学习后断线窗口内该会话的漏票才可回补。从未私聊过机器人的
// 会话无从得知 chat_id，无法覆盖（README 与降级文案均明示此边界）。） ============

export const p2pChatsPath = (): string => path.join(batchQueueRoot(), "feishu-p2p-chats.json");

/** 读已登记私聊 chat_id（无文件/损坏 = 空数组，重新学习即可——登记是幂等的）。 */
export const loadP2pChats = async (): Promise<string[]> => {
    try {
        const raw = JSON.parse(await fs.readFile(p2pChatsPath(), "utf-8")) as { chats?: unknown };
        return Array.isArray(raw?.chats) ? raw.chats.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
};

/**
 * 登记一个私聊 chat_id（已登记 = false 零写入；新登记 = true）。
 * 读-并-写整文件原子替换：与游标写各自独立文件，最坏并发丢一次登记（下条消息重学，幂等），
 * 游标语义不受任何影响。
 */
export const recordP2pChat = async (chatId: string): Promise<boolean> => {
    const chats = await loadP2pChats();
    if (chats.includes(chatId)) return false;
    const next = { chats: [...chats, chatId], updatedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(p2pChatsPath()), { recursive: true });
    const tmp = `${p2pChatsPath()}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
    await fs.rename(tmp, p2pChatsPath());
    return true;
};

const RECONCILE_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        permissionDenied: "⚠️ 对账不可用（缺 im:message 历史权限）：断线窗口内的群聊与已登记私聊消息可能漏票（从未私聊过机器人的会话无法回补）——请翻聊天记录，重要内容重新 @机器人 或手动 batch add。去飞书开放平台给应用补「获取与发送单聊、群组消息」权限可消除本提示。",
        pullFail: (r: string) => `⚠️ 对账拉取失败（游标不推进，下轮重试）：${r}`,
        summary: (pulled: number, created: number, skipped: number) => `🔁 对账完成：拉到 ${pulled} 条，补建 ${created} 票，跳过 ${skipped} 条`,
        empty: "🔁 对账完成：窗口内无新消息",
    },
    en: {
        permissionDenied: "⚠️ Reconciliation unavailable (missing im:message history permission): group and registered direct-chat messages sent while disconnected may not become tickets (chats that never messaged the bot cannot be backfilled) — check chat history, re-@ the bot for important ones, or run `batch add` manually. Granting the \"read & send messages\" permission to the app on the Feishu open platform clears this notice.",
        pullFail: (r: string) => `⚠️ Reconcile pull failed (cursor not advanced; will retry next cycle): ${r}`,
        summary: (pulled: number, created: number, skipped: number) => `🔁 Reconcile done: pulled ${pulled}, created ${created}, skipped ${skipped}`,
        empty: "🔁 Reconcile done: no new messages in window",
    },
};
const msg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (RECONCILE_MSG[locale] ?? RECONCILE_MSG.zh)[key] ?? RECONCILE_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

export interface ReconcileResult {
    ok: boolean;
    /** 本轮拉到的消息条数（拉取失败 = 0）。 */
    pulled: number;
    /** 补建票数。 */
    created: number;
    /** 跳过/去重条数。 */
    skipped: number;
    /** 缺历史权限降级（游标已推进，文案已明示）。 */
    degraded?: boolean;
}

/**
 * 跑一轮对账：读游标 → [cursor, now) 增量拉 → 逐条 handle（幂等）→ 推进游标。
 * pull 失败：普通失败游标不动（下轮重试）；permissionDenied 游标推进到 now + 明示降级
 * （fail-visible，不对账风暴）。
 */
export const runReconcile = async (args: {
    pull: FeishuPull;
    handle: (c: FeishuMessageCandidate) => Promise<FeishuTicketResult>;
    now?: () => Date;
    locale?: SyncLocale;
    out?: (line: string) => void;
}): Promise<ReconcileResult> => {
    const locale = args.locale ?? "zh";
    const out = args.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const now = args.now ?? (() => new Date());
    const nowMs = now().getTime();
    const cursor = await loadCursor();
    const startMs = cursor?.cursor ?? String(nowMs - FIRST_RUN_WINDOW_MS);
    const endMs = String(nowMs);

    const pulled = await args.pull(startMs, endMs);
    if (!pulled.ok) {
        if (pulled.permissionDenied) {
            await saveCursor(endMs, now());
            out(msg(locale, "permissionDenied"));
            return { ok: true, pulled: 0, created: 0, skipped: 0, degraded: true };
        }
        out(msg(locale, "pullFail", pulled.reason));
        return { ok: false, pulled: 0, created: 0, skipped: 0 };
    }

    let created = 0;
    let skipped = 0;
    let maxCreateTime = startMs;
    for (const m of pulled.messages) {
        const t = Number.parseInt(m.createTimeMs, 10);
        if (Number.isFinite(t) && t > Number.parseInt(maxCreateTime, 10)) maxCreateTime = m.createTimeMs;
        const r = await args.handle(m);
        if (r.ok && r.action === "created") created++;
        else skipped++;
    }
    await saveCursor(maxCreateTime > startMs ? maxCreateTime : endMs, now());
    if (pulled.messages.length === 0) out(msg(locale, "empty"));
    else out(msg(locale, "summary", pulled.messages.length, created, skipped));
    return { ok: true, pulled: pulled.messages.length, created, skipped };
};
