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
 *  /api/config（dump-config 只读诊断：有效配置树 + 来源标注）、
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
import type { ApprovalDecision } from "@/host/type.ts";
import { readStore, writeStore } from "@/session/store.ts"
import { forkSession } from "@/session/fork.ts";
import { pushSessionInbox } from "@/agent/inbox.ts";
import { appConfig } from "@/config/index.ts";
import { dumpEffectiveConfig } from "@/config/dump.ts";
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
    // ★ 多模态：上限放宽到 20mb——attachments 以 base64 随 JSON 携带（约 1.33 倍膨胀，8MB 原图 ≈ 10.7MB payload）
    app.use(express.json({ limit: "20mb" }));

    // 会话级 AbortController 仓库：/api/chat 按 sessionId 注册，/api/abort 据此主动中止 agent 任务
    const activeControllers = new Map<string, AbortController>();

    app.get("/health", (req, res) => {
        res.status(200).json({ status: "ok" });
    });

    // ★ 对话主通道：改成 SSE 流式，把 agent 的所有事件（含 approval_request）实时推前端
    app.post("/api/chat", async (req, res) => {
        const raw = req.body as UnifiedInboundMessage;
        const sessionIdRaw = raw?.sessionId;

        // ★ content 类型校验：缺失/非字符串会污染下游（expandSlashCommand(undefined) 静默返回 undefined →
        //   {role:'user', content:undefined} 进入 buildContextMessages + appendMessage → 落盘缺键坏行 + 模型收到非法消息体）
        if (typeof raw?.content !== "string") {
            res.status(400).json({ error: "content 必须为字符串" });
            return;
        }

        // ★ 多模态：attachments 可选，存在时校验形状（数组、元素含 mime/base64 字符串）——
        //   形状非法直接 400；业务级有效性（image/* 前缀 / 尺寸上限）由 contentParts.toWireUserContent 宽容降级处理
        if (raw?.attachments !== undefined) {
            const ok = Array.isArray(raw.attachments)
                && raw.attachments.every((a: any) => a && typeof a === "object"
                    && typeof a.mime === "string" && typeof a.base64 === "string");
            if (!ok) {
                res.status(400).json({ error: "attachments 必须为 {name?, mime, base64} 对象数组" });
                return;
            }
        }

        // ★ 安全①：sessionId 若由客户端传入，先过白名单（防路径穿越），非法直接 400（尚未进入 SSE）
        if (sessionIdRaw !== undefined && !isSafeSessionId(sessionIdRaw)) {
            res.status(400).json({ error: "invalid sessionId" });
            return;
        }
        // ★ 统一解析 sessionId：缺省则服务端生成并回填 raw，使路由层 / 业务层 / /api/abort 用同一键。
        //   否则匿名请求不入 activeControllers → ①并发上限 MAX_CONCURRENT_SESSIONS 形同虚设；
        //   ②/api/abort 永远找不到控制器（匿名会话无法停止）；③handleUnifiedChat 每次新建会话落盘膨胀。
        const sessionId = sessionIdRaw ?? createUUID();
        if (raw) raw.sessionId = sessionId;

        // ★ 安全②：并发上限保护（sessionId 已统一，匿名会话同样计数）
        if (activeControllers.size >= MAX_CONCURRENT_SESSIONS) {
            res.status(429).json({ error: "too many concurrent sessions" });
            return;
        }
        // ★ 安全③：同会话串行——避免第二个请求覆盖前一个的 AbortController 导致前者失控
        if (activeControllers.has(sessionId)) {
            res.status(409).json({ error: "session already active" });
            return;
        }

        const ac = new AbortController();
        // ★ 断连检测：req.aborted 在 Node 18+ 已弱化（SSE 长连接下客户端关标签页不一定触发），
        //   补 res.on('close') 作为可靠信号（res.close 在 SSE 连接断开时触发，body 读完不会误触发——
        //   那是 req.close 的行为）。两者共用 onAbort，幂等（writableEnded 判定 + ac.abort 多次安全）。
        const onAbort = (): void => {
            if (!res.writableEnded) ac.abort();
        };
        req.on("aborted", onAbort);
        res.on("close", onAbort);

        // SSE 响应头
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // 禁用反向代理缓冲，保证实时推送
        res.flushHeaders?.();

        const sseWrite = (obj: Record<string, unknown>): void => {
            if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };

        // 注册本次请求的 AbortController（sessionId 恒有值），供 /api/abort 按 sessionId 主动中止
        activeControllers.set(sessionId, ac);

        try {
            // sseWrite 作为主通道；sendOutbound 仅作非 SSE 渠道的后备（此处不会被调用）
            await handleUnifiedChat(raw, (outbound) => sendOutbound(res, outbound), sseWrite, ac.signal);
        } catch (err) {
            sseWrite({ eventType: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
            req.off("aborted", onAbort);
            res.off("close", onAbort);
            activeControllers.delete(sessionId);
            if (!res.writableEnded) res.end();
        }
    });

    // ★ 审批回传入站路由：前端用户点批准/拒绝后调用，解锁在 /api/chat 里挂起的工具协程
    //   必须携带 sessionId 且与挂起时一致，门锁据此拦截跨会话越权审批。
    app.post("/api/approve", (req, res) => {
        const { sessionId, toolsId, approved } = (req.body || {}) as { sessionId?: string; toolsId?: string; approved?: ApprovalDecision };
        const validDecisions: ApprovalDecision[] = ['allow-once', 'allow-always', 'deny'];
        if (!isSafeSessionId(sessionId) || typeof toolsId !== "string" || approved == null || !validDecisions.includes(approved)) {
            res.status(400).json({ ok: false, error: "需要 { sessionId: string, toolsId: string, approved: 'allow-once'|'allow-always'|'deny' }" });
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

    // ★ inbox steering 入站（第二梯队 #2）：向运行中会话排队补充输入，runAgent 回合边界 claim 注入。
    //   按 sessionId 跨端点操作，与 /api/approve、/api/abort 同模板；挂 /api 下自动过 requireAuth。
    app.post("/api/sessions/inbox", (req, res) => {
        const { sessionId, content } = (req.body || {}) as { sessionId?: string; content?: string };
        if (!isSafeSessionId(sessionId) || typeof content !== "string" || !content.trim()) {
            res.status(400).json({ ok: false, error: "需要 { sessionId: string, content: string }" });
            return;
        }
        // 子会话（spawn_agent 内部会话）不开放排队：用户只知道主 sessionId，防误用护栏
        if (sessionId.includes("__sub__")) {
            res.status(400).json({ ok: false, error: "不支持向子会话排队" });
            return;
        }
        if (!appConfig.inboxSteering) {
            res.status(501).json({ ok: false, error: "inbox steering 已禁用（DEEP_SEEK_INBOX=0）" });
            return;
        }
        if (!activeControllers.has(sessionId)) {
            res.status(409).json({ ok: false, queued: false, error: "会话不在运行中（请直接 /api/chat 发送）" });
            return;
        }
        const queued = pushSessionInbox(sessionId, content);
        res.status(queued ? 200 : 409).json({ ok: queued, queued });
    });

    // ★ 会话分叉（事件日志化落地）：从源会话任意历史点派生新会话（拷 transcript 前缀 + 派生 state）。
    //   upToLineId 缺省 = 最后一个已完成 turn 边界。CLI/VSCode 分叉选择 UX 属后续「会话历史UX」项目，
    //   此端点先提供本地程序化入口（对齐产品定位：serve 仅本地 API 入口）。
    app.post("/api/sessions/fork", async (req, res) => {
        const { sessionId, upToLineId } = (req.body || {}) as { sessionId?: string; upToLineId?: string };
        if (!isSafeSessionId(sessionId) || (upToLineId !== undefined && typeof upToLineId !== "string")) {
            res.status(400).json({ ok: false, error: "需要 { sessionId: string, upToLineId?: string }" });
            return;
        }
        try {
            const result = await forkSession(sessionId, upToLineId);
            res.json({ ok: true, ...result });
        } catch (e) {
            // 源不存在 / upToLineId 未找到 → 404（forkSession 抛错信息已可读）
            res.status(404).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });

    // ★ dump-config（第二梯队 #5）：只读输出合并后有效配置树 + 逐字段来源标注
    //    （default/env/settings.global/settings.project；机密字段仅指纹）。GET 无副作用，
    //    挂 /api 下自动过 requireAuth——本地程序化诊断入口（「这个行为到底被谁改了」一查便知）。
    app.get("/api/config", (_req, res) => {
        res.json({ ok: true, ...dumpEffectiveConfig() });
    });

    app.post("/createJson", async (req, res) => {
        try {
            const raw = req.body as UnifiedInboundMessage;
            // ★ 若客户端传入 sessionId，先过白名单（防穿越）；缺省则服务端生成
            if (raw?.sessionId !== undefined && !isSafeSessionId(raw.sessionId)) {
                res.status(400).json({ status: "error", message: "invalid sessionId" });
                return;
            }
            // ★ content 类型校验（旧版无校验，undefined/非字符串会污染下游）
            if (raw?.content !== undefined && typeof raw.content !== "string") {
                res.status(400).json({ status: "error", message: "invalid content" });
                return;
            }
            const sessionId = raw?.sessionId || createUUID();
            let data = await readStore(sessionId);
            if (Object.keys(data).length === 0) {
                // ⚠️ writeStore 现落盘到 <id>.state.json（与转录 <id>.jsonl 物理隔离），不再覆盖 JSONL 日志。
                //    此处 messages 仅作调试快照，不参与 agent 转录管线（runAgent 走 transcript.jsonl）。
                data = {
                    createdAt: new Date().toISOString(),
                    messages: [{ role: 'user', content: raw?.content || '' }] // ★ 移除调试期硬编码占位 '当前北京时间2222'
                };
                await writeStore(sessionId, data);
            }
            res.status(200).json({ status: "ok", sessionId, data });
        } catch (error) {
            console.error("接口执行崩溃:", error);
            res.status(500).json({ status: "error", message: "服务器内部错误" });
        }
    });
    // ★ 统一错误中间件：Express 4 不会自动捕获 async handler 的 rejected promise，
    //   兜底防止未处理异常导致请求挂起或进程级 unhandledRejection。须放在所有路由之后、return app 之前。
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        console.error("[express] 未处理路由异常:", err);
        if (!res.writableEnded) res.status(500).json({ error: "服务器内部错误" });
    });

    return app;
}
