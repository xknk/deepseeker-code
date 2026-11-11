/**
 * @file batch/webhook.ts
 * @description 多入口工单流水线 P3：本地 webhook 端点（方案 §7）——POST /hooks/:channel → 建票入队。
 *
 *  归一层新入口（§2 原则 2：一切入口归一为工单文件）：内网 CI 失败钩子 / 测试流程 POST → 统一工单
 *  pending/，由既有 batch 内核（worktree 隔离 + 验收 + 看门狗）执行。与 sync 建票完全同语义：
 *  accept 解析同闸（§9.7 外部 accept 默认忽略，allowExternalAccept 显式开启 + 单命令形态校验 +
 *  强制 needs-review）、引用块边界（§4.3 外部文本是数据不是指令）、附件三态（§5.2.2/§9.10，
 *  processAttachmentList 复用）、.sync.lock 临界区 + sync-state 去重 + maxTicketsPerDay 日上限。
 *  另加每 channel 固定窗口限流（防坏掉的 CI 洪水灌队）。
 *
 *  ★ 轻模块红线（守门测试钉死 import 白名单）：零 LLM、零 express、零外部命令——
 *    handleWebhook(channel, payload, deps) 纯逻辑，deps 注入 fetch/download/out/now/queueRoot/
 *    projectRoot，单测不启服务、不打真网。
 *  ★ 配置面刻意零新键：本地 sync.json 被旧版全局 CLI（1.0.65）的定时器共读，未知键会 fail-closed
 *    拒载整份配置 = 定时器停摆——只复用既有键（defaultAccept/defaultSetup/defaultBudgetYuan/
 *    maxTicketsPerDay/allowExternalAccept/maxBodyLength/testPathPatterns），经 loadSyncConfig
 *    {allowNoSource:true} 读取（webhook-only 用户可不配拉模式源）。限流阈值走环境变量
 *    DEEPSEEKER_CODE_WEBHOOK_RATE（进程级，不落盘）。
 *  ★ 去重键 = 内容哈希：source-id = webhook:<channel>:<sha1(title+"\n"+body) 前 12 hex>——
 *    CI 同内容重推天然同 id → 200 duplicate；内容变了 → 新 id 新票（webhook 无续修，v1 刻意不做）。
 *  ★ 响应语义：200 {ok,status,ticketId?}；400 形态错/缺验收；401 鉴权（路由层 requireAuth）；
 *    429 限流/日上限/锁忙。响应绝不回显请求正文。
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { batchQueueRoot, enqueueTicketFile } from "./queue.ts";
import { generateBatchId } from "./ticket.ts";
import { loadSyncConfig, DEFAULT_MAX_BODY_LENGTH, type SyncConfig, type SyncLocale } from "./sync/config.ts";
import { acquireSyncLock, releaseSyncLock } from "./sync/lock.ts";
import { loadSyncState, appendSyncState, syncFingerprint, todayTicketCount, type SyncStateEntry } from "./sync/state.ts";
import { detectAccept, isSingleCommandShape } from "./sync/accept.ts";
import { processAttachmentList, type DownloadFile, type AttachmentItem, type SyncAttachmentResult } from "./sync/attachments.ts";
import { QUOTE_PREAMBLE, buildQuotedExternalBody } from "./sync/boundary.ts";

// ============ 注入面 ============

/** 附件下载的 HTTP 面（缺省 global fetch；测试注入假实现零真网）。 */
export type WebhookBinaryFetch = (url: string) => Promise<{ status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;

export interface WebhookDeps {
    /** 附件下载 HTTP（缺省 global fetch；makeWebhookDownloadFile 消费）。 */
    fetchImpl?: WebhookBinaryFetch;
    /** 直接注入下载器（测试假实现优先；缺省 makeWebhookDownloadFile(fetchImpl)）。 */
    download?: DownloadFile;
    /** 日志通道（缺省 process.stdout.write；一行一事，不回显请求正文）。 */
    out?: (line: string) => void;
    /** 测试时钟（票 id 时间戳 / state seenAt / 每日上限 / 限流窗口）。 */
    now?: () => Date;
    /** sync.json 发现根（缺省 batchQueueRoot()）。锁/state/队列仍走 batchQueueRoot（env 可重定向）。 */
    queueRoot?: string;
    /** 本地自动探测的项目根（缺省 process.cwd()；serve 启动目录 = 目标项目根）。 */
    projectRoot?: string;
    locale?: SyncLocale;
}

/** 统一结果：路由层薄适配成 HTTP 状态码 + JSON（绝不回显请求正文）。 */
export type WebhookResult =
    | { ok: true; http: 200; status: "created"; ticketId: string }
    | { ok: true; http: 200; status: "duplicate"; ticketId?: string }
    | { ok: false; http: 400 | 429 | 500; error: string };

// ============ 常量与校验 ============

/** channel 形态（方案 §7）：小写字母数字开头，可含 - _，最长 32。 */
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** title 有效窗口：清洗（压空白 + trim）后 1-200 字符，越界 400（不静默截断）。 */
const MAX_TITLE_LENGTH = 200;
/** 每票附件个数上限（与 sync 侧提取上限同口径）。 */
const MAX_WEBHOOK_ATTACHMENTS = 10;
/** 限流缺省：每 channel 每分钟 5 票；DEEPSEEKER_CODE_WEBHOOK_RATE（正整数）可覆盖。 */
const DEFAULT_WEBHOOK_RATE_PER_MIN = 5;

const sanitizeWebhookTitle = (t: string): string => t.replace(/\s+/g, " ").trim();

const isHttpUrl = (v: string): boolean => /^https?:\/\//i.test(v.trim());

/** webhook 票的身份键（内容哈希）：同内容重推天然同 id。 */
export const webhookSourceId = (channel: string, title: string, body: string): string =>
    `webhook:${channel}:${createHash("sha1").update(`${title}\n${body}`, "utf-8").digest("hex").slice(0, 12)}`;

// ============ 限流（固定窗口，内存 Map，进程生命周期即可） ============

const rateWindows = new Map<string, { window: number; count: number }>();

/** 测试隔离用：清空限流窗口（进程内状态，无持久化副作用）。 */
export const resetWebhookRateLimits = (): void => {
    rateWindows.clear();
};

export const webhookRatePerMinute = (): number => {
    const raw = Number(process.env.DEEPSEEKER_CODE_WEBHOOK_RATE);
    return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_WEBHOOK_RATE_PER_MIN;
};

/** 消费一个配额；窗口滚动（按分钟取整）即重置。超限返回 false（调用方回 429）。 */
const consumeRate = (channel: string, atMs: number, limit: number): boolean => {
    const win = Math.floor(atMs / 60_000);
    const cur = rateWindows.get(channel);
    if (!cur || cur.window !== win) {
        rateWindows.set(channel, { window: win, count: 1 });
        return true;
    }
    if (cur.count >= limit) return false;
    cur.count++;
    return true;
};

// ============ 双语文案（照 sync/strings.ts 模式：zh/en 成对） ============

const WEBHOOK_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        badChannel: "channel 非法：须为小写字母/数字开头、可含 - 与 _、最长 32 字符（如 ci-alert）。",
        badPayload: "请求体须为 JSON 对象（Content-Type: application/json）。",
        badTitle: "title 必填：清洗空白后 1-200 字符的字符串。",
        badBodyType: "body 须为字符串（可缺省）。",
        badBodyLong: (n: number) => `body 超长（${n} 字符）：上限 maxBodyLength（sync.json 可调，缺省 50000）。`,
        badAcceptType: "accept 须为非空字符串（可缺省）。",
        badSourceUrl: "source-url 须为 http(s):// 开头的链接（可缺省）。",
        badAttachments: "attachments 须为 {url, name?} 对象数组（url 须为 http(s) 链接，最多 10 个，可缺省）。",
        rateLimited: (n: number) => `触发限流：该 channel 每分钟最多 ${n} 票（DEEPSEEKER_CODE_WEBHOOK_RATE 可调）。请稍后重试。`,
        capReached: (n: number) => `今日建票已达上限 ${n}（maxTicketsPerDay）：其余工单明日自动恢复。`,
        lockBusy: "sync 正在运行（建票临界区被占用）：请稍后重试。",
        missingAccept: "缺验收命令：宁可不自动做，不猜验收。补法（任选其一）：\n  1) 在 sync.json 加 \"defaultAccept\": \"<验收命令>\"（全仓库统一缺省）；\n  2) 请求体带 \"accept\" 字段（单行命令），并在 sync.json 开启 \"allowExternalAccept\": true（默认忽略外部命令）；\n  3) 让仓库可探测：提供 package.json scripts.test / Makefile test 目标 / go.mod。",
        externalBadShape: "accept 被拒（形态不合规）：只接受单行「可执行名+参数」，禁 | & ; < > ` $ 与换行（allowExternalAccept 开启也不放行管道/重定向/换行）。",
        externalEmpty: "accept 为空字符串：要么删掉该字段，要么给单行命令。",
        configFail: (e: string) => `sync.json 配置非法，拒绝建票（fail-closed）：${e}`,
        created: (channel: string, id: string, title: string) => `📥 [webhook:${channel}] 新票 [${id}] ${title}`,
        duplicate: (channel: string, sourceId: string) => `⏭️ [webhook:${channel}] 已见未变，跳过（duplicate）：${sourceId}`,
        enqueueFail: (channel: string, err: string) => `🚫 [webhook:${channel}] 建票失败：${err}`,
        stateFail: (channel: string, e: string) => `⚠️ [webhook:${channel}] sync-state 记录失败（票已入队，勿重推同内容）：${e}`,
        ignoredAcceptOut: "请求携带了 accept 字段但 allowExternalAccept 未开启：已忽略（票内已注记）。",
        acceptFromExternal: "webhook 请求 accept 字段（allowExternalAccept 已开启；单命令形态校验通过，已强制 needs-review 人工复核）",
        acceptNote: (desc: string) => `验收命令说明：accept 来自 ${desc}。`,
    },
    en: {
        badChannel: "Invalid channel: must start with a lowercase letter/digit, may contain - and _, at most 32 chars (e.g. ci-alert).",
        badPayload: "Request body must be a JSON object (Content-Type: application/json).",
        badTitle: "title is required: a string of 1-200 chars after whitespace collapsing.",
        badBodyType: "body must be a string (optional).",
        badBodyLong: (n: number) => `body too long (${n} chars): cap is maxBodyLength (tune via sync.json, default 50000).`,
        badAcceptType: "accept must be a non-empty string (optional).",
        badSourceUrl: "source-url must be an http(s):// link (optional).",
        badAttachments: "attachments must be an array of {url, name?} objects (url must be http(s), at most 10, optional).",
        rateLimited: (n: number) => `Rate limited: at most ${n} tickets per minute per channel (tunable via DEEPSEEKER_CODE_WEBHOOK_RATE). Retry later.`,
        capReached: (n: number) => `Daily ticket cap reached (${n}, maxTicketsPerDay): remaining tickets resume tomorrow.`,
        lockBusy: "A sync is running (ticket-creation critical section busy): please retry later.",
        missingAccept: "Missing acceptance command: rather than guessing, no ticket. Fix with either:\n  1) add \"defaultAccept\": \"<command>\" in sync.json (repo-wide default);\n  2) carry an \"accept\" field in the request body (single-line command) and set \"allowExternalAccept\": true in sync.json (external commands are ignored by default);\n  3) make the repo detectable: package.json scripts.test / a Makefile test target / go.mod.",
        externalBadShape: "accept rejected (bad shape): only a single-line \"executable + args\" form is allowed; | & ; < > ` $ and newlines are banned even with allowExternalAccept on.",
        externalEmpty: "accept is an empty string: remove the field or provide a single-line command.",
        configFail: (e: string) => `sync.json is invalid; refusing to create tickets (fail-closed): ${e}`,
        created: (channel: string, id: string, title: string) => `📥 [webhook:${channel}] new ticket [${id}] ${title}`,
        duplicate: (channel: string, sourceId: string) => `⏭️ [webhook:${channel}] seen and unchanged, skipping (duplicate): ${sourceId}`,
        enqueueFail: (channel: string, err: string) => `🚫 [webhook:${channel}] failed to enqueue: ${err}`,
        stateFail: (channel: string, e: string) => `⚠️ [webhook:${channel}] failed to append sync-state (ticket IS enqueued; do not re-push the same content): ${e}`,
        ignoredAcceptOut: "Request carried an accept field but allowExternalAccept is off: ignored (noted inside the ticket).",
        acceptFromExternal: "the webhook request accept field (allowExternalAccept on; single-command shape validated; needs-review forced)",
        acceptNote: (desc: string) => `Accept command note: accept from ${desc}.`,
    },
};
const msg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (WEBHOOK_MSG[locale] ?? WEBHOOK_MSG.zh)[key] ?? WEBHOOK_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

// ============ 附件下载器（无鉴权头的普通 HTTP GET） ============

/**
 * 造 webhook 附件下载器（DownloadFile 形状，与 GitHub/GitLab 侧同签名——processAttachmentList 不分支）：
 * 无鉴权头的普通 HTTP GET（fetch → arrayBuffer → 落盘），大小/类型护栏全部沿用 attachments.ts
 * 既有实现（单文件 10MB / 单票 20MB / 魔数判型 / 不解压不进 worktree）。
 */
export const makeWebhookDownloadFile = (fetchImpl?: WebhookBinaryFetch): DownloadFile => {
    const f: WebhookBinaryFetch = fetchImpl ?? ((url) => fetch(url));
    return async (url, destAbs) => {
        try {
            const r = await f(url);
            if (r.status < 200 || r.status >= 300) return { ok: false, reason: `HTTP ${r.status}` };
            const bytes = Buffer.from(await r.arrayBuffer());
            await fs.writeFile(destAbs, bytes);
            return { ok: true, sizeBytes: bytes.length };
        } catch (e: any) {
            return { ok: false, reason: String(e?.message ?? e) };
        }
    };
};

// ============ 建票源文本（与 sync 票同构；勿改 buildSyncTicketSource 老签名，此为独立实现） ============

/** webhook 票的验收解析结果（含「外部 accept 被忽略」注记位）。 */
export interface WebhookAcceptResolution {
    accept: string;
    origin: "config" | "external" | "detect";
    needsReview: boolean;
    detectSource?: string;
    /** 请求带了 accept 字段但 allowExternalAccept 未开启 → 已忽略（票内注记，不静默）。 */
    ignoredExternalAccept?: boolean;
}

/**
 * 组装 webhook 工单源文本（frontmatter + 引用块正文 + 验收来源注记 + 附件段）。
 * 与 buildSyncTicketSource 同构：frontmatter 只给人与策略，agent 只见 body（引用块 = 数据边界，§4.3）。
 */
export const buildWebhookTicketSource = (args: {
    channel: string;
    title: string;
    body: string;
    acc: WebhookAcceptResolution;
    sourceId: string;
    sourceUrl?: string;
    needsReview: boolean;
    config: SyncConfig;
    att?: SyncAttachmentResult;
    preId?: string;
    locale: SyncLocale;
}): string => {
    const c = args.config;
    const lines = [
        "---",
        `title: ${args.title}`,
        `accept: ${args.acc.accept}`,
        c.defaultSetup ? `setup: ${c.defaultSetup}` : null,
        "source: webhook",
        args.sourceUrl ? `source-url: ${args.sourceUrl}` : null,
        `source-id: ${args.sourceId}`,
        args.needsReview ? "needs-review: true" : null,
        c.defaultBudgetYuan !== undefined ? `budget-yuan: ${c.defaultBudgetYuan}` : null,
        args.att?.dir && args.preId ? `attachments: batch/attachments/${args.preId}` : null,
        "---",
        "",
        buildQuotedExternalBody(QUOTE_PREAMBLE[args.locale], `webhook:${args.channel}`, args.title, args.body),
    ];
    let text = lines.filter((l) => l !== null).join("\n") + "\n";
    // 验收来源注记（与 sync 同款）：外部/探测来源必须让看票的人一眼知道 accept 哪来的。
    if (args.acc.origin !== "config") {
        const desc = args.acc.origin === "detect" ? (args.acc.detectSource ?? "") : msg(args.locale, "acceptFromExternal");
        text += `---\n${msg(args.locale, "acceptNote", desc)}\n`;
    }
    // 外部 accept 被忽略的注记（§9.7 fail-closed 的可见面）：请求方写了 accept 但配置没开闸——
    // 票里必须写明「不是没看见，是不采信」，否则 CI 作者会以为自己的验收命令生效了。
    if (args.acc.ignoredExternalAccept) {
        const head = args.locale === "zh" ? "验收字段说明" : "Accept field note";
        const note = args.locale === "zh"
            ? "请求携带了 accept 字段，但 sync.json 未开启 allowExternalAccept——外部验收命令默认不采信，该字段已被忽略（当前验收命令来自本地配置或自动探测）。"
            : "The request carried an accept field, but allowExternalAccept is not enabled in sync.json — external acceptance commands are ignored by default, so the field was dropped (the current accept comes from local config or auto-detection).";
        text += `---\n${head}：${note}\n`;
    }
    // 附件段：内联文本在引用块内、落盘给绝对路径、不可读标「未读取 + 原因」——绝不静默（§5.2.2）。
    if (args.att?.section) text += `\n${args.att.section}\n`;
    return text;
};

// ============ 主入口（纯逻辑，零 express） ============

/** 读 webhook 侧配置原文：queueRoot 下 sync.json；文件不存在 = 全缺省（webhook-only 零配置可用）。 */
const readConfigRaw = async (queueRoot: string): Promise<string> => {
    try {
        return await fs.readFile(path.join(queueRoot, "sync.json"), "utf-8");
    } catch {
        return "{}";
    }
};

/**
 * 处理一次 webhook 建票请求（P3 §7）。所有失败都返回结构化结果（不抛），路由层薄适配成 HTTP。
 * 流序：形态校验 → 限流 → 配置 → .sync.lock 临界区 → 去重 → 日上限 → accept 解析（§9.7 同闸）
 * → 附件三态 → 建票入队 → state 记账。
 */
export const handleWebhook = async (channel: string, payload: unknown, deps?: WebhookDeps): Promise<WebhookResult> => {
    const locale = deps?.locale ?? "zh";
    const out = deps?.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const now = deps?.now ?? (() => new Date());
    const queueRoot = deps?.queueRoot ?? batchQueueRoot();
    const projectRoot = deps?.projectRoot ?? process.cwd();

    // —— 1. 形态校验（fail-closed：任何字段形态错 400 + 一句人话，绝不静默）——
    if (!CHANNEL_RE.test(channel)) return { ok: false, http: 400, error: msg(locale, "badChannel") };
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return { ok: false, http: 400, error: msg(locale, "badPayload") };
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.title !== "string") return { ok: false, http: 400, error: msg(locale, "badTitle") };
    const title = sanitizeWebhookTitle(p.title);
    if (title.length < 1 || title.length > MAX_TITLE_LENGTH) return { ok: false, http: 400, error: msg(locale, "badTitle") };
    const body = p.body === undefined ? "" : p.body;
    if (typeof body !== "string") return { ok: false, http: 400, error: msg(locale, "badBodyType") };
    const rawAccept = p.accept;
    if (rawAccept !== undefined && (typeof rawAccept !== "string" || !rawAccept.trim())) {
        return { ok: false, http: 400, error: msg(locale, "badAcceptType") };
    }
    if (p["source-url"] !== undefined && (typeof p["source-url"] !== "string" || !isHttpUrl(p["source-url"]))) {
        return { ok: false, http: 400, error: msg(locale, "badSourceUrl") };
    }
    const attItems: AttachmentItem[] = [];
    if (p.attachments !== undefined) {
        if (!Array.isArray(p.attachments) || p.attachments.length > MAX_WEBHOOK_ATTACHMENTS) {
            return { ok: false, http: 400, error: msg(locale, "badAttachments") };
        }
        for (const a of p.attachments) {
            if (a === null || typeof a !== "object" || Array.isArray(a)) return { ok: false, http: 400, error: msg(locale, "badAttachments") };
            const item = a as Record<string, unknown>;
            if (typeof item.url !== "string" || !isHttpUrl(item.url)) return { ok: false, http: 400, error: msg(locale, "badAttachments") };
            if (item.name !== undefined && typeof item.name !== "string") return { ok: false, http: 400, error: msg(locale, "badAttachments") };
            attItems.push({ url: item.url, rawName: item.name ?? "" });
        }
    }

    // —— 2. 限流（固定窗口每 channel 每分钟 N 票；防坏掉的 CI 洪水灌队）——
    const rate = webhookRatePerMinute();
    if (!consumeRate(channel, now().getTime(), rate)) {
        return { ok: false, http: 429, error: msg(locale, "rateLimited", rate) };
    }

    // —— 3. 配置（复用既有键零新键；webhook-only 用户可不配源；错配置 fail-closed 拒建）——
    const cfg = await loadSyncConfig({ raw: await readConfigRaw(queueRoot), locale, allowNoSource: true });
    if (!cfg.ok) return { ok: false, http: 500, error: msg(locale, "configFail", cfg.error) };
    const config = cfg.config;
    const maxBodyLength = config.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH;
    if (body.length > maxBodyLength) return { ok: false, http: 400, error: msg(locale, "badBodyLong", body.length) };

    // —— 4. 临界区（复用 .sync.lock：与 sync/定时器互斥，防并发建票与 state 竞态）——
    const lock = await acquireSyncLock(locale);
    if (!lock.ok) return { ok: false, http: 429, error: msg(locale, "lockBusy") };
    try {
        // —— 5. 去重（§4.2 同一 state 文件）：同 sourceId 且同指纹 → duplicate（CI 重推幂等）；
        //        指纹变了 → 当新票建（webhook 无续修，v1 刻意不做）。
        const sourceId = webhookSourceId(channel, title, body);
        const fingerprint = syncFingerprint(title, body, []);
        const state = await loadSyncState();
        const existing = state.get(sourceId) as SyncStateEntry | undefined;
        if (existing && existing.fingerprint === fingerprint) {
            out(msg(locale, "duplicate", channel, sourceId));
            return { ok: true, http: 200, status: "duplicate", ticketId: existing.ticketId };
        }

        // —— 6. 每日上限（§5.2.3 复用 maxTicketsPerDay：webhook 票计入同一配额）——
        if (config.maxTicketsPerDay !== undefined && (await todayTicketCount(now())) >= config.maxTicketsPerDay) {
            return { ok: false, http: 429, error: msg(locale, "capReached", config.maxTicketsPerDay) };
        }

        // —— 7. accept 解析（§9.7 同闸，序与 sync 一致：本地配置 > 外部[gated] > 自动探测 > 拒绝）——
        let acc: WebhookAcceptResolution | undefined;
        if (config.defaultAccept && config.defaultAccept.trim()) {
            acc = { accept: config.defaultAccept.trim(), origin: "config", needsReview: false, ignoredExternalAccept: rawAccept !== undefined };
        } else if (rawAccept !== undefined && config.allowExternalAccept === true) {
            // 外部 accept：显式开启才采信，且只收单命令形态（禁管道/重定向/换行），采信即强制 needs-review。
            const candidate = (rawAccept as string).trim();
            if (!isSingleCommandShape(candidate)) return { ok: false, http: 400, error: msg(locale, "externalBadShape") };
            acc = { accept: candidate, origin: "external", needsReview: true };
        } else {
            const d = await detectAccept(projectRoot, locale);
            if (d.ok && d.accept && d.source) {
                acc = { accept: d.accept, origin: "detect", needsReview: true, detectSource: d.source, ignoredExternalAccept: rawAccept !== undefined };
            } else {
                return { ok: false, http: 400, error: msg(locale, "missingAccept") };
            }
        }
        if (acc.ignoredExternalAccept) out(`⚠️ [webhook:${channel}] ${msg(locale, "ignoredAcceptOut")}`);

        // —— 8. 附件三态（§5.2.2 复用 processAttachmentList；先占票 id 供附件目录命名）——
        const preId = generateBatchId(now());
        const download = deps?.download ?? makeWebhookDownloadFile(deps?.fetchImpl);
        let att: SyncAttachmentResult | undefined;
        if (attItems.length > 0) {
            try {
                att = await processAttachmentList({ items: attItems, ticketId: preId, locale, download });
            } catch (e: any) {
                const why = String(e?.message ?? e).slice(0, 120);
                att = {
                    section: locale === "zh" ? `### 附件——未读取：附件处理异常（${why}）` : `### Attachments — not read: processing error (${why})`,
                    needsReview: false,
                    anyAttachment: true,
                };
            }
        }

        // —— 9. 建票入队（临时文件 + enqueueTicketFile：复用全部既有校验，不绕过 accept 必填）——
        const needsReview = acc.needsReview || att?.needsReview === true;
        const source = buildWebhookTicketSource({
            channel, title, body, acc, sourceId,
            sourceUrl: typeof p["source-url"] === "string" ? p["source-url"].trim() : undefined,
            needsReview, config, att, preId, locale,
        });
        const tmp = path.join(os.tmpdir(), `dsc-webhook-ticket-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
        let enq: { ok: true; id: string; title: string } | { ok: false; error: string };
        try {
            await fs.writeFile(tmp, source, "utf-8");
            enq = await enqueueTicketFile(tmp, locale, preId);
            if (!enq.ok && att?.dir) await fs.rm(att.dir, { recursive: true, force: true }).catch(() => { }); // 入队失败回收附件目录防孤儿
        } finally {
            await fs.rm(tmp, { force: true }).catch(() => { });
        }
        if (!enq.ok) {
            out(msg(locale, "enqueueFail", channel, enq.error));
            return { ok: false, http: 500, error: msg(locale, "enqueueFail", channel, enq.error) };
        }

        // —— 10. state 记账（verdict=work → 今日上限自然计入；append 失败只告警——票已存在，
        //         回 500 会诱导 CI 重推建出重复票，fail-visible 但不破坏队列）。
        try {
            await appendSyncState({ sourceId, ticketId: enq.id, seenAt: now().toISOString(), fingerprint, verdict: "work", title });
        } catch (e: any) {
            out(msg(locale, "stateFail", channel, String(e?.message ?? e)));
        }
        out(msg(locale, "created", channel, enq.id, title));
        return { ok: true, http: 200, status: "created", ticketId: enq.id };
    } finally {
        await releaseSyncLock();
    }
};
