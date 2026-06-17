/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 15:41:07
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-17 08:51:53
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\serve\chatPorcessing.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { UnifiedInboundMessage, UnifiedOutboundMessage } from "@/channels/unifiedMessage.ts"
import { runAgent } from "@/agent/runAgent.ts";
import { agentTools } from "@/tool/index.ts";
import { appConfig } from "@/config/index.ts";
import { createUUID, getOrCreateSessionId, getRollingState, setRollingState } from "@/session/store.ts"
import { appendMessage, readMessages } from "@/session/transcript.ts";
import OpenAI from "openai";
import { buildContextMessages } from "@/session/content.ts";
import { Msg } from "@/session/contextCore.ts";
type OutboundSender = (outbound: UnifiedOutboundMessage) => Promise<void>;

/**
 * @description: 获取用户输入信息并调用agent进行处理
 * @param {inbound} 用户输入信息
 * @param {sendOutbound} 返回消息回调方法
 * @return {*}
 */
export const handleUnifiedChat = async (
    inbound: UnifiedInboundMessage,
    sendOutbound: OutboundSender,
) => {
    const traceId = inbound.traceId || createUUID(); // 全链路追踪 ID
    const sessionId: string = inbound.sessionId || await getOrCreateSessionId(inbound.sessionId); // 用户会话标识
    const SYSTEM_PROMPT = `你是一个能调用工具的助手。任务完成后直接用自然语言给出最终答案，不要再调用工具。`
    // 1. 跨会话构建上下文（防爆栈）
    const fullMessages: Msg[] = await buildContextMessages(
        sessionId,
        { role: "user", content: inbound.content },
        SYSTEM_PROMPT,
    );

    await appendMessage(
        {
            sessionId,
            role: 'user',
            content: inbound.content,
        }
    ) // 添加本次对话消息

    const replyText = await runAgent(
        fullMessages, {
        sessionId,
        toolSchemas: agentTools,
        modelWindow: appConfig.MAX_HISTORY_TOKENS,
        keepRecentUnits: appConfig.KEEP_RECENT_UNITS,
        compactRatio: appConfig.COMPACT_RATIO,
        parentSystemPrompt:SYSTEM_PROMPT,
    }) // 调用agent
    await appendMessage(
        {
            sessionId,
            role: 'assistant',
            content: replyText || "",
        }
    ) // 添加本次对话结果消息
    const outboundMeta = {
        traceId,
        sessionId
    } // 输出元数据

    await sendOutbound({ content: replyText || '', metadata: outboundMeta });
}