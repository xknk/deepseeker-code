/**
 * @file cli/src/replay.ts
 * @description 纯模块：ChatRow 行类型 + buildReplayRows（transcript → 可渲染行重建）。
 *  从 useChatState.tsx 抽出，使其脱离 React/Ink 即可在 node:test 下单测。
 *  唯一外部依赖是 core 的 TraceBase 类型（@/observability/type），无 React/Ink。
 *  ★ 事件日志化：输入升级为 readTranscriptLines 的消息+事件混合序列——事件行不渲染本体，
 *    round.end 的 usage 回挂到最近 assistant 行（回放补 usage），run.abandoned / 未闭合末 run
 *    渲染「被中断」info 行；纯消息数组（无事件行）输入行为不变。
 */
import type { TraceBase, Todo } from "@/observability/type.ts";
import { isEventLine } from "@/session/transcript.ts";

/** 一行转录（线性消息流）。 */
export type ChatRow =
    | { id: number; kind: "user"; text: string }
    | { id: number; kind: "assistant"; text: string; streaming?: boolean; usage?: TraceBase['usage'] }
    | { id: number; kind: "system"; text: string }
    | { id: number; kind: "info"; text: string }
    | { id: number; kind: "meta"; text: string }
    | { id: number; kind: "thinking"; text: string; expanded: boolean; streaming?: boolean; startedAt: number; durationMs?: number; tokens?: number }
    | {
        id: number;
        kind: "tool";
        toolCallId: string;
        toolName: string;
        args?: unknown;
        result?: string;
        ok?: boolean;
        status: "running" | "done";
        /** 运行中最新进度片段（tool.progress，如 run_command 的 stdout 末行）；done 后不展示。 */
        progress?: string;
    }
    /** 任务清单行（内联于消息流）：active=true 时留动态区随状态更新；新轮开始冻结为 Static，留在原位（新消息上方）。 */
    | { id: number; kind: "todos"; todos: Todo[]; active?: boolean };

/**
 * 从转录行重建可渲染行（user/assistant/tool/thinking），供 --resume 挂载回放与 /sessions 载入复用。
 * - user → user 行；assistant.reasoning_content → thinking 行（已完成态、无耗时）；
 *   assistant.content → assistant 行；assistant.tool_calls 先占位 running，待配对 role:"tool" 回填为 done；
 * - 事件行（dscEvent，事件日志化）：不渲染本体——round.end 的 usage 回挂最近 assistant 行、
 *   run.abandoned 渲染「被中断」info 行；末 run 未闭合（崩溃残留）在收尾补 info 行；
 * - system 等其它角色跳过（不向用户展示）。损坏/缺字段静默降级，不抛错。
 * @param lines readTranscriptLines 读出的行数组（消息 + 事件混合；纯消息数组/宽松 fixture 同样兼容——
 *   按 any 宽松解析，与本模块「损坏/缺字段静默降级」哲学一致）
 * @param nid 行 id 生成器（自增，保证与实时行 id 空间不冲突）
 */
export const buildReplayRows = (lines: any[], nid: () => number): ChatRow[] => {
    const rows: ChatRow[] = [];
    /** tool_call_id → 占位行 id，待 tool 结果回填。 */
    const pending = new Map<string, number>();
    /** 事件日志化：run 闭合跟踪（末 run 未闭合 → 收尾补「被中断」info 行）。 */
    let lastStartRunId: string | undefined;
    const closedRuns = new Set<string>();
    /** usage 回挂：找最近的 assistant 行挂上（cached_tokens → TraceBase 口径 prompt_cache_hit_tokens）。 */
    const attachUsage = (u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number }) => {
        for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i];
            if (r.kind === 'assistant') {
                rows[i] = {
                    ...r,
                    usage: {
                        ...(r.usage ?? {}),
                        prompt_tokens: u.prompt_tokens,
                        completion_tokens: u.completion_tokens,
                        total_tokens: u.total_tokens,
                        prompt_cache_hit_tokens: u.cached_tokens,
                    },
                };
                return;
            }
        }
    };
    for (const line of lines) {
        if (isEventLine(line)) {
            if (line.dscEvent === 'run.start') lastStartRunId = line.runId;
            else if (line.dscEvent === 'run.end' || line.dscEvent === 'run.abandoned') closedRuns.add(line.runId);
            // round.end.usage = 本轮真实用量；run.end.usage = 整 run 累计（仅当该 assistant 行尚无 usage 才挂，避免覆盖轮级数据）
            if ((line.dscEvent === 'round.end' || line.dscEvent === 'run.end') && line.usage && (line.usage.prompt_tokens != null || line.usage.total_tokens != null)) {
                const last = [...rows].reverse().find((r) => r.kind === 'assistant') as Extract<ChatRow, { kind: 'assistant' }> | undefined;
                if (line.dscEvent === 'round.end' || !last?.usage) attachUsage(line.usage);
            }
            if (line.dscEvent === 'run.abandoned') {
                rows.push({ id: nid(), kind: 'info', text: '⚠️ 此回合被中断，未完成' });
            }
            continue;
        }
        const m = line as any; // 消息行：按 any 宽松访问（reasoning_content 等厂商扩展字段不在 OpenAI 类型上）
        const role = m?.role;
        if (role === "user") {
            const text = typeof m.content === "string" ? m.content
                : Array.isArray(m.content)
                    ? (m.content as any[]).filter((p) => typeof p?.text === "string").map((p) => p.text).join("")
                    : "";
            if (text.trim()) rows.push({ id: nid(), kind: "user", text });
        } else if (role === "assistant") {
            if (typeof m.reasoning_content === "string" && m.reasoning_content.trim()) {
                rows.push({ id: nid(), kind: "thinking", text: m.reasoning_content, expanded: false, streaming: false, startedAt: 0 });
            }
            if (typeof m.content === "string" && m.content.trim()) {
                rows.push({ id: nid(), kind: "assistant", text: m.content });
            }
            if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    const tcId = typeof tc?.id === "string" ? tc.id : "";
                    const name = tc?.function?.name ?? "(tool)";
                    let args: unknown;
                    try { args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : undefined; } catch { args = tc?.function?.arguments; }
                    const rowId = nid();
                    rows.push({ id: rowId, kind: "tool", toolCallId: tcId, toolName: name, args, status: "running" });
                    if (tcId) pending.set(tcId, rowId);
                }
            }
        } else if (role === "tool") {
            const tcId = typeof m?.tool_call_id === "string" ? m.tool_call_id : "";
            const content = typeof m?.content === "string" ? m.content : "";
            const rowId = tcId ? pending.get(tcId) : undefined;
            if (rowId != null) {
                const idx = rows.findIndex((r) => r.id === rowId);
                if (idx >= 0) {
                    const r = rows[idx] as Extract<ChatRow, { kind: "tool" }>;
                    rows[idx] = { ...r, result: content, ok: true, status: "done" };
                }
                pending.delete(tcId);
            } else {
                rows.push({ id: nid(), kind: "tool", toolCallId: tcId, toolName: "(tool)", result: content, ok: true, status: "done" });
            }
        }
    }
    // 收尾：仍有 running 占位（被中断、无 tool 结果）→ 标记 done，避免回放里永挂「运行中」。
    for (const rowId of pending.values()) {
        const idx = rows.findIndex((r) => r.id === rowId);
        if (idx >= 0) {
            const r = rows[idx] as Extract<ChatRow, { kind: "tool" }>;
            rows[idx] = { ...r, result: r.result ?? "", ok: false, status: "done" };
        }
    }
    // 事件日志化收尾：末 run 未闭合（进程被杀、连 run.abandoned 都没来得及补）→ 补「被中断」info 行。
    if (lastStartRunId && !closedRuns.has(lastStartRunId)) {
        rows.push({ id: nid(), kind: 'info', text: '⚠️ 此回合被中断，未完成' });
    }
    return rows;
};
