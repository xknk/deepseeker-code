/**
 * @file batch/feishu/approval.ts
 * @description 多入口工单流水线 P4：卡片审批跨进程文件协议（P4 方案 §5）。
 *
 *  runner(batch run) 与 listen(batch listen feishu) 是两个进程，协议走文件（approvals/ 目录）：
 *
 *    runner: requestApproval(高危) → 写 <uuid>.pending.json → 轮询 <uuid>.decision.json
 *            （30min 超时 = deny，fail-closed）→ 消费决定 → 清理 pending
 *    listen: 轮询发现 pending → 推交互卡（value 带 approvalId）→ card.action.trigger
 *            → 校验点卡人 open_id ∈ users → 原子写 <uuid>.decision.json（temp+rename，只决定一次）
 *
 *  - 存活探测：listen 周期写 .listener-heartbeat（pid + 是否具备推送能力）；runner 只在
 *    「存活且可推送」时进入卡片等待，否则维持现状（自动应答器 deny + 记录，零回归零新输出）。
 *  - 决定文件带 approvalId 比对（防错配）；写决定走「临时文件 + rename」原子化；
 *    一个 pending 只决定一次（decision.json 已存在即拒绝——check-then-act 与仓库既有锁语义一致）。
 *  - 残留清理带 10min 宽限（sweepStaleApprovals）：过期的 pending 不立刻删——可能是 runner
 *    正在轮询的在途请求；超时+宽限后才清。
 *  - 安全：点卡人必须在 users 白名单（listen 侧校验）；卡片内容不含 diff 与验收输出（外发红线，
 *    同 PR 正文四要素精神）；批准 = allow-once 单次生效，不改工具白名单。
 *  ★ 轻模块红线（守门测试钉死）：零 SDK、零 LLM——纯 fs 协议，runner/listen/单测三方共用。
 */
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { batchQueueRoot } from "../queue.ts";
import type { SyncLocale } from "../sync/config.ts";

/** 审批等待超时（分钟，方案 §5：缺省 30 = deny fail-closed）。 */
export const APPROVAL_TIMEOUT_MIN = 30;
/** pending 残留清理宽限（分钟）：过期后留存这么久才被 sweep 清（防误删在途请求）。 */
export const APPROVAL_SWEEP_GRACE_MIN = 10;
/** 心跳保鲜窗口（毫秒）：listen 每 30s 刷新心跳，runner 按 90s 判活。 */
export const HEARTBEAT_MAX_AGE_MS = 90_000;
/** 心跳写入间隔（毫秒，listen 扫描循环每 N tick 写一次）。 */
export const HEARTBEAT_WRITE_INTERVAL_MS = 30_000;
/** 轮询间隔（毫秒）：runner 查决定文件 / listen 扫 pending。 */
export const APPROVAL_POLL_MS = 2_000;

export const approvalsDir = (): string => path.join(batchQueueRoot(), "approvals");
const pendingPath = (id: string): string => path.join(approvalsDir(), `${id}.pending.json`);
const decisionPath = (id: string): string => path.join(approvalsDir(), `${id}.decision.json`);
const heartbeatPath = (): string => path.join(approvalsDir(), ".listener-heartbeat");

/** pending 文件内容（卡片展示字段全部脱敏摘要，不含 diff 与验收输出）。 */
export interface ApprovalPending {
    approvalId: string;
    /** 高危工具名（如 run_command）。 */
    tool: string;
    /** 请求摘要（脱敏单行截断；由调用方传入已瘦身 detail）。 */
    summary: string;
    ticketId?: string;
    ticketTitle?: string;
    requestedAt: string;
    /** 超时时刻（ISO）——runner 到点 deny；listen 展示期限。 */
    expiresAt: string;
}

/** decision 文件内容。 */
export interface ApprovalDecisionFile {
    approvalId: string;
    /** allow = 本票本次放行（allow-once 语义，不改白名单）。 */
    decision: "allow" | "deny";
    /** 点卡人 open_id（audit）。 */
    decidedBy: string;
    decidedAt: string;
}

const APPR_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        pendingMissing: "pending 不存在（已超时或已被清理）",
        alreadyDecided: "该审批已被决定过（一个 pending 只决定一次）",
        cardDisabled: "users 白名单为空：卡片审批无推送目标，本请求按拒绝处理",
        timeout: (m: number) => `⏱️ 审批等待超时（${m} 分钟）→ deny（fail-closed）`,
        pushed: (id: string, m: number) => `📨 卡片审批请求已推送（${id.slice(0, 8)}…，${m} 分钟内有效，超时视为拒绝）`,
        allowedByCard: (by: string) => `✅ 飞书卡片批准（by ${by.slice(0, 8)}…）→ allow-once`,
        deniedByCard: (by: string) => `🚫 飞书卡片拒绝（by ${by.slice(0, 8)}…）`,
        notAlive: "飞书监听不在运行：高危审批维持本地自动应答（deny + 记录）",
    },
    en: {
        pendingMissing: "pending not found (expired or swept)",
        alreadyDecided: "this approval was already decided (one pending, one decision)",
        cardDisabled: "users whitelist is empty: card approval has no push target; treating as deny",
        timeout: (m: number) => `⏱️ approval wait timed out (${m} min) → deny (fail-closed)`,
        pushed: (id: string, m: number) => `📨 card approval pushed (${id.slice(0, 8)}…, valid for ${m} min; timeout = deny)`,
        allowedByCard: (by: string) => `✅ approved via Feishu card (by ${by.slice(0, 8)}…) → allow-once`,
        deniedByCard: (by: string) => `🚫 denied via Feishu card (by ${by.slice(0, 8)}…)`,
        notAlive: "feishu listener is not running: high-risk approvals fall back to local auto-reply (deny + record)",
    },
};
const msg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (APPR_MSG[locale] ?? APPR_MSG.zh)[key] ?? APPR_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

/** 默认轮询等待（真实定时器；测试注入 sleep 免真等）。 */
const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** 原子写 JSON（临时文件 + rename——读侧永远见不到半截文件）。 */
const atomicWriteJson = async (filePath: string, value: unknown): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    await fs.rename(tmp, filePath);
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
    } catch {
        return null;
    }
};

// ============ 心跳（listen 写，runner 读：跨进程判活 + 推送能力） ============

export interface ListenerHeartbeat {
    pid: number;
    at: string;
    /** users 白名单非空 = 具备卡片推送/审批能力；false 时 runner 不进入卡片等待。 */
    canApprove: boolean;
}

/** listen 周期调用：刷新心跳。approvers = users 白名单人数。 */
export const writeListenerHeartbeat = async (canApprove: boolean, now: Date = new Date()): Promise<void> => {
    const hb: ListenerHeartbeat = { pid: process.pid, at: now.toISOString(), canApprove };
    await atomicWriteJson(heartbeatPath(), hb);
};

/** 读取心跳（无/损坏/过期 = null）。 */
export const readListenerHeartbeat = async (now: Date = new Date(), maxAgeMs = HEARTBEAT_MAX_AGE_MS): Promise<ListenerHeartbeat | null> => {
    const hb = await readJson<ListenerHeartbeat>(heartbeatPath());
    if (!hb || typeof hb.at !== "string") return null;
    const t = Date.parse(hb.at);
    if (!Number.isFinite(t) || now.getTime() - t > maxAgeMs) return null;
    return hb;
};

/**
 * 「listen 存活且可推送卡片」判定——runner 决定走卡片等待还是现状 deny 的唯一依据。
 * 心跳过期/不存在 = 不存活（返回 false，零输出零行为变化）。
 */
export const isListenerAlive = async (now: Date = new Date(), maxAgeMs = HEARTBEAT_MAX_AGE_MS): Promise<boolean> => {
    const hb = await readListenerHeartbeat(now, maxAgeMs);
    return !!hb && hb.canApprove === true;
};

// ============ runner 侧：落 pending + 轮询决定 ============

export interface CardApprovalArgs {
    /** 高危工具名。 */
    tool: string;
    /** 审批说明（工具声明的瘦身 detail；进卡片前再压成单行摘要）。 */
    detail: string;
    ticketId?: string;
    ticketTitle?: string;
    /** 等待超时（分钟）；缺省 APPROVAL_TIMEOUT_MIN=30。 */
    timeoutMin?: number;
    /** 轮询间隔（毫秒）；缺省 APPROVAL_POLL_MS。 */
    pollMs?: number;
    locale?: SyncLocale;
    /** 日志通道（缺省 process.stdout.write；不存活路径刻意零输出——现状零回归）。 */
    out?: (line: string) => void;
    /** 测试时钟。 */
    now?: () => Date;
    /** 测试注入等待（缺省真实定时器）。 */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * 卡片审批（runner 侧）。listen 不存活/不可推送 → 立即 deny（调用方走现状记录路径，零回归）；
 * 存活 → 落 pending → 轮询 decision（approvalId 比对防错配）→ allow 返回 "allow-once"，
 * deny/超时返回 "deny"（fail-closed）。两种结局都清理 pending（残留由 sweep 兜底）。
 */
export const requestCardApproval = async (args: CardApprovalArgs): Promise<"allow-once" | "deny"> => {
    const locale = args.locale ?? "zh";
    const out = args.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const now = args.now ?? (() => new Date());
    const sleep = args.sleep ?? defaultSleep;
    const timeoutMin = args.timeoutMin ?? APPROVAL_TIMEOUT_MIN;
    const pollMs = args.pollMs ?? APPROVAL_POLL_MS;

    if (!(await isListenerAlive(now()))) return "deny"; // 现状路径：不落 pending、零输出（users 为空同此：心跳 canApprove=false）

    const approvalId = randomUUID();
    const start = now();
    const expires = new Date(start.getTime() + timeoutMin * 60_000);
    const pending: ApprovalPending = {
        approvalId,
        tool: args.tool,
        summary: args.detail.replace(/\s+/g, " ").trim().slice(0, 200),
        ticketId: args.ticketId,
        ticketTitle: args.ticketTitle,
        requestedAt: start.toISOString(),
        expiresAt: expires.toISOString(),
    };
    await atomicWriteJson(pendingPath(approvalId), pending);
    out(msg(locale, "pushed", approvalId, timeoutMin));

    try {
        for (; ; ) {
            await sleep(pollMs);
            const d = await readJson<ApprovalDecisionFile>(decisionPath(approvalId));
            if (d && d.approvalId === approvalId && (d.decision === "allow" || d.decision === "deny")) {
                out(d.decision === "allow" ? msg(locale, "allowedByCard", d.decidedBy ?? "") : msg(locale, "deniedByCard", d.decidedBy ?? ""));
                return d.decision === "allow" ? "allow-once" : "deny";
            }
            if (now().getTime() >= expires.getTime()) {
                out(msg(locale, "timeout", timeoutMin));
                return "deny";
            }
        }
    } finally {
        // 清理 pending（决定文件留给 audit；sweep 会连同过期决定一起回收）。
        await fs.rm(pendingPath(approvalId), { force: true }).catch(() => { });
    }
};

// ============ listen 侧：写决定（原子 + 只决定一次 + approvalId 比对） ============

export type WriteDecisionResult = { ok: true } | { ok: false; error: string };

/**
 * 写审批决定（listen 的 card.action.trigger 处理器调用）。
 * - pending 不存在 → 拒绝（已超时清理或根本没这单）；
 * - decision.json 已存在 → 拒绝（一个 pending 只决定一次）；
 * - 写入走 temp + rename 原子化；approvalId 以文件名为准（调用方从卡片 value 取）。
 */
export const writeApprovalDecision = async (d: { approvalId: string; decision: "allow" | "deny"; decidedBy: string; now?: () => Date; locale?: SyncLocale }): Promise<WriteDecisionResult> => {
    const locale = d.locale ?? "zh";
    const pending = await readJson<ApprovalPending>(pendingPath(d.approvalId));
    if (!pending || pending.approvalId !== d.approvalId) return { ok: false, error: msg(locale, "pendingMissing") };
    if (await readJson<ApprovalDecisionFile>(decisionPath(d.approvalId))) return { ok: false, error: msg(locale, "alreadyDecided") };
    const file: ApprovalDecisionFile = {
        approvalId: d.approvalId,
        decision: d.decision,
        decidedBy: d.decidedBy,
        decidedAt: (d.now ?? (() => new Date()))().toISOString(),
    };
    await atomicWriteJson(decisionPath(d.approvalId), file);
    return { ok: true };
};

// ============ 扫描与清理（listen 推卡扫描 + 残留兜底） ============

/** 列出未过期的 pending（listen 推卡扫描用；损坏文件跳过——写侧是 temp+rename，理论无半截文件，防御性容忍）。 */
export const listPendingApprovals = async (now: Date = new Date()): Promise<ApprovalPending[]> => {
    const dir = approvalsDir();
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const out: ApprovalPending[] = [];
    for (const f of entries) {
        if (!f.endsWith(".pending.json")) continue;
        const p = await readJson<ApprovalPending>(path.join(dir, f));
        if (!p || typeof p.approvalId !== "string" || typeof p.tool !== "string") continue;
        const exp = Date.parse(p.expiresAt ?? "");
        if (Number.isFinite(exp) && exp <= now.getTime()) continue; // 过期：runner 自己会 deny，不推卡
        out.push(p);
    }
    return out;
};

/**
 * 残留清理：过期超过宽限期（APPROVAL_SWEEP_GRACE_MIN）的 pending 及其决定文件一并回收。
 * 宽限防误删在途：runner 轮询循环还活着时它的 pending 已过期，但马上要出 timeout-deny 并自清——
 * sweep 抢删会导致 finally 里的 rm 落空（无害），但决定文件可能还没被 audit 消费，故等宽限。
 * listen 扫描循环周期调用；runner 侧不调（各清各的，sweep 是兜底）。
 */
export const sweepStaleApprovals = async (now: Date = new Date()): Promise<number> => {
    const dir = approvalsDir();
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const graceMs = APPROVAL_SWEEP_GRACE_MIN * 60_000;
    let removed = 0;
    for (const f of entries) {
        const id = f.endsWith(".pending.json") ? f.slice(0, -".pending.json".length)
            : f.endsWith(".decision.json") ? f.slice(0, -".decision.json".length) : null;
        if (!id) continue; // .listener-heartbeat 与 tmp 残留不动（tmp 由原子写自净）
        const p = await readJson<ApprovalPending>(pendingPath(id));
        const exp = p ? Date.parse(p.expiresAt ?? "") : NaN;
        // pending 已丢（只剩 decision 残留）→ deadline=0 视为早已过期；expiresAt 解析不出 → 同理可清
        const deadline = Number.isFinite(exp) ? exp : 0;
        if (now.getTime() - deadline < graceMs) continue;
        const okP = await fs.rm(pendingPath(id), { force: true }).then(() => true, () => false);
        const okD = await fs.rm(decisionPath(id), { force: true }).then(() => true, () => false);
        if (okP || okD) removed++;
    }
    return removed;
};

/** 测试隔离用：清空 approvals 目录（心跳保留与否由调用方决定；测试一般整目录重建）。 */
export const resetApprovalsDir = async (): Promise<void> => {
    await fs.rm(approvalsDir(), { recursive: true, force: true }).catch(() => { });
};
