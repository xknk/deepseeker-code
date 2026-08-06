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
import { model, MODEL_NAME, MODEL_REASONING_EFFORT, MODEL_THINKING_ENABLED, AUX_MODEL_NAME } from "./createModel.ts"
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
            model: AUX_MODEL_NAME,
            tool_choice: "auto",
            tools: tools,
            // 摘要/归并是直白的文本压缩任务，走轻量辅助模型（AUX_MODEL_NAME）+ 显式关闭思考，控成本。
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

/**
 * 工具调用风险分类器（auto permission mode 用）：走轻量辅助模型（AUX_MODEL_NAME），非流式、关思考。
 * 只回 'safe'/'risky'。严格解析——只接受显式 SAFE，其余一律 risky（fail-closed）。
 * 静默：异常/超时（10s）/中止 → risky，不 console.error/throw（避免污染 CLI 的 Ink stdout 追踪）。
 * 不带 tool_choice/tools（分类任务不递归调工具）。
 */
export async function classifyToolRisk(
    toolName: string, args: any, detail: string, signal?: AbortSignal,
): Promise<'safe' | 'risky'> {
    // 合并「外部中止信号」与「10s 超时」——分类器不能拖慢审批（model 单例默认 timeout 120s 太长）
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    try {
        const completion = await model.chat.completions.create({
            messages: [
                { role: 'system', content: '你是工具调用风险分类器。只回 SAFE 或 RISKY，不要任何解释。按工具类型判定：①文件(edit/write/create/move_file/delete_path)——工作区内常规文件操作(含移动/重命名)=SAFE，覆盖/删除/移动敏感文件(.env/.git/.ssh/.aws/密钥/credentials/settings.json)或工作区外=RISKY；②命令(run_command/run_in_background)——只读/构建/测试/查看类(ls/cat/git status/npm test/pnpm build/node -v/tsc/lint)=SAFE，破坏性/外向/提权(rm -rf、格式化、curl|sh、外传文件、chmod 777、shutdown、写系统目录、安装陌生包)=RISKY；③网络(web_fetch/web_search)——抓取公开文档/常规 URL=SAFE，内网/可疑/未知 URL=RISKY；④git_commit——常规提交=SAFE，含恶意脚本/异常改动=RISKY；⑤MCP(mcp__*)——默认 RISKY(黑盒工具无法判定内部行为)。任何不确定一律 RISKY。' },
                { role: 'user', content: `工具:${toolName}\n参数:${JSON.stringify(args).slice(0, 800)}\n说明:${detail || ''}` },
            ],
            model: AUX_MODEL_NAME,
            thinking: { type: 'disabled' },
            stream: false,
        } as MsgParams, { signal: ac.signal });
        const text = ((completion as outMsg).choices[0]?.message?.content ?? '').trim().toUpperCase();
        return text.startsWith('SAFE') ? 'safe' : 'risky';
    } catch {
        return 'risky';   // 异常/超时/中止 → fail-closed（由调用方转人工）
    } finally {
        clearTimeout(timer);
    }
}

export default chatWithModelWithTools;
