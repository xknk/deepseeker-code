/**
 * @file batch/feishu/listen.ts
 * @description 多入口工单流水线 P4：`batch listen feishu` 常驻编排（P4 方案 §1/§2/§5/§6）。
 *
 *  拓扑（方案 §2）：飞书开放平台 ⇄(WSClient 长连接，全系统唯一客户端) ⇄ 本进程：
 *    - im.message.receive_v1 → handleFeishuMessage（白名单闸/去重/accept 同闸/附件三态/建票入队）
 *    - card.action.trigger   → 校验点卡人 ∈ users → 原子写 approvals/<id>.decision.json
 *    - 扫描循环              → approvals/<id>.pending.json 推交互卡（3s 内 toast 由回调处理器保证）
 *    - 对账循环（§6）        → 游标增量拉消息补漏票；缺历史权限 → 明示降级文案（fail-visible）
 *
 *  ★ 重模块红线：@larksuiteoapi/node-sdk 只许在【本文件】动态 import（变量 specifier——esbuild
 *    无法静态内联，运行时从安装树解析；缺包 → 一句安装提示退出，零主干依赖零体积）。LLM
 *    gatekeeper judge 同样动态 import（feishu listen 无需 DEEP_SEEK_API_KEY，除非 gatekeeper 开）。
 *  ★ 单实例红线（spike 硬限制 5）：同应用多客户端不广播（随机一个收消息）→ 只允许一个 listen
 *    进程——心跳新鲜挡 90s 内旧进程残留，.listen.lock（wx 独占创建 = 原子）挡并发双开竞态；
 *    锁拒绝发生在 wsClient.start 之前，输家绝不产生第二条连接。
 *  ★ start() 语义红线（1.0.67 实锤）：SDK 的 wsClient.start() 校验完凭证立即 resolve，返回值不是
 *    连接生命周期——生命周期信号只走构造器回调 onReady/onError（见 WsHooks 注释）。
 *  ★ 密钥红线：FEISHU_APP_ID/FEISHU_APP_SECRET 只读环境变量（deps.env 注入测试），永不入日志。
 *  ★ 回调 3 秒约束（spike 硬限制 4）：card.action.trigger 处理器只做一次小文件写，立即回 toast。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot, snapshotQueue } from "../queue.ts";
import { loadFeishuConfig, type FeishuConfig } from "./config.ts";
import { handleFeishuMessage, handleFeishuFollowup, feishuGateVerdict, feishuTitleOf, normalizeMessageEvent, type FeishuMessageCandidate, type FeishuTicketResult } from "./message.ts";
import {
    writeListenerHeartbeat, readListenerHeartbeat, listPendingApprovals, sweepStaleApprovals,
    writeApprovalDecision, acquireListenLock, releaseListenLock, APPROVAL_POLL_MS, HEARTBEAT_WRITE_INTERVAL_MS,
} from "./approval.ts";
import {
    lookupMsgMap, recordMsgMap, listPendingNotifications, clearNotification, bumpNotificationRetries, notifyText,
} from "./notify.ts";
import { runReconcile, loadKnownChats, recordKnownChat, type FeishuPull } from "./reconcile.ts";
import type { DownloadFile } from "../sync/attachments.ts";
import type { SyncLocale } from "../sync/config.ts";

/** SDK 包名（动态 import 的变量 specifier：打包器无法内联，运行时按安装树解析）。 */
const SDK_SPECIFIER = "@larksuiteoapi/node-sdk";
/** 缺 SDK 时的安装提示（一句人话，可照抄）。 */
const SDK_INSTALL_HINT = `未安装飞书 SDK：请先执行 npm install -g ${SDK_SPECIFIER}（或在本项目内 npm install ${SDK_SPECIFIER}），再运行 batch listen feishu。SDK 不随主包安装（可选依赖不进主干）。`;

// ============ 双语文案 ============

const LISTEN_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        missingEnv: "缺飞书应用凭证：请设置环境变量 FEISHU_APP_ID 与 FEISHU_APP_SECRET（企业自建应用的 App ID / App Secret，见 README「飞书入口」跟着点）。凭证只走环境变量，绝不写进配置文件。",
        badConfig: (e: string) => `feishu.json 配置无效：${e}`,
        alreadyRunning: (pid: number) => `已有飞书监听进程在运行（pid ${pid}）：同应用多客户端不广播（消息只会随机送达一个连接），全系统只允许一个 batch listen feishu 进程。`,
        started: "🟢 飞书长连接已建立（Ctrl+C 退出）；建票与审批卡日志同步写入 feishu-listen.log",
        stopped: "🔴 飞书监听已退出",
        wsFail: (e: string) => `❌ 长连接建立失败：${e}（检查凭证与网络；飞书国内直连，不需要代理）`,
        gatekeeperNoKey: "gatekeeper 已开启但 DEEP_SEEK_API_KEY 未设置：LLM 判定不可用，消息将仅过规则闸后放行（如需 LLM 过滤请先设 key）。",
        usersEmpty: "users 白名单为空：卡片审批无推送目标——高危审批将维持本地自动应答（deny + 记录）。要手机点审批请在 feishu.json 配 users。",
        botInfoFail: (e: string) => `⚠️ 获取机器人 open_id 失败（${e}）：mentionOnlyInGroup=true 下群消息将全部拒收，请检查应用权限或把 mentionOnlyInGroup 配为 false。`,
        msgSkip: (why: string) => `⏭️ [feishu] 跳过消息：${why}`,
        msgFail: (e: string) => `❌ [feishu] 消息处理异常（不中断监听）：${e}`,
        chatLearned: (chatId: string) => `💬 会话已纳入断线对账（${chatId.slice(0, 12)}…）：此后断线窗口内该会话漏票可回补`,
        legSkip: (chatId: string, why: string, permission: boolean) => `⚠️ [feishu] 对账跳过会话 ${chatId.slice(0, 12)}…：${why}${permission ? "（缺「获取与发送单聊、群组消息」权限）" : ""}——该会话断线窗口内漏票无法自动回补，重要内容请重新 @机器人`,
        cardDenied: (who: string) => `🚫 点卡人不在 users 白名单，拒绝审批：${who}`,
        cardOk: (id: string, d: string) => `🎴 审批决定已落盘 [${id.slice(0, 8)}…] ${d}`,
        cardFail: (e: string) => `⚠️ 卡片决定写入失败：${e}`,
        pushFail: (e: string) => `⚠️ 卡片推送失败（下轮扫描重试）：${e}`,
        signalExit: (sig: string) => `收到 ${sig}，正在退出…`,
    },
    en: {
        missingEnv: "Missing Feishu app credentials: set environment variables FEISHU_APP_ID and FEISHU_APP_SECRET (App ID / App Secret of a custom enterprise app — see the README Feishu section). Credentials live only in env vars, never in config files.",
        badConfig: (e: string) => `feishu.json is invalid: ${e}`,
        alreadyRunning: (pid: number) => `A Feishu listener is already running (pid ${pid}): multiple clients on one app do not broadcast (only a random one receives), so only one 'batch listen feishu' process is allowed system-wide.`,
        started: "🟢 Feishu long connection established (Ctrl+C to exit); ticket & approval-card logs also go to feishu-listen.log",
        stopped: "🔴 Feishu listener stopped",
        wsFail: (e: string) => `❌ Failed to establish the long connection: ${e} (check credentials and network; Feishu CN connects directly — no proxy needed)`,
        gatekeeperNoKey: "gatekeeper is on but DEEP_SEEK_API_KEY is unset: LLM judging unavailable, messages will pass the rule gate only (set the key if you want LLM filtering).",
        usersEmpty: "users whitelist is empty: card approval has no push target — high-risk approvals fall back to local auto-reply (deny + record). Configure users in feishu.json to approve from your phone.",
        botInfoFail: (e: string) => `⚠️ Failed to fetch bot open_id (${e}): with mentionOnlyInGroup=true all group messages will be rejected — check app permissions or set mentionOnlyInGroup=false.`,
        msgSkip: (why: string) => `⏭️ [feishu] message skipped: ${why}`,
        msgFail: (e: string) => `❌ [feishu] message handling error (listener keeps running): ${e}`,
        chatLearned: (chatId: string) => `💬 chat registered for reconcile backfill (${chatId.slice(0, 12)}…): missed tickets in this chat are now recoverable after reconnects`,
        legSkip: (chatId: string, why: string, permission: boolean) => `⚠️ [feishu] reconcile skipped chat ${chatId.slice(0, 12)}…: ${why}${permission ? " (missing the read & send messages scope)" : ""} — tickets missed in this chat during disconnects cannot be backfilled; re-@ the bot for important ones`,
        cardDenied: (who: string) => `🚫 clicker not in the users whitelist, approval refused: ${who}`,
        cardOk: (id: string, d: string) => `🎴 approval decision recorded [${id.slice(0, 8)}…] ${d}`,
        cardFail: (e: string) => `⚠️ failed to write the approval decision: ${e}`,
        pushFail: (e: string) => `⚠️ card push failed (will retry next scan): ${e}`,
        signalExit: (sig: string) => `received ${sig}, exiting…`,
    },
};
const msg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (LISTEN_MSG[locale] ?? LISTEN_MSG.zh)[key] ?? LISTEN_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

// ============ 注入面 ============

export interface FeishuListenDeps {
    /** 凭证（缺省读 FEISHU_APP_ID / FEISHU_APP_SECRET；测试必须显式注入——严禁真 env 发真请求）。 */
    env?: { appId?: string; secret?: string };
    /** SDK 加载器（缺省动态 import；测试注入假 SDK，SDK 面 100% mock）。 */
    loadSdk?: () => Promise<any>;
    locale?: SyncLocale;
    /** 日志通道（缺省：stdout + <batch>/feishu-listen.log 追加，对齐定时钟日志惯例）。 */
    log?: (line: string) => void;
    now?: () => Date;
    /** 循环等待注入（缺省真实定时器；测试驱动节奏与停机）。 */
    sleep?: (ms: number) => Promise<void>;
    /** approvals 扫描间隔（毫秒，缺省 2000）。 */
    scanMs?: number;
    /** 心跳写入间隔（毫秒，缺省 30s）。 */
    heartbeatMs?: number;
    /** 对账间隔（毫秒，缺省 10min；§6 断线兜底即靠周期对账实现）。 */
    reconcileMs?: number;
    /** 信号注册（缺省 true；测试关掉防进程全局副作用）。 */
    registerSignals?: boolean;
    /** 外部停机钩子（缺省永不停；测试用它收尾）。 */
    shouldStop?: () => boolean;
    /** LLM gatekeeper judge（缺省 gatekeeper 开时动态 import LLM 链构造；测试注入假 judge）。 */
    gatekeeperJudge?: (args: { title: string; body: string; candidate: FeishuMessageCandidate }) => Promise<{ verdict: "work" | "reject"; reason?: string }>;
    /** 附件下载器（缺省由 SDK 资源 API 构造；测试注入假下载器零真网）。 */
    download?: DownloadFile;
    /** 建票 deps 覆盖（queueRoot/projectRoot 透传 handleFeishuMessage；测试重定向用）。 */
    queueRoot?: string;
    projectRoot?: string;
}

/** 变量 specifier 动态 import：esbuild 无法静态解析 → 产物保留运行时 import，缺包走提示路径。 */
const defaultLoadSdk = async (): Promise<any> => {
    const spec = SDK_SPECIFIER;
    return await import(spec);
};

/** sleep 的默认真实实现（定时器 unref：停机打断后不许这个输家 timer 拖住进程退出）。 */
const defaultSleep = (ms: number): Promise<void> => new Promise((res) => {
    const t = setTimeout(res, ms);
    if (typeof t?.unref === "function") t.unref();
});

/** 缺省日志：stdout + 追加 <batch>/feishu-listen.log（一行一事；打不开文件只降级 stdout）。 */
const makeDefaultLog = (): ((line: string) => void) => {
    const file = path.join(batchQueueRoot(), "feishu-listen.log");
    return (line: string) => {
        process.stdout.write(line + "\n");
        void fs.appendFile(file, `[${new Date().toISOString()}] ${line}\n`, "utf-8").catch(() => { });
    };
};

/** SDK 实例包（建连与 API 面；全部防御性取字段——SDK 版本演进不击垮监听）。 */
interface SdkBundle {
    client: any;
    wsClient: any;
    dispatcher: any;
    botOpenId?: string;
}

/**
 * WS 生命周期钩子（构造器回调）。
 * ★ SDK 1.76 语义红线：`wsClient.start()` 校验完凭证后立即 resolve（连接由内部 reConnect 循环
 * 持有），返回值【不是】连接生命周期——把它当「连接关闭信号」用（.then(stop)）会让扫描/对账
 * 循环在首轮就退出（1.0.67 实锤：进程在 start+reconcileMs 准时自杀）。生命周期信号只走这里：
 * onReady=首次握手成功；onError=终态失败（不可重试/重试耗尽）。断线由 SDK 自动重连，不算终态。
 */
interface WsHooks {
    onReady?: () => void;
    onError?: (err: Error) => void;
}

const bootSdk = async (sdk: any, appId: string, secret: string, locale: SyncLocale, log: (l: string) => void, hooks?: WsHooks): Promise<SdkBundle | null> => {
    if (!sdk?.Client || !sdk?.WSClient || !sdk?.EventDispatcher) return null;
    const client = new sdk.Client({ appId, appSecret: secret });
    const loggerLevel = sdk.LoggerLevel?.info ?? "info";
    const wsClient = new sdk.WSClient({ appId, appSecret: secret, loggerLevel, ...(hooks ?? {}) });
    const dispatcher = new sdk.EventDispatcher({});
    let botOpenId: string | undefined;
    try {
        // bot info：SDK 未暴露 bot 命名空间（client.bot.info 不存在）→ 通用 request 直打
        // /open-apis/bot/v3/info（v4 路径 404；返回体顶层即 bot 对象，防御性兼容包一层 data）。
        const resp = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
        const body = resp?.data ?? resp;
        botOpenId = body?.bot?.open_id ?? body?.open_id ?? body?.data?.bot?.open_id;
    } catch (e: any) {
        log(msg(locale, "botInfoFail", String(e?.message ?? e)));
    }
    return { client, wsClient, dispatcher, botOpenId };
};

/** SDK 消息资源下载器（feishu:// 合成 url → im.message resource API → 落盘；缺方法/失败标未读取）。 */
const makeSdkDownload = (client: any): DownloadFile => async (url: string, destAbs: string) => {
    const m = /^feishu:\/\/resource\/([^/]+)\/([^?]+)\?type=(image|file)$/.exec(url);
    if (!m) return { ok: false, reason: "feishu:// url 形态不符" };
    const fn = client?.im?.message?.getResource ?? client?.im?.message?.resource;
    if (typeof fn !== "function") return { ok: false, reason: "SDK 缺少消息资源下载方法" };
    try {
        const r = await fn.call(client.im.message, {
            path: { message_id: decodeURIComponent(m[1]), file_key: decodeURIComponent(m[2]) },
            params: { type: m[3] },
        });
        const payload = r?.data ?? r;
        const buf = Buffer.isBuffer(payload) ? payload
            : payload instanceof Uint8Array ? Buffer.from(payload)
                : payload instanceof ArrayBuffer ? Buffer.from(new Uint8Array(payload))
                    : typeof payload === "string" ? Buffer.from(payload, "base64") : null;
        if (!buf || buf.length === 0) return { ok: false, reason: `资源响应无二进制内容（code ${r?.code ?? "?"}）` };
        await fs.writeFile(destAbs, buf);
        return { ok: true, sizeBytes: buf.length };
    } catch (e: any) {
        return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
    }
};

/** SDK 抛错提错误体：larksuite SDK 把 HTTP 4xx 抛成 Error 且 message 只有状态码——飞书 code/msg 在 response.data，提取不到回退 message（230027 群权限实锤被吞过）。 */
const sdkErrWhy = (e: any): string => {
    const d = e?.response?.data;
    return d?.code !== undefined && d?.msg ? `${d.code} ${d.msg}` : String(e?.message ?? e);
};
/** 权限缺失归一：飞书权限错码（99991672 会话列表、230027 群消息历史）+ 数字前缀兜底 + 文案正则。 */
const isPermissionDeny = (why: string, e?: any): boolean => {
    const c = Number(e?.response?.data?.code ?? /^\d+/.exec(why)?.[0] ?? 0);
    return c === 99991672 || c === 230027 || /permission|权限|denied|forbidden/i.test(why);
};

/**
 * 增量拉取（§6 对账）：逐白名单群 + 已登记会话（私聊/群聊 chat_id 从首条实时消息学习，见 recordKnownChat）
 * 按时间窗翻页（im/v1/messages list），权限缺失归一为 permissionDenied。
 * ★ 逐腿隔离（1.0.71 真机实锤：群腿缺 im:message.group_msg 权限报 400/230027，旧代码整轮 return
 *   失败——私聊腿被连坐，每轮对账死在第一步）：单腿失败降级明示并跳过（legSkip），其余腿照常拉；
 *   只有全部腿失败才整轮失败（游标不动下轮重试）。
 * ★ 时间单位红线（1.0.72 真机实锤：list 的 start_time/end_time 是【秒】，传毫秒=公元 3 万年的
 *   未来窗、查询恒空——补票从来没工作过；窗内游标/内部比较统一毫秒，只在查询边界换秒）。
 * extraChatIds 缺省空函数——测试/纯群场景不传即可。
 */
const makeSdkPull = (client: any, cfg: FeishuConfig, log: (l: string) => void, locale: SyncLocale, extraChatIds: () => string[] = () => []): FeishuPull => async (startMs, endMs) => {
    const out: FeishuMessageCandidate[] = [];
    const chatIds = [...new Set([...cfg.chats, ...extraChatIds()])];
    const failed: { why: string; permission: boolean }[] = [];
    const startSec = String(Math.floor(Number(startMs) / 1000));
    const endSec = String(Math.floor(Number(endMs) / 1000));
    let okLegs = 0;
    for (const chatId of chatIds) {
        let pageToken: string | undefined = undefined;
        let legOk = false;
        let legFail: { why: string; permission: boolean } | null = null;
        for (let page = 0; page < 20; page++) { // 翻页上限 20×50=1000 条：对账窗口异常巨大时截断（日志可见）
            let r: any;
            try {
                r = await client.im.message.list({
                    params: {
                        container_id_type: "chat",
                        container_id: chatId,
                        start_time: startSec,
                        end_time: endSec,
                        sort_type: "ByCreateTimeAsc",
                        page_size: 50,
                        ...(pageToken ? { page_token: pageToken } : {}),
                    },
                });
            } catch (e: any) {
                legFail = { why: sdkErrWhy(e), permission: isPermissionDeny(sdkErrWhy(e), e) };
                break;
            }
            const code = r?.code ?? 0;
            if (code !== 0) {
                const why = `${code} ${r?.msg ?? ""}`.trim();
                legFail = { why, permission: isPermissionDeny(why, r) };
                break;
            }
            legOk = true;
            for (const item of r?.data?.items ?? []) {
                const c = normalizeMessageEvent(item);
                if (c) out.push(c);
                else log(msg(locale, "msgSkip", `类型不支持或形态异常（message_id ${item?.message_id ?? "?"}）`));
            }
            pageToken = r?.data?.page_token;
            if (!r?.data?.has_more || !pageToken) break;
        }
        if (legFail) {
            failed.push(legFail);
            log(msg(locale, "legSkip", chatId, legFail.why, legFail.permission)); // 逐腿降级明示（不连坐其他会话）
        } else if (legOk) {
            okLegs++;
        }
    }
    if (okLegs === 0 && failed.length > 0) {
        return { ok: false, reason: failed[0].why, permissionDenied: failed.some((f) => f.permission) };
    }
    out.sort((a, b) => (Number.parseInt(a.createTimeMs, 10) || 0) - (Number.parseInt(b.createTimeMs, 10) || 0));
    return { ok: true, messages: out };
};

/** 缺省 LLM gatekeeper judge：动态 import LLM 链（不拖累无需 key 的纯监听场景），单次判定 work/reject。 */
const makeDefaultJudge = async (): Promise<NonNullable<FeishuListenDeps["gatekeeperJudge"]>> => {
    const { chatWithModelWithSummary } = await import("@/llm/model.ts");
    return async ({ title, body }) => {
        const messages = [
            {
                role: "system",
                content: "你是工单准入把关器。判断这条来自飞书消息的任务描述是否值得自动开工修复（work）还是噪音应拒收（reject）。只输出 JSON：{\"verdict\":\"work\"或\"reject\",\"reason\":\"一句话理由\"}。寒暄、闲聊测试、与代码无关的内容一律 reject。",
            },
            { role: "user", content: `标题：${title}\n正文：${body}` },
        ];
        const r = await chatWithModelWithSummary(messages as any, undefined, {});
        const text: string = r?.choices?.[0]?.message?.content ?? "";
        const m = /\{[\s\S]*?\}/.exec(text);
        if (!m) return { verdict: "work", reason: "judge 输出无 JSON，默认放行" };
        try {
            const parsed = JSON.parse(m[0]) as { verdict?: string; reason?: string };
            if (parsed.verdict === "reject") return { verdict: "reject", reason: parsed.reason };
            return { verdict: "work" };
        } catch {
            return { verdict: "work", reason: "judge 输出解析失败，默认放行" };
        }
    };
};

/** 新版交互卡（§5：behaviors callback，value 只收对象类型；卡片固定 zh，不含 diff 与验收输出）。 */
/**
 * 审批卡（卡片 JSON 2.0）。★ 形态为 2026-11-06 真机 API 实测定型（错一个就 230099 整卡被拒）：
 *   - `tag:"action"` 容器 ✗（ErrCode 200861 "unsupported tag action"——那是旧版 JSON 1.0 组件）；
 *   - `tag:"note"` ✗（同 200861）；`config.update_multi` ✗（ErrCode 300302 "update_multi is false"）；
 *   - 按钮【直接】作为 body.elements 元素 ✓（实测 code 0）；markdown ✓。
 * 回调值经 behaviors callback 原样回到 card.action.trigger（见步骤 7 处理器）。
 */
const buildApprovalCard = (p: { approvalId: string; tool: string; summary: string; ticketId?: string; ticketTitle?: string; expiresAt: string }): string => JSON.stringify({
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "🔐 挂机任务高危操作审批" }, template: "red" },
    body: {
        elements: [
            {
                tag: "markdown",
                content: [
                    `**票**：${p.ticketId ?? "?"}${p.ticketTitle ? ` ${p.ticketTitle.slice(0, 60)}` : ""}`,
                    `**工具**：${p.tool}`,
                    `**请求**：${p.summary.slice(0, 200)}`,
                    `**期限**：${p.expiresAt}（超时自动拒绝，fail-closed）`,
                    `批准 = allow-once 单次生效，不改变工具白名单。`,
                ].join("\n"),
            },
            {
                tag: "button",
                text: { tag: "plain_text", content: "批准（仅本票本次）" },
                type: "primary",
                behaviors: [{ type: "callback", value: { approvalId: p.approvalId, decision: "allow" } }],
            },
            {
                tag: "button",
                text: { tag: "plain_text", content: "拒绝" },
                type: "danger",
                behaviors: [{ type: "callback", value: { approvalId: p.approvalId, decision: "deny" } }],
            },
        ],
    },
});

/** 从 card.action.trigger 数据提取动作（防御性：value 只收对象，但形态可能随版本演进）。 */
const extractCardAction = (data: any): { approvalId?: string; decision?: "allow" | "deny"; operatorOpenId?: string } => {
    const value = data?.action?.value ?? data?.value;
    const decision = value?.decision === "allow" || value?.decision === "deny" ? value.decision : undefined;
    return {
        approvalId: typeof value?.approvalId === "string" ? value.approvalId : undefined,
        decision,
        operatorOpenId: data?.operator?.open_id ?? data?.operator?.openId,
    };
};

// ============ 主编排 ============

export interface FeishuListenResult { code: number }

/**
 * 常驻监听主入口（`batch listen feishu`）。返回即代表退出（fatal 启动失败 / 信号 / 停机钩子），
 * code 0=正常退出，1=启动失败（CLI 侧透传 process.exitCode）。
 */
export const runFeishuListen = async (deps?: FeishuListenDeps): Promise<FeishuListenResult> => {
    const locale = deps?.locale ?? "zh";
    const log = deps?.log ?? makeDefaultLog();
    const now = deps?.now ?? (() => new Date());
    const sleep = deps?.sleep ?? defaultSleep;
    const scanMs = deps?.scanMs ?? APPROVAL_POLL_MS;
    const heartbeatMs = deps?.heartbeatMs ?? HEARTBEAT_WRITE_INTERVAL_MS;
    const reconcileMs = deps?.reconcileMs ?? 10 * 60_000;
    const shouldStop = deps?.shouldStop ?? (() => false);

    // —— 1. 凭证（env 注入面：测试绝不读真 env）——
    const env = deps?.env ?? { appId: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET };
    if (!env.appId || !env.secret) {
        log(msg(locale, "missingEnv"));
        return { code: 1 };
    }

    // —— 2. 配置（fail-closed）——
    const cfg = await loadFeishuConfig({ locale });
    if (!cfg.ok) {
        log(msg(locale, "badConfig", cfg.error));
        return { code: 1 };
    }
    if (cfg.config.gatekeeper && !deps?.gatekeeperJudge && !process.env.DEEP_SEEK_API_KEY) {
        log(msg(locale, "gatekeeperNoKey"));
    }
    if (cfg.config.users.length === 0) {
        log(msg(locale, "usersEmpty"));
    }

    // —— 3. 单实例（spike 硬限制：集群不广播 → 只允许一个客户端）——
    const existing = await readListenerHeartbeat(now());
    if (existing) {
        log(msg(locale, "alreadyRunning", existing.pid));
        return { code: 1 };
    }

    // —— 3.5 停机原语与 WS 生命周期钩子（必须先于 SDK 构造：onReady/onError 是 WSClient 的
    //        构造器回调，{...hooks} 展开发生在构造时刻——构造后再赋值传不进去）——
    let stopReason: string | null = null;
    // 睡眠打断：requestStop 必须能唤醒正在长睡的循环（对账缺省睡 10min——不唤醒的话 Ctrl+C /
    // ws 终态失败后进程最长滞留 10 分钟才收尾，1.0.68 冒烟实锤：扫描循环 75s 退了、进程还活着）。
    // ★ 多路唤醒：扫描/对账两循环并发睡眠，单槽 res 会互相覆盖（扫描的唤醒钩子被顶掉 =
    //    唤醒丢失）；每个睡眠者注册自己的 res、在自己的 finally 里摘除，唤醒时全量触发。
    const sleepers = new Set<() => void>();
    const sleepInterruptible = async (ms: number): Promise<void> => {
        let mine: (() => void) | undefined;
        try {
            await Promise.race([
                sleep(ms),
                new Promise<void>((res) => {
                    mine = res;
                    sleepers.add(res);
                }),
            ]);
        } finally {
            if (mine) sleepers.delete(mine); // race 双边结算都要摘本轮回调（防悬挂 res 漏进下一轮）
        }
    };
    const requestStop = (why: string): void => {
        if (stopReason === null) stopReason = why;
        for (const res of [...sleepers]) res(); // Promise res 幂等，重复触发无副作用
    };
    let wsExitCode = 0;
    const wsHooks: WsHooks = {
        onReady: () => log(msg(locale, "started")),
        onError: (e: Error) => {
            log(msg(locale, "wsFail", String(e?.message ?? e)));
            wsExitCode = 1;
            requestStop("ws error");
        },
    };

    // —— 4. SDK（动态加载；缺包一句安装提示）——
    let sdk: any;
    try {
        sdk = await (deps?.loadSdk ?? defaultLoadSdk)();
    } catch (e: any) {
        log(`${SDK_INSTALL_HINT}${e?.code ? `（${e.code}）` : ""}`);
        return { code: 1 };
    }
    const bundle = await bootSdk(sdk, env.appId, env.secret, locale, log, wsHooks);
    if (!bundle) {
        log(SDK_INSTALL_HINT);
        return { code: 1 };
    }
    const { client, wsClient, dispatcher, botOpenId } = bundle;
    const fcfg = cfg.config;

    // —— 4.5 单实例锁（wx 独占创建 = 原子）：并发双开在此串行化，输家在 wsClient.start（步骤 8）
    //        之前退出、绝不产生第二条连接。心跳（步骤 3）挡 90s 内旧进程残留，锁挡真并发竞态。
    //        此后到函数末尾无早退路径 → 释放只在退出清理一处；崩溃残留由下一次 acquire 死 pid 接管自愈。——
    const lock = await acquireListenLock();
    if (!lock.ok) {
        log(msg(locale, "alreadyRunning", lock.holderPid));
        return { code: 1 };
    }

    // —— 4.6 会话 chat_id 学习集（私聊+群聊）：启动载入已登记会话，实时过白名单消息持续登记
    //        （群聊 1.0.70 起与私聊对称——实时建票不依赖 chats 配置，不学习的群断线必漏票）——
    const learnedChats = new Set<string>();
    for (const c of await loadKnownChats()) learnedChats.add(c);

    // —— 5. 建票/审批/对账的公共 deps ——
    const handleDeps = {
        botOpenId,
        download: deps?.download ?? makeSdkDownload(client),
        gatekeeperJudge: deps?.gatekeeperJudge ?? (fcfg.gatekeeper ? await makeDefaultJudge().catch(() => undefined) : undefined),
        out: log,
        now,
        queueRoot: deps?.queueRoot,
        projectRoot: deps?.projectRoot,
        locale,
    };

    // —— 5.5 处理 + 回执 wrapper（实时/对账两路共用）：聊天入口必须有反馈——建票成败都回话，
    //        静默 = 黑洞（2026-11-06 真机联调实锤：配额拒收静默、建票成功也无回执，用户无从判断）。
    //        回执发送失败只留日志不重试——票已建/已拒，回执是增益不是关键路径。 ——
    const replyAck = async (candidate: FeishuMessageCandidate, r: FeishuTicketResult, source: "live" | "reconcile"): Promise<void> => {
        let text: string | null = null;
        let ticketId: string | undefined;
        if (!r.ok) text = notifyText.ackSkipped(locale, r.error.slice(0, 160));
        else if (r.action === "created") {
            ticketId = r.ticketId;
            const snap = await snapshotQueue().catch(() => ({ pending: [] as string[], running: [] as string[], done: [] as string[] }));
            text = notifyText.ackCreated(locale, r.ticketId, feishuTitleOf(candidate.text), Math.max(0, snap.pending.length - 1));
        } else if (r.action === "appended") {
            ticketId = r.ticketId;
            text = notifyText.ackAppended(locale, r.ticketId, r.title);
        } else if (r.action === "followup-created") {
            ticketId = r.ticketId;
            text = notifyText.ackFollowupCreated(locale, r.ticketId, r.prevId);
        } else if (r.action === "duplicate") {
            // 对账重拉的 duplicate 不回话（用户没新动作，凭空冒提示反而困惑）；实时重发 = 用户在问，必回
            if (source === "live") text = notifyText.ackDuplicate(locale, r.ticketId);
        } else if (r.action === "skipped") {
            text = notifyText.ackSkipped(locale, r.reason.slice(0, 200));
        }
        if (!text) return;
        const at = candidate.chatType === "group" ? `<at user_id="${candidate.senderOpenId}"></at> ` : "";
        const sentId = await sendText(client, candidate.chatId, `${at}${text}`);
        if (sentId && ticketId) await recordMsgMap(sentId, ticketId); // 回复回执消息 = 同票追加/续修
    };

    const handleAndReply = async (candidate: FeishuMessageCandidate, source: "live" | "reconcile"): Promise<FeishuTicketResult> => {
        // 回复路由先行：parent_id 命中映射表且回复者在 users 白名单 → 追加/续修那张票。
        // 免 @（回复关系即触发——群里话题式跟进不该被 mentionOnly 拦住）；白名单外的回复不走路由，
        // 落到下面的闸 = 静默（不给陌生会话回话）。
        if (candidate.parentId && fcfg.users.includes(candidate.senderOpenId)) {
            const prevId = await lookupMsgMap(candidate.parentId).catch(() => null);
            if (prevId) {
                const r = await handleFeishuFollowup(candidate, prevId, fcfg, handleDeps);
                if (r) {
                    await replyAck(candidate, r, source);
                    return r;
                }
                // null = 前票执行中/无踪迹：回落正常建票流（回执口径同新建票）
            }
        }
        const gate = feishuGateVerdict(candidate, fcfg, handleDeps.botOpenId);
        if (!gate.ok) return { ok: true, action: "skipped", reason: gate.reason };
        const r = await handleFeishuMessage(candidate, fcfg, handleDeps);
        await replyAck(candidate, r, source);
        return r;
    };

    // —— 6. 消息事件（im.message.receive_v1）：归一 → 建票管线；异常只留日志不击垮监听 ——
    dispatcher.register({
        "im.message.receive_v1": async (data: any) => {
            try {
                const candidate = normalizeMessageEvent(data);
                if (!candidate) {
                    const type = data?.message?.message_type ?? data?.type ?? "?";
                    log(msg(locale, "msgSkip", `类型不支持或形态异常（${type}）`));
                    return;
                }
                // 过白名单发送者的会话（私聊/群聊）：登记 chat_id 纳入断线对账（先于建票闸——
                // 会话注册与单条消息的票结果无关；对账拉回的消息仍走完整闸门，无白名单绕行）
                if (candidate.chatId && fcfg.users.includes(candidate.senderOpenId)) {
                    const learned = await recordKnownChat(candidate.chatId).catch(() => false);
                    if (learned) {
                        learnedChats.add(candidate.chatId);
                        log(msg(locale, "chatLearned", candidate.chatId));
                    }
                }
                const r = await handleAndReply(candidate, "live");
                if (!r.ok) log(msg(locale, "msgFail", r.error));
                else if (r.action === "skipped" && r.reason) log(msg(locale, "msgSkip", r.reason));
            } catch (e: any) {
                log(msg(locale, "msgFail", String(e?.message ?? e)));
            }
        },
    });

    // —— 7. 卡片回调（card.action.trigger）：3 秒内回 toast（只做一次小文件写，同步完成）——
    dispatcher.register({
        "card.action.trigger": async (data: any) => {
            const a = extractCardAction(data);
            if (!a.approvalId || !a.decision) {
                return { toast: { type: "error", content: "回调数据不完整（缺 approvalId 或 decision）" } };
            }
            if (!a.operatorOpenId || !fcfg.users.includes(a.operatorOpenId)) {
                log(msg(locale, "cardDenied", a.operatorOpenId ?? "?"));
                return { toast: { type: "error", content: "无权审批：点卡人不在 feishu.json users 白名单" } };
            }
            const r = await writeApprovalDecision({ approvalId: a.approvalId, decision: a.decision, decidedBy: a.operatorOpenId, now, locale });
            if (!r.ok) {
                log(msg(locale, "cardFail", r.error));
                return { toast: { type: "error", content: r.error } };
            }
            log(msg(locale, "cardOk", a.approvalId, a.decision === "allow" ? "allow" : "deny"));
            return { toast: { type: a.decision === "allow" ? "success" : "info", content: a.decision === "allow" ? "已批准（单次生效）" : "已拒绝" } };
        },
    });

    // —— 8. 长连接：生命周期信号走构造器回调（步骤 3.5 的 wsHooks）。★ start() 返回值不是连接
    //        生命周期（校验完凭证立即 resolve）——绝不能 .then(requestStop)：那会让两个循环首轮
    //        即退（1.0.67 实锤）。断线由 SDK 自动重连；终态失败（重试耗尽/不可重试）走 onError 停机，
    //        runner 侧心跳过期判定是外部看门狗，进程内不因断线自杀。——
    void bundle.wsClient.start({ eventDispatcher: dispatcher }).catch((e: any) => {
        // start() 自身的同步校验拒绝（凭证形态错等）；运行期终态失败走上面 onError
        log(msg(locale, "wsFail", String(e?.message ?? e)));
        wsExitCode = 1;
        requestStop("ws error");
    });

    // —— 9. 信号（缺省注册；测试关闭防全局副作用）——
    const onSignal = (sig: string): void => {
        log(msg(locale, "signalExit", sig));
        requestStop(sig);
    };
    if (deps?.registerSignals !== false) {
        process.once("SIGINT", () => onSignal("SIGINT"));
        process.once("SIGTERM", () => onSignal("SIGTERM"));
    }

    // —— 10. 启动对账（补上次进程断线窗口）+ 周期对账循环（§6）——
    const reconcileLoop = async (): Promise<void> => {
        const pull = makeSdkPull(client, fcfg, log, locale, () => [...learnedChats]);
        let first = true;
        for (; ; ) {
            if (!first) await sleepInterruptible(reconcileMs); // 停机可打断（见步骤 3.5）
            first = false;
            if (shouldStop() || stopReason !== null) return;
            await runReconcile({
                pull,
                handle: (c) => handleAndReply(c, "reconcile"),
                now,
                locale,
                out: log,
            }).catch((e: any) => log(msg(locale, "msgFail", String(e?.message ?? e))));
        }
    };

    // —— 11. 扫描循环：心跳 + 残留清理 + pending 推卡 ——
    let lastHeartbeat = 0;
    let lastSweep = 0;
    const pushed = new Set<string>();
    const scanLoop = async (): Promise<void> => {
        for (; ; ) {
            if (shouldStop() || stopReason !== null) return;
            const t = now().getTime();
            if (t - lastHeartbeat >= heartbeatMs) {
                lastHeartbeat = t;
                await writeListenerHeartbeat(fcfg.users.length > 0, now()).catch(() => { });
            }
            if (t - lastSweep >= heartbeatMs) {
                lastSweep = t;
                await sweepStaleApprovals(now()).catch(() => 0);
            }
            try {
                const pendings = await listPendingApprovals(now());
                for (const p of pendings) {
                    if (pushed.has(p.approvalId)) continue;
                    const ok = await pushCard(client, p, fcfg, log, locale);
                    if (ok) pushed.add(p.approvalId);
                }
            } catch { /* 扫描异常下轮重试 */ }
            // —— 11.5 完成通知推送（runner 经 finishTicket 落盘 → 此处发送）：监听不在 = 文件留存
            //        等回来补推（断线不丢通知）；连败 NOTIFY_MAX_RETRIES 次放弃（会话不可达）——
            for (const n of await listPendingNotifications().catch(() => [] as Awaited<ReturnType<typeof listPendingNotifications>>)) {
                const sentId = await sendText(client, n.chatId, notifyText.finish(locale, n));
                if (sentId !== null) {
                    await recordMsgMap(sentId, n.ticketId); // 回复报告消息 = 续修该票
                    await clearNotification(n.ticketId);
                    log(notifyText.notifySent(locale, n.ticketId, sentId)); // 成功也留痕（2026-11-09 排查「重复推送」时成功路径零日志、无从对账）
                } else {
                    const giveUp = await bumpNotificationRetries(n);
                    if (giveUp) log(notifyText.notifyGiveUp(locale, n.ticketId));
                    else log(notifyText.notifyRetry(locale, n.ticketId, n.retries));
                }
            }
            await sleepInterruptible(scanMs); // 停机可打断
        }
    };

    // —— 12. 汇合：任一循环退出（停机钩子/信号/长连接断）即收尾 ——
    await Promise.all([scanLoop(), reconcileLoop()]);
    if (wsExitCode !== 0) requestStop("ws error");
    await fs.rm(path.join(batchQueueRoot(), "approvals", ".listener-heartbeat"), { force: true }).catch(() => { });
    await releaseListenLock();
    log(msg(locale, "stopped"));
    return { code: stopReason === "ws error" ? 1 : 0 };
};

/** 发一条文本消息到会话（回执/完成推送共用；成功返回消息 id 供回复路由登记，失败 null 不抛）。 */
const sendText = async (client: any, chatId: string, text: string): Promise<string | null> => {
    try {
        const r = await client.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
        });
        if ((r?.code ?? 0) !== 0) return null;
        return typeof r?.data?.message_id === "string" ? r.data.message_id : null;
    } catch {
        return null;
    }
};

/** 推一张审批卡到 users 白名单的每个私聊（users 为空由启动日志与心跳 canApprove=false 兜底）。 */
const pushCard = async (client: any, p: { approvalId: string; tool: string; summary: string; ticketId?: string; ticketTitle?: string; expiresAt: string }, fcfg: FeishuConfig, log: (l: string) => void, locale: SyncLocale): Promise<boolean> => {
    if (fcfg.users.length === 0) return true; // 无目标：置为已处理（runner 心跳 canApprove=false 不会落 pending）
    const content = buildApprovalCard(p);
    let allOk = true;
    for (const openId of fcfg.users) {
        try {
            const r = await client.im.message.create({
                params: { receive_id_type: "open_id" },
                data: { receive_id: openId, msg_type: "interactive", content },
            });
            const code = r?.code ?? 0;
            if (code !== 0) {
                allOk = false;
                log(msg(locale, "pushFail", `${code} ${r?.msg ?? ""}`.trim()));
            }
        } catch (e: any) {
            allOk = false;
            log(msg(locale, "pushFail", String(e?.message ?? e)));
        }
    }
    return allOk;
};
