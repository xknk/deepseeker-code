/**
 * @file llm/providers/replay/index.ts
 * @description ReplayProvider（第二梯队 #4）：按剧本（script）回放模型响应的确定性 provider。
 *
 *  用途：harness 控制流 bug（PHANTOM / EARLY_FINAL / TOOL_DIGEST / repeat 熔断 / 流式重试等）
 *  的【零成本确定性回归】——不调真实 API，逐回合吐出预录响应 + 可注入故障（stall/限流/超长），
 *  复现历史 bug 的模型侧行为，断言守护体系行为不回退。录制源 = 会话 transcript 的 assistant 序列
 *  （scriptFromMessages），真跑一次即可生成可复放剧本。
 *
 *  核心语义：
 *  - 剧本按序消费：streamChat 每被调一次进入下一 turn；**只有完整流完（无故障）才推进游标**——
 *    streamInference 的三道重试会重入同一 turn，故障按 per-turn 次数预算（fault.times，默认 1）
 *    消耗，耗尽后同一 turn 干净流出（重试成功场景）。
 *  - 故障类型对准 streamInference 的三条重试通道 + 致命档：
 *      idle            → message 恰为 'stream_idle_timeout'（streamInference 按串匹配判 idle）；
 *      transient       → 携带 replayFault 标记 + status 429（isTransientError 自识别）；
 *      context_length  → replayFault 标记（isContextLengthError 自识别；配 afterChars=0 满足 noOutputYet 前提）；
 *      fatal           → 每次进入该 turn 都抛（重试耗尽 → InferenceResult error → runAgent final 收尾）。
 *    afterChars>0 → 先吐该长度正文再抛（复现「已推文本 → text.reset → 重试」的 mid-stream 场景）。
 *  - 录制器：每次 streamChat 记录入参（messages 快照 + tools + opts），测试据此断言「模型实际看到了什么」
 *    （如 ephemeral nudge 是否注入、inbox steering 是否送达）——这是纯黑盒断言做不到的。
 *  - 剧本耗尽 = 空回复（content null、无 tool_calls）——runAgent 的 PHANTOM 守护接管，确定性收尾，绝不挂死。
 *
 *  其余接口：summarize 返回确定性占位 ChatCompletion（压缩路径不打真 API）；classifyRisk 返回剧本裁决
 *  （默认 'safe'，harness 回归不触发审批弹窗，保持全链路无人值守确定性）；buildAssistantMessage 产出
 *  DeepSeek 兼容 wire（含 reasoning_content 扩展字段），使「从 transcript 录制 → 回放 → 再落盘」round-trip。
 */
import { Msg } from "@/session/contextCore.ts";
import { outMsg, toolMsg } from "../../type.ts";
import { AssistantParts, LLMProvider, ProviderStreamChunk, ProviderStreamOpts, ProviderUsage } from "../../provider.ts";

// ============ 剧本类型 ============

/** 故障类型：对准 streamInference 三条重试通道 + 致命档（见文件头注释）。 */
export type ReplayFaultType = 'idle' | 'transient' | 'context_length' | 'fatal';

/** 单 turn 内的故障注入。times=消耗预算（默认 1，即首次重入干净）；afterChars=先吐多少正文字符再抛。 */
export interface ReplayFault {
    type: ReplayFaultType;
    /** 该 turn 的前 N 次 streamChat 尝试抛故障（默认 1）；第 N+1 次起干净流出 */
    times?: number;
    /** 先 yield 该长度的正文再抛（mid-stream 故障，默认 0 = 未吐任何内容即抛） */
    afterChars?: number;
    /** 自定义错误 message（缺省按类型给确定默认值） */
    message?: string;
}

/** 一个回放回合：模型的一次完整响应（流式分片由 provider 内部生成）。 */
export interface ReplayTurn {
    kind: 'reply';
    /** 正文（null = 无正文，如纯工具轮）；空串/null 且无 tool_calls → PHANTOM 场景 */
    content?: string | null;
    /** 思考增量（映射 reasoning_content） */
    reasoning?: string;
    /** 工具调用（args 为普通对象，回放时 JSON.stringify 为 arguments） */
    toolCalls?: { name: string; args?: Record<string, any>; id?: string }[];
    /** 末包 usage（可选；回放计量用，测试断言 usage 链路） */
    usage?: ProviderUsage;
    /** 故障注入（可选） */
    fault?: ReplayFault;
}

/** 回放剧本：turns 序列 + 非流式接口的确定性配置。 */
export interface ReplayScript {
    turns: ReplayTurn[];
    /** classifyRisk 裁决（默认 'safe'：harness 回归免审批弹窗，全链路无人值守） */
    riskVerdict?: 'safe' | 'risky';
    /** summarize 返回文本（压缩路径占位） */
    summarizeText?: string;
}

/** streamChat 调用记录（测试断言「模型看到了什么」）。messages 为调用时长度快照（slice）。 */
export interface ReplayCall {
    /** 本次调用进入的 turn 下标（耗尽后等于 turns.length） */
    turnIndex: number;
    messages: Msg[];
    tools: toolMsg[] | undefined;
    opts: ProviderStreamOpts;
}

/** 回放 provider 句柄：LLMProvider + 可观测/控制面（测试用）。 */
export type ReplayProviderHandle = LLMProvider & {
    /** 每次 streamChat 的入参记录（追加式，reset 清空） */
    readonly calls: ReplayCall[];
    /** 当前游标（下一个待回放的 turn 下标） */
    readonly cursor: number;
    /** 复位游标 / 调用记录 / 故障预算（复用同一实例跑多场景） */
    readonly reset: () => void;
};

// ============ 工厂 ============

/**
 * 创建回放 provider。确定性：无延迟、无随机、无网络——同样的剧本跑出逐字节相同的事件流。
 */
export const createReplayProvider = (script: ReplayScript): ReplayProviderHandle => {
    const turns = Array.isArray(script.turns) ? script.turns : [];
    let cursor = 0;
    let attemptCounts: number[] = [];
    const calls: ReplayCall[] = [];

    const makeFaultError = (fault: ReplayFault): Error => {
        const msg = fault.message
            ?? (fault.type === 'idle' ? 'stream_idle_timeout'
                : fault.type === 'context_length' ? 'context_length_exceeded（回放注入）'
                : fault.type === 'transient' ? 'HTTP 429 rate limit（回放注入）'
                : '回放致命错误（fatal）');
        const e: any = new Error(msg);
        e.replayFault = fault.type;
        if (fault.type === 'transient') e.status = 429;
        return e;
    };

    const streamChat = async function* (messages: Msg[], tools: toolMsg[] | undefined, opts: ProviderStreamOpts): AsyncGenerator<ProviderStreamChunk> {
        const turnIndex = cursor;
        calls.push({ turnIndex, messages: [...messages], tools, opts });
        const turn = turns[turnIndex];
        if (!turn) return; // 剧本耗尽 = 空回复（completed 空 content；PHANTOM 守护接管）
        const attempt = attemptCounts[turnIndex] ?? 0;
        attemptCounts[turnIndex] = attempt + 1;
        const fault = turn.fault;
        // fatal 不设预算：每次重入都抛（重试耗尽 → InferenceResult error → runAgent final 收尾）；
        // 其余类型按 times 预算（默认 1），耗尽后同 turn 干净流出（重试成功场景）。
        const shouldFault = !!fault && (fault.type === 'fatal' || attempt < (fault.times ?? 1));
        if (shouldFault) {
            const f = fault!;
            const n = Math.min(f.afterChars ?? 0, (turn.content ?? '').length);
            if (n > 0) yield { kind: 'text', text: (turn.content ?? '').slice(0, n) };
            throw makeFaultError(f);
        }
        // 干净流出：reasoning → text → tool_call 分片（每 call：name 一个 delta + arguments 整段一个 delta）→ usage
        if (turn.reasoning) yield { kind: 'reasoning', text: turn.reasoning };
        if (turn.content) yield { kind: 'text', text: turn.content };
        const tcs = turn.toolCalls ?? [];
        for (let i = 0; i < tcs.length; i++) {
            const tc = tcs[i];
            yield { kind: 'tool_call_delta', index: i, id: tc.id ?? `call_replay_${turnIndex}_${i}`, type: 'function', nameDelta: tc.name };
            yield { kind: 'tool_call_delta', index: i, argumentsDelta: JSON.stringify(tc.args ?? {}) };
        }
        if (turn.usage) yield { kind: 'usage', usage: turn.usage };
        cursor++; // 完整流完才推进（故障重试重入同一 turn）
    };

    const summarize = async (_messages: Msg[], _tools: toolMsg[] | undefined, _opts: { signal?: AbortSignal }): Promise<outMsg> => ({
        id: 'replay-summary',
        object: 'chat.completion',
        created: 0, // 确定性：固定值（回放产物不掺时间戳，diff 稳定）
        model: 'replay',
        choices: [{
            index: 0,
            message: { role: 'assistant', content: script.summarizeText ?? '（回放摘要：压缩路径的确定性占位文本）', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    return {
        id: 'replay',
        displayName: 'Replay',
        modelLabel: 'Replay',
        streamChat,
        summarize,
        classifyRisk: async () => script.riskVerdict ?? 'safe',
        buildAssistantMessage: (parts: AssistantParts): Msg => {
            // DeepSeek 兼容 wire：reasoning_content 扩展字段 + OpenAI tool_calls——transcript 录制/回放 round-trip
            const m: any = { role: 'assistant', content: parts.content };
            if (parts.reasoning) m.reasoning_content = parts.reasoning;
            if (parts.toolCalls?.length) m.tool_calls = parts.toolCalls;
            return m;
        },
        // 自识别回放注入的故障（streamInference 经 activeProvider 调用这两个分类器驱动重试通道）
        isContextLengthError: (e: any) => e?.replayFault === 'context_length',
        isTransientError: (e: any) => e?.replayFault === 'transient',
        get calls() { return calls; },
        get cursor() { return cursor; },
        reset: () => { cursor = 0; attemptCounts = []; calls.length = 0; },
    };
};

// ============ 录制：从 transcript 消息序列生成剧本 ============

/**
 * 把会话消息序列（readMessages 产物）中的 assistant 轮转成回放剧本。
 * 跳过空轮（无正文且无工具调用）——那正是历史 bug 的 PHANTOM 场景，应手工构造而非录制；
 * reasoning_content / tool_calls.arguments 原样保留（DeepSeek wire 兼容，回放再落盘逐字段一致）。
 * user/system/tool 行忽略（回放只负责模型侧行为；工具真实执行由 harness 侧驱动）。
 */
export const scriptFromMessages = (messages: any[]): ReplayScript => ({
    turns: (messages ?? [])
        .filter((m) => m?.role === 'assistant')
        .map((m) => {
            let toolCalls: ReplayTurn['toolCalls'];
            if (Array.isArray(m.tool_calls)) {
                toolCalls = m.tool_calls.map((tc: any) => {
                    let args: Record<string, any> = {};
                    try { args = typeof tc?.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc?.function?.arguments ?? {}); } catch { /* 非法 JSON 按空参 */ }
                    // id 透传（保留原 call_id 使回放 transcript 与录制源对齐）
                    return { name: String(tc?.function?.name ?? ''), args, id: tc?.id ?? undefined };
                });
            }
            return {
                kind: 'reply' as const,
                content: typeof m.content === 'string' ? m.content : null,
                reasoning: typeof m.reasoning_content === 'string' ? m.reasoning_content : undefined,
                toolCalls,
            };
        })
        .filter((t) => (t.content ?? '') !== '' || (t.toolCalls?.length ?? 0) > 0) as ReplayTurn[],
});
