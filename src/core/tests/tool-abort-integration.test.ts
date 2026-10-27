/**
 * @file tests/tool-abort-integration.test.ts
 * @description 中止链路集成守门（用户实测：VSCode 端点 ■ 终止无效，run_command 永远转圈）：
 *  贯穿 scheduleToolCalls → processToolCall → run_command（真 spawn）的中途 abort。
 *
 *  根因（2026-10-27 法医定位）：spawn 的 signal 选项（Node 内部监听）先于工具自注册的
 *  onAbort→killTree 触发——TerminateProcess 只杀最外层进程，killTree 的 taskkill /T 对已死根
 *  「找不到进程」直接失败，孙进程（tsx 的 esbuild、node --test 的每文件子进程）全部存活并持有
 *  继承的 stdout 管道 → close 永不触发 → 工具永不结束。修法：spawn 不再传 signal，abort 唯一
 *  走 onAbort→killTree（根活着时 taskkill /T 能整树剿灭）。
 *
 *  两层用例：
 *  - 单进程命令（sleep）：回归基线（新旧代码都须过）。
 *  - tsx 多层进程树（bash → node(tsx) → esbuild）：生产挂死形状。判别力 best-effort——旧代码结局
 *    取决于 bash 是否 exec 优化掉外层（exec 则 job-object 击杀连带全树、不 exec 则孤儿攥管道挂死），
 *    非确定；挂死分支由 20s timeout 兜底失败。修复后两形状恒快速收尾。
 *
 *  ★ 涉及 transcript 落盘（appendMessage），沿用 kernel-audit-secondbatch 惯例：
 *    env 沙盒先就位，再动态 import（防 config/store 加载期读真实 ~/.deepseeker-code）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-abort-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { scheduleToolCalls } = await import("@/agent/toolScheduling.ts");
const { commandTools } = await import("@/tool/registry/command.ts");
const { resolveWinShell } = await import("@/tool/registry/background.ts");

const runCommand = commandTools.find((t: any) => t.function.name === "run_command")!;

/** 收割 scheduleToolCalls 的 yield 事件与 return value */
const harvestSchedule = async (assistantMessage: any, message: any[], ctx: any) => {
    const gen = scheduleToolCalls(assistantMessage, message, ctx);
    const events: any[] = [];
    let res = await gen.next();
    while (!res.done) { events.push(res.value); res = await gen.next(); }
    return { events, result: res.value };
};

const makeCtx = (signal: AbortSignal | undefined): any => ({
    sessionId: `abort-it-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    cwd: SANDBOX,
    depth: 0,
    round: 1,
    startTime: performance.now(),
    llmDecisionSource: "llm",
    signal,
    rawTools: [runCommand],
    events: async () => { },
    permissionMode: undefined,
    planMode: false,
    onUIEvent: undefined,
    requestApproval: (async () => true) as any, // 审批放行（免 LLM 分类器/人工）
    requestQuestion: undefined,
    ideAction: undefined,
    keepRecentUnits: 5,
    compactRatio: 0.72,
    modelWindow: 250000,
    parentSystemPrompt: "SYS",
    contextTokensEst: undefined,
    readTracker: undefined,
    reportCost: undefined,
    toolCostSink: undefined,
    onAuxUsage: undefined,
    planWriteRejections: undefined,
    budgetCheck: undefined,
    batchBudgetChars: undefined,
});

/** abort 在 delayMs 后触发；断言工具提前结束（≪命令时长）+ 调度层 aborted + 失败哨兵回填 */
const abortMidFlight = async (command: string, delayMs: number, commandSeconds: number) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), delayMs);
    const assistantMessage = {
        tool_calls: [{
            id: "tc-abort", type: "function",
            function: { name: "run_command", arguments: JSON.stringify({ command }) },
        }],
    };
    const message: any[] = [];
    const t0 = Date.now();
    const { events, result } = await harvestSchedule(assistantMessage, message, makeCtx(ac.signal));
    const dt = Date.now() - t0;

    assert.ok(dt < commandSeconds * 1000 - 3000, `应在命令时长内提前结束（实耗 ${dt}ms——终止未生效，进程/管道未断）`);
    const end = events.find((e) => e.type === "tool.end") as any;
    assert.ok(end, "应发出 tool.end");
    assert.equal(end.ok, false, "被中止的工具应按失败收尾");
    const toolMsg = message.find((m) => m.role === "tool") as any;
    assert.ok(toolMsg, "tool 结果应回填 message");
    // ★ 中止归一契约锁（command.ts abortedByUser）：killTree 杀灭的原始 close 码非确定（Win taskkill→1 等），
    //   但中止收尾恒归一 ⟦DSC_EXIT:-1⟧——与「命令自己失败退出 1」可区分（background-degrade abort 回归同锁此值）
    const content = String(toolMsg.content);
    assert.match(content, /⟦DSC_EXIT:-1⟧/, `tool 结果应为中止归一哨兵 -1，实为：${content.slice(0, 200)}`);
    assert.doesNotMatch(content, /⟦DSC_EXIT:0⟧/, "被中止不得伪造成功退出（exit 0）");
    return dt;
};

describe("中止链路集成（调度层 → run_command）", () => {
    it("单进程命令中途 abort → 提前结束（回归基线）", { skip: process.platform === "win32" && !resolveWinShell() ? "win32 无 Git Bash，跳过" : false }, async () => {
        const dt = await abortMidFlight("sleep 8", 800, 8);
        console.log(`    [single-proc] finished in ${dt}ms`);
    });

    it("tsx 多层进程树中途 abort → 整树剿灭、管道断开、提前结束", { timeout: 20_000, skip: process.platform === "win32" && !resolveWinShell() ? "win32 无 Git Bash，跳过" : false }, async () => {
        // 生产形态（用户实测挂死的形状）：bash → node(tsx) → esbuild service——多层进程树。
        // 旧代码（spawn 带 signal）只杀最外层、killTree 对已死根 taskkill 失败，esbuild/子进程
        // 存活攥住继承的 stdout 管道 → close 永不触发 → 本用例在旧代码下挂到 timeout。
        // tsx 须从仓库根解析（工具 cwd = 工作区根），用后恢复沙盒根。
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
        const savedRoot = process.env.WORKSPACE_ROOT;
        process.env.WORKSPACE_ROOT = repoRoot;
        try {
            const dt = await abortMidFlight(`node --import tsx -e "console.log('up'); setInterval(()=>{}, 1<<30)"`, 800, 20);
            console.log(`    [tsx-tree] finished in ${dt}ms`);
        } finally {
            process.env.WORKSPACE_ROOT = savedRoot;
        }
    });
});
