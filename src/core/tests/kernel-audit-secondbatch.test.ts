/**
 * @file tests/kernel-audit-secondbatch.test.ts
 * @description 内核审查报告（.ai-docs/Agent内核审查报告.md）第二批修复守门（2026-10-20）：
 *  - P1-4  窗口/校准按模型维度（resolveModelWindow + getCalibration per-model 分键、扁平兜底、镜像回写）
 *  - P1-5  子 agent 增量上报预算（costRelay 只报正增量 + budgetCheck 链式贯通 + runAgent 三 flush 点；
 *          第五轮复核收尾：轮边界消费点行为断言 + flush 基数=budgetSpentYuan 子树完整口径）
 *  - P1-7  计划拒绝熔断（非 SAFE 拒绝计数，2 次转向 nudge / 4 次强制收尾）
 *  - P1-6  声明化收尾（terminal/parallelizable/argKind/subagentAllowed/batchAllowed 五声明字段，
 *          四处按名特判退役为「声明优先 / 名单兜底」；验收场景：新增声明 terminal 的测试工具不改名单即终结并串行）
 *
 *  约定：本文件涉及 transcript 落盘（scheduleToolCalls E2E）与 store 读写，**静态 import 会先于
 *  模块体执行**（env 未及设置即用真实 ~/.deepseeker-code）——故一律在 env 沙盒就位后动态 import
 *  （tool-declaration-drift.test.ts 同法）；node 内建模块可静态导入。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-audit2-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(CORE_ROOT, rel), "utf-8");

// —— 被测模块（env 就位后动态加载）——
const { appConfig, MODEL_WINDOWS, resolveModelWindow } = await import("@/config/index.ts");
const { createNudgeScheduler, PLAN_REJECT_NUDGE_AT, PLAN_REJECT_FORCE_AT, PLAN_REJECT_FORCE_FINAL_TEXT } = await import("@/agent/agentNudges.ts");
const { createCostRelay } = await import("@/agent/costRelay.ts");
const { exitPlanModeToolSchema, enterPlanModeToolSchema } = await import("@/agent/planMode.ts");
const { scheduleToolCalls } = await import("@/agent/toolScheduling.ts");
const { getRollingState, getCalibration, updateCalibration, writeStore } = await import("@/session/store.ts");
// ★ P1-5 收尾行为断言所需（replay.test.ts 同惯例：@/ 别名同 specifier → 同一模块实例）
const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { runAgent } = await import("@/agent/runAgent.ts");
const { readTranscriptLines } = await import("@/session/transcript.ts");

let sidSeq = 0;
const sid = (): string => `audit2-${Date.now()}-${sidSeq++}`;

/** 挂载回放 provider 执行 fn，结束复位（防泄漏影响其它测试）。返回 provider 句柄供断言。（replay.test.ts 同款） */
const withReplay = async <T>(script: any, fn: (p: any) => Promise<T>): Promise<{ handle: any; ret: T }> => {
    const p = createReplayProvider(script);
    setActiveProvider(p);
    try {
        const ret = await fn(p);
        return { handle: p, ret };
    } finally {
        resetActiveProvider();
    }
};

/** 收割 scheduleToolCalls 的 yield 事件与 return value（for-await 取不到 generator return value）。 */
const harvestSchedule = async (assistantMessage: any, message: any[], ctx: any) => {
    const gen = scheduleToolCalls(assistantMessage, message, ctx);
    const events: any[] = [];
    let res = await gen.next();
    while (!res.done) { events.push(res.value); res = await gen.next(); }
    return { events, result: res.value };
};

/** E2E 工具表夹具：SAFE 只读假工具（execute 可计数），按需附加 P1-6 声明字段。 */
const makeFakeTools = (calls: string[], extra: Record<string, any> = {}) => [
    {
        type: "function",
        function: {
            name: "fake_read_tool",
            description: "fake safe read",
            parameters: { type: "object", properties: {} },
            safetyLevel: "safe",
            isSync: true,
            execute: async () => { calls.push("fake_read_tool"); return "read-ok"; },
            ...extra,
        },
    },
    {
        type: "function",
        function: {
            name: "fake_second_tool",
            description: "fake safe read 2",
            parameters: { type: "object", properties: {} },
            safetyLevel: "safe",
            isSync: true,
            execute: async () => { calls.push("fake_second_tool"); return "second-ok"; },
        },
    },
] as any[];

/** scheduleToolCalls 的 ToolCallContext 夹具（events 为 no-op trace；沙盒 dataDir 承接落盘）。 */
const makeScheduleCtx = (rawTools: any[]): any => ({
    sessionId: sid(),
    cwd: SANDBOX,
    depth: 0,
    round: 1,
    startTime: performance.now(),
    llmDecisionSource: "llm",
    rawTools,
    events: async () => { },
    keepRecentUnits: 5,
    compactRatio: 0.72,
    modelWindow: 250000,
    parentSystemPrompt: "SYS",
});

const tc = (id: string, name: string): any =>
    ({ id, type: "function", function: { name, arguments: "{}" } });

describe("内核审查报告第二批守门", () => {
    // ==================== P1-4 ====================
    describe("P1-4 窗口/校准按模型维度", () => {
        it("resolveModelWindow：表内命中按模型、表外/未传回退全局 MAX_HISTORY_TOKENS", () => {
            MODEL_WINDOWS["audit2-window-32k"] = 32000;
            try {
                assert.equal(resolveModelWindow("audit2-window-32k"), 32000);
                assert.equal(resolveModelWindow("  audit2-window-32k  "), 32000, "模型 id trim 后命中");
                assert.equal(resolveModelWindow("some-unknown-model"), appConfig.MAX_HISTORY_TOKENS);
                assert.equal(resolveModelWindow(undefined), appConfig.MAX_HISTORY_TOKENS);
                assert.equal(resolveModelWindow("   "), appConfig.MAX_HISTORY_TOKENS, "纯空白视同未传");
            } finally {
                delete MODEL_WINDOWS["audit2-window-32k"];
            }
            assert.equal(resolveModelWindow("audit2-window-32k"), appConfig.MAX_HISTORY_TOKENS, "清表后回退（测试自清理）");
        });

        it("校准按模型分键：同会话两模型互不污染；扁平字段镜像=最近写入模型", async () => {
            const s = sid();
            await updateCalibration(s, "model-a", { calibRatio: 1.2 });
            await updateCalibration(s, "model-b", { calibRatio: 2.5, lastRealPromptTokens: 100 });
            const a = await getCalibration(s, "model-a");
            const b = await getCalibration(s, "model-b");
            assert.equal(a.calibRatio, 1.2, "model-a 校准不被 model-b 覆盖");
            assert.equal(b.calibRatio, 2.5, "model-b 校准独立");
            assert.equal(b.lastRealPromptTokens, 100);
            const flat = await getRollingState(s);
            assert.equal(flat.calibRatio, 2.5, "旧扁平镜像字段=最近写入模型（fork 透传语义不变）");
            const noModel = await getCalibration(s);
            assert.equal(noModel.calibRatio, 2.5, "缺省 modelId = 扁平视图");
        });

        it("旧会话兼容：盘上扁平字段（P1-4 前形状）被任意新模型读作兜底；升级写入后 per-model 与扁平并存", async () => {
            const s = sid();
            await writeStore(s, { calibRatio: 1.9, lastCachedTokens: 7 } as any);
            const legacy = await getCalibration(s, "brand-new-model");
            assert.equal(legacy.calibRatio, 1.9, "per-model 未命中 → 扁平兜底（旧数据不丢）");
            assert.equal(legacy.lastCachedTokens, 7);
            await updateCalibration(s, "model-a", { calibRatio: 1.1 });
            assert.equal((await getCalibration(s, "model-a")).calibRatio, 1.1);
            assert.equal((await getCalibration(s, "model-b")).calibRatio, 1.1,
                "其他模型 per-model 未命中 → 回退扁平镜像（语义=最近写入模型的观测，兜底不丢校准）");
        });

        it("三处主链路接入（结构扫描）：chatProcessing 主链 / compactSessionNow 手动压缩 / 子 agent manifest.model", () => {
            assert.match(readRepo("src/serve/chatProcessing.ts"), /modelWindow: resolveModelWindow\(opts\?\.model\)/);
            const tr = readRepo("src/agent/truncate.ts");
            assert.match(tr, /getCalibration\(opts\.sessionId, MODEL_NAME\)/);
            assert.match(tr, /modelWindow: resolveModelWindow\(MODEL_NAME\)/);
            assert.match(readRepo("src/agent/subagent.ts"), /resolveModelWindow\(manifest\.model\)/);
        });
    });

    // ==================== P1-5 ====================
    describe("P1-5 子 agent 增量上报预算", () => {
        it("costRelay：只报正增量、幂等、负回退不报、非有限数与亚舍位噪声不报", () => {
            const sinked: number[] = [];
            const relay = createCostRelay((y) => sinked.push(y));
            assert.equal(relay.reported, 0);
            relay.flush(0.5);
            assert.deepEqual(sinked, [0.5]);
            relay.flush(0.5);
            assert.deepEqual(sinked, [0.5], "同总额重复 flush 幂等零副作用");
            relay.flush(0.4);
            assert.deepEqual(sinked, [0.5], "总额回退不报负增量");
            relay.flush(Number.NaN);
            relay.flush(Number.POSITIVE_INFINITY);
            assert.deepEqual(sinked, [0.5], "非有限数不报");
            relay.flush(0.5 + 1e-9);
            assert.deepEqual(sinked, [0.5], "六位小数舍入归零的浮点噪声不报");
            relay.flush(0.75);
            assert.deepEqual(sinked, [0.5, 0.25], "只报正增量 0.25");
            assert.equal(relay.reported, 0.75);
            const noSink = createCostRelay(undefined);
            assert.doesNotThrow(() => noSink.flush(5), "主 run（无 sink）flush 为 no-op 不抛");
            assert.equal(noSink.reported, 0);
        });

        it("budgetCheck 链式贯通（结构扫描）：runAgent 自武装 → toolCallCtx → subagent subOptions 三环缺一不可", () => {
            const ra = readRepo("src/agent/runAgent.ts");
            assert.match(readRepo("src/agent/type.ts"), /budgetCheck\?: \(\) => boolean/, "RunAgentOptions 须声明 budgetCheck");
            assert.match(ra, /const inheritedBudgetCheck = options\.budgetCheck/, "主 run 自武装（已有注入优先）");
            assert.match(ra, /budgetCheck: inheritedBudgetCheck/, "toolCallCtx 须注入 budgetCheck（runSubagent 经 toolCtx 拿闭包）");
            const flushCount = (ra.match(/costRelay\.flush\(budgetSpentYuan\)/g) ?? []).length;
            assert.ok(flushCount >= 3, `round.end×2 + finally 共 3 处增量 flush，实得 ${flushCount}`);
            assert.ok(!/costRelay\.flush\(spentTotal/.test(ra),
                "flush 基数须为 budgetSpentYuan（子树完整口径）——自身三账会把 depth≥2 孙代花费困在中继层以下");
            assert.match(ra, /depth > 0 && options\.budgetCheck\?\.\(\)/,
                "轮边界消费点须存在且显式限定子 run（主 run 预算截断文案专属路径不受影响）");
            const sub = readRepo("src/agent/subagent.ts");
            assert.match(sub, /budgetCheck: ctx\.budgetCheck/, "subOptions 须透传父探测闭包给子 runAgent");
            const wf = readRepo("src/tool/registry/workflow.ts");
            assert.match(wf, /\{ \.\.\.ctx,/, "run_workflow subCtx 用 spread 继承 ctx（budgetCheck 自动贯通）");
        });

        it("P1-5 行为断言（第五轮复核盲区）：子 run 轮边界 budgetCheck 命中 → stopReason='limit' 提前收尾，不再全额烧完", async () => {
            const sid2 = `audit2-budget-${Date.now()}`;
            let checks = 0;
            const { handle, ret } = await withReplay({
                turns: [
                    { kind: 'reply' as const, content: null, toolCalls: [{ name: 'fake_read_tool', args: {} }] },
                    { kind: 'reply' as const, content: '不该被产出的第二轮推理' },
                ],
            }, async (p) => {
                const message: any[] = [
                    { role: 'system', content: 'audit2 行为断言用' },
                    { role: 'user', content: '子任务：读一下' },
                ];
                const events: any[] = [];
                for await (const ev of runAgent(message, {
                    sessionId: sid2, cwd: SANDBOX, events: (async () => { }) as any,
                    toolSchemas: makeFakeTools([]), modelWindow: 250000,
                    keepRecentUnits: 5, compactRatio: 0.72, parentSystemPrompt: '',
                    depth: 1, noEarlyFinal: true, // 与 runSubagent 真实 subOptions 同形
                    budgetCheck: () => ++checks > 1, // 第 1 轮边界放行、第 2 轮边界熔断
                })) events.push(ev);
                return { events, lines: await readTranscriptLines(sid2), calls: p.calls };
            });
            assert.equal(handle.calls.length, 1, "第 2 轮推理不得发生（轮边界即熔断，不再烧下一轮全上下文）");
            const finals = ret.events.filter((e: any) => e.type === 'final');
            assert.equal(finals.length, 1, "恰好一个 final（收尾干净，非静默卡死）");
            assert.match(finals[0].text, /预算中止/, "final 须带预算熔断文案（随工具结果回传父模型）");
            const runEnd = (ret.lines as any[]).find((l: any) => l.dscEvent === 'run.end');
            assert.equal(runEnd?.stopReason, 'limit', "run.end 落盘 stopReason='limit'");
            assert.equal(ret.lines.filter((l: any) => l.dscEvent === 'round.end').length, 1, "第 1 轮完整闭合（round.end 已写后才熔断）");
        });

        it("P1-5 行为断言：主 run（depth=0）不受 budgetCheck 影响（即便误传恒真闭包也不截断）", async () => {
            const sid2 = `audit2-mainrun-${Date.now()}`;
            const { handle, ret } = await withReplay({
                turns: [{ kind: 'reply' as const, content: '已完成：主 run 正常收尾，未受 budgetCheck 影响。' }],
            }, async (p) => {
                const message: any[] = [
                    { role: 'system', content: 'audit2 行为断言用' },
                    { role: 'user', content: '正常回答即可' },
                ];
                const events: any[] = [];
                for await (const ev of runAgent(message, {
                    sessionId: sid2, cwd: SANDBOX, events: (async () => { }) as any,
                    toolSchemas: makeFakeTools([]), modelWindow: 250000,
                    keepRecentUnits: 5, compactRatio: 0.72, parentSystemPrompt: '',
                    depth: 0,
                    budgetCheck: () => true, // 误传恒真——主 run 消费点有 depth>0 门禁，不得被截断
                })) events.push(ev);
                return { events, calls: p.calls };
            });
            assert.equal(handle.calls.length, 1, "正常完成唯一一轮推理");
            const finals = ret.events.filter((e: any) => e.type === 'final');
            assert.equal(finals.length, 1);
            assert.doesNotMatch(finals[0].text, /预算/, "主 run final 不带预算文案（预算截断走 depth=0 专属路径）");
        });
    });

    // ==================== P1-7 ====================
    describe("P1-7 计划拒绝熔断", () => {
        it("阈值常量：NUDGE_AT=2 / FORCE_AT=4；强制收尾文案可用", () => {
            assert.equal(PLAN_REJECT_NUDGE_AT, 2);
            assert.equal(PLAN_REJECT_FORCE_AT, 4);
            const text = PLAN_REJECT_FORCE_FINAL_TEXT(4);
            assert.match(text, /中止/);
            assert.match(text, /4/);
        });

        it("调度语义：第 1 次不推；达 NUDGE_AT 发一次转向 nudge（不重复发）；getter 记累计值", () => {
            const nudges = createNudgeScheduler({ planMode: true });
            assert.equal(nudges.planWriteRejections(), 0);
            nudges.notePlanWriteRejected(1);
            assert.equal(nudges.pickNudge(2), null, "未达阈值不推");
            nudges.notePlanWriteRejected(2);
            assert.equal(nudges.planWriteRejections(), 2);
            const m = nudges.pickNudge(2);
            assert.ok(m, "达 NUDGE_AT 须发转向 nudge");
            assert.match(String(m?.content ?? ""), /⟦DSC:PLAN_REJECT⟧/);
            assert.match(String(m?.content ?? ""), /exit_plan_mode/);
            assert.equal(nudges.pickNudge(3), null, "nudge 一次性消费");
            nudges.notePlanWriteRejected(5);
            assert.equal(nudges.pickNudge(4), null, "转向 nudge 每 run 至多一次（不重复念经）");
        });

        it("计数与熔断执行（结构扫描）：只计非 SAFE 拒绝；FORCE_AT 轮边界强制收尾", () => {
            const te = readRepo("src/agent/toolExecution.ts");
            assert.match(te, /safetyLevel !== ToolSafetyLevel\.SAFE\) planWriteRejections\?\.\(1\)/,
                "只计非 SAFE 工具的拒绝（ask_question 等交互类被拒不计）");
            const ra = readRepo("src/agent/runAgent.ts");
            assert.match(ra, /planWriteRejections: \(delta: number\)/, "toolCallCtx 须接增量回调（计数+通知调度器）");
            assert.match(ra, /options\.planMode && planWriteRej >= PLAN_REJECT_FORCE_AT/, "轮边界强制收尾判定");
            assert.match(ra, /stopReason = 'limit';[\s\S]{0,200}PLAN_REJECT_FORCE_FINAL_TEXT/, "强制收尾走 stopReason='limit'");
        });
    });

    // ==================== P1-6 ====================
    describe("P1-6 声明化收尾", () => {
        it("plan 控制工具带终结声明：exit=plan_exit / enter=plan_enter", () => {
            assert.equal((exitPlanModeToolSchema.function as any).terminal, "plan_exit");
            assert.equal((enterPlanModeToolSchema.function as any).terminal, "plan_enter");
        });

        it("四处按名特判退役（结构扫描）：调度/执行层改读声明，名单仅存兜底", () => {
            const sched = readRepo("src/agent/toolScheduling.ts");
            assert.ok(!/if \(name === ['"]exit_plan_mode['"] \|\| name === ['"]enter_plan_mode['"]\)/.test(sched),
                "canParallelize 不得再按名排除终结类");
            assert.match(sched, /matched\.function\.terminal\)/, "终结类串行改读 terminal 声明");
            assert.match(sched, /parallelizable === false/, "显式否决并行的声明须被消费");
            const exec = readRepo("src/agent/toolExecution.ts");
            assert.match(exec, /terminal: \{ kind: 'generic' \}/, "generic 终结 outcome 须由执行层产出");
            assert.match(sched, /kind === 'enter_plan_mode'[\s\S]{0,400}else \{/, "调度层 generic 终结分支须存在");
            assert.match(exec, /declaredTerminal === 'plan_exit' \|\| \(!declaredTerminal && calledName === "exit_plan_mode"\)/,
                "声明优先、按名退化为未声明者兜底");
            assert.match(exec, /declaredTerminal === true/, "generic 终结声明在执行出口消费");
            assert.match(exec, /matchedTool\.function\.argKind === 'command'/, "命令语义改读 argKind 声明");
            assert.ok(!/calledName === 'run_command' \|\| calledName === 'run_in_background'/.test(exec),
                "命令三处按名判定须退役");
            const sub = readRepo("src/agent/subagent.ts");
            assert.match(sub, /subagentAllowed !== false/, "子 agent 收权改读声明（名单兜底）");
        });

        it("registry 声明落位（结构扫描）：命令类 argKind/收权声明、ask parallelizable:false", () => {
            const cmd = readRepo("src/tool/registry/command.ts");
            assert.match(cmd, /argKind: 'command'/);
            assert.match(cmd, /subagentAllowed: false/);
            assert.match(cmd, /batchAllowed: false/);
            const bg = readRepo("src/tool/registry/background.ts");
            assert.match(bg, /argKind: 'command'/);
            assert.match(bg, /subagentAllowed: false/);
            const fsr = readRepo("src/tool/registry/fs.ts");
            assert.match(fsr, /subagentAllowed: false/, "delete_path 须声明收权");
            const ask = readRepo("src/tool/registry/ask.ts");
            assert.match(ask, /parallelizable: false/, "ask_question 须显式否决并行");
            const batch = readRepo("../cli/src/batchRunner.ts");
            assert.match(batch, /batchAllowed !== false/, "挂机过滤改读声明（名单兜底）");
        });

        it("验收场景：新增 terminal:true 声明的测试工具（不改任何名单）→ 结果只给用户、终结本轮、其后并行调用补占位不执行", async () => {
            const calls: string[] = [];
            const termTool: any = {
                type: "function",
                function: {
                    name: "fake_term_tool",
                    description: "declared terminal, not in any list",
                    parameters: { type: "object", properties: {} },
                    safetyLevel: "safe",
                    isSync: true,
                    execute: async () => { calls.push("fake_term_tool"); return "TERMINAL-RESULT"; },
                },
            };
            termTool.function.terminal = true; // 唯一声明：terminal（验收点）
            const tools = [termTool, ...makeFakeTools(calls)];
            const ctx = makeScheduleCtx(tools);
            const message: any[] = [];
            const { events, result } = await harvestSchedule(
                { role: "assistant", content: "", tool_calls: [tc("t1", "fake_term_tool"), tc("t2", "fake_read_tool")] },
                message, ctx,
            );
            assert.deepEqual(calls, ["fake_term_tool"], "后续工具不得执行");
            assert.equal(result.kind, "terminal");
            assert.equal((result as any).terminalText, "TERMINAL-RESULT", "终结文本=工具结果（给用户不再回喂模型）");
            const skipped = message.find((m) => m.role === "tool" && m.tool_call_id === "t2");
            assert.match(String(skipped?.content ?? ""), /已跳过/, "其后调用补占位（防孤儿 tool_call_id）");
            assert.ok(events.some((e) => e.type === "tool.end" && e.toolCallId === "t1"), "终结工具照发 tool.end（前端卡片不滞留）");
        });

        it("验收场景：parallelizable:false 声明（不改名单）→ 强制串行；两 SAFE 未声明工具仍自动并行", async () => {
            // 并行：连续 SAFE 未声明 → start,start,end,end
            const callsP: string[] = [];
            const ctxP = makeScheduleCtx(makeFakeTools(callsP));
            const { events: evP, result: resP } = await harvestSchedule(
                { role: "assistant", content: "", tool_calls: [tc("p1", "fake_read_tool"), tc("p2", "fake_second_tool")] },
                [], ctxP,
            );
            assert.equal(resP.kind, "completed");
            assert.deepEqual(evP.map((e) => e.type), ["tool.start", "tool.start", "tool.end", "tool.end"], "未声明 SAFE 工具自动并行");
            // 串行：第二个工具声明 parallelizable:false → start,end,start,end
            const callsS: string[] = [];
            const tools = makeFakeTools(callsS);
            tools[1].function.parallelizable = false; // 唯一声明：否决并行（验收点）
            const ctxS = makeScheduleCtx(tools);
            const { events: evS } = await harvestSchedule(
                { role: "assistant", content: "", tool_calls: [tc("s1", "fake_read_tool"), tc("s2", "fake_second_tool")] },
                [], ctxS,
            );
            assert.deepEqual(evS.map((e) => e.type), ["tool.start", "tool.end", "tool.start", "tool.end"], "显式否决并行 → 强制串行");
        });
    });
});
