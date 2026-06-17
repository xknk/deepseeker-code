// ============ 事件回调（可观测性） ============
export interface RunAgentEvents {
    onLlmRequest?: (e: { round: number }) => void;
    onLlmResponse?: (e: { round: number; usage?: { total_tokens?: number; prompt_tokens?: number; prompt_cache_hit_tokens?: number } }) => void;
    onLlmError?: (e: { round: number; error: Error }) => void;
    onToolStart?: (e: { round: number; name: string; args: any }) => void;
    onToolEnd?: (e: { round: number; name: string; args: any; result: string; ok: boolean; durationMs: number }) => void;
    onLoopDetected?: (e: { round: number; signature: string }) => void;
    /** 上下文压缩：incremental=单层追加(损失一段) / full=全量浓缩(罕见,重建) */
    onContextCompacted?: (e: { beforeTokens: number; afterTokens: number; mode: 'incremental' | 'full' }) => void;
    onTaskEnd?: (e: { round: number; reason: 'natural' | 'aborted' | 'error' | 'loop'; content: string }) => void;
}

export interface RunAgentOptions {
    toolSchemas?: any[];          // 工具列表（必传，runAgent 不再内置默认，避免与 tool/index.ts 循环依赖）
    abortSignal?: AbortSignal; // 是否主动停止
    onAssistantTextDelta?: (delta: string) => void;
    sessionId: string; // 会话id
    agentId?: string; //agentid
    events?: RunAgentEvents; // 回调方法
    modelWindow: number; // 最大上下文token
    depth?: number; // agent 嵌套深度，主 agent 为 0
    keepRecentUnits: number, // 最大保留条数
    compactRatio: number, // 占用超过最大token*compactRatio时则开始压缩上下文
    parentSystemPrompt: string,
    archivedMessageCount?: number,
}
