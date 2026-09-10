/**
 * @file commands/bashDirect.ts
 * @description `!` shell 直执行（对齐 Claude Code / pi 的 bang 透传）：
 *  输入以 `!` 开头 → 不经模型、不经审批流，直接在本机 shell 执行；输出回显给用户，
 *  并以 user 消息落 transcript（下轮 buildContextMessages 自然带入，模型可见命令与输出）。
 *
 *  纯客户端拦截：CLI（App.onSubmit）/ VSCode（host.submit）各自在把输入交给模型前接住 `!` 前缀，
 *  core 只提供「执行 + 格式化 + 落盘」三个纯函数；不设 serve 端点（交互式 UX，非 API 面）。
 */
import { exec } from "node:child_process";
import { appendMessage } from "@/session/transcript.ts";

/** 回显/落盘共用的输出截断上限（超出省略中段；防超大日志灌爆上下文与终端）。 */
const OUTPUT_MAX_CHARS = 4000;
/** 默认超时 60s；DEEP_SEEK_BANG_TIMEOUT_MS 可覆盖（调用时读取，测试可临时设小）。 */
const timeoutMs = (): number => {
    const n = Number(process.env.DEEP_SEEK_BANG_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 60_000;
};

export interface BashDirectResult {
    ok: boolean;
    /** stdout + stderr 组合输出（已截断） */
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
}

/** 输出截断：保头保尾，中段以省略标注替代（头尾通常各含命令回显与最终结果/报错）。 */
export const truncateOutput = (s: string): string => {
    if (s.length <= OUTPUT_MAX_CHARS) return s;
    const half = Math.floor(OUTPUT_MAX_CHARS / 2);
    return `${s.slice(0, half)}\n…（中段省略 ${s.length - OUTPUT_MAX_CHARS} 字符）…\n${s.slice(-half)}`;
};

/**
 * 本机 shell 直执行（child_process.exec：Windows 走 cmd.exe，POSIX 走 /bin/sh，与用户手工敲命令同语义）。
 * cwd 由调用方传工作区根；signal 可选（Esc 中止 → kill 子进程，回调以 timedOut 收尾）。
 */
export const runBashDirect = (cmd: string, cwd: string, signal?: AbortSignal): Promise<BashDirectResult> =>
    new Promise((resolve) => {
        let settled = false;
        const finish = (r: BashDirectResult): void => { if (!settled) { settled = true; resolve(r); } };
        const start = Date.now();
        const child = exec(cmd, { cwd, timeout: timeoutMs(), maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            const durationMs = Date.now() - start;
            // exec 超时/abort 杀进程 → err.killed=true 且 code 为 null（信号终止）
            const timedOut = err != null && err.killed === true;
            const combined = stderr ? (stdout ? `${stdout}\n` : "") + stderr : stdout;
            const exitCode = err == null ? 0 : typeof err.code === "number" ? err.code : null;
            finish({ ok: err == null, output: truncateOutput(combined ?? ""), exitCode, timedOut, durationMs });
        });
        if (signal) {
            const onAbort = (): void => { try { child.kill(); } catch { /* 已退出 */ } };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }
    });

/** 组装落盘/回显文本：`!bash $` 前缀保留（模型可识别该输出源于用户直跑的命令，非其自身动作）。 */
export const formatBashEntry = (cmd: string, r: BashDirectResult): string =>
    `!bash $ ${cmd}\n` +
    (r.timedOut ? `[超时中止（>${Math.round(r.durationMs / 1000)}s）]\n` : "") +
    (r.exitCode != null && r.exitCode !== 0 ? `[退出码 ${r.exitCode}]\n` : "") +
    (r.output.trim() || "(无输出)");

/** 以 user 消息落 transcript：下轮对话模型自动看到（零 contextCore 改动）。 */
export const recordBashEntry = async (sessionId: string, text: string): Promise<void> => {
    await appendMessage({ sessionId, role: "user", content: text });
};
