/**
 * @file agent/streamInference.ts
 * @description 流式推理消费（async generator）。
 *  驱动 activeProvider.streamChat 流式拉取标准化 ProviderStreamChunk：边收边 yield text.delta / thinking.delta；
 *  按 index 拼接 tool_calls 分片；末包收 usage。含三道有限重试——流式 stall（idle 超时）/ API 瞬时错误
 *  （429/5xx/网络复位）/ 上下文超长降级（context_length_exceeded → 强制压缩后重试）。重试前若已推过文本则先 yield text.reset。
 *
 *  从 runAgent 流式推理段抽出。yield text.delta|thinking.delta|text.reset，return InferenceResult——
 *  final 永远由主循环 yield，本模块绝不 yield final。消费方用 `yield* streamInference(ctx)` 委托。
 *  ★ 厂商中立：消费 ProviderStreamChunk（kind: text/reasoning/tool_call_delta/usage），不再直接读 DeepSeek 的
 *    reasoning_content 字段名——映射在 provider.streamChat 内（Step 8 切换完成）。拼装 assistantMessage 委托
 *    provider.buildAssistantMessage（DeepSeek 在其内挂 reasoning_content 扩展字段），杜绝手工列举漏挂。
 */
import { createHash } from "node:crypto";
import { Msg } from "@/session/contextCore.ts";
import { AgentEvent, RunAgentEvents, ThinkingLevel } from "./type.ts";
import { TraceDecisionSource } from "@/observability/type.ts";
import { activeProvider } from "@/llm/model.ts";
import type { ProviderUsage } from "@/llm/provider.ts";
import { ensureFitsWindow } from "./truncate.ts";
import { appendMessage } from "@/session/transcript.ts";
import { estimateTokens } from "@/session/contextCore.ts";
import { msgText } from "@/session/contentParts.ts";

/** sha1 前 10 位短哈希：前缀分段指纹用（只入 trace 供跨会话对比，不上模型）。 */
const sha1short = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** 退避上限（ms）：服务器给天价 Retry-After 时封顶，防止 agent 被单次限流冻结半小时+。 */
const RETRY_BACKOFF_CAP_MS = 30_000;

/**
 * 从 API 错误中提取 Retry-After 头（毫秒）。SDK 的 APIError.headers 可能是 Headers 实例或普通对象，
 * 头名可能是 `retry-after`（HTTP 日期或秒数）或 `retry-after-ms`（毫秒，OpenAI 系扩展）。
 * 解析不了（缺失 / HTTP 日期形式 / 非数字）→ 返回 null，调用方回落固定指数退避。导出供测试。
 */
export const extractRetryAfterMs = (e: any): number | null => {
    try {
        const h = e?.headers;
        if (!h) return null;
        const get = (k: string): string | undefined =>
            typeof h.get === 'function' ? (h.get(k) ?? undefined) : (h[k] ?? h[k.toLowerCase()]);
        const ms = get('retry-after-ms');
        if (ms != null) {
            const n = Number(ms);
            if (Number.isFinite(n) && n >= 0) return n;
        }
        const sec = get('retry-after');
        if (sec != null) {
            const n = Number(sec);
            if (Number.isFinite(n) && n >= 0) return n * 1000; // 仅数字秒；HTTP 日期形式不解析（罕见），回落指数退避
        }
    } catch { /* 头读取容错 */ }
    return null;
};

/** 推理结果（判别联合）：
 *  - completed —— 流式正常结束，携带拼装好的 assistantMessage（provider 产物，含厂商扩展字段如 reasoning_content），主循环落盘后继续；
 *  - aborted   —— 用户中止；若仅有 partial 文本（无半截 tool_call）已在本模块内落盘，partialText 供主循环拼 final；
 *  - error     —— 推理异常（已发 llm.error 埋点），主循环 yield final(发生错误) + return。 */
export type InferenceResult =
    | { kind: 'completed'; assistantMessage: Msg; usage?: ProviderUsage }
    | { kind: 'aborted'; partialText: string }
    | { kind: 'error'; error: Error };

/** streamInference 运行期依赖（原 runAgent 推理段闭包变量的显式打包）。message 为引用共享——
 *  本模块在 abort 落盘 / context_length 降级压缩时原地修改它，主循环可见。 */
export type StreamInferenceContext = {
    message: Msg[];
    /** NUDGE 自评尾部副本（每 NUDGE_EVERY 轮），主循环构造；降级重试时据此重算 inferenceMessages */
    nudgeMsg: { role: 'system'; content: string } | null;
    sessionId: string;
    depth: number;
    round: number;
    startTime: number;
    userDecisionSource: TraceDecisionSource;
    llmDecisionSource: TraceDecisionSource;
    signal?: AbortSignal;
    cleanedToolSchemas: any[];
    model?: string;
    thinkingLevel?: ThinkingLevel;
    events: RunAgentEvents;
    keepRecentUnits: number;
    compactRatio: number;
    modelWindow: number;
    /** ★ 工具 schema 常数项（token，P2 口径修正）：真实 prompt_tokens 含 cleanedToolSchemas 段而
     *  estimateTokens(messages) 不含。llm.request 估算与校准分母都须加上，缺省 0（兼容旧调用方）。 */
    toolsTokens?: number;
};

/**
 * nudge 尾附（ephemeral，不进 message 数组）。
 * ★ DS thinking 严格档规避：nudge 跟在 assistant 草稿之后时（EARLY_FINAL/PHANTOM 守护轮线形状
 *   [.., 草稿 assistant, nudge]），请求落入「续写」严格校验档（最后一条非 system 消息为 assistant）——
 *   任何一条 assistant 缺 reasoning_content 都 400，而模型简答时草稿天然无思考字段（round 1
 *   reasoning=0chars 实测），stripHistoricalReasoning 的「全量回传」无从保留。把 nudge 角色改成 user
 *   （请求以 user 结尾 → 宽松档）从根上绕开；语义不变（推模型继续的指令），纯 wire 层，落盘不动。
 */
const withNudgeTail = (base: Msg[], nudge: { role: string; content: string } | null): Msg[] => {
    if (!nudge) return base;
    const lastRole = (base[base.length - 1] as any)?.role;
    return [...base, lastRole === "assistant" ? { ...nudge, role: "user" } : nudge] as Msg[];
};

/**
 * 流式推理一轮。yield 流式事件，return InferenceResult。
 * 三道有限重试（idle stall / API 瞬时 / context_length 降级）均内置；耗尽或不可重试异常 → return error/aborted。
 */
export const streamInference = async function* (ctx: StreamInferenceContext): AsyncGenerator<AgentEvent, InferenceResult> {
    const { message, nudgeMsg, sessionId, depth, round, startTime, userDecisionSource, llmDecisionSource,
        signal, cleanedToolSchemas, model, thinkingLevel, events, keepRecentUnits, compactRatio, modelWindow,
        toolsTokens = 0 } = ctx;
    let inferenceMessages = withNudgeTail(message, nudgeMsg);
    let assistantMessage: Msg = { role: 'assistant', content: null } as Msg;
    try {
        // ★ 前缀分段指纹（P0 缓存诊断）：tools 段 / system 段 / 摘要槽各记 sha1 短哈希 + 消息数。
        //   DS 前缀缓存按序列化字节匹配，跨会话对比这四个字段即可二分定位「fresh-session 首轮 miss」的分歧点：
        //   toolsHash 变 → 工具表分歧（env 门控漂移 / 版本迭代）；sysHash 变 → message[0] 注入漂移（locale/
        //   skills/memory）；全同仍 miss → DS 服务端缓存 TTL/LRU 驱逐，非本地前缀问题。
        const prefixFingerprint = {
            toolsHash: sha1short(JSON.stringify(cleanedToolSchemas)),
            sysHash: sha1short(String((message[0] as any)?.content ?? '')),
            sumHash: sha1short(String((message[1] as any)?.content ?? '')),
            msgCount: message.length,
        };
        events({
            sessionId,
            eventType: 'llm.request',
            metadata: { depth, decisionSource: userDecisionSource, ok: true, durationMs: performance.now() - startTime, round, ...prefixFingerprint },
            // ★ P2 口径：估算加上工具 schema 常数项（与 API 真实 prompt_tokens 同口径，trace 里 est/real 才可比）
            usage: { prompt_tokens: estimateTokens(inferenceMessages) + toolsTokens },
            payload: { input: msgText(message[message.length - 1].content) },   // ★ 多模态：trace 只记文本视图
        });
        console.log(`🔄 代理推理第 ${round} 轮（流式）...`);

        // ★ 流式消费：累积 content（边收边 yield text.delta）+ 按 index 拼接 tool_calls 分片 + 收 usage
        let contentBuf = "";
        let reasoningBuf = ""; // 思考增量累积（provider 映射后的 reasoning chunk；工具调用轮后续须回传给 API）
        const toolCallsBuf = new Map<number, { id?: string; type?: string; function: { name: string; arguments: string } }>();
        let lastUsage: ProviderUsage | undefined;
        // ★ 流式 stall 有限重试：provider 的 idle 超时会抛 stream_idle_timeout。仅当本回合【尚未产出任何内容】
        //   （三个 buffer 全空 = stall 发生在首 chunk 之前，最常见的连接级 stall）时重试，避免已 yield 给前端的
        //   文本/思考在重试后重复输出。重试耗尽、或已有部分输出、或非 idle 错误 → 抛交外层 catch 优雅收尾
        //   （emit llm.error + return error → 主循环 yield final，busy 自动清零，杜绝永久卡死）。
        const MAX_STREAM_RETRIES = 2;
        // ★ API 瞬时错误（429/5xx/网络复位）的有限重试预算：与 idle 重试独立计数，互不挤占。每轮重置，
        //   避免一次长任务被偶发限流永久中断。★ 流式请求已关 SDK 内建重试（stream.ts maxRetries: 0，
        //   单层化防 15 次放大），本层是唯一重试通道，预算 2→3（1+3=4 次尝试，对齐原 SDK 侧 5 次的量级）。
        const MAX_API_RETRIES = 3;
        let apiRetries = 0;
        // ★ 本轮是否已做过「上下文超长强制压缩」降级：最多降级一次，二次仍超长交外层 catch 优雅收尾
        let compactedThisRound = false;
        for (let streamAttempt = 0; ; streamAttempt++) {
            try {
                // ★ 消费标准化 ProviderStreamChunk（provider 已把 DeepSeek/OpenAI delta+usage 映射好）。
                //   reasoning_content 字段名不再出现于此（provider 内映射为 kind:'reasoning'）。
                for await (const chunk of activeProvider.streamChat(inferenceMessages, cleanedToolSchemas, { signal, model, thinkingLevel })) {
                    if (signal?.aborted) break;
                    switch (chunk.kind) {
                        case 'text':
                            contentBuf += chunk.text;
                            yield { type: 'text.delta', text: chunk.text };
                            break;
                        case 'reasoning':
                            reasoningBuf += chunk.text;
                            yield { type: 'thinking.delta', text: chunk.text };
                            break;
                        case 'tool_call_delta': {
                            const idx = chunk.index;
                            let buf = toolCallsBuf.get(idx);
                            if (!buf) { buf = { function: { name: "", arguments: "" } }; toolCallsBuf.set(idx, buf); }
                            if (chunk.id) buf.id = chunk.id;
                            if (chunk.type) buf.type = chunk.type;
                            if (chunk.nameDelta) buf.function.name += chunk.nameDelta;
                            if (chunk.argumentsDelta) buf.function.arguments += chunk.argumentsDelta;
                            break;
                        }
                        case 'usage':
                            lastUsage = chunk.usage;
                            break;
                    }
                }
                break; // 流正常结束（含用户中止经 provider 干净 break）→ 跳出重试循环
            } catch (streamErr) {
                // 用户中止：provider 已干净 break 不会到此；防御性判断交外层 signal.aborted 分支处理
                if (signal?.aborted) throw streamErr;
                const isIdleTimeout = streamErr instanceof Error && streamErr.message === 'stream_idle_timeout';
                // ★ 放宽 stall 重试门控：原 noOutputYet 要求「完全无输出」才重试，但工具调用轮几乎总有前导文案
                //   （"让我读取 X…"），导致工具调用前的 stall 永不重试、等满 120s 后直接放弃（用户症状"卡了"）。
                //   现改为：只要【尚未拼出完整可执行的 tool_call】（arguments 不可解析 = 仍在流式中）就允许重试；
                //   已拼出完整 tool_call 则不重试（避免重复执行已敲定的工具）。这是用户卡死症状的直接修复。
                const hasCompleteToolCall = [...toolCallsBuf.values()].some(
                    tc => { try { JSON.parse(tc.function.arguments); return true; } catch { return false; } }
                );
                const noOutputYet = !contentBuf && !reasoningBuf && toolCallsBuf.size === 0;
                if (isIdleTimeout && (noOutputYet || !hasCompleteToolCall) && streamAttempt < MAX_STREAM_RETRIES) {
                    // ★ 重试前若已向前端推过文本/思考，发 text.reset 让前端丢弃这部分（重试会重新生成，避免重复显示）
                    if (!noOutputYet) yield { type: 'text.reset' };
                    console.warn(`⚠️ 流式 stall（idle 超时${noOutputYet ? '，尚无输出' : '，tool_call 未流完'}），第 ${streamAttempt + 1}/${MAX_STREAM_RETRIES} 次重试...`);
                    contentBuf = ""; reasoningBuf = ""; toolCallsBuf.clear(); lastUsage = undefined;
                    continue;
                }
                // ★ API 瞬时错误重试：429 限流 / 5xx 服务端错误 / 连接级网络复位 → 原请求重试 + 退避。
                //   缘由：原逻辑对这类错误直接 throw → 外层 catch final 终结整轮，单用户依赖云端模型场景下，一次偶发
                //   限流/抖动就中断长 coding 任务且不可自动恢复（只能手动续接）。重试前若已向前端推过文本/思考，
                //   发 text.reset 让前端丢弃，避免重试重新生成时重复显示（与 idle 重试同处理）。退避 sleep 期间用户
                //   中止 → sleep reject → 冒泡至外层 catch 的 signal.aborted 分支优雅收尾（partial 文本落盘 + final）。
                //   ★ Retry-After 感知：服务器明确给出等待时长（retry-after / retry-after-ms）时以其为准
                //   （DS 限流是账号级的，盲目短退避只会连续撞墙）；未给则指数退避 1s→2s→4s；统一 30s 封顶。
                if (activeProvider.isTransientError(streamErr) && apiRetries < MAX_API_RETRIES && !signal?.aborted) {
                    apiRetries++;
                    const retryAfterMs = extractRetryAfterMs(streamErr);
                    const backoffMs = Math.min(
                        Math.max(1000 * Math.pow(2, apiRetries - 1), retryAfterMs ?? 0),
                        RETRY_BACKOFF_CAP_MS,
                    );
                    if (!noOutputYet) yield { type: 'text.reset' };
                    const statusHint = (streamErr as any)?.status ? `${(streamErr as any).status} ` : '';
                    const raHint = retryAfterMs != null ? `，遵 Retry-After=${retryAfterMs}ms` : '';
                    console.warn(`⚠️ API 瞬时错误（${statusHint}${streamErr instanceof Error ? streamErr.message : String(streamErr)}），${backoffMs}ms 后第 ${apiRetries}/${MAX_API_RETRIES} 次重试${raHint}...`);
                    await new Promise<void>((resolve, reject) => {
                        const t = setTimeout(resolve, backoffMs);
                        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
                    });
                    contentBuf = ""; reasoningBuf = ""; toolCallsBuf.clear(); lastUsage = undefined;
                    continue;
                }
                // ★ 上下文超长降级：API 返回 context_length_exceeded（400）且本轮尚未产出任何内容 → 强制压缩后重试本轮。
                //   缘由：本地 estimateTokens 对代码/JSON 严重低估（CJK 1:1、英文 ÷4.8），常出现"本地没超阈值→不压缩→API 端实际超限 400"。
                //         现有 ensureFitsWindow 只在推理前基于本地估算触发，与 API 实际超长错误解耦——此处补"推理时降级"路径，避免暴力终止。
                //   做法：复用 ensureFitsWindow（keepRecentUnits 砍半，更激进归档旧消息并生成摘要落盘），压缩后重算 inferenceMessages 续推。
                //   最多一次（compactedThisRound）；强制压缩自身若失败（物理熔断/超窗口）会冒泡至外层 catch 优雅收尾。
                if (activeProvider.isContextLengthError(streamErr) && noOutputYet && !compactedThisRound) {
                    console.warn(`⚠️ 上下文超长（API 400 context_length_exceeded），强制压缩后重试本轮推理...`);
                    await ensureFitsWindow({
                        sessionId,
                        messageArr: message,
                        keepRecentUnits: Math.max(1, Math.floor((keepRecentUnits ?? 6) / 2)),
                        compactRatio,
                        modelWindow,
                        events,
                        depth,
                        signal,
                        toolsTokens,
                    });
                    inferenceMessages = withNudgeTail(message, nudgeMsg);
                    compactedThisRound = true;
                    contentBuf = ""; reasoningBuf = ""; toolCallsBuf.clear(); lastUsage = undefined;
                    continue;
                }
                throw streamErr; // 重试耗尽 / 已有部分输出 / 非 idle/超长 错误 → 交外层 catch 优雅收尾
            }
        }
        if (signal?.aborted) {
            // ★ 中止落盘：仅有文本、无半截 tool_call 时，把用户已看到的 partial assistant 文本落盘，
            //   恢复会话后仍可见；若有半截 tool_call（不可保留半工具），整体丢弃。
            if (contentBuf && toolCallsBuf.size === 0) {
                message.push({ role: 'assistant', content: contentBuf });
                await appendMessage({ sessionId, role: 'assistant', content: contentBuf });
            }
            return { kind: 'aborted', partialText: contentBuf };
        }

        // 流式拼接出 assistantMessage（委托 provider 构造厂商特定 wire 格式）。
        // ★ reasoning_content 落盘：思考增量拼进 assistantMessage 供 UI 思考展示 / recall 归档召回；
        //   provider.buildAssistantMessage 内统一挂载，本处不再手工列举字段名（杜绝漏挂的回归点）。
        //   API 回传侧由 provider 出口的 stripHistoricalReasoning 统一剥离（2026-09-10 探针证实
        //   DeepSeek 不强制回传——官方「必须完整回传否则 400」口径比服务端实际校验严格，剥历史省 ~25%）。
        const toolCallsArr = toolCallsBuf.size > 0
            ? Array.from(toolCallsBuf.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([idx, tc]) => ({ id: tc.id ?? `call_${round}_${idx}`, type: tc.type || 'function', function: tc.function }))
            : undefined;
        assistantMessage = activeProvider.buildAssistantMessage({
            content: contentBuf || null,
            reasoning: reasoningBuf || undefined,
            toolCalls: toolCallsArr,
        });

        events({
            sessionId,
            eventType: 'llm.response',
            metadata: { depth, decisionSource: llmDecisionSource, ok: true, durationMs: performance.now() - startTime, round },
            usage: {
                prompt_tokens: lastUsage?.prompt_tokens,
                completion_tokens: lastUsage?.completion_tokens,
                total_tokens: lastUsage?.total_tokens,
                prompt_cache_hit_tokens: lastUsage?.cached_tokens,
                prompt_cache_miss_tokens: (lastUsage?.prompt_tokens || 0) - (lastUsage?.cached_tokens || 0),
            },
            payload: { input: msgText(message[message.length - 1].content) },   // ★ 多模态：trace 只记文本视图
        });
        console.log(`[DSC-DIAG] streamInference round ${round} 完成: content=${contentBuf.length}chars reasoning=${reasoningBuf.length}chars toolCalls=${toolCallsBuf.size}`);
        // ★ 带出本轮真实 usage（prompt_tokens/cached_tokens）：供 runAgent 维护「估算校准系数」
        //   （修正 estimateTokens 对代码/CJK 的系统性低估）与「缓存命中率」（缓存感知压缩决策）。
        //   仅 completed 路径有；aborted/error 不带，调用方按 undefined 处理（回落保守默认）。
        return { kind: 'completed', assistantMessage, usage: lastUsage };
    } catch (error) {
        // 异常路径中止（如退避 sleep 被 abort reject）：不落盘 partial，主循环用 lastContent 收尾
        if (signal?.aborted) {
            return { kind: 'aborted', partialText: '' };
        }
        const err = error instanceof Error ? error : new Error(String(error));
        events({
            sessionId,
            eventType: 'llm.error',
            metadata: { depth, decisionSource: llmDecisionSource, ok: false, durationMs: performance.now() - startTime, attempt: round },
            payload: { input: msgText(message[message.length - 1].content), output: err.message },   // ★ 多模态：文本视图
        });
        console.log(`[DSC-DIAG] streamInference round ${round} ═══ ERROR: ${err.message}`);
        return { kind: 'error', error: err };
    }
};
