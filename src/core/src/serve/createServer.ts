/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 08:22:37
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-15 17:04:29
 * @FilePath: \deepSeekCode\src\core\src\serve\createServer.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file serve/createServer.ts
 * @description HTTP 服务构建：基于 express 暴露核心路由——
 *  /api/chat（SSE 流式对话主通道，含审批事件推送）、/api/approve（审批回传，解锁挂起的工具协程）、
 *  /api/abort（按 sessionId 主动中止 agent 任务：审批判拒绝、工具执行终止）、
 *  /createJson（会话历史读写）、/health（健康检查）。
 */
import express from "express";
import { UnifiedInboundMessage } from "@/channels/unifiedMessage.ts"
import { handleUnifiedChat } from "./chatProcessing.ts"
import { sendOutbound } from "@/channels/chatChannelAdapter.ts";
import { resolveUserApprovalLock } from "@/tool/approvalGate.ts";
import { readStore, writeStore } from "@/session/store.ts"
import { createUUID } from "@/common/index.ts";

/** 创建并返回 express 应用（已注册全部路由，尚未 listen）。 */
export const createServer = () => {
    const app = express();
    app.use(express.json({ limit: "5mb" }));

    // 会话级 AbortController 仓库：/api/chat 按 sessionId 注册，/api/abort 据此主动中止 agent 任务
    const activeControllers = new Map<string, AbortController>();

    app.get("/health", (req, res) => {
        res.status(200).json({ status: "ok" });
    });

    // ★ 对话主通道：改成 SSE 流式，把 agent 的所有事件（含 approval_request）实时推前端
    app.post("/api/chat", async (req, res) => {
        const ac = new AbortController();
        // 勿监听 req「close」：body 读完后常触发，会误杀进行中的 LLM
        const onAbort = (): void => {
            if (!res.writableEnded) ac.abort();
        };
        req.on("aborted", onAbort);

        // SSE 响应头
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // 禁用反向代理缓冲，保证实时推送
        res.flushHeaders?.();

        const sseWrite = (obj: Record<string, unknown>): void => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };

        const raw = req.body as UnifiedInboundMessage;
        const sessionId = raw?.sessionId;
        // 注册本次请求的 AbortController，供 /api/abort 按 sessionId 主动中止
        if (sessionId) activeControllers.set(sessionId, ac);

        try {
            // sseWrite 作为主通道；sendOutbound 仅作非 SSE 渠道的后备（此处不会被调用）
            await handleUnifiedChat(raw, (outbound) => sendOutbound(res, outbound), sseWrite, ac.signal);
        } catch (err) {
            sseWrite({ eventType: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
            req.off("aborted", onAbort);
            if (sessionId) activeControllers.delete(sessionId);
            if (!res.writableEnded) res.end();
        }
    });

    // ★ 审批回传入站路由：前端用户点批准/拒绝后调用，解锁在 /api/chat 里挂起的工具协程
    app.post("/api/approve", (req, res) => {
        const { toolsId, approved } = (req.body || {}) as { toolsId?: string; approved?: boolean };
        if (typeof toolsId !== "string" || typeof approved !== "boolean") {
            res.status(400).json({ ok: false, error: "需要 { toolsId: string, approved: boolean }" });
            return;
        }
        const ok = resolveUserApprovalLock(toolsId, approved);
        res.json({ ok });
    });

    // ★ 主动中止入站路由：前端点"停止"按钮时调用，按 sessionId 中止 /api/chat 里挂起的 agent 任务
    //   （审批挂起→判拒绝并清理门锁；工具执行→command 子进程被 SIGTERM 真正终止）
    app.post("/api/abort", (req, res) => {
        const { sessionId } = (req.body || {}) as { sessionId?: string };
        if (typeof sessionId !== "string") {
            res.status(400).json({ ok: false, error: "需要 { sessionId: string }" });
            return;
        }
        const ac = activeControllers.get(sessionId);
        if (!ac) {
            res.status(404).json({ ok: false, error: "未找到该会话的活跃任务（可能已结束）" });
            return;
        }
        ac.abort();                         // 触发中断：审批判拒绝、工具执行终止
        activeControllers.delete(sessionId);
        res.json({ ok: true });
    });

    app.post("/createJson", async (req, res) => {
        try {
            const raw = req.body as UnifiedInboundMessage;
            const sessionId = raw?.sessionId || createUUID();
            let data = await readStore(sessionId);
            if (Object.keys(data).length === 0) {
                data = {
                    createdAt: new Date().toISOString(),
                    messages: [{ role: 'user', content: raw?.content || '当前北京时间2222' }]
                };
                await writeStore(sessionId, data);
            } else {
                console.log(`[IO] 成功命中历史文件，直接读取数据: ${sessionId}.json`);
            }
            res.status(200).json({ status: "ok", sessionId, data });
        } catch (error) {
            console.error("接口执行崩溃:", error);
            res.status(500).json({ status: "error", message: "服务器内部错误" });
        }
    });
    return app;
}
