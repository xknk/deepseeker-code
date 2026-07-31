/**
 * @file cli/src/replay.ts
 * @description 纯模块：ChatRow 行类型 + buildReplayRows（transcript → 可渲染行重建）。
 *  从 useChatState.tsx 抽出，使其脱离 React/Ink 即可在 node:test 下单测。
 *  唯一外部依赖是 core 的 TraceBase 类型（@/observability/type），无 React/Ink。
 */
import type { TraceBase } from "@/observability/type.ts";

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
    };

/**
 * 从转录消息重建可渲染行（user/assistant/tool/thinking），供 --resume 挂载回放与 /sessions 载入复用。
 * - user → user 行；assistant.reasoning_content → thinking 行（已完成态、无耗时）；
 *   assistant.content → assistant 行；assistant.tool_calls 先占位 running，待配对 role:"tool" 回填为 done；
 * - system 等其它角色跳过（不向用户展示）。损坏/缺字段静默降级，不抛错。
 * @param msgs readMessages 读出的 OpenAI 消息数组（每条一行 JSONL）
 * @param nid 行 id 生成器（自增，保证与实时行 id 空间不冲突）
 */
export const buildReplayRows = (msgs: any[], nid: () => number): ChatRow[] => {
    const rows: ChatRow[] = [];
    /** tool_call_id → 占位行 id，待 tool 结果回填。 */
    const pending = new Map<string, number>();
    for (const m of msgs) {
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
    return rows;
};
