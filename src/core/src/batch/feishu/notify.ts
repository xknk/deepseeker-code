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

// ============ 直答会话映射表（C1 会话粘住：与票映射刻意分表，互不污染路由） ============

/**
 * feishu-da-sessions.json：机器人直答回复消息 id → 直答 sessionId。
 * ★ 刻意独立于 feishu-msg-map.json：回复一张票的回执必须路由成「追加/续修」（票语义），
 *   回复一条直答必须续问（问答语义）——两表混用会让路由口径互相踩。同一把封顶/损坏自愈纪律。
 */
const daMapPath = (): string => path.join(batchRoot(), "feishu-da-sessions.json");

interface DaMapFile { map: Record<string, string>; updatedAt: string }

const loadDaMap = async (): Promise<Record<string, string>> => {
    try {
        const raw = JSON.parse(await fs.readFile(daMapPath(), "utf-8")) as DaMapFile;
        return raw?.map && typeof raw.map === "object" ? raw.map : {};
    } catch {
        return {};
    }
};

/** 登记一条 直答回复消息 id → 直答 sessionId（追问复用会话=前缀缓存热；幂等覆盖）。 */
export const recordDaSession = async (msgId: string, sessionId: string): Promise<void> => {
    if (!msgId || !sessionId) return;
    try {
        const map = await loadDaMap();
        map[msgId] = sessionId;
        const keys = Object.keys(map);
        for (const k of keys.slice(0, Math.max(0, keys.length - MSG_MAP_CAP))) delete map[k];
        const tmp = `${daMapPath()}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        await fs.writeFile(tmp, JSON.stringify({ map, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
        await fs.rename(tmp, daMapPath());
    } catch { /* 映射失败只影响追问粘住（降级为新会话），不阻塞直答主流程 */ }
};

/** 查消息 id 对应的直答 sessionId（无/损坏 = null）。 */
export const lookupDaSession = async (msgId: string): Promise<string | null> => {
    if (!msgId) return null;
    return (await loadDaMap())[msgId] ?? null;
};

// ============ 外发摘要闸（C3 结论回传：剥代码块 + 封顶；完成推送与直答回答同闸） ============

/**
 * 结论文字摘要构造器（外发红线的唯一放行形态）：剥 fenced 代码块（含未闭合退化到串尾）、
 * 剥行内反引号记号（保内容）、压空白为单空格、封顶 cap 字符加省略号。
 * 仍禁的东西（diff 体/凭据/验收原文）不经过本函数——上游就不放进来；这里只负责
 * 「允许结论文字」的形态约束。纯函数，守门测试直接验证。
 */
export const reportSummary = (text: string, cap = 200): string => {
    const stripped = (text || "")
        .replace(/```[\s\S]*?(```|$)/g, " ") // fenced 块整段剥（未闭合剥到串尾）
        .replace(/`([^`]*)`/g, "$1")        // 行内代码剥记号保内容
        .replace(/\s+/g, " ")
        .trim();
    if (!stripped) return "";
    return stripped.length > cap ? `${stripped.slice(0, cap)}…` : stripped;
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
    /** ★ B5（2026-11-09）：改动文件名列表——changed-file frontmatter 解析出【真实文件条目】
     *  （`<path> (+N/-M)` / `<path> (binary)` 形态；省略行不含该形态自然滤除）。
     *  仅文件名、不含 diff（外发红线）；解析/封顶在 writeFinishNotification，发送端只读不补算。 */
    changedFileNames: string[];
    /** ★ B2（2026-11-09）：被拒工具清单——denied-tool frontmatter 逐条原样（`<tool> — <detail>`），
     *  省略行（不含分隔符）滤除。推送追加「⚠️ N 个操作没放行…回复本消息可续修补跑」的拒因数据源。 */
    deniedTools: string[];
    /** ★ C3（2026-11-10）：结论摘要——报告 summary frontmatter 原样（runner 侧经 reportSummary
     *  剥代码块后落盘；单行 ≤200 字符）。旧版报告无此字段 = undefined，推送自然缺省该行。 */
    summary?: string;
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

/** 报告 frontmatter 多值提取（逐行；B2/B5 拒清单与改动清单共用）。 */
const reportFmAll = (report: string, key: string): string[] =>
    [...report.matchAll(new RegExp(`^${key}:\\s*(.+)$`, "gm"))].map((m) => m[1].trim());

/** changed-file 条目形态（numstatToChangedFiles 产出）：`<path> (+N/-M)` 或 `<path> (binary)`；省略行不匹配 → 滤除。 */
const CHANGED_FILE_ENTRY = /^(.+?)\s\((?:\+\d+\/-\d+|binary)\)$/;
/** denied-tool 条目形态：`<tool> — <detail>`（buildReport 落盘口径）；省略行不含分隔符 → 滤除。 */
const DENIED_TOOL_SEP = " — ";

/**
 * 落一张完成通知（queue.finishTicket 单一咽喉调用；票带 feishu-chat 才有此文件）。
 * 报告字段解析失败不抛——通知是增益不是关键路径，最差少推一条、日志可见。
 */
export const writeFinishNotification = async (args: { ticketId: string; reportMd: string; chatId: string; senderOpenId?: string; title: string }): Promise<void> => {
    try {
        const changedFiles = [...args.reportMd.matchAll(/^changed-file:\s*(.+)$/gm)].length;
        // B5：文件名列表（仅真实条目；封顶 30 与报告侧 CHANGED_FILE_CAP 同量级——推送展示侧再封顶）。
        const changedFileNames = reportFmAll(args.reportMd, "changed-file")
            .map((v) => CHANGED_FILE_ENTRY.exec(v)?.[1])
            .filter((x): x is string => !!x)
            .slice(0, 30);
        // B2：拒清单（含分隔符的真实条目；省略行滤除）。
        const deniedTools = reportFmAll(args.reportMd, "denied-tool")
            .filter((v) => v.includes(DENIED_TOOL_SEP))
            .slice(0, 30);
        // C3：结论摘要（runner 已剥代码块并压成单行；缺省 = 旧版报告，推送自然缺省该行）。
        const summary = reportFm(args.reportMd, "summary") || undefined;
        const n: FinishNotification = {
            ticketId: args.ticketId,
            chatId: args.chatId,
            senderOpenId: args.senderOpenId,
            title: args.title.slice(0, 60),
            status: reportFm(args.reportMd, "status") || "unknown",
            // cost 归一：缺省/旧版报告字面 "null"（batchRunner 无价模型曾直写 "null"）→ "?"（推送 ¥null 实锤，2026-11-09）
            cost: (v => !v || v === "null" ? "?" : v)(reportFm(args.reportMd, "cost-yuan")),
            branch: reportFm(args.reportMd, "branch") || "",
            changedFiles,
            changedFileNames,
            deniedTools,
            summary,
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

// ============ 回执文案（纯函数；中英双语，拟人口径——不露票号黑话，对人只称「这件事/代号」） ============

const STATUS_ZH: Record<string, string> = {
    passed: "✅ 验收通过",
    "accept-failed": "❌ 验收未通过",
    timeout: "⏱ 超时终止",
    error: "❌ 执行出错",
    "setup-failed": "⚠️ 环境准备（setup）失败",
    rejected: "🚫 工单被拒（未执行）",
    "watchdog-killed": "⏹ 看门狗终止（疑似卡死）",
    "baseline-broken": "⚠️ 基线测试本身是坏的",
    stopped: "🛑 已按你的指令停下",
};

/** 票号短代号（末段，如 20261111-112350-pyta → pyta）：对人可见处一律用短代号，完整票号只留在报告路径。
 *  非标准形态（段数 < 3，如测试桩 t-3）原样返回——代号唯一可撤销的语义在 listen 侧兜住。 */
const shortCode = (ticketId: string): string => {
    const parts = ticketId.split("-");
    return parts.length >= 3 ? (parts[parts.length - 1] ?? ticketId) : ticketId;
};

export const notifyText = {
    /** 建票回执（ahead=前面还有几件）。★ C2 即跑世界：默认点火即跑；排队时如实说排队。 */
    ackCreated: (locale: SyncLocale, ticketId: string, title: string, ahead: number): string =>
        locale === "zh"
            ? `🏃 收到，${ahead > 0 ? `排上了（前面还有 ${ahead} 件，依次跑）：「` : "这就去办：「"}${title}」。跑完回来汇报；想补充细节直接回这条`
            : `🏃 On it: "${title}"${ahead > 0 ? ` (queued, ${ahead} ahead)` : ""}. I'll report back here when it's done; reply to this message to add details`,
    /** ★ C2 意图词延迟回执（「今晚跑/明早跑/中午跑」）：whenHuman=开跑时刻的人话（如「明 01:00」）。
     *  代号随回执露出——撤销（取消 <代号>）靠它，不露完整票号。 */
    ackDeferred: (locale: SyncLocale, ticketId: string, title: string, whenHuman: string): string =>
        locale === "zh"
            ? `🌙 好的，排在 ${whenHuman}：「${title}」。到点自动开工；想撤掉就发「取消 ${shortCode(ticketId)}」`
            : `🌙 Scheduled for ${whenHuman} as you asked: "${title}". It starts automatically then; to cancel, send "cancel ${shortCode(ticketId)}"`,
    /** ★ C1 直答升级建票回执（写操作零容忍 → 升级建票，不引入「手机上批代码」）。 */
    ackUpgraded: (locale: SyncLocale, ticketId: string, title: string): string =>
        locale === "zh"
            ? `🛠️ 这件要动文件（问答模式只查不改），我当任务去办了：「${title}」。跑完回来汇报`
            : `🛠️ This one needs file changes (Q&A mode is read-only), so I'm running it as a task: "${title}". I'll report back when done`,
    /** ★ C1 直答回执（答案已过外发摘要闸：剥代码块、封顶；costText=本次花费，带 ¥ 前缀或 "?"）。 */
    daAnswer: (locale: SyncLocale, answer: string, costText: string): string =>
        locale === "zh" ? `📖 ${answer}${costText !== "?" ? `\n（花了 ¥${costText}）` : ""}` : `📖 ${answer}${costText !== "?" ? `\n(cost ¥${costText})` : ""}`,
    /** ★ C1 直答失败回执（失败不静默——静默=黑洞；引导改走任务路）。 */
    daError: (locale: SyncLocale, why: string): string =>
        locale === "zh"
            ? `⚠️ 这题没答上来：${why}。稍后可以再问一次；要改代码就直接说事，我去办`
            : `⚠️ Couldn't answer: ${why}. Feel free to ask again later; for code changes just describe the task and I'll run it`,
    /** 拒收回执（过了白名单但没建成——拒因必须回给人，静默=黑洞）。 */
    ackSkipped: (locale: SyncLocale, reason: string): string =>
        locale === "zh"
            ? `⚠️ 这条没接：${reason}`
            : `⚠️ Not picked up: ${reason}`,
    /** 重复回执（同内容已在办——回答"到底收没收到"）。 */
    ackDuplicate: (locale: SyncLocale, ticketId: string | undefined): string =>
        locale === "zh"
            ? `ℹ️ 这件事之前已经排过了，没有重复开${ticketId ? `（代号 ${shortCode(ticketId)}）` : ""}；有进展会汇报`
            : `ℹ️ This one was already queued${ticketId ? ` (code ${shortCode(ticketId)})` : ""}; no duplicate created. You'll hear back when it's done`,
    /** 追加回执（原件事在排队：内容已并入）。 */
    ackAppended: (locale: SyncLocale, ticketId: string, title: string): string =>
        locale === "zh"
            ? `➕ 收到——并进了排着的「${title}」，一起跑，不另开一件`
            : `➕ Appended to the queued "${title}" — they'll run together, no separate task`,
    /** 续办回执（上一件已跑完：续办件已排，基座=上件产物分支）。 */
    ackFollowupCreated: (locale: SyncLocale, ticketId: string, prevId: string): string =>
        locale === "zh"
            ? `🔁 收到，接着上一件继续办（${shortCode(prevId)} 那件的后续）——之前的改动都在基础上，不重做。跑完汇报`
            : `🔁 Continuing from ${shortCode(prevId)} — builds on the previous changes, no redo. Queued; report when done`,
    /** ★ B3 确认语闸回执（2026-11-09）：整句确认语不开票，回一句收到（si6d 实证误开票烧 ¥0.77）。 */
    ackConfirm: (locale: SyncLocale): string =>
        locale === "zh" ? "👍 收到" : "👍 Got it",
    /** ★ B4 后续回执（2026-11-09）：回复时上一件正在执行 → 新件照排、排其后，回执写明排队关系
     *  （此前此分支只回通用回执，「我的追加去哪了」无着落——路由总表黑洞分支补齐）。 */
    ackQueuedBehind: (locale: SyncLocale, ticketId: string, title: string, prevId: string): string =>
        locale === "zh"
            ? `🧵 收到——上一件还在跑，这件排它后面（各跑完各汇报）；想补充继续回这条`
            : `🧵 Got it — the previous task is still running; this one queues right after it (each reports when done). Reply here to add more`,
    /** 完成推送（手机可读摘要；不含 diff 与验收输出——外发红线）。
     *  ★ B5：改动清单带文件名列表（封顶 8 个，超出「等 N 个」）；★ B2：deniedTools 非空时追加
     *  「⚠️ N 个操作没放行…回复本消息可续修补跑」拒清单 + 翻案引导（此时通用尾注让位给引导语）。 */
    finish: (locale: SyncLocale, n: FinishNotification): string => {
        const zh = locale === "zh";
        const status = zh ? (STATUS_ZH[n.status] ?? n.status) : n.status;
        const names = n.changedFileNames ?? [];
        const shown = names.slice(0, 8);
        const files = n.changedFiles === 0
            ? (zh ? "没动文件" : "no files changed")
            : names.length === 0
                ? (zh ? `动了 ${n.changedFiles} 个文件` : `${n.changedFiles} file(s) changed`)
                : (zh
                    ? `动了 ${n.changedFiles} 个文件（${shown.join("、")}${names.length > 8 ? ` 等 ${names.length} 个` : ""}）`
                    : `${n.changedFiles} file(s) changed (${shown.join(", ")}${names.length > 8 ? ` +${names.length - 8} more` : ""})`);
        const costPart = zh ? `花了 ¥${n.cost}` : `cost ¥${n.cost}`;
        const branchPart = n.branch ? (zh ? `，改动在分支 ${n.branch}` : `, changes on branch ${n.branch}`) : "";
        const denied = n.deniedTools ?? [];
        const deniedShown = denied.slice(0, 3).map((d) => {
            const i = d.indexOf(DENIED_TOOL_SEP);
            const tool = i >= 0 ? d.slice(0, i) : d;
            const why = i >= 0 ? d.slice(i + DENIED_TOOL_SEP.length) : "";
            return zh ? `${tool}（${why.slice(0, 60)}）` : `${tool} (${why.slice(0, 60)})`;
        });
        const deniedLine = denied.length === 0 ? "" : (zh
            ? `\n⚠️ ${denied.length} 个操作没放行：${deniedShown.join("；")}${denied.length > 3 ? ` 等 ${denied.length} 项` : ""}，回复本消息可续修补跑`
            : `\n⚠️ ${denied.length} op(s) not permitted: ${deniedShown.join("; ")}${denied.length > 3 ? ` +${denied.length - 3} more` : ""} | reply to this message to follow up and re-run`);
        const tail = denied.length === 0 ? (zh ? "\n要跟进直接回这条" : "\nReply here to follow up") : "";
        // ★ C3 结论摘要（外发红线唯一放行形态：runner 侧已剥代码块封顶 200 字；旧报告无此行自然缺省）
        const summaryLine = n.summary ? `\n📄 ${n.summary}` : "";
        return `📋 「${n.title}」\n${status}，${files}，${costPart}${branchPart}${summaryLine}${deniedLine}\n报告：${n.reportPath}${tail}`;
    },
    // ============ C4 控制面回执（整句控制词的答复；数据在 listen 侧查队列/进度文件后传入） ============
    /** 「队列」：在跑 + 待跑一览（runningLine/pendingLines 由 listen 拼好——文案与数据同闸在此定型）。 */
    ctlQueue: (locale: SyncLocale, runningLine: string, pendingLine: string): string =>
        locale === "zh"
            ? `📋 ${runningLine}${pendingLine ? `\n${pendingLine}` : ""}`
            : `📋 ${runningLine}${pendingLine ? `\n${pendingLine}` : ""}`,
    /** 「进度」：当前件轮次+正在干什么（progressLine 由 listen 从进度心跳文件拼好）。 */
    ctlProgress: (locale: SyncLocale, progressLine: string): string => progressLine,
    /** 「停」已受理（软停：跑完当前这步就收尾，改动保留、报告照推）。 */
    ctlStopAccepted: (locale: SyncLocale, ticketId: string): string =>
        locale === "zh"
            ? "🛑 好，正在停——等手上这步做完就收尾，改动留在分支上，结果照常发你"
            : "🛑 Stopping — I'll wrap up after the current step. Changes stay on the branch; you'll still get the report",
    /** 「停」但没有在跑的件。 */
    ctlNothingRunning: (locale: SyncLocale): string =>
        locale === "zh" ? "ℹ️ 现在手上没有在跑的活儿" : "ℹ️ Nothing is running right now",
    /** 「进度」但没有在跑的件。 */
    ctlNothingRunningProgress: (locale: SyncLocale): string =>
        locale === "zh" ? "ℹ️ 现在手上没有在跑的活儿；想看排了哪些，发「队列」" : "ℹ️ Nothing running; send \"queue\" to see what's lined up",
    /** 「取消 <代号>」成功。 */
    ctlCancelled: (locale: SyncLocale, ticketId: string, title: string): string =>
        locale === "zh"
            ? `🗑️ 撤掉了：「${title}」（还没开跑）`
            : `🗑️ Cancelled "${title}" (it hadn't started)`,
    /** 「取消 <代号>」找不到（已开跑/已撤过/无此件）。 */
    ctlCancelGone: (locale: SyncLocale, ticketId: string): string =>
        locale === "zh"
            ? `⚠️ 没找到排着的「${ticketId}」——可能已经开跑或撤过；在跑的要停就发「停」`
            : `⚠️ Nothing queued matches "${ticketId}" (already started or cancelled; to stop a running one, send "stop")`,
    /** 剧本 E 闲聊引导（「在吗」整句）：一句话说清两种用法。 */
    ctlHello: (locale: SyncLocale): string =>
        locale === "zh"
            ? "在的。想查什么直接问（我查了就答）；要改代码的活描述清楚，我去办，跑完汇报。"
            : "Here. Ask anything you want looked up (I'll answer inline); describe code changes as tasks and I'll run them, reporting back when done.",
    /** sendText 成功留痕（日志用，不外发；C3：5x46 实锤发送结果零日志无从对账）。 */
    sendOk: (locale: SyncLocale, msgId: string, len: number): string =>
        locale === "zh"
            ? `📤 [feishu] 消息已发送（msg ${msgId}，${len} 字符）`
            : `📤 [feishu] message sent (msg ${msgId}, ${len} chars)`,
    /** sendText 失败留痕（日志用，不外发；只记业务码与原因，凭据/鉴权头永不进日志）。 */
    sendFail: (locale: SyncLocale, why: string): string =>
        locale === "zh"
            ? `⚠️ [feishu] 消息发送失败：${why}`
            : `⚠️ [feishu] message send failed: ${why}`,
    /** 通知推送失败放弃（日志用，不外发）。 */
    notifyGiveUp: (locale: SyncLocale, ticketId: string): string =>
        locale === "zh"
            ? `⚠️ [feishu] 完成通知 ${ticketId} 连续 ${NOTIFY_MAX_RETRIES} 次发送失败，放弃（会话可能已不可达；报告仍在 ${`.deepseeker-code/batch/done/${ticketId}.report.md`}）`
            : `⚠️ [feishu] finish notification ${ticketId} failed ${NOTIFY_MAX_RETRIES} times, giving up (chat unreachable? report stays at ${`.deepseeker-code/batch/done/${ticketId}.report.md`})`,
    /** 通知推送成功留痕（日志用，不外发）——成功也要可对账，否则手机收到 N 条时无线索可查。 */
    notifySent: (locale: SyncLocale, ticketId: string, msgId: string): string =>
        locale === "zh"
            ? `📤 [feishu] 完成通知已推送：票 ${ticketId}（消息 ${msgId}，已映射回复路由并清除待发）`
            : `📤 [feishu] finish notification pushed: ticket ${ticketId} (message ${msgId}, reply route mapped, pending cleared)`,
    /** 通知推送单次失败（下轮扫描重试；日志用，不外发）。 */
    notifyRetry: (locale: SyncLocale, ticketId: string, attempt: number): string =>
        locale === "zh"
            ? `⚠️ [feishu] 完成通知发送失败：票 ${ticketId} 第 ${attempt}/${NOTIFY_MAX_RETRIES} 次，下轮扫描重试`
            : `⚠️ [feishu] finish notification send failed: ticket ${ticketId} attempt ${attempt}/${NOTIFY_MAX_RETRIES}, will retry next scan`,
};
