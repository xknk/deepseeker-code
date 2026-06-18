/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 08:22:37
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-12 15:32:11
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\serve\createServe.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";

import OpenAI from "openai";
import { UnifiedInboundMessage } from "@/channels/unifiedMessage.ts"
import { handleUnifiedChat } from "./chatPorcessing.ts"
import { sendOutbound } from "@/channels/chatChannelAdapter.ts";
import { writeStore, readStore } from "@/session/store.ts"
import { createUUID } from "@/common/index.ts";
export function createServer() {
    const app = express();
    // 解析 JSON 请求体，并限制大小为 5MB 以处理复杂 Payload
    app.use(express.json({ limit: "5mb" }));
    // 提供一个简单的健康检查端点
    app.get("/health", (req, res) => {
        res.status(200).json({ status: "ok" });
    });
    app.post("/api/chat", async (req, res) => {
        const ac = new AbortController();
        // 勿监听 req「close」：在 Node 中 body 读完后常会触发，并非客户端断开，会误杀进行中的 LLM。
        const onAbort = (): void => {
            if (!res.writableEnded) ac.abort();
        };
        req.on("aborted", onAbort);
        try {
            const raw = req.body as UnifiedInboundMessage;
            const sseWrite = (obj: Record<string, unknown>): void => {
                res.write(`data: ${JSON.stringify(obj)}\n\n`);
            };
            handleUnifiedChat(raw, (outbound) => sendOutbound(res, outbound))

        } catch (err) {
            if (!res.writableEnded) {
                res.status(500).json({
                    success: false,
                    error: err instanceof Error ? err.message : String(err)
                });
            }

        } finally {
            req.off("aborted", onAbort);
        }
    });
    // 1. 必须使用 POST 请求来接收 req.body
    app.post("/createJson", async (req, res) => {
        try {
            const raw = req.body as UnifiedInboundMessage;
            // 2. 确定唯一的 sessionId：前端传了就用前端的，没传就生成全新的
            const sessionId = raw?.sessionId || createUUID();
            // 3. 读取数据（遇到你刚才那个报错时，data 会安全地拿到 {}）
            let data = await readStore(sessionId);
            // 4. 💡 核心解耦兜底：如果 data 是空对象（说明触发了 ENOENT 报错，文件不存在）
            if (Object.keys(data).length === 0) {
                // 定义你的初始 JSON 数据结构
                data = {
                    createdAt: new Date().toISOString(),
                    messages: [
                        { role: 'user', content: raw?.content || '当前北京时间2222' }
                    ]
                };
                // 真正把文件写入硬盘！下次再读就不会报 ENOENT 了
                await writeStore(sessionId, data);
            } else {
                console.log(`[IO] 成功命中历史文件，直接读取数据: ${sessionId}.json`);
            }

            // 5. 必须把确认后的 sessionId 和数据一起返回给前端
            res.status(200).json({ status: "ok", sessionId, data });

        } catch (error) {
            console.error("接口执行崩溃:", error);
            res.status(500).json({ status: "error", message: "服务器内部错误" });
        }
    });
    return app;
}