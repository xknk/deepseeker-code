import { TraceBase } from "@/observability/type.ts";
import { Msg } from "@/session/contextCore.ts";
export type RunAgentEvents = (base: TraceBase) => Promise<void>
// ============ 事件回调（可观测性） ============

export interface RunAgentOptions {
    toolSchemas?: any[];          // 工具列表（必传，runAgent 不再内置默认，避免与 tool/index.ts 循环依赖）
    abortSignal?: AbortSignal; // 是否主动停止
    onAssistantTextDelta?: (delta: string) => void;
    sessionId: string; // 会话id
    agentId?: string; //agentid
    events: RunAgentEvents; // 回调方法
    modelWindow: number; // 最大上下文token
    depth?: number; // agent 嵌套深度，主 agent 为 0
    keepRecentUnits: number, // 最大保留条数
    compactRatio: number, // 占用超过最大token*compactRatio时则开始压缩上下文
    parentSystemPrompt: string,
    archivedMessageCount?: number,
}

export interface ensureOptions  {
    sessionId: string, 
    messageArr: Msg[], 
    compactRatio: number, 
    keepRecentUnits: number, 
    modelWindow: number, 
    events: RunAgentEvents, 
    depth: number, signal?: AbortSignal
}

export type AgentEvent =
    | { type: 'round.start'; round: number }
    | { type: 'text.delta'; text: string }            // 流式文本，替代 onAssistantTextDelta
    | { type: 'tool.start'; toolCallId: string; toolName: string; args: any }
    | { type: 'tool.end'; toolCallId: string; toolName: string; result: string; ok: boolean }
    | { type: 'final'; text: string };
