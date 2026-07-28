/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 16:36:09
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-11 17:08:46
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\channels\chatChannelAdapter.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AEs
 */
/**
 * @file channels/chatChannelAdapter.ts
 * @description WebChat 渠道适配器：sendOutbound 把统一出站消息转成 HTTP JSON 响应回给前端。
 *  作为非 SSE 渠道的后备发送通道（SSE 主通道由 chatProcessing 的 sseWrite 直接推送）。
 */
import type { Response } from "express";
import { UnifiedOutboundMessage } from "./unifiedMessage.ts";

/** 把出站消息以 JSON 形式回送给 express Response（丢失 res 时安全丢弃，防止崩溃）。 */
export const sendOutbound = async (target: unknown, message: UnifiedOutboundMessage) => {
    const res = target as Response | undefined;
    if (!res) {
        // 如果因为某些原因（如异步超时已响应）丢失了 res 对象，则终止操作防止崩溃
        console.warn("[WebChatAdapter] Missing response object, message dropped.");
        return;
    }
    res.json({
        reply: message.content,
        ...(message.metadata && Object.keys(message.metadata).length > 0
            ? { metadata: message.metadata }
            : {}),
    })
}