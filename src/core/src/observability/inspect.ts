/**
 * @file observability/inspect.ts
 * @description P2-15 可观测性命令的数据采集与格式化：/usage /context /permissions /mcp /hooks /debug。
 *  纯采集 + 文本格式化，无 UI（CLI 的 runLocalSlash 与 VSCode 的 localObs 消息都调用后以 info 行渲染）。
 *  数据源：trace JSONL（usage）、session store（archived）、appConfig（context/debug）、
 *  以及 core 新增的 listPermissionRules / listHooks / listMcpClients。
 *  ★ 双语：各函数尾参 locale 由调用端显式传入（CLI getLocale() / VSCode host.currentLocale），
 *    缺省 "zh" 兼容旧调用；文案集中在 OBS 词表（zh/en 键集一致，漏英文键回退中文）。
 */
import fs from "fs";
import { appConfig } from "@/config/index.ts";
import { listPermissionRules } from "@/tool/permissions.ts";
import { listHooks } from "@/hooks/registry.ts";
import { listMcpClients } from "@/tool/mcp/loader.ts";
import { getTraceStorePath } from "@/observability/store.ts";
import { readUsageRecords, summarizeUsage, topTools } from "@/observability/usageLog.ts";
import { calcCostYuan, priceFor } from "@/config/prices.ts";
import { getRollingState } from "@/session/store.ts";
import { getToolOutputSidecarDir } from "@/session/sidecar.ts";
import { parseSummarySlot } from "@/agent/truncate.ts";
import { getRecallHitCount } from "@/tool/registry/recall.ts";
import { MODEL_NAME, AUX_MODEL_NAME } from "@/llm/createModel.ts";

/** 观测输出语言（与 UI 层 UiLocale 同形；独立声明避免 core 依赖 vscode/cli 模块）。 */
export type ObsLocale = "zh" | "en";

/** 观测文案词表：值为字符串或模板函数；zh/en 键集一致。 */
const OBS: Record<ObsLocale, Record<string, any>> = {
    zh: {
        usageNoData: "📊 Token 用量：暂无数据（本会话尚无 LLM 响应落盘）。",
        usageHead: (rounds: number) => `📊 Token 用量（本会话，${rounds} 次 LLM 响应）`,
        usageTokens: (prompt: string, completion: string, total: string) =>
            `  输入(prompt): ${prompt}  | 输出(completion): ${completion}  | 合计: ${total}`,
        usageCache: (hit: string, rate: string, miss: string) =>
            `  缓存命中: ${hit}（${rate}%）  | 缓存未命中: ${miss}`,
        usageSplit: (main: string, sub: string) =>
            `  主 agent: ${main}  | 子 agent(spawn/workflow): ${sub}`,
        usageSessionRuns: (runs: number, rounds: number, avg: string, aborted: number, pct: number) =>
            `  ▎本会话 ${runs} 个 run：${rounds} 轮（均 ${avg} 轮/run）· 中止 ${aborted}/${runs}（${pct}%）`,
        usageNoTools: "（无工具调用）",
        usageRunLine: (ts: string, rounds: number, tok: string, stop: string, tools: string) =>
            `    ${ts}  ${rounds}轮  ${tok} tok  ${stop}  ${tools}`,
        stopLabel: { normal: "完成", aborted: "中止", error: "错误", repeat: "熔断", limit: "超限" } as Record<string, string>,
        usageWeek: (runs: number, rounds: number, avg: string, abortPct: number, tokens: string, hitPct: string) =>
            `  ▎近 7 天（使用日志 · 全项目）：${runs} runs · ${rounds} 轮（均 ${avg} 轮/run）· 中止 ${abortPct}% · ${tokens} tok（缓存命中 ${hitPct}%）`,
        usageTopTools: (tools: string[]) => `    常用工具: ${tools.join("、") || "（无）"}`,
        usageWeekCost: (cost: string, saved: string, unpriced: number) =>
            `    近 7 天花费 ¥${cost}（缓存命中已省 ¥${saved}）${unpriced > 0 ? ` · ${unpriced} 条无价记录未计` : ""}`,
        usageTopSessions: (tops: string) => `    费用 top 会话: ${tops}`,
        usageTip: "  提示：并行 workflow 会放大子 agent 用量；缓存命中率越高，输入成本越低。",
        ctxHead: "🧠 上下文治理",
        ctxWindow: (window: string, threshold: string, ratio: number, keep: number) =>
            `  窗口上限: ${window}  | 压缩阈值: ${threshold}（${ratio}×）  | 保留最近: ${keep} 对话单元`,
        ctxLastPrompt: (p: string | null, fillRate: string | null) =>
            `  最近 prompt: ${p ?? "（尚无）"}${fillRate ? `（占窗口 ${fillRate}%）` : ""}`,
        ctxArchived: (n: number) => `  已归档(压缩)消息条数: ${n}`,
        ctxEntities: (n: number) => `  本会话已归档实体: ${n} 个（摘要槽索引）`,
        ctxRecall: (n: number) => `  召回命中: ${n} 次（recall 工具，本次进程内计数）`,
        ctxSidecar: (n: number) => `  侧车存档: ${n} 条（超长工具结果原文，recall with_full 取回）`,
        ctxTip: (pct: number) => `  超过阈值即触发滚动压缩；fillRate 接近 ${pct}% 时即将压缩。`,
        permEmpty: "🔒 权限规则：无（全部走默认 safetyLevel：SAFE 免审 / MUTATION·DANGER 审批）。",
        permHead: "🔒 权限规则（优先级 deny > ask > allow；未匹配走默认 safetyLevel）",
        permNone: "(无)",
        permGroup: (icon: string, label: string, n: number) => `  ${icon} ${label}（${n}）:`,
        mcpEmpty: "🔌 MCP：无已连接 server（在 ~/.deepseeker-code/mcp.json 配置）。",
        mcpHead: (n: number, tools: number) => `🔌 MCP server（${n} 个，共 ${tools} 个工具）`,
        mcpLine: (name: string, tools: string) => `  • ${name}（${tools}）`,
        mcpToolCount: (n: number) => `${n} 个工具`,
        mcpToolCountFail: "工具数获取失败",
        hooksEmpty: "🪝 Hooks：无（在 ~/.deepseeker-code/settings.json 的 hooks 段配置）。",
        hooksHead: (n: number) => `🪝 Hooks（共 ${n} 条，按事件分组）`,
        hooksGroup: (evt: string, n: number) => `  • ${evt}（${n}）:`,
        dbgHead: "🐞 Debug 快照",
        dbgSessionNone: "(未初始化)",
        dbgModels: (main: string, aux: string) => `  主模型: ${main}  | 辅助模型: ${aux}`,
        dbgAuxNone: "(未配置)",
        dbgOn: "开",
        dbgOff: "关",
        dbgParallel: (on: string, conc: number, steps: number) =>
            `  并行工具: ${on}  | workflow 并发上限: ${conc}  | workflow 最大步数: ${steps}`,
        dbgUndo: (on: string, search: string) => `  undo: ${on}  | 搜索后端: ${search}`,
        dbgSearchAuto: "(自动)",
        dbgPlatform: (node: string, platform: string) => `  Node: ${node}  | 平台: ${platform}`,
    },
    en: {
        usageNoData: "📊 Token usage: no data yet (no LLM responses logged for this session).",
        usageHead: (rounds: number) => `📊 Token usage (this session, ${rounds} LLM responses)`,
        usageTokens: (prompt: string, completion: string, total: string) =>
            `  Input (prompt): ${prompt}  | Output (completion): ${completion}  | Total: ${total}`,
        usageCache: (hit: string, rate: string, miss: string) =>
            `  Cache hit: ${hit} (${rate}%)  | Cache miss: ${miss}`,
        usageSplit: (main: string, sub: string) =>
            `  Main agent: ${main}  | Sub agents (spawn/workflow): ${sub}`,
        usageSessionRuns: (runs: number, rounds: number, avg: string, aborted: number, pct: number) =>
            `  ▎This session: ${runs} runs, ${rounds} rounds (avg ${avg}/run) · aborted ${aborted}/${runs} (${pct}%)`,
        usageNoTools: "(no tool calls)",
        usageRunLine: (ts: string, rounds: number, tok: string, stop: string, tools: string) =>
            `    ${ts}  ${rounds} rounds  ${tok} tok  ${stop}  ${tools}`,
        stopLabel: { normal: "done", aborted: "aborted", error: "error", repeat: "fuse", limit: "limit" } as Record<string, string>,
        usageWeek: (runs: number, rounds: number, avg: string, abortPct: number, tokens: string, hitPct: string) =>
            `  ▎Last 7 days (usage log · all projects): ${runs} runs · ${rounds} rounds (avg ${avg}/run) · aborted ${abortPct}% · ${tokens} tok (cache hit ${hitPct}%)`,
        usageTopTools: (tools: string[]) => `    Top tools: ${tools.join(", ") || "(none)"}`,
        usageWeekCost: (cost: string, saved: string, unpriced: number) =>
            `    7-day spend ¥${cost} (cache hits saved ¥${saved})${unpriced > 0 ? ` · ${unpriced} unpriced records excluded` : ""}`,
        usageTopSessions: (tops: string) => `    Costliest sessions: ${tops}`,
        usageTip: "  Tip: parallel workflows multiply sub-agent usage; higher cache hit rate means lower input cost.",
        ctxHead: "🧠 Context governance",
        ctxWindow: (window: string, threshold: string, ratio: number, keep: number) =>
            `  Window cap: ${window}  | Compact threshold: ${threshold} (${ratio}×)  | Keep recent: ${keep} dialogue units`,
        ctxLastPrompt: (p: string | null, fillRate: string | null) =>
            `  Last prompt: ${p ?? "(none yet)"}${fillRate ? ` (${fillRate}% of window)` : ""}`,
        ctxArchived: (n: number) => `  Archived (compacted) messages: ${n}`,
        ctxEntities: (n: number) => `  Archived entities this session: ${n} (summary-slot index)`,
        ctxRecall: (n: number) => `  Recall hits: ${n} (recall tool, in-process count)`,
        ctxSidecar: (n: number) => `  Sidecar archives: ${n} (full tool outputs, retrievable via recall with_full)`,
        ctxTip: (pct: number) => `  Rolling compaction triggers past the threshold; fillRate near ${pct}% means compaction is imminent.`,
        permEmpty: "🔒 Permission rules: none (everything uses default safetyLevel: SAFE auto-approve / MUTATION·DANGER gated).",
        permHead: "🔒 Permission rules (priority deny > ask > allow; unmatched uses default safetyLevel)",
        permNone: "(none)",
        permGroup: (icon: string, label: string, n: number) => `  ${icon} ${label} (${n}):`,
        mcpEmpty: "🔌 MCP: no connected servers (configure in ~/.deepseeker-code/mcp.json).",
        mcpHead: (n: number, tools: number) => `🔌 MCP servers (${n}, ${tools} tools total)`,
        mcpLine: (name: string, tools: string) => `  • ${name} (${tools})`,
        mcpToolCount: (n: number) => `${n} tools`,
        mcpToolCountFail: "failed to count tools",
        hooksEmpty: "🪝 Hooks: none (configure under the hooks key in ~/.deepseeker-code/settings.json).",
        hooksHead: (n: number) => `🪝 Hooks (${n} total, grouped by event)`,
        hooksGroup: (evt: string, n: number) => `  • ${evt} (${n}):`,
        dbgHead: "🐞 Debug snapshot",
        dbgSessionNone: "(not initialized)",
        dbgModels: (main: string, aux: string) => `  Main model: ${main}  | Aux model: ${aux}`,
        dbgAuxNone: "(not configured)",
        dbgOn: "on",
        dbgOff: "off",
        dbgParallel: (on: string, conc: number, steps: number) =>
            `  Parallel tools: ${on}  | Workflow concurrency cap: ${conc}  | Workflow max steps: ${steps}`,
        dbgUndo: (on: string, search: string) => `  undo: ${on}  | Search backend: ${search}`,
        dbgSearchAuto: "(auto)",
        dbgPlatform: (node: string, platform: string) => `  Node: ${node}  | Platform: ${platform}`,
    },
};

/** 取词：缺键回退 zh（英文表漏键时功能不破，仅可见不一致）。 */
const obsT = (locale: ObsLocale) => {
    const dict = OBS[locale] ?? OBS.zh;
    return (key: string): any => dict[key] ?? OBS.zh[key] ?? key;
};

const CWD = process.cwd();
const fmt = (n: number | undefined | null): string => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "-");

/** 读取并解析当前会话的 trace JSONL（容错：无文件/解析失败返回 []）。 */
const readTrace = async (sessionId: string): Promise<any[]> => {
    if (!sessionId) return [];
    try {
        const p = await getTraceStorePath(sessionId);
        const text = await fs.promises.readFile(p, "utf8");
        const out: any[] = [];
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
        }
        return out;
    } catch { return []; }
};

/** token 数缩写：≥10k 显示 12.3k，其余原样千分位 */
const fmtK = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : fmt(n));

/** /usage：从 trace 汇总 token 用量（按主 agent / 子 agent 拆分 + 缓存命中），并附使用日志（路线 #6）
 *  的本会话 run 明细与近 7 天日常聚合——evals 测「能不能」，使用日志测「日常省不省」。 */
export const inspectUsage = async (sessionId: string, locale: ObsLocale = "zh"): Promise<string> => {
    const t = obsT(locale);
    const trace = await readTrace(sessionId);
    const responses = trace.filter(x => x?.eventType === "llm.response" && x?.usage);
    // ★ 使用日志读侧（跨会话长期口径见 scripts/usage-report.ts）：本会话 run 明细 + 近 7 天全项目聚合
    const sessionRuns = (await readUsageRecords()).filter(r => r.sessionId === sessionId);
    if (responses.length === 0 && sessionRuns.length === 0) return t("usageNoData");
    let prompt = 0, completion = 0, total = 0, cacheHit = 0, cacheMiss = 0;
    let mainTotal = 0, subTotal = 0;
    for (const r of responses) {
        const u = r.usage;
        prompt += u.prompt_tokens ?? 0;
        completion += u.completion_tokens ?? 0;
        total += u.total_tokens ?? 0;
        cacheHit += u.prompt_cache_hit_tokens ?? 0;
        cacheMiss += u.prompt_cache_miss_tokens ?? 0;
        const depth = r?.metadata?.depth ?? 0;
        if (depth > 0) subTotal += u.total_tokens ?? 0; else mainTotal += u.total_tokens ?? 0;
    }
    const cacheRate = prompt > 0 ? ((cacheHit / prompt) * 100).toFixed(1) : "0.0";
    const rounds = responses.length;
    const stopLabel = t("stopLabel") as Record<string, string>;
    const lines = [
        t("usageHead")(rounds),
        t("usageTokens")(fmt(prompt), fmt(completion), fmt(total)),
        t("usageCache")(fmt(cacheHit), cacheRate, fmt(cacheMiss)),
        t("usageSplit")(fmt(mainTotal), fmt(subTotal)),
    ];
    if (sessionRuns.length > 0) {
        const ss = summarizeUsage(sessionRuns);
        const abortedPct = ss.mainRuns > 0 ? Math.round((ss.stopReasons.aborted / ss.mainRuns) * 100) : 0;
        const avgRounds = ss.mainRuns > 0 ? (ss.mainRounds / ss.mainRuns).toFixed(1) : "0";
        lines.push(t("usageSessionRuns")(ss.mainRuns, ss.mainRounds, avgRounds, ss.stopReasons.aborted, abortedPct));
        for (const r of sessionRuns.filter(x => x.depth === 0).slice(-6)) {
            const tools = topTools(r.tools, 3).map(([n, c]) => `${n}×${c}`).join(" ") || t("usageNoTools");
            lines.push(t("usageRunLine")(String(r.ts).slice(5, 16).replace("T", " "), r.rounds, fmtK(r.totalTokens ?? 0), stopLabel[r.stopReason] ?? r.stopReason, tools));
        }
    }
    // 近 7 天聚合（保留记录列表供成本逐条折算——成本信任链 D3：优先读落盘 costYuan，旧记录按现价现算兜底；
    // 无价记录不进钱的和（null 语义，绝不编数））
    const weekRecords = await readUsageRecords(7);
    const week = summarizeUsage(weekRecords);
    if (week.runs > 0) {
        const weekHit = week.promptTokens > 0 ? ((week.cachedTokens / week.promptTokens) * 100).toFixed(1) : "0.0";
        const weekAbort = week.mainRuns > 0 ? Math.round((week.stopReasons.aborted / week.mainRuns) * 100) : 0;
        const weekAvg = week.mainRuns > 0 ? (week.mainRounds / week.mainRuns).toFixed(1) : "0";
        const tools = topTools(week.tools, 4).map(([n, c]) => `${n}×${c}`);
        lines.push(
            t("usageWeek")(week.mainRuns, week.mainRounds, weekAvg, weekAbort, fmtK(week.totalTokens), weekHit),
            t("usageTopTools")(tools),
        );
        const bySession = new Map<string, number>();
        let weekCost = 0, weekSaved = 0, pricedRuns = 0;
        for (const r of weekRecords) {
            const c = r.costYuan ?? calcCostYuan(r.model, r);
            if (c == null) continue;
            pricedRuns++;
            weekCost += c;
            bySession.set(r.sessionId, (bySession.get(r.sessionId) ?? 0) + c);
            const p = priceFor(r.model);
            if (p) weekSaved += ((r.cachedTokens ?? 0) * (p.input - p.cacheHit)) / 1e6; // 命中部分按未命中价本要多付的差价
        }
        if (pricedRuns > 0) {
            const tops = [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
                .map(([sid, c]) => `${sid.slice(0, 8)} ¥${c.toFixed(3)}`).join(" · ");
            const unpaid = week.runs - pricedRuns;
            lines.push(t("usageWeekCost")(weekCost.toFixed(3), weekSaved.toFixed(3), unpaid));
            if (tops) lines.push(t("usageTopSessions")(tops));
        }
    }
    lines.push(t("usageTip"));
    return lines.join("\n");
};

/** /context：当前上下文窗口治理参数 + 最近一轮 prompt token + 已归档条数 + 归档资产三键（H3）。 */
export const inspectContext = async (sessionId: string, locale: ObsLocale = "zh"): Promise<string> => {
    const t = obsT(locale);
    const trace = await readTrace(sessionId);
    // 最近一次带 usage 的响应 = 最近上下文规模
    let lastPrompt: number | undefined;
    for (let i = trace.length - 1; i >= 0; i--) {
        const u = trace[i]?.usage?.prompt_tokens;
        if (typeof u === "number") { lastPrompt = u; break; }
    }
    let archived = 0;
    let archivedEntities = 0;
    try {
        const rolling = await getRollingState(sessionId);
        archived = rolling.archivedMessageCount ?? 0;
        // H3 归档实体数：摘要槽 ⟦DSC:ARCHIVE-INDEX⟧ 段的确定性解析（parseSummarySlot 与写入侧同源，勿在此重写解析）
        archivedEntities = parseSummarySlot(rolling.rollingSummary ?? "").index.length;
    } catch { /* ignore */ }
    // H3 侧车存档条数：tool-outputs 目录 .txt 计数（目录不存在=0，不报错）
    let sidecarCount = 0;
    try {
        sidecarCount = (await fs.promises.readdir(getToolOutputSidecarDir(sessionId)))
            .filter((f) => f.endsWith(".txt")).length;
    } catch { /* ignore */ }
    const window = appConfig.MAX_HISTORY_TOKENS;
    const ratio = appConfig.COMPACT_RATIO;
    const threshold = Math.round(window * ratio);
    const fillRate = lastPrompt ? ((lastPrompt / window) * 100).toFixed(1) : null;
    return [
        t("ctxHead"),
        t("ctxWindow")(fmt(window), fmt(threshold), ratio, appConfig.KEEP_RECENT_UNITS),
        t("ctxLastPrompt")(lastPrompt ? fmt(lastPrompt) : null, fillRate),
        t("ctxArchived")(archived),
        t("ctxEntities")(archivedEntities),
        t("ctxRecall")(getRecallHitCount(sessionId)),
        t("ctxSidecar")(sidecarCount),
        t("ctxTip")(Math.round(ratio * 100)),
    ].join("\n");
};

/** /permissions：列出已加载的 allow/ask/deny 规则。 */
export const inspectPermissions = (locale: ObsLocale = "zh"): string => {
    const t = obsT(locale);
    const r = listPermissionRules();
    const total = r.allow.length + r.deny.length + r.ask.length;
    if (total === 0) return t("permEmpty");
    const render = (label: string, kind: "allow" | "ask" | "deny", icon: string) => {
        const list = r[kind];
        if (list.length === 0) return `  ${icon} ${label}: ${t("permNone")}`;
        return t("permGroup")(icon, label, list.length) + "\n" + list.map(x => `      ${x.toolName}${x.raw && x.raw !== x.toolName ? `  ← ${x.raw}` : ""}`).join("\n");
    };
    return [t("permHead"), render("Deny", "deny", "🚫"), render("Ask", "ask", "❓"), render("Allow", "allow", "✅")].join("\n");
};

/** /mcp：已连接的 MCP server + 工具数。 */
export const inspectMcp = async (locale: ObsLocale = "zh"): Promise<string> => {
    const t = obsT(locale);
    const clients = await listMcpClients();
    if (clients.length === 0) return t("mcpEmpty");
    const lines = clients.map(c => t("mcpLine")(c.serverName, c.toolCount >= 0 ? t("mcpToolCount")(c.toolCount) : t("mcpToolCountFail")));
    const totalTools = clients.reduce((s, c) => s + (c.toolCount > 0 ? c.toolCount : 0), 0);
    return [t("mcpHead")(clients.length, totalTools), ...lines].join("\n");
};

/** /hooks：已注册的 hook 规则。 */
export const inspectHooks = (locale: ObsLocale = "zh"): string => {
    const t = obsT(locale);
    const hooks = listHooks();
    if (hooks.length === 0) return t("hooksEmpty");
    const byEvent = new Map<string, typeof hooks>();
    for (const h of hooks) {
        const arr = byEvent.get(h.event) ?? [];
        arr.push(h);
        byEvent.set(h.event, arr);
    }
    const lines = [...byEvent.entries()].map(([evt, arr]) => {
        return t("hooksGroup")(evt, arr.length) + "\n" + arr.map(h => `      matcher=${h.matcher}  source=${h.source}${h.onError ? `  onError=${h.onError}` : ""}`).join("\n");
    });
    return [t("hooksHead")(hooks.length), ...lines].join("\n");
};

/** /debug：配置/环境快照（排障用）。 */
export const inspectDebug = (sessionId: string, locale: ObsLocale = "zh"): string => {
    const t = obsT(locale);
    return [
        t("dbgHead"),
        `  session: ${sessionId || t("dbgSessionNone")}`,
        `  cwd: ${CWD}`,
        t("dbgModels")(MODEL_NAME, AUX_MODEL_NAME ?? t("dbgAuxNone")),
        `  dataDir: ${appConfig.dataDir}`,
        t("dbgParallel")(appConfig.parallelSafeTools ? t("dbgOn") : t("dbgOff"), appConfig.workflowConcurrency, appConfig.workflowMaxSteps),
        t("dbgUndo")(appConfig.undoEnabled ? t("dbgOn") : t("dbgOff"), appConfig.searchProvider || t("dbgSearchAuto")),
        t("dbgPlatform")(process.version, process.platform),
    ].join("\n");
};
