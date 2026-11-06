/**
 * @file batch/feishu/message.ts
 * @description 多入口工单流水线 P4：飞书消息事件 → 工单（P4 方案 §4，与 webhook.ts 同构）。
 *
 *  归一层新入口（§2 原则 2）：飞书消息经白名单闸 → 规则闸 → 去重 → gatekeeper → 日上限 →
 *  accept 四档同闸 → 附件三态 → 建票入队。与 sync/webhook 完全同一建票管线：
 *  - accept 解析序（§9.7）：sync.json defaultAccept > 消息内 accept 块[仅 allowExternalAccept] >
 *    自动探测 > 拒建票——IM 消息里写的「验收命令」不特殊采信（复用 sync/accept.ts resolveAccept）。
 *  - 引用块边界（§4.3）：外部文本是数据不是指令（QUOTE_PREAMBLE + 逐行 "> " 包裹）。
 *  - 附件三态（§5.2.2）：processAttachmentList 复用，飞书侧经 im.message.resource 下载
 *    （feishu://resource/<messageId>/<fileKey>?type=… 合成 url，下载器由 listen 注入）；
 *    权限/下载失败逐条标「未读取 + 原因」，绝不静默。
 *  - 去重/锁/日上限：.sync.lock + sync-state（内容哈希 source-id）+ maxTicketsPerDay 全复用。
 *  - 预算（§9.6）：budget-yuan = min(feishu.budgetYuan, sync.defaultBudgetYuan)——IM 强制小额。
 *
 *  ★ 轻模块红线（守门测试钉死 import 白名单）：零 SDK、零 LLM、零网络——SDK 与 LLM 全部经 deps
 *    注入（download / gatekeeperJudge / botOpenId），单测不打真网、不碰真飞书。
 *  ★ 规则闸作者项刻意不叠加 sync.json authorAllowlist：feishu 的作者白名单 = chats/users 本身
 *    （闸已过）；叠加 issue 侧名单会把所有 ou_xxx 发送者误杀。
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { batchQueueRoot, enqueueTicketFile, readReport, acquireRunLock, releaseRunLock } from "../queue.ts";
import { generateBatchId, parseBatchTicket, type BatchTicket } from "../ticket.ts";
import { doneTicketPath, extractPrevReportSummary } from "../continuation.ts";
import { recordMsgMap } from "./notify.ts";
import { loadSyncConfig, type SyncConfig, type SyncLocale } from "../sync/config.ts";
import { acquireSyncLock, releaseSyncLock } from "../sync/lock.ts";
import { loadSyncState, appendSyncState, syncFingerprint, todayTicketCount, type SyncStateEntry } from "../sync/state.ts";
import { resolveAccept, extractExternalAccept } from "../sync/accept.ts";
import { applyRuleGate, normalizeTitle } from "../sync/rulegate.ts";
import { processAttachmentList, type DownloadFile, type AttachmentItem, type SyncAttachmentResult } from "../sync/attachments.ts";
import { QUOTE_PREAMBLE, buildQuotedExternalBody } from "../sync/boundary.ts";
import type { FeishuConfig } from "./config.ts";

// ============ 消息事件归一（SDK 面的形状在此收拢，listen/对账两侧共用） ============

/** 飞书消息资源（图片/文件），下载经 feishu:// 合成 url 走注入的 DownloadFile。 */
export interface FeishuResource {
    fileKey: string;
    kind: "image" | "file";
    /** 文件名（file 消息自带；图片无则留空由附件内核合成）。 */
    name?: string;
}

/** 归一后的消息候选（白名单闸 / 规则闸 / 建票管线的统一输入）。 */
export interface FeishuMessageCandidate {
    messageId: string;
    chatId: string;
    chatType: "p2p" | "group";
    /** 发送者 open_id（白名单与 source-id 用）。 */
    senderOpenId: string;
    /** 提取的纯文本（text 正文 / post 富文本文字段；图片等无文字消息为空串）。 */
    text: string;
    /** 提及列表（群 @机器人判定用）。 */
    mentions: { openId?: string; key?: string }[];
    /** 飞书 create_time（毫秒字符串；对账游标用）。 */
    createTimeMs: string;
    /** 消息携带的可下载资源。 */
    resources: FeishuResource[];
    /** 原始 message_type（不支持的类型跳过并留日志，不静默）。 */
    messageType: string;
    /** 回复目标消息 id（用户在会话里「回复」某条消息时平台带的 parent_id；普通消息无此字段）。
     *  回复即续修的路由键：命中消息映射表（notify.ts）→ 追加/续修那张票。 */
    parentId?: string;
}

/** 合成资源下载 url（DownloadFile 消费；listen 侧解析回 messageId/fileKey 调 SDK）。 */
export const feishuResourceUrl = (messageId: string, r: FeishuResource): string =>
    `feishu://resource/${encodeURIComponent(messageId)}/${encodeURIComponent(r.fileKey)}?type=${r.kind}`;

/**
 * 归一 im.message.receive_v1 事件数据 → 候选。v1 支持 text / post（取文字段+图片资源）/
 * image / file；其余类型返回 null（调用方留一行跳过日志，不静默）。解析失败（缺 message/sender、
 * content 非法 JSON）也返回 null——事件形态异常不值得建票，但必须留日志。
 *
 * 形态兼容两路（字段名归一）：
 * - 事件路：{ message: { message_type, content, chat_id, chat_type, mentions }, sender: { sender_id: { open_id } } }
 * - 列表路（im/v1/messages 对账拉取 item，2026-11-06 真机实锤字段名）：{ msg_type, body: { content },
 *   chat_id, chat_type, mentions[{id:"ou_…",id_type,key}] , sender: { id, id_type } }——类型字段叫
 *   **msg_type**（非 type/message_type）；mentions.id 是字符串 open_id（非事件路的 {open_id} 对象）。
 */
export const normalizeMessageEvent = (data: any): FeishuMessageCandidate | null => {
    const m = data?.message ?? data; // 事件包一层 message；列表 item 本身就是消息体
    const senderOpenId: string | undefined =
        data?.sender?.sender_id?.open_id
        ?? data?.sender?.senderId?.open_id
        ?? (data?.sender?.id_type === "open_id" || data?.sender?.idType === "open_id" ? data?.sender?.id : undefined)
        ?? (m?.sender?.sender_id?.open_id ?? (m?.sender?.id_type === "open_id" ? m?.sender?.id : undefined));
    if (!m || typeof m.message_id !== "string" || typeof m.chat_id !== "string" || !senderOpenId) return null;
    if (m.deleted === true) return null; // 列表路可能含已删除消息（真机 item 带 deleted 标志）
    const chatType: "p2p" | "group" = m.chat_type === "group" ? "group" : "p2p";
    const type = typeof m.message_type === "string" ? m.message_type // 事件路
        : typeof m.msg_type === "string" ? m.msg_type // 列表路（真机实锤）
            : typeof m.type === "string" ? m.type : "";
    const mentions: { openId?: string; key?: string }[] = Array.isArray(m.mentions)
        ? m.mentions.map((x: any) => ({ openId: x?.id?.open_id ?? x?.id?.openId ?? (x?.id_type === "open_id" ? x?.id : undefined), key: typeof x?.key === "string" ? x.key : undefined }))
        : [];
    let text = "";
    const resources: FeishuResource[] = [];
    try {
        const rawContent = m.content ?? m.body?.content;
        const content = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
        if (type === "text" && typeof content?.text === "string") {
            text = content.text;
            // @提及占位符（@_user_1）不是任务内容：按 mentions[].key 剔除，避免污染标题与正文
            for (const mk of mentions) {
                if (mk.key) text = text.split(mk.key).join(" ");
            }
        } else if (type === "post" && content?.content !== undefined) {
            // 富文本：递归取 text/a 段；img/file 节点收资源（下载走 resource API，与独立图片/文件消息同路）。
            const walk = (nodes: any[]): void => {
                if (!Array.isArray(nodes)) return;
                for (const n of nodes) {
                    if (Array.isArray(n)) { walk(n); continue; } // 飞书 post 结构 = 段落数组的数组
                    if (!n || typeof n !== "object") continue;
                    if ((n.tag === "text" || n.tag === "a") && typeof n.text === "string") text += (text ? "\n" : "") + n.text;
                    else if (n.tag === "img" && typeof n.image_key === "string") resources.push({ fileKey: n.image_key, kind: "image" });
                    else if (n.tag === "file" && typeof n.file_key === "string") resources.push({ fileKey: n.file_key, kind: "file", name: typeof n.file_name === "string" ? n.file_name : undefined });
                    else if (Array.isArray(n.content)) walk(n.content);
                }
            };
            walk(Array.isArray(content.content) ? content.content : []);
            if (typeof content.title === "string" && content.title.trim()) text = `${content.title}\n${text}`;
        } else if (type === "image" && typeof content?.image_key === "string") {
            resources.push({ fileKey: content.image_key, kind: "image" });
        } else if (type === "file" && typeof content?.file_key === "string") {
            resources.push({ fileKey: content.file_key, kind: "file", name: typeof content.file_name === "string" ? content.file_name : undefined });
        } else {
            return null; // 音视频/表情包/合并转发等 v1 不支持——调用方留跳过日志
        }
    } catch {
        return null; // content 不是合法 JSON——形态异常不建票（fail-closed，留日志）
    }
    return {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType,
        senderOpenId,
        text: text.trim(),
        mentions,
        createTimeMs: String(m.create_time ?? ""),
        resources,
        messageType: type,
        parentId: typeof m.parent_id === "string" && m.parent_id ? m.parent_id : undefined,
    };
};

// ============ 白名单闸（群：chat_id ∈ chats 且（非 mentionOnly 或被 @机器人）；私聊：open_id ∈ users） ============

export type FeishuGateVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 白名单闸。@机器人判定：mentions[].id.open_id === botOpenId，或正文含 <at user_id="botOpenId"> 标签
 * （两种形态平台都出过）。botOpenId 未知且群消息要求 mention → 拒收并给明示原因（fail-visible：
 * 宁可漏票提示修配置，不可放开成「群里任何消息都出票」）。
 */
export const feishuGateVerdict = (c: FeishuMessageCandidate, cfg: FeishuConfig, botOpenId?: string): FeishuGateVerdict => {
    if (c.chatType === "p2p") {
        if (!cfg.users.includes(c.senderOpenId)) return { ok: false, reason: `私聊发送者不在 users 白名单：${c.senderOpenId}` };
        return { ok: true };
    }
    if (!cfg.chats.includes(c.chatId)) return { ok: false, reason: `群不在 chats 白名单：${c.chatId}` };
    if (!cfg.mentionOnlyInGroup) return { ok: true };
    const atTag = typeof botOpenId === "string" && botOpenId ? c.text.includes(`user_id="${botOpenId}"`) : false;
    const mentioned = (!!botOpenId && c.mentions.some((x) => x.openId === botOpenId)) || atTag;
    if (!mentioned) {
        return {
            ok: false,
            reason: botOpenId
                ? "群消息未 @机器人（mentionOnlyInGroup=true，仅 @机器人 出票）"
                : "无法确认 @机器人（bot open_id 获取失败）：mentionOnlyInGroup=true 下本条拒收——修好 bot info 后重发，或把 mentionOnlyInGroup 配为 false",
        };
    }
    return { ok: true };
};

// ============ 票源文本零件 ============

/** 飞书票身份键（内容哈希，webhook 同法）：feishu:<发送者open_id>:<sha1(消息文本) 前12hex>。 */
export const feishuSourceId = (senderOpenId: string, text: string): string =>
    `feishu:${senderOpenId}:${createHash("sha1").update(text, "utf-8").digest("hex").slice(0, 12)}`;

/** title = 消息首行截 120（压空白；空消息回退「飞书工单」——空文本在建票前已被文本闸拒绝，此处仅兜底）。 */
export const feishuTitleOf = (text: string): string => {
    const first = text.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim()) ?? "";
    const t = first.replace(/\s+/g, " ").trim().slice(0, 120);
    return t || "飞书工单";
};

/** 飞书票的验收解析结果（对齐 webhook 的 WebhookAcceptResolution）。 */
export interface FeishuAcceptResolution {
    accept: string;
    origin: "config" | "external" | "detect";
    needsReview: boolean;
    detectSource?: string;
    /** 消息带了 accept 块但 allowExternalAccept 未开启 → 已忽略（票内注记，不静默）。 */
    ignoredExternalAccept?: boolean;
}

/**
 * 组装飞书工单源文本（frontmatter + 引用块正文 + 注记 + 附件段）。与 buildWebhookTicketSource 同构：
 * frontmatter 只给人与策略，agent 只见 body（引用块 = 数据边界，§4.3）。
 */
export const buildFeishuTicketSource = (args: {
    title: string;
    body: string;
    acc: FeishuAcceptResolution;
    sourceId: string;
    needsReview: boolean;
    config: SyncConfig;
    budgetYuan: number;
    att?: SyncAttachmentResult;
    preId?: string;
    locale: SyncLocale;
    /** 反馈闭环（P4）：回执/报告推送目标会话与回复路由键（票跑完 finishTicket 按此落通知）。 */
    feishu?: { chatId: string; messageId: string; senderOpenId: string };
}): string => {
    const c = args.config;
    const lines = [
        "---",
        `title: ${args.title}`,
        `accept: ${args.acc.accept}`,
        c.defaultSetup ? `setup: ${c.defaultSetup}` : null,
        "source: feishu",
        `source-id: ${args.sourceId}`,
        args.feishu ? `feishu-chat: ${args.feishu.chatId}` : null,
        args.feishu ? `feishu-msg: ${args.feishu.messageId}` : null,
        args.feishu ? `feishu-sender: ${args.feishu.senderOpenId}` : null,
        args.needsReview ? "needs-review: true" : null,
        `budget-yuan: ${args.budgetYuan}`,
        args.att?.dir && args.preId ? `attachments: batch/attachments/${args.preId}` : null,
        "---",
        "",
        buildQuotedExternalBody(QUOTE_PREAMBLE[args.locale], "feishu", args.title, args.body),
    ];
    let text = lines.filter((l) => l !== null).join("\n") + "\n";
    if (args.acc.origin !== "config") {
        const desc = args.acc.origin === "detect" ? (args.acc.detectSource ?? "") : msg(args.locale, "acceptFromExternal");
        text += `---\n${msg(args.locale, "acceptNote", desc)}\n`;
    }
    if (args.acc.ignoredExternalAccept) {
        const head = args.locale === "zh" ? "验收字段说明" : "Accept field note";
        const note = args.locale === "zh"
            ? "消息携带了 accept 代码块，但 sync.json 未开启 allowExternalAccept——外部验收命令默认不采信，该块已被忽略（当前验收命令来自本地配置或自动探测）。"
            : "The message carried an accept fenced block, but allowExternalAccept is not enabled in sync.json — external acceptance commands are ignored by default, so the block was dropped (the current accept comes from local config or auto-detection).";
        text += `---\n${head}：${note}\n`;
    }
    if (args.att?.section) text += `\n${args.att.section}\n`;
    return text;
};

// ============ 双语文案（照 webhook.ts 模式） ============

const FEISHU_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        badBody: "消息文本为空（图片/文件类消息请附一句话说明要修什么）。",
        missingAccept: "缺验收命令：宁可不自动做，不猜验收。补法（任选其一）：\n  1) 在 sync.json 加 \"defaultAccept\": \"<验收命令>\"（全仓库统一缺省）；\n  2) 在消息里写 ```accept 代码块（单行命令），并在 sync.json 开启 \"allowExternalAccept\": true（默认忽略外部命令）；\n  3) 让仓库可探测：提供 package.json scripts.test / Makefile test 目标 / go.mod。",
        externalBadShape: "accept 代码块被拒（形态不合规）：只接受单行「可执行名+参数」，禁 | & ; < > ` $ 与换行（allowExternalAccept 开启也不放行管道/重定向/换行）。",
        configFail: (e: string) => `sync.json 配置非法，拒绝建票（fail-closed）：${e}`,
        created: (id: string, title: string) => `📥 [feishu] 新票 [${id}] ${title}`,
        duplicate: (sourceId: string) => `⏭️ [feishu] 已见未变，跳过（duplicate）：${sourceId}`,
        rejected: (reason: string) => `🚫 [feishu] 拒绝建票：${reason}`,
        gatekeeperReject: (reason: string) => `🚫 [feishu] gatekeeper 判定 reject：${reason}`,
        gatekeeperFail: (e: string) => `⚠️ [feishu] gatekeeper 判定失败（本条按放行处理）：${e}`,
        enqueueFail: (err: string) => `🚫 [feishu] 建票失败：${err}`,
        stateFail: (e: string) => `⚠️ [feishu] sync-state 记录失败（票已入队，勿重发同内容）：${e}`,
        ignoredAcceptOut: "消息携带了 accept 代码块但 allowExternalAccept 未开启：已忽略（票内已注记）。",
        acceptFromExternal: "飞书消息 accept 代码块（allowExternalAccept 已开启；单命令形态校验通过，已强制 needs-review 人工复核）",
        acceptNote: (desc: string) => `验收命令说明：accept 来自 ${desc}。`,
        attNoDownloader: "下载器未注入（listen 未接 SDK）",
    },
    en: {
        badBody: "Message text is empty (for image/file messages, add a sentence describing what to fix).",
        missingAccept: "Missing acceptance command: rather than guessing, no ticket. Fix with either:\n  1) add \"defaultAccept\": \"<command>\" in sync.json (repo-wide default);\n  2) write a ```accept fenced block in the message (single-line command) and set \"allowExternalAccept\": true in sync.json (external commands are ignored by default);\n  3) make the repo detectable: package.json scripts.test / a Makefile test target / go.mod.",
        externalBadShape: "accept block rejected (bad shape): only a single-line \"executable + args\" form is allowed; | & ; < > ` $ and newlines are banned even with allowExternalAccept on.",
        configFail: (e: string) => `sync.json is invalid; refusing to create tickets (fail-closed): ${e}`,
        created: (id: string, title: string) => `📥 [feishu] new ticket [${id}] ${title}`,
        duplicate: (sourceId: string) => `⏭️ [feishu] seen and unchanged, skipping (duplicate): ${sourceId}`,
        rejected: (reason: string) => `🚫 [feishu] rejected: ${reason}`,
        gatekeeperReject: (reason: string) => `🚫 [feishu] gatekeeper verdict reject: ${reason}`,
        gatekeeperFail: (e: string) => `⚠️ [feishu] gatekeeper judge failed (message passes this time): ${e}`,
        enqueueFail: (err: string) => `🚫 [feishu] failed to enqueue: ${err}`,
        stateFail: (e: string) => `⚠️ [feishu] failed to append sync-state (ticket IS enqueued; do not resend the same content): ${e}`,
        ignoredAcceptOut: "The message carried an accept block but allowExternalAccept is off: ignored (noted inside the ticket).",
        acceptFromExternal: "the Feishu message accept block (allowExternalAccept on; single-command shape validated; needs-review forced)",
        acceptNote: (desc: string) => `Accept command note: accept from ${desc}.`,
        attNoDownloader: "downloader not injected (listen has no SDK)",
    },
};
const msg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (FEISHU_MSG[locale] ?? FEISHU_MSG.zh)[key] ?? FEISHU_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

// ============ 注入面与主入口（纯逻辑，零 SDK / 零网络） ============

export interface FeishuDeps {
    /** bot open_id（群 @机器人判定；listen 启动时经通用 request 打 /bot/v3/info 取，取不到传 undefined = 群 mention 档拒收）。 */
    botOpenId?: string;
    /** 飞书资源下载器（listen 注入 SDK 实现；缺省全部标「未读取」不静默）。 */
    download?: DownloadFile;
    /** LLM gatekeeper 单判（listen 注入；仅 cfg.gatekeeper=true 时调用）。 */
    gatekeeperJudge?: (args: { title: string; body: string; candidate: FeishuMessageCandidate }) => Promise<{ verdict: "work" | "reject"; reason?: string }>;
    /** 日志通道（缺省 process.stdout.write）。 */
    out?: (line: string) => void;
    /** 测试时钟（票 id 时间戳 / state seenAt / 每日上限）。 */
    now?: () => Date;
    /** sync.json 发现根（缺省 batchQueueRoot()）。锁/state/队列仍走 batchQueueRoot（env 可重定向）。 */
    queueRoot?: string;
    /** 本地自动探测的项目根（缺省 process.cwd()）。 */
    projectRoot?: string;
    locale?: SyncLocale;
}

export type FeishuTicketResult =
    | { ok: true; action: "created"; ticketId: string }
    | { ok: true; action: "duplicate"; ticketId?: string }
    | { ok: true, action: "skipped"; reason: string }
    | { ok: true; action: "appended"; ticketId: string; title: string; reason: string }
    | { ok: true; action: "followup-created"; ticketId: string; prevId: string; reason: string }
    | { ok: false; error: string };

/** 读策略配置原文：queueRoot 下 sync.json；文件不存在 = 全缺省（复用既有键零新键，webhook 同法）。 */
const readConfigRaw = async (queueRoot: string): Promise<string> => {
    try {
        return await fs.readFile(path.join(queueRoot, "sync.json"), "utf-8");
    } catch {
        return "{}";
    }
};

/** 记一条 reject 进 sync-state（防对账重拉时重复过 gatekeeper 烧钱）；失败只吞（不阻塞主流程）。 */
const recordReject = async (sourceId: string, fingerprint: string, title: string, reason: string, now: () => Date): Promise<void> => {
    try {
        await appendSyncState({ sourceId, seenAt: now().toISOString(), fingerprint, verdict: "reject", reason, title });
    } catch { /* state 失败只影响下轮免判，不阻塞 */ }
};

/**
 * 处理一条飞书消息（白名单 → 配置 → 去重 → 规则闸 → gatekeeper → 锁内复核 → 日上限 → accept 四档
 * → 附件 → 建票）。所有失败都返回结构化结果（不抛）——常驻进程不能被单条坏消息击垮。
 */
export const handleFeishuMessage = async (candidate: FeishuMessageCandidate, fcfg: FeishuConfig, deps?: FeishuDeps): Promise<FeishuTicketResult> => {
    const locale = deps?.locale ?? "zh";
    const out = deps?.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const now = deps?.now ?? (() => new Date());
    const queueRoot = deps?.queueRoot ?? batchQueueRoot();
    const projectRoot = deps?.projectRoot ?? process.cwd();

    // —— 1. 白名单闸（fail-visible：拒收原因留日志，发件人重发可恢复）——
    const gate = feishuGateVerdict(candidate, fcfg, deps?.botOpenId);
    if (!gate.ok) return { ok: true, action: "skipped", reason: gate.reason };

    const title = feishuTitleOf(candidate.text);
    const sourceId = feishuSourceId(candidate.senderOpenId, candidate.text);
    const fingerprint = syncFingerprint(title, candidate.text, []);

    // —— 2. 策略配置（复用 sync.json 既有键零新键；错配置 fail-closed 拒建）——
    const cfg = await loadSyncConfig({ raw: await readConfigRaw(queueRoot), locale, allowNoSource: true });
    if (!cfg.ok) return { ok: false, error: msg(locale, "configFail", cfg.error) };
    const config = cfg.config;

    // —— 3. 状态预读（去重 + 规则闸已知标题；正式去重在锁内复核）——
    const state = await loadSyncState();
    const existing = state.get(sourceId) as SyncStateEntry | undefined;
    if (existing && existing.fingerprint === fingerprint) {
        if (existing.verdict === "work") {
            out(msg(locale, "duplicate", sourceId));
            return { ok: true, action: "duplicate", ticketId: existing.ticketId };
        }
        return { ok: true, action: "skipped", reason: existing.reason ? `已见过（曾拒绝：${existing.reason}）` : "已见过（曾拒绝）" };
    }

    // —— 4. 规则闸（复用 applyRuleGate：屏蔽词/正文超长/同标题重复；作者项刻意不叠加，见文件头）——
    const knownTitles = new Set<string>();
    for (const e of state.values()) if (e.verdict === "work" && e.title) knownTitles.add(normalizeTitle(e.title));
    const gateVerdict = applyRuleGate(
        { sourceId, url: "", title, body: candidate.text, author: candidate.senderOpenId, comments: [] } as any,
        { ...config, authorAllowlist: undefined } as SyncConfig,
        knownTitles,
        locale,
    );
    if (!gateVerdict.work) {
        out(msg(locale, "rejected", gateVerdict.reason));
        await recordReject(sourceId, fingerprint, title, gateVerdict.reason, now);
        return { ok: true, action: "skipped", reason: gateVerdict.reason };
    }

    // —— 5. gatekeeper（LLM 单判，默认关；开且未注入 judge → 留日志放行，fail-visible）——
    if (fcfg.gatekeeper) {
        if (!deps?.gatekeeperJudge) {
            out(msg(locale, "gatekeeperFail", "judge 未注入（listen 未接 LLM）"));
        } else {
            try {
                const v = await deps.gatekeeperJudge({ title, body: candidate.text.slice(0, 2000), candidate });
                if (v.verdict === "reject") {
                    const reason = v.reason ?? "gatekeeper 判定不值得开工";
                    out(msg(locale, "gatekeeperReject", reason));
                    await recordReject(sourceId, fingerprint, title, reason, now);
                    return { ok: true, action: "skipped", reason };
                }
            } catch (e: any) {
                out(msg(locale, "gatekeeperFail", String(e?.message ?? e)));
            }
        }
    }

    // —— 6. 临界区（.sync.lock：与 sync/webhook 互斥，防并发建票与 state 竞态）——
    const lock = await acquireSyncLock(locale);
    if (!lock.ok) return { ok: false, error: lock.error };
    try {
        // 锁内复核去重（对账与实时事件可能并发到达）
        const state2 = await loadSyncState();
        const existing2 = state2.get(sourceId) as SyncStateEntry | undefined;
        if (existing2 && existing2.fingerprint === fingerprint) {
            if (existing2.verdict === "work") return { ok: true, action: "duplicate", ticketId: existing2.ticketId };
            return { ok: true, action: "skipped", reason: existing2.reason ? `已见过（曾拒绝：${existing2.reason}）` : "已见过（曾拒绝）" };
        }

        // —— 7. 每日上限（复用 maxTicketsPerDay：feishu 票计入同一配额）——
        if (config.maxTicketsPerDay !== undefined && (await todayTicketCount(now())) >= config.maxTicketsPerDay) {
            const reason = locale === "zh" ? `今日建票已达上限 ${config.maxTicketsPerDay}（maxTicketsPerDay）` : `daily ticket cap reached (${config.maxTicketsPerDay}, maxTicketsPerDay)`;
            return { ok: true, action: "skipped", reason };
        }

        // —— 8. 文本闸（空文本：图片/文件消息没一句话说明，不猜任务）——
        if (!candidate.text.trim()) return { ok: true, action: "skipped", reason: msg(locale, "badBody") };

        // —— 9. accept 四档同闸（§9.7，复用 resolveAccept：配置 > 外部块[gated] > 探测 > 拒绝）——
        const external = extractExternalAccept(candidate.text);
        const r = await resolveAccept(title, candidate.text, config, locale, projectRoot);
        let acc: FeishuAcceptResolution;
        if (r.ok) {
            acc = { accept: r.accept, origin: r.origin, needsReview: r.needsReview, detectSource: r.detectSource, ignoredExternalAccept: external !== null && config.allowExternalAccept !== true };
        } else {
            // 拒绝分型：带了 accept 块 = 形态/空块错误；没带 = 「缺验收」给人话指引
            return { ok: true, action: "skipped", reason: external !== null ? msg(locale, "externalBadShape") : msg(locale, "missingAccept") };
        }
        if (acc.ignoredExternalAccept) out(`⚠️ [feishu] ${msg(locale, "ignoredAcceptOut")}`);

        // —— 10. 附件三态（复用 processAttachmentList；feishu:// 合成 url 走注入下载器）——
        const preId = generateBatchId(now());
        let att: SyncAttachmentResult | undefined;
        if (candidate.resources.length > 0) {
            const items: AttachmentItem[] = candidate.resources.map((res) => ({
                url: feishuResourceUrl(candidate.messageId, res),
                rawName: res.name ?? "",
            }));
            const download: DownloadFile = deps?.download ?? (async () => ({ ok: false, reason: msg(locale, "attNoDownloader") }));
            try {
                att = await processAttachmentList({ items, ticketId: preId, locale, download });
            } catch (e: any) {
                const why = String(e?.message ?? e).slice(0, 120);
                att = {
                    section: locale === "zh" ? `### 附件——未读取：附件处理异常（${why}）` : `### Attachments — not read: processing error (${why})`,
                    needsReview: false,
                    anyAttachment: true,
                };
            }
        }

        // —— 11. 建票入队（预算 = min(feishu.budgetYuan, sync.defaultBudgetYuan)，IM 强制小额 §9.6）——
        const budgetYuan = config.defaultBudgetYuan !== undefined ? Math.min(fcfg.budgetYuan, config.defaultBudgetYuan) : fcfg.budgetYuan;
        const needsReview = acc.needsReview || att?.needsReview === true;
        const source = buildFeishuTicketSource({
            title, body: candidate.text, acc, sourceId, needsReview, config, budgetYuan, att, preId, locale,
            feishu: { chatId: candidate.chatId, messageId: candidate.messageId, senderOpenId: candidate.senderOpenId },
        });
        const tmp = path.join(os.tmpdir(), `dsc-feishu-ticket-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
        let enq: { ok: true; id: string; title: string } | { ok: false; error: string };
        try {
            await fs.writeFile(tmp, source, "utf-8");
            enq = await enqueueTicketFile(tmp, locale, preId);
            if (!enq.ok && att?.dir) await fs.rm(att.dir, { recursive: true, force: true }).catch(() => { }); // 入队失败回收附件目录防孤儿
        } finally {
            await fs.rm(tmp, { force: true }).catch(() => { });
        }
        if (!enq.ok) {
            out(msg(locale, "enqueueFail", enq.error));
            return { ok: false, error: msg(locale, "enqueueFail", enq.error) };
        }

        // —— 12. state 记账（append 失败只告警——票已存在，报错会诱导重发建重复票）——
        try {
            await appendSyncState({ sourceId, ticketId: enq.id, seenAt: now().toISOString(), fingerprint, verdict: "work", title });
        } catch (e: any) {
            out(msg(locale, "stateFail", String(e?.message ?? e)));
        }
        // —— 12.5 回复路由登记：用户回复这条原消息 = 追加/续修本票（notify.ts 映射表）——
        await recordMsgMap(candidate.messageId, enq.id);
        out(msg(locale, "created", enq.id, title));
        return { ok: true, action: "created", ticketId: enq.id };
    } finally {
        await releaseSyncLock();
    }
};

// ============ 回复即续修（P4 反馈闭环：连续需求不丢上下文） ============

/**
 * 追加段构造（前票还在排队：内容并入原票正文）。引用块包裹 = §4.3 数据边界红线——
 * 追加内容与首票正文同等对待（外部数据非指令），frontmatter 一律不动。
 */
const buildAppendSection = (title: string, body: string, atIso: string, locale: SyncLocale): string => {
    const head = locale === "zh"
        ? `## 追加需求（飞书回复 · ${atIso.slice(0, 16).replace("T", " ")}）`
        : `## Follow-up (Feishu reply · ${atIso.slice(0, 16).replace("T", " ")})`;
    const label = locale === "zh" ? "feishu 回复" : "feishu reply";
    return `\n---\n\n${head}\n\n${buildQuotedExternalBody(QUOTE_PREAMBLE[locale], label, title, body)}`;
};

/**
 * 续修票源文本（前票已跑完：新票接前票产物分支，不重做）。验收/预算/超时/环境是「这个任务怎么算
 * 修好」的本地事实，从前票 frontmatter 继承（同 P2 续修链三硬约定）；body 注入前次报告摘要。
 */
const buildFeishuFollowupSource = (args: {
    prev: BatchTicket; prevId: string; prevSummary: string;
    title: string; body: string; sourceId: string; candidate: FeishuMessageCandidate; locale: SyncLocale;
}): string => {
    const zh = args.locale === "zh";
    const head = zh
        ? `【续修票】本票续修前票 ${args.prevId}（同任务有新需求）。代码基座为前票产物分支：前次修复已包含在待检出的代码里，勿重做；只处理下方新需求。本次为全新会话，前次对话上下文不可见。`
        : `[Continuation] This ticket continues ${args.prevId} (new requirements on the same task). The code base is the previous ticket's artifact branch: the previous fix is already in the checked-out tree — do NOT redo it; only handle the new requirements below. Fresh session; previous conversation is not visible.`;
    const label = zh ? "feishu 新需求" : "feishu new requirement";
    const lines = [
        "---",
        `title: ${args.title}`,
        `accept: ${args.prev.accept}`,
        args.prev.setup ? `setup: ${args.prev.setup}` : null,
        args.prev.budgetYuan !== undefined ? `budget-yuan: ${args.prev.budgetYuan}` : null,
        args.prev.timeoutMin !== undefined ? `timeout-min: ${args.prev.timeoutMin}` : null,
        "source: feishu",
        `source-id: ${args.sourceId}`,
        `continues: ${args.prevId}`,
        `feishu-chat: ${args.candidate.chatId}`,
        `feishu-msg: ${args.candidate.messageId}`,
        `feishu-sender: ${args.candidate.senderOpenId}`,
        args.prev.needsReview ? "needs-review: true" : null,
        "---",
        "",
        head,
        "",
        "## " + (zh ? "前次结果摘要" : "Previous result summary"),
        "",
        args.prevSummary,
        "",
        buildQuotedExternalBody(QUOTE_PREAMBLE[args.locale], label, args.title, args.body),
    ];
    return lines.filter((l) => l !== null).join("\n") + "\n";
};

/**
 * 处理一条「回复」（parent_id 命中消息映射表 → 路由到那张票）：
 *  - 前票还在 pending → 内容追加进原票正文（一个任务半夜一次跑完；runner 取票竞态用运行锁封窗）；
 *  - 前票已 done → 走 P2 续修链：新票 continues=前票，基座=前票产物分支，验收/预算继承；
 *  - 前票正被 runner 执行（running）或已无踪迹 → 返回 null，调用方回落正常建票流。
 * 幂等：state 去重先行（对账重拉同一条回复 → duplicate，不重复追加）。
 * ★ 调用方（listen）必须先确认 sender ∈ users 白名单——回复关系不是白名单的替代。
 */
export const handleFeishuFollowup = async (candidate: FeishuMessageCandidate, prevTicketId: string, fcfg: FeishuConfig, deps?: FeishuDeps): Promise<FeishuTicketResult | null> => {
    const locale = deps?.locale ?? "zh";
    const out = deps?.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const now = deps?.now ?? (() => new Date());
    void fcfg; // 白名单校验在调用方（见文件头注）；本函数只管票的合并与续接

    const title = feishuTitleOf(candidate.text);
    const sourceId = feishuSourceId(candidate.senderOpenId, candidate.text);
    const fingerprint = syncFingerprint(title, candidate.text, []);

    // —— 1. 去重先行（对账重拉同一条回复不重复追加/续修）——
    const state = await loadSyncState();
    const existing = state.get(sourceId) as SyncStateEntry | undefined;
    if (existing && existing.fingerprint === fingerprint) {
        if (existing.verdict === "work") return { ok: true, action: "duplicate", ticketId: existing.ticketId };
        return { ok: true, action: "skipped", reason: existing.reason ? `已见过（曾拒绝：${existing.reason}）` : "已见过（曾拒绝）" };
    }

    // —— 2. 文本闸（空文本回复与首票同规：不猜任务）——
    if (!candidate.text.trim()) return { ok: true, action: "skipped", reason: msg(locale, "badBody") };

    const pendingFile = path.join(batchQueueRoot(), "pending", `${prevTicketId}.md`);
    const runningFile = path.join(batchQueueRoot(), "running", `${prevTicketId}.md`);

    // —— 3. 前票还在排队：并入原票（运行锁封「读-改-写 vs runner 取票」竞态窗，毫秒级持锁）——
    const runLock = await acquireRunLock(locale);
    if (runLock.ok) {
        try {
            let src: string | null = null;
            try {
                src = await fs.readFile(pendingFile, "utf-8");
            } catch { /* 不在 pending：走 4/5 */ }
            if (src !== null) {
                const updated = src + buildAppendSection(title, candidate.text, now().toISOString(), locale);
                const tmp = `${pendingFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
                await fs.writeFile(tmp, updated, "utf-8");
                await fs.rename(tmp, pendingFile); // 原子换：锁内无取票竞争，rename 即成
                await appendSyncState({ sourceId, ticketId: prevTicketId, seenAt: now().toISOString(), fingerprint, verdict: "work", title }).catch(() => { });
                await recordMsgMap(candidate.messageId, prevTicketId);
                const prevTitle = titleOfTicketSource(src) ?? prevTicketId;
                out(`➕ [feishu] 回复并入排队票 [${prevTicketId}] ${prevTitle}`);
                return {
                    ok: true, action: "appended", ticketId: prevTicketId, title: prevTitle,
                    reason: locale === "zh" ? `已并入排队中的票 ${prevTicketId}` : `appended to queued ticket ${prevTicketId}`,
                };
            }
        } finally {
            await releaseRunLock();
        }
    }

    // —— 4. 前票正在被 runner 执行：不并（半途塞内容 runner 看不见），回落正常建票 ——
    try {
        await fs.access(runningFile);
        return null;
    } catch { /* 不在 running：继续 */ }

    // —— 5. 前票已跑完：续修链（新票继承验收/预算，基座=前票产物分支）——
    let prevSrc: string;
    try {
        prevSrc = await fs.readFile(doneTicketPath(prevTicketId), "utf-8");
    } catch {
        return null; // 无踪迹（存档被 clean 等）→ 调用方回落正常建票
    }
    const parsed = parseBatchTicket(prevSrc, locale);
    if (!parsed.ok) return null; // 前票损坏：不当续修建，回落正常流
    const prev = parsed.ticket;

    // 日上限同闸（续修票也占配额——与 handleFeishuMessage 同一把尺）
    const cfg = await loadSyncConfig({ raw: await readConfigRaw(deps?.queueRoot ?? batchQueueRoot()), locale, allowNoSource: true });
    if (!cfg.ok) return { ok: false, error: msg(locale, "configFail", cfg.error) };
    if (cfg.config.maxTicketsPerDay !== undefined && (await todayTicketCount(now())) >= cfg.config.maxTicketsPerDay) {
        return { ok: true, action: "skipped", reason: locale === "zh" ? `今日建票已达上限 ${cfg.config.maxTicketsPerDay}（maxTicketsPerDay）` : `daily ticket cap reached (${cfg.config.maxTicketsPerDay}, maxTicketsPerDay)` };
    }

    const prevSummary = extractPrevReportSummary(await readReport(prevTicketId), locale);
    const preId = generateBatchId(now());
    const source = buildFeishuFollowupSource({ prev, prevId: prevTicketId, prevSummary, title, body: candidate.text, sourceId, candidate, locale });
    const tmp = path.join(os.tmpdir(), `dsc-feishu-followup-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
    let enq: { ok: true; id: string; title: string } | { ok: false; error: string };
    try {
        await fs.writeFile(tmp, source, "utf-8");
        enq = await enqueueTicketFile(tmp, locale, preId);
    } finally {
        await fs.rm(tmp, { force: true }).catch(() => { });
    }
    if (!enq.ok) {
        out(msg(locale, "enqueueFail", enq.error));
        return { ok: false, error: msg(locale, "enqueueFail", enq.error) };
    }
    await appendSyncState({ sourceId, ticketId: enq.id, seenAt: now().toISOString(), fingerprint, verdict: "work", title }).catch(() => { });
    await recordMsgMap(candidate.messageId, enq.id);
    out(`🔁 [feishu] 续修票 [${enq.id}]（接 ${prevTicketId}）${title}`);
    return {
        ok: true, action: "followup-created", ticketId: enq.id, prevId: prevTicketId,
        reason: locale === "zh" ? `续修票 ${enq.id}（接 ${prevTicketId}）已建` : `continuation ticket ${enq.id} (after ${prevTicketId}) created`,
    };
};

/** 从票源文本取 title frontmatter（追加回执显示原票标题用；取不到回退 null）。 */
const titleOfTicketSource = (src: string): string | null => {
    const m = /^title:\s*(.*)$/m.exec(src);
    return m ? m[1].trim() || null : null;
};
