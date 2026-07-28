/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 08:22:37
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-23 10:00:00
 * @FilePath: \deepSeekCode\src\core\src\serve\createServer.ts
 * @Description: 这是默认设置,请设置`customMade`,打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file serve/createServer.ts
 * @description HTTP 服务构建：基于 express 暴露核心路由——
 *  /api/chat（SSE 流式对话主通道，含审批事件推送）、/api/approve（审批回传，解锁挂起的工具协程）、
 *  /api/abort（按 sessionId 主动中止 agent 任务：审批判拒绝、工具执行终止）、
 *  /createJson（会话历史读写）、/health（健康检查）。
 *
 *  ★ 安全（2026-07-23 加固）：
 *   1) /api/* 与 /createJson 全部经 requireAuth 中间件，要求 Authorization: Bearer <token>；
 *   2) 所有来自请求体的 sessionId 经 isSafeSessionId 白名单校验（防路径穿越）；
 *   3) /api/approve 必须带与挂起时一致的 sessionId（防跨会话审批越权）；
 *   4) /api/chat 并发上限 + 同会话串行（防资源耗尽 / 控制器覆盖）。
 *   服务默认仅监听 127.0.0.1（见 serve/index.ts），远程攻击者无法直连。
 */
import express from "express";
import { UnifiedInboundMessage } from "@/channels/unifiedMessage.ts"
import { handleUnifiedChat } from "./chatProcessing.ts"
import { sendOutbound } from "@/channels/chatChannelAdapter.ts";
import { resolveUserApprovalLock } from "@/tool/approvalGate.ts";
import { readStore, writeStore } from "@/session/store.ts"
import { createUUID, isSafeSessionId } from "@/common/index.ts";
import { requireAuth } from "./auth.ts";

/** 单进程最大并发会话数（本地单机保护，防恶意/失控请求耗尽资源）。 */
const MAX_CONCURRENT_SESSIONS = 8;

/** 创建并返回 express 应用（已注册全部路由，尚未 listen）。 */
export const createServer = () => {
    const app = express();

    // ★ 鉴权闸先于 body 解析注册：无 token 的请求在解析 JSON 前即被 401 拒绝，
    //   避免未授权者借大体积 body 拖累服务端（/health 保持开放便于存活探活）。
    app.use("/api", requireAuth);
    app.use("/createJson", requireAuth);
    app.use(express.json({ limit: "5mb" }));

    // 会话级 AbortController 仓库：/api/chat 按 sessionId 注册，/api/abort 据此主动中止 agent 任务
    const activeControllers = new Map<string, AbortController>();

    app.get("/health", (req, res) => {
        res.status(200).json({ status: "ok" });
    });

    // ★ 对话主通道：改成 SSE 流式，把 agent 的所有事件（含 approval_request）实时推前端
    app.post("/api/chat", async (req, res) => {
        const raw = req.body as UnifiedInboundMessage;
        const sessionIdRaw = raw?.sessionId;

        // ★ 安全①：sessionId 若由客户端传入，先过白名单（防路径穿越），非法直接 400（尚未进入 SSE）
        if (sessionIdRaw !== undefined && !isSafeSessionId(sessionIdRaw)) {
            res.status(400).json({ error: "invalid sessionId" });
            return;
        }
        // ★ 安全②：并发上限保护
        if (activeControllers.size >= MAX_CONCURRENT_SESSIONS) {
            res.status(429).json({ error: "too many concurrent sessions" });
            return;
        }
        // ★ 安全③：同会话串行——避免第二个请求覆盖前一个的 AbortController 导致前者失控
        if (sessionIdRaw && activeControllers.has(sessionIdRaw)) {
            res.status(409).json({ error: "session already active" });
            return;
        }

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

        const sessionId = sessionIdRaw;
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
    //   必须携带 sessionId 且与挂起时一致，门锁据此拦截跨会话越权审批。
    app.post("/api/approve", (req, res) => {
        const { sessionId, toolsId, approved } = (req.body || {}) as { sessionId?: string; toolsId?: string; approved?: boolean };
        if (!isSafeSessionId(sessionId) || typeof toolsId !== "string" || typeof approved !== "boolean") {
            res.status(400).json({ ok: false, error: "需要 { sessionId: string, toolsId: string, approved: boolean }" });
            return;
        }
        const ok = resolveUserApprovalLock(sessionId, toolsId, approved);
        res.json({ ok });
    });

    // ★ 主动中止入站路由：前端点"停止"按钮时调用，按 sessionId 中止 /api/chat 里挂起的 agent 任务
    //   （审批挂起→判拒绝并清理门锁；工具执行→command 子进程被 SIGTERM 真正终止）
    app.post("/api/abort", (req, res) => {
        const { sessionId } = (req.body || {}) as { sessionId?: string };
        if (!isSafeSessionId(sessionId)) {
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
            // ★ 若客户端传入 sessionId，先过白名单（防穿越）；缺省则服务端生成
            if (raw?.sessionId !== undefined && !isSafeSessionId(raw.sessionId)) {
                res.status(400).json({ status: "error", message: "invalid sessionId" });
                return;
            }
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
