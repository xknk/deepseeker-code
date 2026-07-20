/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-16 10:30:00
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\command.ts
 * @Description: 命令执行工具 (run_command) —— spawn shell 命令，流式吐 stdout/stderr + 退出码
 */
import { spawn } from "child_process";
import { CustomTool, ToolSafetyLevel, ToolExecutionResultStatus, ToolContext } from "../type.ts";
import { WORKSPACE_ROOT, resolveSafePath } from "../guard.ts";

/**
 * @file tool/registry/command.ts
 * @description 命令执行类工具集。run_command：spawn shell 执行命令，
 *  流式返回 stdout/stderr 并附带退出码；属于 DANGER 级高危操作，每次执行都需用户审批。
 */

/** 命令执行类工具集（详见上方 @file 说明）。 */
export const commandTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "run_command",
            description: "在工作区执行 shell 命令（跑测试 / 构建 / git 等），流式返回 stdout/stderr 并附带退出码。属于高危操作，每次执行都需要用户审批。",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "完整的 shell 命令（如 'npm test'、'git status'、'pnpm build'）" },
                    cwd: { type: "string", description: "工作目录的相对路径（可选，默认工作区根）" },
                },
                required: ["command"],
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: (args: { command: string; cwd?: string }) =>
                `⚠️【命令执行审批】\n目录: ${args.cwd || "（工作区根）"}\n命令: ${args.command}`,
            timeoutMs: 300000,        // 预留阈值（当前取消由用户中断 ctx.abortSignal 驱动，本字段暂未启用）
            maxOutputCharacters: 20000, // 防构建日志撑爆上下文
            verifyResult: (rawOutput: string) => {
                const m = rawOutput.match(/\[exit:\s*(-?\d+)\]/);
                const code = m ? parseInt(m[1], 10) : 0;
                return code === 0
                    ? { status: ToolExecutionResultStatus.SUCCESS }
                    : { status: ToolExecutionResultStatus.FAILED, summary: `命令退出码非零：${code}` };
            },
            // 流式 execute：spawn → 队列桥接 → yield stdout/stderr 片段 → 收尾 [exit: N]
            async *execute(args: { command: string; cwd?: string }, ctx?: ToolContext): AsyncGenerator<string> {
                const cwd = args.cwd ? resolveSafePath(args.cwd) : WORKSPACE_ROOT;

                const proc = spawn(args.command, {
                    shell: true,            // win32 必须：npm/git 等是 .cmd 包装器，需 shell 解释
                    cwd,
                    signal: ctx?.abortSignal, // abort 时 Node 自动向子进程发 SIGTERM
                });

                // 事件 → generator 桥接（队列 + 完成标志）
                const queue: string[] = [];
                let exitCode: number | null = null;
                let settled = false;

                proc.stdout?.on("data", (d: Buffer) => queue.push(d.toString()));
                proc.stderr?.on("data", (d: Buffer) => queue.push(d.toString()));
                proc.on("error", (e: Error) => {
                    queue.push(`\n[spawn error: ${e.message}]`);
                    exitCode = -1;
                    settled = true;
                });
                proc.on("close", (code: number | null) => {
                    exitCode = code ?? 0;
                    settled = true;
                });

                // abort 兜底：signal 已传 spawn，这里再显式 kill 保险（防止某些 shell 子进程树不响应）
                const onAbort = () => { try { proc.kill(); } catch { /* 已退出 */ } };
                ctx?.abortSignal?.addEventListener("abort", onAbort);

                try {
                    while (!settled || queue.length > 0) {
                        while (queue.length > 0) yield queue.shift() as string;
                        if (!settled) await new Promise((r) => setTimeout(r, 16)); // 16ms 轮询
                    }
                    yield `\n[exit: ${exitCode}]`;
                } finally {
                    ctx?.abortSignal?.removeEventListener("abort", onAbort);
                }
            },
        },
    },
];
