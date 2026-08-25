/**
 * @file tests/background-degrade.test.ts
 * @description run_command 超时自动转后台（auto-degrade）+ 后台注册表收编链路单测：
 *  - 运行超阈值（runCommandAutoBgMs）/ 空闲看门狗（RUN_COMMAND_IDLE_TIMEOUT_MS）触发降级：
 *    不杀进程、收编进注册表、yield task_id、绝不出现 EXIT 哨兵（退出码未知契约，verifyResult → SUCCESS）
 *  - 降级前的已 drain 输出 seed 进后台环形缓冲（get_background_output 可见全史）
 *  - 快速退出 / 非零退出 / abort 旧路径回归；run_in_background 重构（attachTaskLifecycle）挂起语义冒烟
 *  - outputFilter / verifyResult 纯函数契约锁
 * ★ generator 必须手动驱动（drain 循环 next()）——只取首个 yield 不会注册 close 监听（已知坑）。
 * ★ appConfig 为可变单例且 execute 每次读取 → 测试按次覆盖，无 env/导入顺序耦合；
 *   空闲阈值是 execute 内 per-call 读 env，设 RUN_COMMAND_IDLE_TIMEOUT_MS 即可（测完删除）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandTools } from "@/tool/registry/command.ts";
import { backgroundTools, resolveWinShell } from "@/tool/registry/background.ts";
import { appConfig } from "@/config/index.ts";
import { ToolContext, ToolExecutionResultStatus } from "@/tool/type.ts";

const runCommand = commandTools.find((t: any) => t.function.name === "run_command")!;
const runBg = backgroundTools.find((t: any) => t.function.name === "run_in_background")!;
const getBg = backgroundTools.find((t: any) => t.function.name === "get_background_output")!;
const stopBg = backgroundTools.find((t: any) => t.function.name === "stop_background_task")!;

const SESSION = "bg-degrade-test";
const makeCtx = (sessionId: string = SESSION, signal?: AbortSignal): ToolContext =>
    ({ sessionId, abortSignal: signal }) as unknown as ToolContext;

/** 手动驱动 generator 至完成，返回全部 yield 拼接（直接测试的已知坑：必须逐 next() 驱动） */
const drain = async (gen: AsyncGenerator<string>): Promise<string> => {
    let s = "";
    while (true) {
        const r = await gen.next();
        if (r.done) break;
        s += r.value;
    }
    return s;
};

const extractTaskId = (s: string): string | null => (s.match(/task_id: (\S+)/) ?? [])[1] ?? null;

/** 按次覆盖 autoBg 阈值（execute 内读单例），finally 恢复，防跨测试污染 */
const withAutoBg = async (ms: number, fn: () => Promise<void>): Promise<void> => {
    const orig = appConfig.runCommandAutoBgMs;
    appConfig.runCommandAutoBgMs = ms;
    try { await fn(); } finally { appConfig.runCommandAutoBgMs = orig; }
};

/** 测试收尾清理：终止收编任务，防活进程/注册表泄漏到后续测试 */
const stopQuiet = async (taskId: string | null): Promise<void> => {
    if (!taskId) return;
    try { await stopBg.function.execute({ task_id: taskId }, makeCtx()); } catch { /* 已退出 */ }
};

/** win32 无 Git Bash 时跳过（POSIX sleep/for 依赖 bash）；非 Win 恒跑 */
const needShell = (name: string, fn: () => Promise<void>): void => {
    const noBash = process.platform === "win32" && !resolveWinShell();
    it(name, { skip: noBash ? "win32 无 Git Bash（POSIX sleep/for 不可用），跳过" : false }, fn);
};

describe("run_command 自动转后台（auto-degrade）", () => {
    it("工具挂载完整性", () => {
        assert.ok(runCommand && runBg && getBg && stopBg, "四个工具应存在");
        assert.equal(typeof runCommand.function.verifyResult, "function");
        assert.equal(typeof runCommand.function.outputFilter, "function");
    });

    needShell("运行超阈值：静默命令自动转后台（无 EXIT 哨兵，verifyResult SUCCESS，跨会话不可见）", async () => {
        await withAutoBg(700, async () => {
            const ctx = makeCtx();
            const out = await drain(runCommand.function.execute({ command: "sleep 6" }, ctx) as AsyncGenerator<string>);
            assert.match(out, /自动转后台/, "应包含降级提示");
            assert.doesNotMatch(out, /⟦DSC_EXIT/, "进程仍在运行、退出码未知，绝不出现哨兵");
            assert.equal(runCommand.function.verifyResult!(out, makeCtx()).status, ToolExecutionResultStatus.SUCCESS, "无哨兵默认 SUCCESS（仍在运行语义由文本承载）");
            const taskId = extractTaskId(out);
            assert.ok(taskId, "应能提取 task_id");
            const st = (await getBg.function.execute({ task_id: taskId! }, ctx)) as string;
            assert.match(st, /状态: running/, "收编后任务应在运行");
            const other = (await getBg.function.execute({ task_id: taskId! }, makeCtx("other-session"))) as string;
            assert.match(other, /未找到/, "跨会话不可见（session 隔离）");
            await stopQuiet(taskId);
        });
    });

    needShell("stop_background_task 终止收编任务 → killed / exit=-1", async () => {
        await withAutoBg(700, async () => {
            const ctx = makeCtx();
            const out = await drain(runCommand.function.execute({ command: "sleep 6" }, ctx) as AsyncGenerator<string>);
            const taskId = extractTaskId(out)!;
            const stopRes = (await stopBg.function.execute({ task_id: taskId }, ctx)) as string;
            assert.match(stopRes, /已终止/);
            const st = (await getBg.function.execute({ task_id: taskId }, ctx)) as string;
            assert.match(st, /killed/);
            assert.match(st, /exit=-1/);
        });
    });

    needShell("快速自然退出不受影响：echo → 哨兵 0 + SUCCESS", async () => {
        await withAutoBg(60_000, async () => {
            const out = await drain(runCommand.function.execute({ command: "echo degrade-ok" }, makeCtx()) as AsyncGenerator<string>);
            assert.match(out, /degrade-ok/);
            assert.match(out, /⟦DSC_EXIT:0⟧/);
            assert.equal(runCommand.function.verifyResult!(out, makeCtx()).status, ToolExecutionResultStatus.SUCCESS);
        });
    });

    needShell("非零退出回归：exit 3 → 哨兵 3 + FAILED", async () => {
        await withAutoBg(60_000, async () => {
            const out = await drain(runCommand.function.execute({ command: "exit 3" }, makeCtx()) as AsyncGenerator<string>);
            assert.match(out, /⟦DSC_EXIT:3⟧/);
            assert.equal(runCommand.function.verifyResult!(out, makeCtx()).status, ToolExecutionResultStatus.FAILED);
        });
    });

    needShell("chatty 命令降级：已 drain 输出 seed 进后台缓冲（get 可见全史）", async () => {
        await withAutoBg(1_500, async () => {
            const ctx = makeCtx();
            const out = await drain(runCommand.function.execute({ command: 'for i in 1 2 3; do echo "seedline$i"; sleep 1; done' }, ctx) as AsyncGenerator<string>);
            assert.match(out, /seedline1/, "前台已收到降级前输出");
            assert.match(out, /自动转后台/);
            const taskId = extractTaskId(out)!;
            const st = (await getBg.function.execute({ task_id: taskId }, ctx)) as string;
            assert.match(st, /seedline1/, "降级前输出应 seed 进后台缓冲（验证 fullOutput 不只 queue）");
            await stopQuiet(taskId);
        });
    });

    needShell("空闲看门狗触发降级（原行为为杀进程）", async () => {
        process.env.RUN_COMMAND_IDLE_TIMEOUT_MS = "700";
        try {
            await withAutoBg(600_000, async () => {
                const ctx = makeCtx();
                const out = await drain(runCommand.function.execute({ command: "sleep 6" }, ctx) as AsyncGenerator<string>);
                assert.match(out, /自动转后台/);
                assert.match(out, /无输出且未退出/, "空闲原因应在提示中注明");
                const taskId = extractTaskId(out)!;
                const st = (await getBg.function.execute({ task_id: taskId }, ctx)) as string;
                assert.match(st, /状态: running/);
                await stopQuiet(taskId);
            });
        } finally {
            delete process.env.RUN_COMMAND_IDLE_TIMEOUT_MS;
        }
    });

    it("outputFilter：长输出降级时提示仍保留在 toModel 尾部", () => {
        const lines = Array.from({ length: 100 }, (_, i) => `build log ${i}`);
        const notice = '\n⏳ [自动转后台]：命令 [x] 已持续运行超过 120s\ntask_id: fake-id\n';
        const raw = lines.join("\n") + notice;
        const r = runCommand.function.outputFilter!(raw);
        assert.equal(r.toUser, raw, "用户视图恒为全文");
        assert.match(r.toModel, /已省略中间/, "超 60 行应触发截断");
        assert.match(r.toModel, /自动转后台/, "降级提示在尾部 40 行内，模型可见");
        assert.match(r.toModel, /task_id: fake-id/);
    });

    it("verifyResult：无哨兵 → SUCCESS（退出码未知契约锁）", () => {
        const out = "\n⏳ [自动转后台]：命令 [x] ...\ntask_id: abc\n";
        assert.equal(runCommand.function.verifyResult!(out, makeCtx()).status, ToolExecutionResultStatus.SUCCESS);
    });

    needShell("abort 回归：中途中止 → 哨兵 -1，不降级", async () => {
        await withAutoBg(60_000, async () => {
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 300);
            const out = await drain(runCommand.function.execute({ command: "sleep 5" }, makeCtx(SESSION, ac.signal)) as AsyncGenerator<string>);
            assert.match(out, /⟦DSC_EXIT:-1⟧/);
            assert.doesNotMatch(out, /自动转后台/);
        });
    });

    needShell("run_in_background 重构冒烟：首 yield 即 task_id，退出后 get 显示 exited", async () => {
        const ctx = makeCtx();
        const gen = runBg.function.execute({ command: "sleep 1" }, ctx) as AsyncGenerator<string>;
        const first = await gen.next();
        assert.equal(first.done, false, "首个 yield 立即返回（不挂起等退出）");
        assert.match(String(first.value), /后台任务已启动/);
        const taskId = extractTaskId(String(first.value))!;
        const rest = await drain(gen); // 挂起语义：等生命周期结束（attachTaskLifecycle resolve）
        assert.equal(rest, "", "退出后无额外产出");
        const st = (await getBg.function.execute({ task_id: taskId }, ctx)) as string;
        assert.match(st, /exited/);
    });
});
