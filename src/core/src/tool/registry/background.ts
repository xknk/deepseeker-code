/**
 * @file tool/registry/background.ts
 * @description 后台任务工具集（自管理进程注册表，方案 A，不动 runAgent 执行模型）：
 *  - run_in_background（DANGER，spawn detached 常驻进程，立即返回 task_id 不阻塞）
 *  - get_background_output（SAFE，读取最近日志 + 运行状态/退出码）
 *  - stop_background_task（MUTATION，按 task_id 跨平台终止进程树）
 *
 *  设计要点：
 *  1) isSync 仍为 true——execute 内 spawn 后立即返回 task_id，框架无需 isSync:false 分支；
 *     isSync:false / exclusiveLock 的原生挂起语义留作后续硬化（见 工具扩充计划.md）。
 *  2) 注册表为模块级 Map（内存态）：进程本身 detached+unref 随宿主存活，但句柄不跨进程重启
 *     持久化——服务重启后旧任务无法再用工具管理（v1 已知限制）。
 *  3) 输出走环形缓冲（每任务上限 MAX_BUFFER_CHARS），防止 dev server 长连接日志吃爆内存。
 */
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { getActiveWorkspaceRoot, resolveSafePath } from "../guard.ts";
import { createUUID } from "@/common/index.ts";

const execFileAsync = promisify(execFile);

interface BgTask {
    taskId: string;
    command: string;
    cwd: string;
    sessionId: string; // ★ 归属会话：跨会话隔离查询/终止，防越权读取其他会话的后台输出
    proc: any;
    startedAt: string;
    status: "running" | "exited" | "killed";
    exitCode: number | null;
    outputBuffer: string;
}

const MAX_BUFFER_CHARS = 100_000; // 每任务输出环形缓冲上限
const registry = new Map<string, BgTask>();

/** 追加输出并维持环形缓冲（超出上限从头部丢弃，保留最新日志） */
function appendOutput(task: BgTask, chunk: string): void {
    task.outputBuffer += chunk;
    if (task.outputBuffer.length > MAX_BUFFER_CHARS) {
        task.outputBuffer = task.outputBuffer.slice(-MAX_BUFFER_CHARS);
    }
}

/** 跨平台终止进程树：Win 用 taskkill /T /F，非 Win 向负 PID 发 SIGKILL 杀整个进程组 */
export async function killTree(proc: any): Promise<void> {
    const pid = proc?.pid;
    if (!pid) return;
    const isWin = process.platform === "win32";
    try {
        if (isWin) {
            // ★ execFile 加 5s 超时兜底：taskkill 极罕见挂起时不让整个 killTree 永久 pending
            //   （shellExecutor 的 void killTree 是 fire-and-forget，超时分支不会回头兜底）。
            await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
        } else {
            process.kill(-pid, "SIGKILL");
        }
    } catch { /* 进程可能已自然退出 */ }
    try { proc.kill(); } catch { /* 兜底 */ }
}

export const backgroundTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "run_in_background",
            description: "在后台启动一个长连接/常驻 shell 命令（如 dev server、watch、tail -f），立即返回 task_id，不阻塞后续推理。常用于先起服务再继续干别的活。用 get_background_output 查日志与状态，stop_background_task 终止。",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "完整的 shell 命令（如 'npm run dev'、'pnpm watch'）" },
                    cwd: { type: "string", description: "工作目录相对路径（可选，默认工作区根）" }
                },
                required: ["command"]
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: false, // 后台任务：首个 yield 立即返回 task_id，进程生命周期由 generator 挂起承载，结束自动释放 exclusiveLock
            // 锁 key 归一化：命令压缩多空格 + 拼 cwd，避免 'npm run dev' / 'npm  run dev' 漏判、
            //   不同 cwd 下同命令误共享锁
            exclusiveLock: (args: { command: string; cwd?: string }) => {
                // cwd 归一化：反斜杠→正斜杠 + 去尾斜杠；仅在不区分大小写的 FS（Win/Mac 默认）上 lowercase，
                //   避免 Linux（区分大小写）把 /repo/Foo 与 /repo/foo 误合并为同锁
                const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
                const normCwd = (args.cwd || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
                return `bg:${(args.command || "").trim().replace(/\s+/g, " ")}@${caseInsensitive ? normCwd.toLowerCase() : normCwd}`;
            },
            requireApproval: (args: { command: string; cwd?: string }) =>
                `⚠️【后台命令审批】\n目录: ${args.cwd || "（工作区根）"}\n命令: ${args.command}\n（将启动常驻后台进程，持续占用资源直至手动停止；同命令互斥）`,
            async *execute(args: { command: string; cwd?: string }, ctx?: ToolContext): AsyncGenerator<string> {
                const cwd = args.cwd ? resolveSafePath(args.cwd) : getActiveWorkspaceRoot();
                const isWin = process.platform === "win32";

                // ★ 编码处理（与 command.ts 对齐）：Windows 下命令常以系统 OEM 代码页（中文=cp936/GBK）输出，
                //   d.toString() 默认 utf-8 会对 GBK 字节产生 U+FFFD 菱形问号。改用 TextDecoder + stream 模式：
                //   首个含高位字节块才定型（纯 ASCII 在两编码下一致），UTF-8 解出 U+FFFD 即回退 GBK（无 gbk 时退回 utf-8）。
                const pendingUtf8 = new TextDecoder("utf-8");
                let decoder: TextDecoder | null = null;
                const decodeChunk = (buf: Buffer): string => {
                    if (!decoder) {
                        const hasHighByte = buf.some((b: number) => b >= 0x80);
                        if (hasHighByte) {
                            const isGbk = buf.toString("utf8").includes("�");
                            try { decoder = new TextDecoder(isGbk ? "gbk" : "utf-8"); }
                            catch { decoder = pendingUtf8; } // 精简 ICU 无 gbk → 退回 utf-8
                        }
                    }
                    return (decoder ?? pendingUtf8).decode(buf, { stream: true });
                };

                let proc: any;
                try {
                    proc = spawn(args.command, { shell: true, cwd, detached: !isWin });
                    proc.unref?.(); // 父进程（agent）不必等待它退出
                } catch (e: any) {
                    yield `❌ [后台启动失败]：${e.message}`;
                    return;
                }

                const taskId = createUUID();
                const task: BgTask = {
                    taskId, command: args.command, cwd, sessionId: ctx?.sessionId ?? "", proc,
                    startedAt: new Date().toISOString(),
                    status: "running", exitCode: null, outputBuffer: ""
                };
                registry.set(taskId, task);

                proc.stdout?.on("data", (d: Buffer) => appendOutput(task, decodeChunk(d)));
                proc.stderr?.on("data", (d: Buffer) => appendOutput(task, decodeChunk(d)));
                // ★ spawn error 由下方 Promise 内监听统一处理（删除此处重复监听，防日志双写）

                // ★ 首个 yield：即时返回 task_id（runBackgroundTool 取此为结果，agent 不阻塞、继续下一轮）
                yield `✅ [后台任务已启动]\ntask_id: ${taskId}\n命令: ${args.command}\n用 get_background_output(task_id="${taskId}") 查日志，stop_background_task(task_id="${taskId}") 终止。`;

                // ★ 后台挂起：等进程退出。generator 挂起期间 = 后台任务存活；
                //   proc 退出 / 被 stop_background_task 杀掉 / 用户 abort → resolve → generator 完成 → 自动释放 exclusiveLock
                await new Promise<void>((resolve) => {
                    let finished = false; // 守卫：abort 与 close 可能先后触发 finish，仅首次生效（防 exitCode 被覆盖 / 日志双写）
                    const finish = (apply: () => void): void => {
                        if (finished) return;
                        finished = true;
                        apply();
                        // 退出后延迟清理注册表（留 60s 供查询退出码），避免长期累积死任务
                        setTimeout(() => registry.delete(taskId), 60_000);
                        ctx?.abortSignal?.removeEventListener("abort", onAbort);
                        // 清理 proc 上的 listener，打破 listener→task→proc 循环引用（否则 60s 持有窗口内累积）
                        try { proc?.stdout?.removeAllListeners?.(); } catch { /* */ }
                        try { proc?.stderr?.removeAllListeners?.(); } catch { /* */ }
                        try { proc?.removeAllListeners?.(); } catch { /* */ }
                        resolve();
                    };
                    // 用户主动中断：杀进程树并标记 killed（确保 generator 完成 → 释放 exclusiveLock，杜绝死锁）
                    const onAbort = (): void => {
                        killTree(proc).finally(() => {
                            finish(() => {
                                if (task.status === "running") task.status = "killed";
                                task.exitCode = task.exitCode ?? -1;
                                appendOutput(task, `\n[用户中止，进程树已终止]`);
                            });
                        });
                    };
                    ctx?.abortSignal?.addEventListener("abort", onAbort, { once: true });
                    proc.on("close", (code: number | null) => {
                        finish(() => {
                            task.status = task.status === "killed" ? "killed" : "exited";
                            task.exitCode ??= code ?? 0; // 已被 abort 设为 -1 时不覆盖，保持 killed 语义
                            appendOutput(task, `\n[进程结束 exit=${code}]`);
                        });
                    });
                    proc.on("error", (e: Error) => {
                        // spawn 失败等场景：更新状态避免永远卡 running
                        finish(() => {
                            if (task.status === "running") task.status = "exited";
                            task.exitCode = task.exitCode ?? -1;
                            appendOutput(task, `\n[spawn error: ${e.message}]`);
                        });
                    });
                });
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_background_output",
            description: "查看指定后台任务的最近输出日志与运行状态（running/exited/killed + 退出码）。纯读，免审批。用于确认 dev server 是否启动成功、查看报错等。",
            parameters: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "run_in_background 返回的 task_id" },
                    tail_lines: { type: "number", description: "只返回最后 N 行日志（默认 50，避免一次灌入过多）" }
                },
                required: ["task_id"]
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { task_id: string; tail_lines?: number }, ctx?: ToolContext): Promise<string> {
                const task = registry.get(args.task_id);
                if (!task || task.sessionId !== ctx?.sessionId) {
                    // 跨会话不可见：统一返回未找到，不泄露 task 是否存在
                    return `❌ [查询失败]：未找到 task_id=${args.task_id}（可能已随服务重启丢失，或不属于当前会话）。`;
                }
                const tail = Math.max(1, args.tail_lines ?? 50);
                const allLines = task.outputBuffer.split("\n");
                const tailText = allLines.slice(-tail).join("\n").trim();
                return [
                    `[后台任务 ${task.taskId}]`,
                    `命令: ${task.command}`,
                    `状态: ${task.status}${task.exitCode !== null ? ` (exit=${task.exitCode})` : ""} | 启动于 ${task.startedAt}`,
                    `--- 最近 ${Math.min(tail, allLines.length)} 行 ---`,
                    tailText || "(暂无输出)"
                ].join("\n");
            }
        }
    },
    {
        type: "function",
        function: {
            name: "stop_background_task",
            description: "终止指定的后台任务（连同其子进程树）。用于停掉 dev server / watch 等常驻进程。",
            parameters: {
                type: "object",
                properties: {
                    task_id: { type: "string", description: "run_in_background 返回的 task_id" }
                },
                required: ["task_id"]
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { task_id: string }) => `申请终止后台任务 ${args.task_id}（及其子进程树）`,
            async execute(args: { task_id: string }, ctx?: ToolContext): Promise<string> {
                const task = registry.get(args.task_id);
                if (!task || task.sessionId !== ctx?.sessionId) {
                    return `❌ [终止失败]：未找到 task_id=${args.task_id}（或不属于当前会话）。`;
                }
                if (task.status !== "running") {
                    return `ℹ️ [stop]：任务 ${args.task_id} 当前状态为 ${task.status}（已不在运行），无需终止。`;
                }
                // ★ 与 abort 路径对齐：预置失败码，防 close 的 code??0 把被杀进程误显为成功退出 0
                task.exitCode = task.exitCode ?? -1;
                await killTree(task.proc);
                task.status = "killed";
                return `✅ [已终止]：后台任务 ${args.task_id}（命令: ${task.command}）及其进程树已停止。`;
            }
        }
    }
];

/** 暴露注册表快照（供可观测/调试/未来 CLI 面板渲染使用，不含 proc 句柄） */
export function listBackgroundTasks(): Omit<BgTask, "proc">[] {
    return Array.from(registry.values()).map(({ proc, ...rest }) => rest);
}

/**
 * 终止所有 cwd 落在 dirPath 之下（含等于）的运行中后台任务（连同进程树）。
 * worktree 移除前调用：避免 dev server 等常驻进程的 cwd 指向已被 git worktree remove 的目录。
 * @returns 被终止的任务数
 */
export async function killBackgroundTasksUnder(dirPath: string): Promise<number> {
    const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const target = norm(dirPath);
    let killed = 0;
    for (const task of registry.values()) {
        if (task.status !== "running") continue;
        const taskCwd = norm(task.cwd);
        // taskCwd === target（cwd 正是该 worktree）或 taskCwd 以 target/ 开头（在 worktree 子目录）
        if (taskCwd === target || taskCwd.startsWith(target + "/")) {
            task.exitCode = task.exitCode ?? -1;
            await killTree(task.proc).catch(() => { /* 进程可能已退出 */ });
            task.status = "killed";
            killed++;
        }
    }
    return killed;
}
