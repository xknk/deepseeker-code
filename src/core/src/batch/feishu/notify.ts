/**
 * @file batch/feishu/notify.ts
 * @description 多入口工单流水线 P4：飞书入口反馈闭环（回执 + 完成推送 + 回复路由映射）。
 *
 *  聊天入口的硬要求：用户发消息必须知道「收到了没有 / 什么时候跑 / 跑得怎么样」——静默建票
 *  等于往黑洞里扔需求（2026-11-06 真机联调实锤：配额拒收静默、建票成功也无回执，用户无从判断）。
 *  三个职责（全部纯 fs，零 SDK 零 LLM——SDK 发送在 listen 侧，文案与文件协议在这侧可单测）：
 *
 *  1. 消息映射表 feishu-msg-map.json：飞书消息 id → 票 id。三类 id 都登记——用户原消息、
 *     机器人回执消息、完成报告推送消息（回复其中任何一个都路由到同一张票）。
 *     「回复即续修」靠它路由：回复事件 parent_id 命中映射 → 追加/续修；未命中 → 当新票。
 *     封顶 500 条（超限丢最旧——续修窗口天然近因；JSON 对象保留插入序，非数字键稳定）。
 *  2. 完成通知 notifications/<ticketId>.json：queue.finishTicket 单一咽喉落盘（票带 feishu-chat
 *     才写，成功失败都写）；listen 扫描循环发送 → 删除。监听进程不在 = 文件留存等回来补推
 *     （断线不丢通知）；重试 5 次仍失败 = 放弃并留日志（防不可达会话无限打 API）。
 *  3. 文案构造器（建票回执/拒因回执/重复回执/追加回执/续修回执/完成推送）：纯函数，中英双语，
 *     全部单行紧凑风（手机通知栏可读；不含 diff 与验收输出——外发红线同审批卡）。
 *
 *  ★ 轻模块红线（同 approval.ts）：零 SDK、零 LLM——listen/queue/单测三方共用。
 */
import fs from "fs/promises";
import path from "path";
import type { SyncLocale } from "../sync/config.ts";

/** 队列根（与 queue.ts 同源逻辑但零 import——queue 会 import 本模块做收尾钩子，反向依赖成环）。 */
const batchRoot = (): string =>
    process.env.DEEPSEEKER_CODE_BATCH_DIR || path.join(process.cwd(), ".deepseeker-code", "batch");

// ============ 消息映射表（回复路由） ============

/** 映射封顶：超限丢最旧（见文件头——续修窗口天然近因）。 */
export const MSG_MAP_CAP = 500;

const msgMapPath = (): string => path.join(batchRoot(), "feishu-msg-map.json");

interface MsgMapFile { map: Record<string, string>; updatedAt: string }

const loadMsgMap = async (): Promise<Record<string, string>> => {
    try {
        const raw = JSON.parse(await fs.readFile(msgMapPath(), "utf-8")) as MsgMapFile;
        return raw?.map && typeof raw.map === "object" ? raw.map : {};
    } catch {
        return {}; // 无文件/损坏 = 空表（重新学习即可，不炸调用方）
    }
};

/** 登记一条 消息 id → 票 id（幂等：重复登记同 id 覆盖同值不写盘）。 */
export const recordMsgMap = async (msgId: string, ticketId: string): Promise<void> => {
    if (!msgId || !ticketId) return;
    try {
        const map = await loadMsgMap();
        if (map[msgId] === ticketId) return;
        map[msgId] = ticketId;
        const keys = Object.keys(map);
        for (const k of keys.slice(0, Math.max(0, keys.length - MSG_MAP_CAP))) delete map[k]; // 丢最旧
        const tmp = `${msgMapPath()}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        await fs.writeFile(tmp, JSON.stringify({ map, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
        await fs.rename(tmp, msgMapPath());
    } catch { /* 映射失败只影响回复路由（降级为当新票），不阻塞建票主流程 */ }
};

/** 查消息 id 对应的票 id（无/损坏 = null）。 */
export const lookupMsgMap = async (msgId: string): Promise<string | null> => {
    if (!msgId) return null;
    return (await loadMsgMap())[msgId] ?? null;
};

// ============ 完成通知文件（runner → listen 跨进程协议） ============

/** 通知重试上限：超限放弃（防 bot 被移出会话等不可达场景无限打 API）。 */
export const NOTIFY_MAX_RETRIES = 5;

/** 完成通知内容（finishTicket 从报告 frontmatter 提取；listen 发送端只读不补算）。 */
export interface FinishNotification {
    ticketId: string;
    /** 回执目标会话（票 frontmatter feishu-chat；群 oc_/私聊 oc_ 同一 receive 面）。 */
    chatId: string;
    /** @ 提及目标（群聊回执前缀 @发送者；票 frontmatter feishu-sender）。 */
    senderOpenId?: string;
    title: string;
    /** 报告 frontmatter status（passed/accept-failed/timeout/…原样透传）。 */
    status: string;
    /** 报告 frontmatter cost-yuan（元；缺省 "?"）。 */
    cost: string;
    /** 报告 frontmatter branch（产物分支；缺省空）。 */
    branch: string;
    /** changed-file 行数（含省略行——量级感知足够，不逐文件列）。 */
    changedFiles: number;
    /** 相对 <项目> 的报告路径（手机上点不开本机路径，但可对账查找）。 */
    reportPath: string;
    /** 发送失败计数（listen 侧累加；达到 NOTIFY_MAX_RETRIES 放弃删除）。 */
    retries: number;
    createdAt: string;
}

const notificationsDir = (): string => path.join(batchRoot(), "notifications");
const notificationPath = (ticketId: string): string => path.join(notificationsDir(), `${ticketId}.json`);

/** 报告 frontmatter 单值提取（extractPrevReportSummary 同法；报告缺失字段回退占位）。 */
const reportFm = (report: string, key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(report);
    return m ? m[1].trim() : "";
};

/**
 * 落一张完成通知（queue.finishTicket 单一咽喉调用；票带 feishu-chat 才有此文件）。
 * 报告字段解析失败不抛——通知是增益不是关键路径，最差少推一条、日志可见。
 */
export const writeFinishNotification = async (args: { ticketId: string; reportMd: string; chatId: string; senderOpenId?: string; title: string }): Promise<void> => {
    try {
        const changedFiles = [...args.reportMd.matchAll(/^changed-file:\s*(.+)$/gm)].length;
        const n: FinishNotification = {
            ticketId: args.ticketId,
            chatId: args.chatId,
            senderOpenId: args.senderOpenId,
            title: args.title.slice(0, 60),
            status: reportFm(args.reportMd, "status") || "unknown",
            cost: reportFm(args.reportMd, "cost-yuan") || "?",
            branch: reportFm(args.reportMd, "branch") || "",
            changedFiles,
            reportPath: `.deepseeker-code/batch/done/${args.ticketId}.report.md`,
            retries: 0,
            createdAt: new Date().toISOString(),
        };
        await fs.mkdir(notificationsDir(), { recursive: true });
        const tmp = `${notificationPath(args.ticketId)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        await fs.writeFile(tmp, JSON.stringify(n, null, 2), "utf-8");
        await fs.rename(tmp, notificationPath(args.ticketId));
    } catch { /* 见文件头：通知失败不击垮收尾 */ }
};

/** 扫待发通知（文件名字典序；损坏文件跳过并清走——半写产物不可信）。 */
export const listPendingNotifications = async (): Promise<FinishNotification[]> => {
    let files: string[];
    try {
        files = (await fs.readdir(notificationsDir())).filter((f) => f.endsWith(".json"));
    } catch {
        return []; // 无目录 = 没有待发通知（正常态）
    }
    const out: FinishNotification[] = [];
    for (const f of files) {
        const p = path.join(notificationsDir(), f);
        try {
            out.push(JSON.parse(await fs.readFile(p, "utf-8")) as FinishNotification);
        } catch {
            await fs.rm(p, { force: true }).catch(() => { }); // 损坏 = 清走（tmp+rename 下不该出现）
        }
    }
    return out;
};

/** 发送成功 → 删文件（幂等：不存在静默）。 */
export const clearNotification = async (ticketId: string): Promise<void> => {
    await fs.rm(notificationPath(ticketId), { force: true }).catch(() => { });
};

/** 发送失败 → retries+1 落盘；达到上限返回 true（调用方删文件+留日志放弃）。 */
export const bumpNotificationRetries = async (n: FinishNotification): Promise<boolean> => {
    n.retries += 1;
    const giveUp = n.retries >= NOTIFY_MAX_RETRIES;
    if (giveUp) await clearNotification(n.ticketId);
    else {
        const tmp = `${notificationPath(n.ticketId)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        await fs.writeFile(tmp, JSON.stringify(n, null, 2), "utf-8").catch(() => { });
        await fs.rename(tmp, notificationPath(n.ticketId)).catch(() => { });
    }
    return giveUp;
};

// ============ 回执文案（纯函数；中英双语，单行紧凑风） ============

const STATUS_ZH: Record<string, string> = {
    passed: "✅ 验收通过",
    "accept-failed": "❌ 验收未通过",
    timeout: "⏱ 超时终止",
    error: "❌ 执行出错",
    "setup-failed": "⚠️ 环境准备（setup）失败",
    rejected: "🚫 工单被拒（未执行）",
    "watchdog-killed": "⏹ 看门狗终止（疑似卡死）",
    "baseline-broken": "⚠️ 基线测试本身是坏的",
};

export const notifyText = {
    /** 建票回执（ahead=前面还有几张）。 */
    ackCreated: (locale: SyncLocale, ticketId: string, title: string, ahead: number): string =>
        locale === "zh"
            ? `✅ 已建票 ${ticketId}「${title}」｜前面还有 ${ahead} 张，随下次挂机跑批执行｜跑完在这里推报告；要补充需求，直接回复本条消息`
            : `✅ Ticket ${ticketId} "${title}" created | ${ahead} ahead of it; runs at the next batch window | report will be pushed here; reply to this message to add requirements`,
    /** 拒收回执（过了白名单但没建成——拒因必须回给人，静默=黑洞）。 */
    ackSkipped: (locale: SyncLocale, reason: string): string =>
        locale === "zh"
            ? `⚠️ 未建票：${reason}`
            : `⚠️ No ticket created: ${reason}`,
    /** 重复回执（同内容已有票——回答"到底收没收到"）。 */
    ackDuplicate: (locale: SyncLocale, ticketId: string | undefined): string =>
        locale === "zh"
            ? `ℹ️ 这个任务已有票${ticketId ? ` ${ticketId}` : ""}，未重复建票；要跟进，回复该票的回执消息`
            : `ℹ️ This task already has a ticket${ticketId ? ` ${ticketId}` : ""}; reply to that ticket's ack to follow up`,
    /** 追加回执（原票在排队：内容已并入原票）。 */
    ackAppended: (locale: SyncLocale, ticketId: string, title: string): string =>
        locale === "zh"
            ? `➕ 已并入排队中的票 ${ticketId}「${title}」——半夜随它一起跑，不另开新票`
            : `➕ Appended to queued ticket ${ticketId} "${title}" — runs together with it, no new ticket`,
    /** 续修回执（原票已跑完：续修票已建，基座=前票产物分支）。 */
    ackFollowupCreated: (locale: SyncLocale, ticketId: string, prevId: string): string =>
        locale === "zh"
            ? `🔁 已建续修票 ${ticketId}（接 ${prevId}）——验收/预算沿用前票，代码基座含前次改动，不重做；已排队`
            : `🔁 Continuation ticket ${ticketId} (after ${prevId}) created — same accept/budget, code base includes the previous fix; queued`,
    /** 完成推送（手机可读摘要；不含 diff 与验收输出——外发红线）。 */
    finish: (locale: SyncLocale, n: FinishNotification): string => {
        const zh = locale === "zh";
        const status = zh ? (STATUS_ZH[n.status] ?? n.status) : n.status;
        const files = zh ? `改动 ${n.changedFiles} 个文件` : `${n.changedFiles} file(s) changed`;
        const cost = zh ? `花费 ¥${n.cost}` : `cost ¥${n.cost}`;
        const branch = n.branch ? (zh ? `｜分支 ${n.branch}` : ` | branch ${n.branch}`) : "";
        const tail = zh ? "｜要跟进，直接回复本条消息" : " | reply to this message to follow up";
        return `📋 票 ${n.ticketId}「${n.title}」跑完｜${status}｜${files}｜${cost}${branch}${tail}\n报告：${n.reportPath}`;
    },
    /** 通知推送失败放弃（日志用，不外发）。 */
    notifyGiveUp: (locale: SyncLocale, ticketId: string): string =>
        locale === "zh"
            ? `⚠️ [feishu] 完成通知 ${ticketId} 连续 ${NOTIFY_MAX_RETRIES} 次发送失败，放弃（会话可能已不可达；报告仍在 ${`.deepseeker-code/batch/done/${ticketId}.report.md`}）`
            : `⚠️ [feishu] finish notification ${ticketId} failed ${NOTIFY_MAX_RETRIES} times, giving up (chat unreachable? report stays at ${`.deepseeker-code/batch/done/${ticketId}.report.md`})`,
};
