/**
 * @file serve/auth.ts
 * @description 执行层统一鉴权：启动期生成 / 从环境变量读取一个 Bearer token，
 *  经 requireAuth 中间件保护所有「会驱动 agent / 改状态」的端点（/api/* 与 /createJson）。
 *
 *  威胁模型说明（务必阅读）：
 *   - 本 token + 127.0.0.1 监听 + 审批绑定 sessionId，三者合力可关闭
 *     「远程 / 跨进程 / 跨会话」攻击者：远程连不上端口、无 token 的本地进程被 401、
 *     持 token 的 A 会话无法批准 B 会话的工具。
 *   - 残留限制：合法持有 token 且开了 /api/chat 的人，其 SSE 流会收到 approval_request，
 *     因此仍可对自己会话的工具「自批准」。这是当前架构固有（审批与模型调用走同一通道），
 *     完全闭环需未来前端提供「模型调用方无法程序化驱动的可信 UI 路径」。单机本地使用可接受。
 */
import crypto from "crypto";
import fsSync from "fs"; // 同步落盘 token（避免顶层 await）
import type { Request, Response, NextFunction } from "express";

/**
 * 鉴权 token：优先取环境变量 DEEPSEEK_CODE_TOKEN（跨重启稳定）；未设则启动期随机生成
 *  32 字节 hex（每次重启变化），并打印到控制台供前端对接。
 */
const RAW_TOKEN =
    (process.env.DEEPSEEK_CODE_TOKEN && process.env.DEEPSEEK_CODE_TOKEN.trim()) ||
    crypto.randomBytes(32).toString("hex");

/** 对外导出（如未来需写入文件 / 透给前端构建）。 */
export const AUTH_TOKEN = RAW_TOKEN;
const TOKEN_BUF = Buffer.from(RAW_TOKEN);

const TOKEN_FILE = process.env.DEEPSEEK_CODE_TOKEN_FILE?.trim();
if (!process.env.DEEPSEEK_CODE_TOKEN) {
    if (TOKEN_FILE) {
        // 生产/日志敏感环境：把 token 落盘到指定文件（POSIX 0600），避免打印到被采集的 stdout
        try {
            fsSync.writeFileSync(TOKEN_FILE, RAW_TOKEN + "\n", { mode: 0o600 });
            console.log(`🔑 AUTH TOKEN 已写入 ${TOKEN_FILE}（权限 0600），未打印到 stdout。`);
        } catch (e: any) {
            console.error(`🚮 写入 token 文件失败 (${TOKEN_FILE})：${e.message}，回退打印：`);
            console.log(`  AUTH TOKEN（回退）: ${RAW_TOKEN}`);
        }
    } else {
        // 未显式配置时打印一次性 token，便于本地对接；生产环境应改用环境变量固化或 DEEPSEEK_CODE_TOKEN_FILE 落盘。
        console.log(
            `\n========================================\n` +
            `  🔑 AUTH TOKEN（本次运行生成，重启即变）:\n   ${RAW_TOKEN}\n` +
            `  设环境变量 DEEPSEEK_CODE_TOKEN 可跨重启稳定。\n` +
            `========================================\n`
        );
    }
}

/**
 * Express 中间件：要求请求头 `Authorization: Bearer <token>`，常量时间比较防时序侧信道。
 *  注意：crypto.timingSafeEqual 在两 Buffer 长度不等时会抛 RangeError，故先判等长再比较。
 */
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const auth = req.headers.authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const presented = m ? m[1] : "";
    const presentedBuf = Buffer.from(presented);
    const ok = presentedBuf.length === TOKEN_BUF.length &&
        (presentedBuf.length === 0 ? false : crypto.timingSafeEqual(presentedBuf, TOKEN_BUF));
    if (!ok) {
        res.status(401).json({ error: "unauthorized" });
        return;
    }
    next();
};
