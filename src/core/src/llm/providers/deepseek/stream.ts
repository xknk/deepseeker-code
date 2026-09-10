/**
 * @file llm/providers/deepseek/stream.ts
 * @description DeepSeek 流式对话：包 model.chat.completions.create，保留 idle stall 超时，
 *  yield 前把 ChatCompletionChunk 映射为标准化 ProviderStreamChunk。
 *
 *  ★ reasoning_content 字符串【deepseek provider 内只在此处读取】（窄化 delta.reasoning_content → {kind:'reasoning'}），
 *    通用层（streamInference）不再知道该字段名。从 llm/model.ts 的 chatWithModelWithTools 搬迁 + chunk 标准化改造。
 *  协议限制不变：tool_call.arguments 是增量分片，须流完拼整才能执行（"边吐字边调工具"做不到）。
 */
import { Msg } from "@/session/contextCore.ts";
import { toolMsg, MsgParams } from "../../type.ts";
import { ProviderStreamChunk, ProviderStreamOpts } from "../../provider.ts";
import { model, MODEL_NAME, MODEL_REASONING_EFFORT, MODEL_THINKING_ENABLED } from "./client.ts";

/** 流式 idle 超时阈值（ms）：两 chunk 间隔超过此值即判定为 stall（连接保持但不吐 chunk），
 *  中止底层 fetch 并上抛带标记错误（stream_idle_timeout），供 streamInference 重试或优雅收尾。
 *  ★ 缘由：SDK client 的 timeout（client.ts 120s）仅覆盖【初始请求】，不防流式中途 stall——
 *    思考模式下偶发的中途静默会让 for await 永久阻塞，进而卡死整个 agent 主循环。
 *  env DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS 可覆盖；默认 120s（与请求 timeout 同口径，思考模式长间隔亦安全）。 */
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS) || 120_000;

/**
 * 历史轮 reasoning_content 剥离（DS API 出口单点，默认开；env DEEP_SEEK_REASONING_PASSTHROUGH=1 还原全量回传）。
 *  ★ 协议探针（2026-09-10，scripts/reasoning-passthrough-probe.ts 9 条 + reasoning-guard-probe.ts 6 变体
 *    真实请求）：校验分两档——user/tool 结尾宽松（剥/全剥/混合都 200），assistant 结尾严格（见函数内注释）。
 *    官方「必须完整回传否则 400」文档描述的是严格档；旧 selftest 400 案底 = 历史丢 reasoning 的续写形状，
 *    与严格档吻合（并非服务端放宽）。
 *  收益（scripts/reasoning-share.ts，123 真实会话取证）：历史思考记录占请求 ~25%；窗口瘦身 → 压缩更晚
 *    触发（压缩是最大单一缓存崩塌源）；冷恢复 / 压缩后 re-prefill 按 miss 价全额省。
 *  ★ 缓存自洽约束：剥离自会话首轮恒定生效时前缀字节稳定（无击穿）；env 中途翻转 = 从分歧点起
 *    re-prefill 一次（罕见且用户主动，可接受）。落盘 transcript 不受影响——buildAssistantMessage 照常
 *    挂载 reasoning_content（UI 思考过程展示 / recall 归档召回均不受影响），剥离只发生在请求出口。
 *  恒等条件（浅拷贝去字段，绝不原地改）：入参数组往往就是落盘消息本体，原地删除会损坏持久化记录。
 */
export const stripHistoricalReasoning = (messages: Msg[]): Msg[] => {
    if (process.env.DEEP_SEEK_REASONING_PASSTHROUGH === "1") return messages;
    // ★ 协议细则（2026-09-10 守护轮 400 实证，scripts/reasoning-guard-probe.ts 六变体 + 真实会话 trace）：
    //   严格档的判定 = 【最后一条非 system 消息是 assistant】（草稿续写场景）——守护轮线形状是
    //   [.., 草稿 assistant, 尾部临时 system nudge]，末条虽是 system，DS 仍按严格校验：
    //   任何一条 assistant 缺 reasoning_content 即 400（历史剥/混合态也炸），全带才 200
    //   （官方「必须完整回传」文档指的就是这个场景）。其余形状（末条非 system 为 user/tool，正常轮）
    //   → 宽松校验，全剥 200。
    //   ⇒ 守护轮形状整请求回退全量回传（旧行为，生产长期验证过），正常轮保持全剥。
    let lastNonSystem: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as any)?.role !== "system") { lastNonSystem = messages[i]; break; }
    }
    if (lastNonSystem?.role === "assistant") return messages;
    return messages.map((m) => {
        const wire = m as any;
        if (wire?.role !== "assistant" || typeof wire.reasoning_content !== "string") return m;
        const copy = { ...wire };
        delete copy.reasoning_content;
        return copy as Msg;
    });
};

/**
 * DeepSeek 流式对话：yield 标准化 ProviderStreamChunk。
 * - thinking 等级映射（运行时覆盖，缺省回退全局 env：MODEL_THINKING_ENABLED / MODEL_REASONING_EFFORT）
 * - idle stall 超时（本地 idleAc + 外部 signal 用 AbortSignal.any 合成）
 * - chunk 标准化：delta.content→text、reasoning_content→reasoning、tool_calls→tool_call_delta、usage→usage
 */
export const streamChat = async function* (
    messages: Msg[],
    tools: toolMsg[] | undefined,
    opts: ProviderStreamOpts,
): AsyncGenerator<ProviderStreamChunk> {
    // ★ 思考等级映射（运行时覆盖，缺省回退全局 env：MODEL_THINKING_ENABLED / MODEL_REASONING_EFFORT）。
    //   DeepSeek V4 实际档位：reasoning_effort ∈ {high, max}（low/medium 兼容映射为 high）；thinking.type ∈ {enabled, disabled}，默认 enabled。
    //   故「关闭思考」必须显式传 thinking.type=disabled——原代码关时漏传（依赖默认 enabled）等于仍开，已在此修正。
    const level = opts.thinkingLevel;
    const thinkingType = (level === undefined ? MODEL_THINKING_ENABLED : level !== "off") ? "enabled" : "disabled";
    const effort: "high" | "max" = level === "max" ? "max"
        : level === "high" ? "high"
        : level === "off" ? "high"        // 关思考时 effort 无意义，回落默认 high
        : MODEL_REASONING_EFFORT;          // undefined → 回退全局 env
    const requestBody = {
        messages: stripHistoricalReasoning(messages),   // ★ 出口剥离历史思考记录（见函数注释；默认开）
        model: opts.model ?? MODEL_NAME, // per-agent 覆盖（声明式子 Agent）；缺省回退全局
        tool_choice: "auto", // 让模型自动选择工具
        tools: tools,
        thinking: { type: thinkingType },   // 始终显式（enabled/disabled），修原「关闭=漏传=仍开」bug
        reasoning_effort: effort,
        stream: true,
        stream_options: { include_usage: true }, // 流式下 usage 在末包 chunk
    } as MsgParams;

    // ★ 流式 idle 超时：本地 idleAc 与外部 signal 用 AbortSignal.any 合成后传给 SDK，任一触发都中止 fetch。
    const idleAc = new AbortController();
    const extSignal = opts.signal;
    const combinedSignal = extSignal ? AbortSignal.any([idleAc.signal, extSignal]) : idleAc.signal;
    // ★ 瞬态重试单层化（流式）：SDK 内建重试在此关闭（maxRetries: 0），统一交给 streamInference 的应用层
    //   重试（idle / 瞬态含 Retry-After 退避 / context_length 降级）——它有 text.reset、abort 感知、
    //   超长降级等 SDK 层不具备的语义。两层同开时 429 最坏 5×3=15 次请求放大账号级限流（client.ts 的
    //   "不再叠加第二层" 注释即此意，但此前实际叠加了）。非流式 helper（summarize/classifyRisk）不受此
    //   影响，保留 client 默认 maxRetries=4。
    // stream:true 时 SDK 返回 Stream<ChatCompletionChunk>（AsyncIterable），手动驱动 reader 消费
    const stream = await model.chat.completions.create(requestBody, {
        signal: combinedSignal,
        maxRetries: 0,
    }) as unknown as AsyncIterable<any>;

    const reader = stream[Symbol.asyncIterator]();
    try {
        while (true) {
            if (extSignal?.aborted) break;   // 调用方中止则停止拉取（双保险）
            // 每片拉取前起 idle 定时器：到点未收到下一 chunk → idleAc.abort() → 中止 fetch → reader.next() reject；
            //   其 await 被 catch 后识别为 idle 超时。
            const idleTimer = setTimeout(() => idleAc.abort(), STREAM_IDLE_TIMEOUT_MS);
            let next: IteratorResult<any>;
            try {
                next = await reader.next();
            } catch (e) {
                // idle 超时（本地定时器触发，非用户中止）→ 抛带标记错误供 streamInference 识别重试/收尾
                if (idleAc.signal.aborted && !extSignal?.aborted) throw new Error('stream_idle_timeout');
                // 用户中止（extSignal）→ 吞掉 AbortError 并干净结束流，交调用方既有的 signal.aborted 检查处理
                if (extSignal?.aborted) break;
                throw e;   // 其他意外错误原样上抛
            } finally {
                clearTimeout(idleTimer);
            }
            if (next.done) break;
            if (extSignal?.aborted) break;
            // ★ chunk 标准化映射：把 DeepSeek/OpenAI 的 delta + usage 拆解为 ProviderStreamChunk。
            //   一个 chunk 可能同时含 content/reasoning/tool_calls/usage → yield 多个标准化 chunk。
            const chunk = next.value;
            const delta = chunk.choices?.[0]?.delta;
            if (delta) {
                if (delta.content) yield { kind: 'text', text: delta.content };
                // ★ reasoning_content 字符串全局只在此处出现：DeepSeek 对 OpenAI delta 的扩展（标准类型未定义），窄化读取
                const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
                if (reasoning) yield { kind: 'reasoning', text: reasoning };
                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        yield {
                            kind: 'tool_call_delta',
                            index: tc.index ?? 0,
                            id: tc.id,
                            type: tc.type,
                            nameDelta: tc.function?.name,
                            argumentsDelta: tc.function?.arguments,
                        };
                    }
                }
            }
            if (chunk.usage) {
                yield {
                    kind: 'usage',
                    usage: {
                        prompt_tokens: chunk.usage.prompt_tokens,
                        completion_tokens: chunk.usage.completion_tokens,
                        total_tokens: chunk.usage.total_tokens,
                        cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
                    },
                };
            }
        }
    } finally {
        // 流句柄清理：正常结束 / 用户中止 / idle 超时均触发，释放底层连接避免句柄泄漏
        await reader.return?.();
    }
};
