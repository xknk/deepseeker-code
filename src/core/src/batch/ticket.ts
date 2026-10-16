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
 *  tools: run_command          ← 可选（显式解锁高危工具，缺省禁 run_command/delete_path，同 SUBAGENT_DENYLIST）
 *  ---
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
    /** 显式解锁的高危工具名清单；缺省空（run_command/delete_path 对模型不可见）。 */
    tools?: string[];
    /** 任务正文（Markdown，喂给 agent 的 user 消息）。 */
    body: string;
}

export type ParsedTicket = { ok: true; ticket: BatchTicket } | { ok: false; error: string };

/** 工单校验错误的输出语言（错误文案直接进 CLI 控制台与被拒报告；缺省 zh 向后兼容）。 */
export type BatchLocale = "zh" | "en";

const TICKET_MSG: Record<BatchLocale, Record<string, any>> = {
    zh: {
        noFrontmatter: "缺少 frontmatter（--- 包裹的头部块）。工单格式见 batch add 帮助。",
        noAccept: "frontmatter 缺 accept（验收命令）。挂机任务必须带可执行验收，缺验收拒绝入队。",
        badBudget: (v: string) => `budget-yuan 非法（"${v}"）：须为正数（元）。`,
        badTimeout: (v: string) => `timeout-min 非法（"${v}"）：须为正整数（分钟）。`,
        badTools: 'tools 为空：要么删掉该行（用缺省禁用清单），要么列工具名（逗号分隔）。',
        emptyBody: "任务正文为空：frontmatter 之后应写任务描述。",
        untitled: "(未命名任务)",
        readFail: (e: string) => `读工单失败：${e}`,
    },
    en: {
        noFrontmatter: "Missing frontmatter (a --- delimited header block). See `batch add` help for the ticket format.",
        noAccept: "Frontmatter is missing `accept` (acceptance command). Batch tasks must carry an executable acceptance check — rejected without one.",
        badBudget: (v: string) => `Invalid budget-yuan ("${v}"): must be a positive number (yuan).`,
        badTimeout: (v: string) => `Invalid timeout-min ("${v}"): must be a positive integer (minutes).`,
        badTools: "Empty tools: either remove the line (use the default denylist) or list tool names (comma-separated).",
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
    const tools = fm["tools"] !== undefined ? parseToolsValue(fm["tools"]) : undefined;
    if (tools && tools.length === 0) return { ok: false, error: ticketMsg(locale, "badTools") };
    const setup = (fm["setup"] ?? "").trim() || undefined; // 任意非空串即 shell 命令，无需校验形态

    const body = bodyRaw.trim();
    if (!body) return { ok: false, error: ticketMsg(locale, "emptyBody") };

    const title = (fm["title"] ?? "").trim() || body.split(/\r?\n/).find((l) => l.trim())?.slice(0, 40) || ticketMsg(locale, "untitled");
    return { ok: true, ticket: { title, accept, setup, budgetYuan, timeoutMin, tools: tools && tools.length > 0 ? tools : undefined, body } };
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
