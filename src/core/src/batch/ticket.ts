/**
 * @file batch/ticket.ts
 * @description 挂机批处理工单（成本信任链第四环 F1）的解析与校验：纯逻辑、零 IO，供队列层与 CLI 执行器消费。
 *
 *  工单格式（<项目>/.deepseeker-code/batch/pending/<id>.md）：
 *  ---
 *  title: 修复日期解析 bug
 *  accept: npm test            ← 必填（缺验收拒绝入队：第一版硬约束，防"看起来做了"）
 *  setup: pnpm install         ← 可选（agent 阶段前在 worktree 内执行的环境准备命令；worktree 是干净
 *                                检出、无 node_modules——验收依赖环境时先装依赖。非零退出=任务失败不烧钱）
 *  budget-yuan: 0.5            ← 可选（本任务花费上限，元；缺省不限）
 *  timeout-min: 30             ← 可选（缺省 30）
 *  retry: 1                    ← 可选（缺省 0）：被 batch 看门狗终止后带证据重试的次数上限（0-3；双倍烧钱口子，默认关）
 *  tools: run_command          ← 可选（显式解锁高危工具，缺省禁 run_command/delete_path，同 SUBAGENT_DENYLIST）
 *  source: github              ← 可选（多入口流水线 §4.1）：自动票必填；人工票缺省 manual
 *  source-url: https://…       ← 可选：外部系统原文链接（审计/回执用）
 *  source-id: github:o/r#42    ← 可选：去重与续修关联键（平台:仓库:编号）
 *  needs-review: true          ← 可选：accept 为自动探测/外部来源时置 true（人工复核提示）
 *  continues: <前 ticketId>    ← 可选（P2）：续修链审计
 *  attachments: batch/attachments/<id> ← 可选：入口附件落盘目录（相对 .deepseeker-code）
 *  feishu-chat: oc_xxx         ← 可选（P4 反馈闭环）：回执/报告推送目标会话 chat_id
 *  feishu-msg: om_xxx          ← 可选：触发本票的飞书消息 id（审计/回复路由）
 *  feishu-sender: ou_xxx       ← 可选：触发者 open_id（群聊回执 @ 用）
 *  not-before: <时间>          ← 可选（C2 意图词延迟执行）：此时刻之前取票跳过（留在 pending，
 *                                FIFO 只在可跑票上生效）——「今晚跑/明早跑」的唯一载体；票档入队时
 *                                必须已带（事后补改会跟点火器竞态）。
 *  ---
 *  ★ 红线（§4.1 评审修订）：以上新字段全部不进模型上下文——batchRunner 只把 body 作为 user 消息；
 *    字段是给人、给 batch pr、给续修与基线策略用的。非法值 fail-closed 拒收。
 *  任务描述正文（Markdown）…
 *
 *  安全注：工单文件位于 .deepseeker-code 保护段，isProtectedWrite 使模型在会话内改不了任务文件
 *  （防自改预算/自过验收）；解析侧仍做白名单校验（数字/枚举/清单），不信任文件内容形态。
 */
import fs from "fs/promises";

/** 解析后的工单（id 由队列层生成后回填）。 */
export interface BatchTicket {
    /** 任务标题（frontmatter 缺省回退正文首个非空行截 40 字）。 */
    title: string;
    /** 验收 shell 命令（必填）：跑完后在 worktree 内执行，exit 0 = 过。 */
    accept: string;
    /** 环境 setup 命令（可选）：agent 阶段前在 worktree 内执行（worktree 是干净检出，验收依赖 node_modules 等时先备好）。 */
    setup?: string;
    /** 本任务花费预算（元）；缺省 undefined = 不限。 */
    budgetYuan?: number;
    /** agent 阶段超时（分钟）；缺省 30。 */
    timeoutMin?: number;
    /** 被 batch 看门狗终止后带证据重试的次数上限（0-3）；缺省 0 = 杀即终态（§6.1，默认关）。 */
    retry?: number;
    /** 显式解锁的高危工具名清单；缺省空（run_command/delete_path 对模型不可见）。 */
    tools?: string[];
    /** 票据来源（§4.1）：sync 自动票必填；人工票缺省 manual。只用于审计与基线策略，不进模型上下文。 */
    source: BatchTicketSource;
    /** 外部系统原文链接（审计/回执用；不进模型上下文）。 */
    sourceUrl?: string;
    /** 去重与续修关联键（平台:仓库:编号；不进模型上下文）。 */
    sourceId?: string;
    /** accept 为自动探测/外部来源/含图票时置 true（提示人工复核，禁自动 batch pr——P2 落牙齿）。 */
    needsReview?: boolean;
    /** 续修链：前次 ticketId（P2）。 */
    continues?: string;
    /** 入口附件落盘目录（相对 .deepseeker-code；body 里有对应绝对路径注记）。 */
    attachments?: string;
    /** 回执/报告推送目标会话（P4 反馈闭环：票建成功回执 + finishTicket 完成推送；不进模型上下文）。 */
    feishuChat?: string;
    /** 触发本票的飞书消息 id（审计/回复路由；不进模型上下文）。 */
    feishuMsg?: string;
    /** 触发者 open_id（群聊回执 @ 前缀用；不进模型上下文）。 */
    feishuSender?: string;
    /** 最早可跑时刻（C2 意图词延迟执行，ISO 8601）：此时刻之前 takeNextTicket 跳过（票留 pending）。
     *  入队时即定（事后补改与点火器竞态）；不进模型上下文。 */
    notBefore?: string;
    /** 任务正文（Markdown，喂给 agent 的 user 消息）。 */
    body: string;
}

/** 票据来源枚举（§4.1）：未知来源 fail-closed 拒收，防 frontmatter 夹带自由文本。 */
export type BatchTicketSource = "github" | "gitlab" | "feishu" | "webhook" | "ci" | "manual";
const SOURCE_ENUM: ReadonlySet<string> = new Set(["github", "gitlab", "feishu", "webhook", "ci", "manual"]);

export type ParsedTicket = { ok: true; ticket: BatchTicket } | { ok: false; error: string };

/** 工单校验错误的输出语言（错误文案直接进 CLI 控制台与被拒报告；缺省 zh 向后兼容）。 */
export type BatchLocale = "zh" | "en";

const TICKET_MSG: Record<BatchLocale, Record<string, any>> = {
    zh: {
        noFrontmatter: "缺少 frontmatter（--- 包裹的头部块）。工单格式见 batch add 帮助。",
        noAccept: "frontmatter 缺 accept（验收命令）。挂机任务必须带可执行验收，缺验收拒绝入队。",
        badBudget: (v: string) => `budget-yuan 非法（"${v}"）：须为正数（元）。`,
        badTimeout: (v: string) => `timeout-min 非法（"${v}"）：须为正整数（分钟）。`,
        badRetry: (v: string) => `retry 非法（"${v}"）：须为 0-3 的整数（看门狗终止后带证据重试次数；缺省 0=不重试）。`,
        badTools: 'tools 为空：要么删掉该行（用缺省禁用清单），要么列工具名（逗号分隔）。',
        badSource: (v: string) => `source 非法（"${v}"）：须为 github|gitlab|feishu|webhook|ci|manual 之一。`,
        badSourceUrl: (v: string) => `source-url 非法（"${v}"）：须为 http(s):// 开头的链接。`,
        badSourceId: (v: string) => `source-id 非法（"${v}"）：须为「平台:仓库:编号」单行形态（如 github:owner/repo#42，不含空白）。`,
        badNeedsReview: (v: string) => `needs-review 非法（"${v}"）：须为 true 或 false。`,
        badContinues: (v: string) => `continues 非法（"${v}"）：须为前次工单 id（单行、无空白）。`,
        badAttachments: (v: string) => `attachments 非法（"${v}"）：须为相对 .deepseeker-code 的目录路径（禁绝对路径与 .. 上跳）。`,
        badFeishuField: (k: string, v: string) => `${k} 非法（"${v}"）：须为单行无空白的飞书 id（feishu-chat=oc_ 会话 / feishu-msg=om_ 消息 / feishu-sender=ou_ 用户）。`,
        badNotBefore: (v: string) => `not-before 非法（"${v}"）：须为可解析的时间（ISO 8601，如 2026-11-11T01:00:00+08:00）。`,
        emptyBody: "任务正文为空：frontmatter 之后应写任务描述。",
        untitled: "(未命名任务)",
        readFail: (e: string) => `读工单失败：${e}`,
    },
    en: {
        noFrontmatter: "Missing frontmatter (a --- delimited header block). See `batch add` help for the ticket format.",
        noAccept: "Frontmatter is missing `accept` (acceptance command). Batch tasks must carry an executable acceptance check — rejected without one.",
        badBudget: (v: string) => `Invalid budget-yuan ("${v}"): must be a positive number (yuan).`,
        badTimeout: (v: string) => `Invalid timeout-min ("${v}"): must be a positive integer (minutes).`,
        badRetry: (v: string) => `Invalid retry ("${v}"): must be an integer 0-3 (evidence-carrying retries after a watchdog kill; default 0 = no retry).`,
        badTools: "Empty tools: either remove the line (use the default denylist) or list tool names (comma-separated).",
        badSource: (v: string) => `Invalid source ("${v}"): must be one of github|gitlab|feishu|webhook|ci|manual.`,
        badSourceUrl: (v: string) => `Invalid source-url ("${v}"): must be an http(s):// link.`,
        badSourceId: (v: string) => `Invalid source-id ("${v}"): must be a single-line "platform:repo:number" form (e.g. github:owner/repo#42, no whitespace).`,
        badNeedsReview: (v: string) => `Invalid needs-review ("${v}"): must be true or false.`,
        badContinues: (v: string) => `Invalid continues ("${v}"): must be the previous ticket id (single line, no whitespace).`,
        badAttachments: (v: string) => `Invalid attachments ("${v}"): must be a directory path relative to .deepseeker-code (no absolute paths, no ".." segments).`,
        badFeishuField: (k: string, v: string) => `Invalid ${k} ("${v}"): must be a single-line Feishu id with no whitespace (feishu-chat=oc_ chat / feishu-msg=om_ message / feishu-sender=ou_ user).`,
        badNotBefore: (v: string) => `Invalid not-before ("${v}"): must be a parseable time (ISO 8601, e.g. 2026-11-11T01:00:00+08:00).`,
        emptyBody: "Empty task body: write the task description after the frontmatter.",
        untitled: "(untitled task)",
        readFail: (e: string) => `Failed to read ticket: ${e}`,
    },
};
const ticketMsg = (locale: BatchLocale, key: string): any => (TICKET_MSG[locale] ?? TICKET_MSG.zh)[key] ?? TICKET_MSG.zh[key] ?? key;

/** 生成工单 id：本地时间 YYYYMMDD-HHmmss + 4 位随机后缀（同秒多投不撞名，文件名排序即 FIFO）。 */
export const generateBatchId = (now = new Date()): string => {
    const p = (n: number, w = 2): string => String(n).padStart(w, "0");
    const rand = Math.random().toString(36).slice(2, 6);
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${rand}`;
};

/** 读取 tools 字段：逗号分隔串或 ["a","b"] 形态，归一为去空白非空数组。 */
const parseToolsValue = (raw: string): string[] =>
    raw
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

/** 正数校验（budget-yuan / timeout-min）：有限正数，否则返回 undefined+错误（由调用方拼提示）。 */
const parsePositiveNumber = (raw: string): number | null => {
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 解析并校验工单源文本。只信任「结构合法」的工单：缺 accept / 数字字段非法 → 拒绝（fail-closed）。
 * frontmatter 用行式 key: value 解析（不引 YAML 依赖；字段集固定、无嵌套，行式足够）。
 */
export const parseBatchTicket = (source: string, locale: BatchLocale = "zh"): ParsedTicket => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
    if (!m) return { ok: false, error: ticketMsg(locale, "noFrontmatter") };
    const [, fmRaw, bodyRaw] = m;

    const fm: Record<string, string> = {};
    for (const line of fmRaw.split(/\r?\n/)) {
        const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
        if (!kv) continue; // 非法行忽略（注释等）；严格 YAML 不做——工单是开发者手写的
        fm[kv[1].toLowerCase()] = kv[2].trim();
    }

    const accept = (fm["accept"] ?? "").trim();
    if (!accept) return { ok: false, error: ticketMsg(locale, "noAccept") };

    let budgetYuan: number | undefined;
    if (fm["budget-yuan"] !== undefined) {
        const n = parsePositiveNumber(fm["budget-yuan"]);
        if (n === null) return { ok: false, error: ticketMsg(locale, "badBudget")(fm["budget-yuan"]) };
        budgetYuan = n;
    }
    let timeoutMin: number | undefined;
    if (fm["timeout-min"] !== undefined) {
        const n = parsePositiveNumber(fm["timeout-min"]);
        if (n === null) return { ok: false, error: ticketMsg(locale, "badTimeout")(fm["timeout-min"]) };
        timeoutMin = n;
    }
    let retry: number | undefined;
    if (fm["retry"] !== undefined) {
        const n = Number(fm["retry"].trim());
        if (!Number.isInteger(n) || n < 0 || n > 3) return { ok: false, error: ticketMsg(locale, "badRetry")(fm["retry"]) };
        retry = n;
    }
    const tools = fm["tools"] !== undefined ? parseToolsValue(fm["tools"]) : undefined;
    if (tools && tools.length === 0) return { ok: false, error: ticketMsg(locale, "badTools") };
    const setup = (fm["setup"] ?? "").trim() || undefined; // 任意非空串即 shell 命令，无需校验形态

    // ============ 多入口流水线新字段（§4.1）：全可选、缺省向后兼容，非法值 fail-closed ============
    let ticketSource: BatchTicketSource = "manual"; // 人工票缺省 manual
    if (fm["source"] !== undefined) {
        const v = fm["source"].trim();
        if (v && !SOURCE_ENUM.has(v)) return { ok: false, error: ticketMsg(locale, "badSource")(fm["source"]) };
        if (v) ticketSource = v as BatchTicketSource;
    }
    let sourceUrl: string | undefined;
    if (fm["source-url"] !== undefined) {
        const v = fm["source-url"].trim();
        if (v && !/^https?:\/\//i.test(v)) return { ok: false, error: ticketMsg(locale, "badSourceUrl")(fm["source-url"]) };
        sourceUrl = v || undefined;
    }
    let sourceId: string | undefined;
    if (fm["source-id"] !== undefined) {
        const v = fm["source-id"].trim();
        // 「平台:仓库:编号」单行形态：首段是平台名，冒号后非空白；含空白/缺冒号都拒
        if (v && !/^[A-Za-z0-9][\w-]*:\S+$/.test(v)) return { ok: false, error: ticketMsg(locale, "badSourceId")(fm["source-id"]) };
        sourceId = v || undefined;
    }
    let needsReview: boolean | undefined;
    if (fm["needs-review"] !== undefined) {
        const v = fm["needs-review"].trim();
        if (v && v !== "true" && v !== "false") return { ok: false, error: ticketMsg(locale, "badNeedsReview")(fm["needs-review"]) };
        needsReview = v ? v === "true" : undefined;
    }
    let continues: string | undefined;
    if (fm["continues"] !== undefined) {
        const v = fm["continues"].trim();
        if (v && !/^[\w.-]+$/.test(v)) return { ok: false, error: ticketMsg(locale, "badContinues")(fm["continues"]) };
        continues = v || undefined;
    }
    let attachments: string | undefined;
    if (fm["attachments"] !== undefined) {
        const v = fm["attachments"].trim();
        if (v) {
            // 相对路径红线：绝对路径（/、\\、盘符）或 .. 上跳段 = 把 agent 的可读入口指到仓外，拒收
            const segs = v.split(/[\\/]+/);
            if (/^([A-Za-z]:)?[\\/]/.test(v) || segs.includes("..")) {
                return { ok: false, error: ticketMsg(locale, "badAttachments")(fm["attachments"]) };
            }
            attachments = v;
        }
    }

    // ============ P4 反馈闭环字段：回执/推送目标与回复路由（全可选；单行无空白，fail-closed） ============
    // 含空白的值 = frontmatter 夹带自由文本（可被当成第二个正文注入），拒收整票。
    const badFeishu = (key: string): string => (ticketMsg(locale, "badFeishuField") as (k: string, v: string) => string)(key, fm[key]);
    const parseFeishuId = (key: string): { v?: string; err?: string } => {
        if (fm[key] === undefined) return {};
        const v = fm[key].trim();
        if (!v) return {};
        return /\s/.test(v) ? { err: badFeishu(key) } : { v };
    };
    const fc = parseFeishuId("feishu-chat");
    if (fc.err) return { ok: false, error: fc.err };
    const fmId = parseFeishuId("feishu-msg");
    if (fmId.err) return { ok: false, error: fmId.err };
    const fsn = parseFeishuId("feishu-sender");
    if (fsn.err) return { ok: false, error: fsn.err };

    // ============ C2 意图词延迟执行字段：not-before（可选；须为可解析时间，归一 ISO） ============
    let notBefore: string | undefined;
    if (fm["not-before"] !== undefined) {
        const v = fm["not-before"].trim();
        if (v) {
            const t = new Date(v).getTime();
            if (!Number.isFinite(t)) return { ok: false, error: ticketMsg(locale, "badNotBefore")(fm["not-before"]) };
            notBefore = new Date(t).toISOString();
        }
    }

    const body = bodyRaw.trim();
    if (!body) return { ok: false, error: ticketMsg(locale, "emptyBody") };

    const title = (fm["title"] ?? "").trim() || body.split(/\r?\n/).find((l) => l.trim())?.slice(0, 40) || ticketMsg(locale, "untitled");
    return {
        ok: true,
        ticket: {
            title, accept, setup, budgetYuan, timeoutMin, retry,
            tools: tools && tools.length > 0 ? tools : undefined,
            source: ticketSource, sourceUrl, sourceId, needsReview, continues, attachments,
            feishuChat: fc.v, feishuMsg: fmId.v, feishuSender: fsn.v, notBefore,
            body,
        },
    };
};

/** 便捷读取：读文件并解析（入队用）。 */
export const readBatchTicket = async (filePath: string, locale: BatchLocale = "zh"): Promise<ParsedTicket> => {
    let source: string;
    try {
        source = await fs.readFile(filePath, "utf-8");
    } catch (e: any) {
        return { ok: false, error: ticketMsg(locale, "readFail")(e?.message ?? e) };
    }
    return parseBatchTicket(source, locale);
};
