/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-16 10:30:00
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\command.ts
 * @Description: 命令执行工具 (run_command) —— spawn shell 命令，流式吐 stdout/stderr + 退出码
 */
import { spawn } from "child_process";
import { CustomTool, ToolSafetyLevel, ToolExecutionResultStatus, ToolContext } from "../type.ts";
import { getActiveWorkspaceRoot, resolveSafePath } from "../guard.ts";
import { killTree } from "./background.ts";

/**
 * 退出码哨兵：用罕用数学括号 ⟦⟧ 界定 + 私有前缀 DSC_EXIT，避免被 stdout 中的字面量 "[exit: 0]"
 * 伪造而击穿防幻觉护城河。真正的退出码恒为 execute 在末尾追加的【最后一个】哨兵，
 * verifyResult 据此取真值；stdout 里即便出现伪造文本也只会排在真值之前。
 */
const EXIT_SENTINEL = (code: number) => `\n⟦DSC_EXIT:${code}⟧`;
const EXIT_SENTINEL_RE = /⟦DSC_EXIT:(-?\d+)⟧/g;

/** run_command 输出字符上限（maxOutputCharacters 字段与 execute 内 maxChars 的单一真相源，避免两处漂移） */
const RUN_COMMAND_MAX_CHARS = 20000;

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
            maxOutputCharacters: RUN_COMMAND_MAX_CHARS, // 💡 我们将在 execute 内部真正落地这个长度限制
            verifyResult: (rawOutput: string) => {
                // ★ 防伪造：取最后一个哨兵匹配（真正的退出码由 execute 在末尾追加）。
                //   旧的 [exit: N] 嗅探会被 stdout 里的字面量骗过，已废弃。
                const matches = [...rawOutput.matchAll(EXIT_SENTINEL_RE)];
                const code = matches.length ? parseInt(matches[matches.length - 1][1], 10) : 0;
                return code === 0
                    ? { status: ToolExecutionResultStatus.SUCCESS }
                    : { status: ToolExecutionResultStatus.FAILED, summary: `命令退出码非零：${code}` };
            },
            // ★ outputFilter：长构建/测试日志分流——用户看全文，模型只看头尾摘要（省 token，保留 EXIT 哨兵与首尾报错）。
            //   verifyResult 在此之前执行（用完整 raw），退出码判定不受影响；写入 message 后不变，不破坏 DeepSeek 前缀缓存。
            outputFilter: (rawOutput: string) => {
                const lines = rawOutput.split("\n");
                const HEAD = 20, TAIL = 40;
                if (lines.length <= HEAD + TAIL) return { toModel: rawOutput, toUser: rawOutput };
                const head = lines.slice(0, HEAD).join("\n");
                const tail = lines.slice(-TAIL).join("\n");
                const omitted = lines.length - HEAD - TAIL;
                return {
                    toModel: `${head}\n\n…(为模型精简：已省略中间约 ${omitted} 行，保留首 ${HEAD} 行 + 末 ${TAIL} 行含退出码与报错)…\n\n${tail}`,
                    toUser: rawOutput,
                };
            },
            async *execute(args: { command: string; cwd?: string }, ctx?: ToolContext): AsyncGenerator<string> {
                // ★ 已移除「高危词黑名单」：它可被空格/大小写/变量/管道轻易变形绕过，反而制造「已拦截」的
                //   虚假安全感，还会误杀合法命令（如 git commit -m "remove unused format"）。
                //   唯一可靠防线是 DANGER 级强制用户审批（现叠加 token 鉴权 + 审批绑定 sessionId + 127.0.0.1 监听）。

                const cwd = args.cwd ? resolveSafePath(args.cwd) : getActiveWorkspaceRoot();
                const maxChars = RUN_COMMAND_MAX_CHARS; // 对应配置的 maxOutputCharacters（单一来源）
                let totalYieldedChars = 0;

                // 💡 优化 2：非 Windows 下开启 detached 属性，以便后续能以进程组（Process Group）形式彻底剿灭子进程树
                const isWin = process.platform === "win32";
                // ★ 若进入工具时 signal 已 aborted，spawn 会同步抛 ERR_ABORTED；前置兜底避免击穿 generator
                if (ctx?.abortSignal?.aborted) {
                    yield `❌ [已中止]：命令 [${args.command}] 未执行（用户已中断）。`;
                    yield EXIT_SENTINEL(-1); // ★ H-2：中止也追加失败哨兵，避免 verifyResult 无哨兵时默认判 SUCCESS
                    return;
                }
                let proc: any;
                try {
                    proc = spawn(args.command, {
                        shell: true,
                        cwd,
                        detached: !isWin, // 非 Win 下支持整个进程组独立
                        signal: ctx?.abortSignal,
                    });
                } catch (e: any) {
                    yield `❌ [启动失败]：spawn 抛出异常（signal 已中止或命令非法）: ${e?.message ?? e}`;
                    yield EXIT_SENTINEL(-1); // ★ H-2：启动失败追加失败哨兵，避免 verifyResult 默认判 SUCCESS
                    return;
                }

                // 💡 优化 3：【核心升级】引入异步延迟队列桥接器，彻底消灭 16ms 忙轮询
                const queue: string[] = [];
                let settled = false;
                let exitCode: number | null = null;
                
                // 专门负责唤醒 await 的控制器
                let resolveWaiter: (() => void) | null = null;
                let idleTimer: NodeJS.Timeout | null = null; // 空闲看门狗计时器：有新数据/退出时清理
                const notifyNewData = () => {
                    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
                    if (resolveWaiter) {
                        resolveWaiter();
                        resolveWaiter = null;
                    }
                };

                // ★ 编码处理（修 Windows stdout 乱码）：命令常以系统 OEM 代码页输出（中文 Windows=cp936/GBK），
                //   原 d.toString()（默认 utf-8）会对 GBK 字节产生 U+FFFD（菱形替代符）；且逐块 toString 会截断跨块
                //   的多字节序列。改用 TextDecoder + stream 模式同时解决两点：
                //   1) 延迟定型：直到出现含高位字节(>=0x80)的块才决定编码（纯 ASCII 在 UTF-8/GBK 下解码一致，先用
                //      utf-8 占位），避免「首块 ASCII 前缀、后续才 GBK 中文」（如 ping 先英文后中文）被误判为 utf-8；
                //   2) UTF-8 探测出现 U+FFFD（非合法 UTF-8）即回退 GBK（Node 内置 full-icu 支持；精简构建无 gbk 时
                //      try/catch 退回 utf-8，至少不崩）。
                let pendingUtf8 = new TextDecoder("utf-8");
                let decoder: TextDecoder | null = null; // 编码定型后非空；null=尚未遇到高位字节块
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

                proc.stdout?.on("data", (d: Buffer) => {
                    queue.push(decodeChunk(d));
                    notifyNewData();
                });
                proc.stderr?.on("data", (d: Buffer) => {
                    queue.push(decodeChunk(d));
                    notifyNewData();
                });
                proc.on("error", (e: Error) => {
                    queue.push(`\n[spawn error: ${e.message}]`);
                    exitCode = -1;
                    settled = true;
                    notifyNewData();
                });
                proc.on("close", (code: number | null) => {
                    // ★ H-1 修复：用 ??= 保留 error 事件已写入的 -1；code=null（被信号杀死/spawn 失败）按 -1 处理。
                    //   旧实现 exitCode = code ?? 0 无条件覆盖，会把 spawn ENOENT（error 置 -1 → close 置 null）误判为成功退出 0。
                    exitCode ??= code == null ? -1 : code;
                    // flush 编码解码器末尾残留的多字节序列（GBK/UTF-8 stream 模式可能留尾字节，不 flush 会丢最后一个字符）
                    if (decoder) queue.push(decoder.decode());
                    queue.push(pendingUtf8.decode());
                    settled = true;
                    notifyNewData();
                });

                // 💡 优化 4：【强力杀死防御】防止长连接子服务脱离控制变成孤儿后台
                // ★ 跨平台进程树终止（复用 background.ts 的 killTree）：
                //   Win 走 taskkill /T /F 连孙进程一并杀，非 Win 向负 PID 发信号杀整个进程组
                const onAbort = () => { void killTree(proc); };
                ctx?.abortSignal?.addEventListener("abort", onAbort);

                let overLimit = false;
                try {
                    // 基于条件唤醒的高级流式循环（overLimit 命中后彻底退出两层循环，避免逐 chunk 重复吐警告 / 反复 onAbort）
                    while ((!settled || queue.length > 0) && !overLimit) {
                        if (queue.length === 0) {
                            // 空闲看门狗：60s 内既无新输出也未退出 → 判定常驻命令（应改用 run_in_background），主动终止释放主循环
                            const IDLE_TIMEOUT_MS = 60_000;
                            let timedOut = false;
                            await new Promise<void>((r) => {
                                resolveWaiter = r;
                                idleTimer = setTimeout(() => { timedOut = true; r(); }, IDLE_TIMEOUT_MS);
                            });
                            if (timedOut && !settled && queue.length === 0) {
                                yield `\n\n⏱️ [看门狗]：命令连续 ${IDLE_TIMEOUT_MS / 1000}s 无输出且未退出，判定为常驻进程（如 dev server / tail -f）。已主动终止以释放主循环——常驻命令请改用 run_in_background。\n`;
                                onAbort();
                                settled = true;
                                overLimit = true;
                                break;
                            }
                        }

                        while (queue.length > 0) {
                            const chunk = queue.shift() as string;
                            totalYieldedChars += chunk.length;

                            // 💡 优化 5：严格践行最大字符限制阻断，防止巨型依赖树构建日志撑爆大模型上下文
                            if (totalYieldedChars > maxChars) {
                                yield `\n\n⚠️ [警告]：输出日志字符量已达上限 ${maxChars}，为保护大模型上下文，后续流已被强行截断。\n`;
                                onAbort(); // 既然日志装不下了，顺便主动掐断子进程执行
                                settled = true;
                                overLimit = true; // ★ 命中上限后跳出外层，杜绝重复吐警告
                                break;
                            }
                            yield chunk;
                        }
                    }
                    if (overLimit) {
                        // ★ 输出被截断视为失败：显式 yield 哨兵 exit:-1，让 verifyResult 判 FAILED，
                        //   避免模型对超长失败构建/测试产生"成功幻觉"（截断场景恰是失败高发区）
                        yield EXIT_SENTINEL(-1);
                    } else if (exitCode !== null) {
                        yield EXIT_SENTINEL(exitCode);
                    }
                } finally {
                    if (idleTimer) clearTimeout(idleTimer);
                    ctx?.abortSignal?.removeEventListener("abort", onAbort);
                }
            },
        },
    },
];

