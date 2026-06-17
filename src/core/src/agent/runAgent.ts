/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 15:25:11
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-17 11:54:07
 * @FilePath: \deepSeekCode\src\core\src\agent\runAgent.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import chatWithModelWithTools from "@/llm/model.ts";
import { ToolContext } from "@/tool/index.ts";
import OpenAI from "openai";
import { appendMessage } from "@/session/transcript.ts";
import { ensureFitsWindow, ensureSummarySlot, truncateToolResult } from "./truncate.ts";
import { RunAgentOptions } from "./type.ts";

/**
 * @description: 防止存入本地消息失败，影响最终推理
 * @param {any} entry
 * @return {*}
 */
const safeAppend = async (entry: any): Promise<void> => {
    try { await appendMessage(entry); }
    catch (e) { console.warn('⚠️ 落盘失败（不影响当前推理）:', e); }
};

// ============ 主流程 ============
export async function runAgent(message: OpenAI.Chat.ChatCompletionMessageParam[], options: RunAgentOptions): Promise<string> {
    const rawTools = options.toolSchemas ?? [];   // ← 不再默认 agentTools，避免循环依赖
    const sessionId = options.sessionId; // 本次会话id
    const events = options.events; // 回调方法
    const modelWindow = options.modelWindow; // 最大上下文token
    const signal = options.abortSignal; // 主动停止
    const depth = options.depth ?? 0;
    const keepRecentUnits = options.keepRecentUnits
    const compactRatio = options.compactRatio
    const parentSystemPrompt = options.parentSystemPrompt
    // 格式化工具消息
    const cleanedToolSchemas = rawTools.map((t: any) => ({
        type: t.type,
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
    }));
    const callOpts = { signal: signal, onAssistantTextDelta: options?.onAssistantTextDelta };
    // 预留系统提示词和摘要存放区域
    ensureSummarySlot(message);
    let round = 0;
    let lastContent: string | undefined = "";
    const recentSignatures: string[] = [];

    while (true) {
        round++;
        // 前端用户主动停止运行
        if (signal?.aborted) {
            events?.onTaskEnd?.({ round, reason: 'aborted', content: lastContent || "" });
            return lastContent || "（已中止）";
        }
        try {
            // 判断是否需要压缩上下文并触发摘要
            await ensureFitsWindow(
                sessionId,
                message,
                keepRecentUnits,
                compactRatio,
                modelWindow as number, events,
                signal
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error("❌ " + msg);
            return (lastContent || "") + `\n（${msg}）`;
        }

        let response: OpenAI.Chat.ChatCompletion;
        try {
            // 获取大模型消息
            console.log(`🔄 代理推理第 ${round} 轮...`);
            response = await chatWithModelWithTools(message, cleanedToolSchemas, callOpts);
        } catch (error) {
            if (signal?.aborted) {
                return lastContent || "（已中止）";
            }
            const err = error instanceof Error ? error : new Error(String(error));
            return lastContent || "（发生错误）";
        }

        // 获取本次对话结果
        const assistantMessage = response.choices[0].message;
        // 存入本次对话上下文中
        message.push({
            role: 'assistant',
            content: assistantMessage.content || null,
            tool_calls: assistantMessage.tool_calls as any,
        });
        // 存入本地上下文会话中
        await safeAppend({
            sessionId,
            role: 'assistant',
            content: assistantMessage.content || null,
            tool_calls: assistantMessage.tool_calls as any
        });
        // 存储最后一条消息，以供后面返回使用
        if (assistantMessage.content) {
            lastContent = assistantMessage.content;
        }

        // 1、如果本次无调用工具或者工具调用完成后，则主动跳出循环
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
            events?.onTaskEnd?.({ round, reason: 'natural', content: lastContent || "" });
            return lastContent || "";
        }
        // 2、检测是否一直重复调用同一个工具，如果超过3次，则主动跳出循环
        const sig = assistantMessage.tool_calls.map((t: any) => `${t.function.name}:${t.function.arguments}`).join("|");
        recentSignatures.push(sig);
        const last3 = recentSignatures.slice(-3);
        if (last3.length === 3 && last3.every(s => s === last3[0])) {
            events?.onLoopDetected?.({ round, signature: sig });
            events?.onTaskEnd?.({ round, reason: 'loop', content: lastContent || "" });
            return (lastContent || "") + "\n（检测到重复工具调用，已停止）";
        }

        // 执行工具（abort 占位 + 截断 + 实时落盘 + 事件）
        let abortedDuringTools = false;
        for (const toolCall of assistantMessage.tool_calls) {
            let calledName = "";
            let calledArgs: any = {};
            let parseFailed = false;
            if (toolCall.type === 'function') {
                calledName = toolCall.function.name;
                try { calledArgs = JSON.parse(toolCall.function.arguments || "{}"); }
                catch { parseFailed = true; }
                console.log(`🤖 模型请求调用工具: ${calledName}，参数:`, calledArgs);
            }
            // abort 占位：为未执行的 tool_call 补 result，保证下次读回配对完整
            if (signal?.aborted) {
                abortedDuringTools = true;
                const placeholder = "（已中止，未执行）";
                message.push({ role: 'tool', tool_call_id: toolCall.id, content: placeholder });
                await safeAppend({ sessionId, role: 'tool', tool_call_id: toolCall.id, content: placeholder });
                continue;
            }
            const t0 = Date.now(); // 记录工具执行时间
            const matchedTool = rawTools.find((t: any) => t.function.name === calledName);
            // ★ execute 传入 ctx（sessionId/abortSignal/depth），spawn_agent 用它创建子 agent
            const toolCtx: ToolContext = { sessionId, abortSignal: signal, depth, keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt };
            let result = "";
            if (parseFailed) {
                result = `参数解析失败：模型返回的 arguments 不是合法 JSON${JSON.stringify(toolCall).slice(0, 300)}`;
            } else if (matchedTool && typeof matchedTool.function.execute === 'function') {
                try {
                    // 执行工具
                    const r = await matchedTool.function.execute(calledArgs, toolCtx);
                    result = typeof r === 'object' ? JSON.stringify(r) : String(r);
                } catch (err) {
                    console.error(`❌ 执行工具 ${calledName} 时发生错误:`, err);
                    result = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
                }
            } else {
                result = `错误：未知工具 "${calledName}" 或该工具无可执行函数`;
            }
            // 获取工具返回的信息，如果超过最大值，则截取中间，留头尾
            result = truncateToolResult(result);
            const ok = !result.startsWith("工具执行失败");
            // 存储本次工具结果的消息到上下文中
            message.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
            // 添加到本地上下文中
            await safeAppend({ sessionId, role: 'tool', tool_call_id: toolCall.id, content: result });
        }
        // 主动停止返回最终消息
        if (abortedDuringTools) {
            return lastContent || "（已中止）";
        }
    }
}
