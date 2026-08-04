/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 17:01:17
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-16 10:00:00
 * @FilePath: \deepSeekCode\src\core\src\llm\model.ts
 * @Description: 流式对话 —— yield 每个 ChatCompletionChunk，由 runAgent 消费
 */
import OpenAI from "openai";
import { Msg } from "@/session/contextCore.ts";
import { model, MODEL_NAME, MODEL_REASONING_EFFORT, MODEL_THINKING_ENABLED } from "./createModel.ts"
import { MsgParams, outMsg, toolMsg } from "./type.ts";
import { ThinkingLevel } from "@/agent/type.ts";

/**
 * 流式对话：yield 每个 ChatCompletionChunk，调用方(runAgent)负责消费。
 * - 文本增量 delta.content 由 runAgent yield 为 text.delta 推前端
 * - tool_calls 分片 delta.tool_calls[index] 由 runAgent 按 index 累积，流完整体 JSON.parse
 * - usage 在最后一个 chunk（已开 stream_options.include_usage）
 * 协议限制：tool_call.arguments 是增量分片，必须流完拼整才能执行（"边吐字边调工具"做不到）。
 */
async function* chatWithModelWithTools(
    messages: Msg[],
    tools?: toolMsg[],
    callOpts?: { signal?: AbortSignal; model?: string; thinkingLevel?: ThinkingLevel },
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
    // ★ 思考等级映射（运行时覆盖，缺省回退全局 env：MODEL_THINKING_ENABLED / MODEL_REASONING_EFFORT）。
    //   DeepSeek V4 实际档位：reasoning_effort ∈ {high, max}（low/medium 兼容映射为 high）；thinking.type ∈ {enabled, disabled}，默认 enabled。
    //   故「关闭思考」必须显式传 thinking.type=disabled——原代码关时漏传（依赖默认 enabled）等于仍开，已在此修正。
    const level = callOpts?.thinkingLevel;
    const thinkingType = (level === undefined ? MODEL_THINKING_ENABLED : level !== "off") ? "enabled" : "disabled";
    const effort: "high" | "max" = level === "max" ? "max"
        : level === "high" ? "high"
        : level === "off" ? "high"        // 关思考时 effort 无意义，回落默认 high
        : MODEL_REASONING_EFFORT;          // undefined → 回退全局 env
    const requestBody = {
        messages: messages,
        model: callOpts?.model ?? MODEL_NAME, // per-agent 覆盖（声明式子 Agent）；缺省回退全局
        tool_choice: "auto", // 让模型自动选择工具
        tools: tools,
        thinking: { type: thinkingType },   // 始终显式（enabled/disabled），修原「关闭=漏传=仍开」bug
        reasoning_effort: effort,
        stream: true,
        stream_options: { include_usage: true }, // 流式下 usage 在末包 chunk
    } as MsgParams;

    // stream:true 时 SDK 返回 Stream<ChatCompletionChunk>（AsyncIterable），按可迭代消费
    // signal 透传给 SDK：中止时真正取消底层 fetch + 服务端停止生成，而非仅在 chunk 到达后 break
    const stream = await model.chat.completions.create(requestBody, {
        signal: callOpts?.signal,
    }) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    for await (const chunk of stream) {
        if (callOpts?.signal?.aborted) break;   // 调用方中止则停止拉取（双保险）
        yield chunk;
    }
}

/**
 * 非流式对话：用于摘要等不需要流式输出的场景（一次拿完整 completion）。
 */
export async function chatWithModelWithSummary(
    messages: Msg[],
    tools?: toolMsg[],
    callOpts?: { signal?: AbortSignal },
): Promise<outMsg> {
    try {
        const requestBody = {
            messages: messages,
            model: MODEL_NAME,
            tool_choice: "auto",
            tools: tools,
            // 摘要/归并是直白的文本压缩任务，无需思考；显式关闭避免白付 reasoning token。
            thinking: { type: "disabled" },
            stream: false,
        } as MsgParams;
        const completion = await model.chat.completions.create(requestBody, {
            signal: callOpts?.signal,
        });
        if (completion && 'choices' in completion) return completion as outMsg;
        throw new Error("API 响应异常，未包含 choices 结构");
    } catch (error) {
        console.error("❌ 接口调用失败:", error);
        throw error;
    }
}

export default chatWithModelWithTools;
