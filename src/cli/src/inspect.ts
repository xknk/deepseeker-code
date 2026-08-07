/**
 * @file cli/src/inspect.ts
 * @description P2-15 可观测性命令的数据采集与格式化：/usage /context /permissions /mcp /hooks /debug。
 *  纯采集 + 文本格式化，无 UI（App.tsx 的 runLocalSlash 调用后经 pushInfo 渲染）。
 *  数据源：trace JSONL（usage）、session store（archived）、appConfig（context/debug）、
 *  以及 core 新增的 listPermissionRules / listHooks / listMcpClients。
 */
import fs from "fs";
import { appConfig } from "@/config/index.ts";
import { listPermissionRules } from "@/tool/permissions.ts";
import { listHooks } from "@/hooks/registry.ts";
import { listMcpClients } from "@/tool/mcp/loader.ts";
import { getTraceStorePath } from "@/observability/store.ts";
import { getRollingState } from "@/session/store.ts";
import { MODEL_NAME, AUX_MODEL_NAME } from "@/llm/createModel.ts";

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

/** /usage：从 trace 汇总 token 用量（按主 agent / 子 agent 拆分 + 缓存命中）。 */
export const inspectUsage = async (sessionId: string): Promise<string> => {
    const trace = await readTrace(sessionId);
    const responses = trace.filter(t => t?.eventType === "llm.response" && t?.usage);
    if (responses.length === 0) return `📊 Token 用量：暂无数据（本会话尚无 LLM 响应落盘）。`;
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
    return [
        `📊 Token 用量（本会话，${rounds} 次 LLM 响应）`,
        `  输入(prompt): ${fmt(prompt)}  | 输出(completion): ${fmt(completion)}  | 合计: ${fmt(total)}`,
        `  缓存命中: ${fmt(cacheHit)}（${cacheRate}%）  | 缓存未命中: ${fmt(cacheMiss)}`,
        `  主 agent: ${fmt(mainTotal)}  | 子 agent(spawn/workflow): ${fmt(subTotal)}`,
        `  提示：并行 workflow 会放大子 agent 用量；缓存命中率越高，输入成本越低。`,
    ].join("\n");
};

/** /context：当前上下文窗口治理参数 + 最近一轮 prompt token + 已归档条数。 */
export const inspectContext = async (sessionId: string): Promise<string> => {
    const trace = await readTrace(sessionId);
    // 最近一次带 usage 的响应 = 最近上下文规模
    let lastPrompt: number | undefined;
    for (let i = trace.length - 1; i >= 0; i--) {
        const u = trace[i]?.usage?.prompt_tokens;
        if (typeof u === "number") { lastPrompt = u; break; }
    }
    let archived = 0;
    try { archived = (await getRollingState(sessionId)).archivedMessageCount ?? 0; } catch { /* ignore */ }
    const window = appConfig.MAX_HISTORY_TOKENS;
    const ratio = appConfig.COMPACT_RATIO;
    const threshold = Math.round(window * ratio);
    const fillRate = lastPrompt ? ((lastPrompt / window) * 100).toFixed(1) : null;
    return [
        `🧠 上下文治理`,
        `  窗口上限: ${fmt(window)}  | 压缩阈值: ${fmt(threshold)}（${ratio}×）  | 保留最近: ${appConfig.KEEP_RECENT_UNITS} 对话单元`,
        `  最近 prompt: ${lastPrompt ? fmt(lastPrompt) : "（尚无）"}${fillRate ? `（占窗口 ${fillRate}%）` : ""}`,
        `  已归档(压缩)消息条数: ${archived}`,
        `  超过阈值即触发滚动压缩；fillRate 接近 ${Math.round(ratio * 100)}% 时即将压缩。`,
    ].join("\n");
};

/** /permissions：列出已加载的 allow/ask/deny 规则。 */
export const inspectPermissions = (): string => {
    const r = listPermissionRules();
    const total = r.allow.length + r.deny.length + r.ask.length;
    if (total === 0) return `🔒 权限规则：无（全部走默认 safetyLevel：SAFE 免审 / MUTATION·DANGER 审批）。`;
    const render = (label: string, kind: "allow" | "ask" | "deny", icon: string) => {
        const list = r[kind];
        if (list.length === 0) return `  ${icon} ${label}: (无)`;
        return `  ${icon} ${label}（${list.length}）:\n` + list.map(x => `      ${x.toolName}${x.raw && x.raw !== x.toolName ? `  ← ${x.raw}` : ""}`).join("\n");
    };
    return [`🔒 权限规则（优先级 deny > ask > allow；未匹配走默认 safetyLevel）`, render("Deny", "deny", "🚫"), render("Ask", "ask", "❓"), render("Allow", "allow", "✅")].join("\n");
};

/** /mcp：已连接的 MCP server + 工具数。 */
export const inspectMcp = async (): Promise<string> => {
    const clients = await listMcpClients();
    if (clients.length === 0) return `🔌 MCP：无已连接 server（在 ~/.deepseeker-code/mcp.json 配置）。`;
    const lines = clients.map(c => `  • ${c.serverName}（${c.toolCount >= 0 ? `${c.toolCount} 个工具` : "工具数获取失败"}）`);
    const totalTools = clients.reduce((s, c) => s + (c.toolCount > 0 ? c.toolCount : 0), 0);
    return [`🔌 MCP server（${clients.length} 个，共 ${totalTools} 个工具）`, ...lines].join("\n");
};

/** /hooks：已注册的 hook 规则。 */
export const inspectHooks = (): string => {
    const hooks = listHooks();
    if (hooks.length === 0) return `🪝 Hooks：无（在 ~/.deepseeker-code/settings.json 的 hooks 段配置）。`;
    const byEvent = new Map<string, typeof hooks>();
    for (const h of hooks) {
        const arr = byEvent.get(h.event) ?? [];
        arr.push(h);
        byEvent.set(h.event, arr);
    }
    const lines = [...byEvent.entries()].map(([evt, arr]) => {
        return `  • ${evt}（${arr.length}）:\n` + arr.map(h => `      matcher=${h.matcher}  source=${h.source}${h.onError ? `  onError=${h.onError}` : ""}`).join("\n");
    });
    return [`🪝 Hooks（共 ${hooks.length} 条，按事件分组）`, ...lines].join("\n");
};

/** /debug：配置/环境快照（排障用）。 */
export const inspectDebug = (sessionId: string): string => {
    return [
        `🐞 Debug 快照`,
        `  session: ${sessionId || "(未初始化)"}`,
        `  cwd: ${CWD}`,
        `  主模型: ${MODEL_NAME}  | 辅助模型: ${AUX_MODEL_NAME ?? "(未配置)"}`,
        `  dataDir: ${appConfig.dataDir}`,
        `  并行工具: ${appConfig.parallelSafeTools ? "开" : "关"}  | workflow 并发上限: ${appConfig.workflowConcurrency}  | workflow 最大步数: ${appConfig.workflowMaxSteps}`,
        `  undo: ${appConfig.undoEnabled ? "开" : "关"}  | 搜索后端: ${appConfig.searchProvider || "(自动)"}`,
        `  Node: ${process.version}  | 平台: ${process.platform}`,
    ].join("\n");
};
