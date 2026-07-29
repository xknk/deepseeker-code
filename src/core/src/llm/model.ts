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
    callOpts?: { signal?: AbortSignal; model?: string },
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
    const requestBody = {
        messages: messages,
        model: callOpts?.model ?? MODEL_NAME, // per-agent 覆盖（声明式子 Agent）；缺省回退全局
        tool_choice: "auto", // 让模型自动选择工具
        tools: tools,
        ...(MODEL_THINKING_ENABLED ? { thinking: { "type": "enabled" } } : {}),
        reasoning_effort: MODEL_REASONING_EFFORT,
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
