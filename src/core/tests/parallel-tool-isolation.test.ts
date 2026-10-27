/**
 * @file tests/parallel-tool-isolation.test.ts
 * @description B 批（并行批异常隔离，方案 §2）守门测试：
 *  1. 同批 3 个工具，第 2 个 execute 抛错 → 第 1/3 结果正常，第 2 个 ok:false + 异常文案（executeTool
 *     既有失败分流）；
 *  2. 批结束后 message 中每个 tool_call_id 都有对应 tool 消息（无孤儿）；
 *  3. processToolCall 顶层包装（B 批新增）：未预期异常收敛成隔离 outcome——ok:false +「已隔离」文案 +
 *     tool.failed 埋点照发（R7）；signal.aborted 时带 aborted:true（R6 不吞 abort），调度层走 aborted 分支；
 *  4. 异常保留参数线索：大参数（>300 字符）→ calledArgs._preview 截断预览带「共 N 字符」；小参数原样保留。
 *  逃逸注入：事件通道同步抛错（旁路 trace 异常不炸工具处理）+ 畸形 toolCall——均为 wrapper 契约的
 *  确定性触发面；execute 抛错本身走 executeTool 既有 try/catch（那是设计内失败路径，不依赖本 wrapper）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-tool-isolation-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { scheduleToolCalls } = await import("@/agent/toolScheduling.ts");
const { processToolCall } = await import("@/agent/toolExecution.ts");

let sidSeq = 0;
const sid = (): string => `tool-iso-${Date.now()}-${sidSeq++}`;

/** 正常只读工具。 */
const okTool = (name: string, out: string): any => ({
    type: "function",
    function: {
        name, description: "fake safe read tool", parameters: { type: "object", properties: {} },
        safetyLevel: "safe", isSync: true,
        execute: async () => out,
    },
});

const makeCtx = (rawTools: any[], over: Record<string, any> = {}): any => ({
    sessionId: sid(), cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
    llmDecisionSource: "llm", signal: undefined, rawTools, events: async () => { },
    permissionMode: undefined, planMode: false,
    onUIEvent: undefined, requestApproval: undefined, requestQuestion: undefined, ideAction: undefined,
    keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000, parentSystemPrompt: "",
    contextTokensEst: undefined, readTracker: undefined, reportCost: undefined, toolCostSink: undefined,
    onAuxUsage: undefined, planWriteRejections: undefined, budgetCheck: undefined, batchBudgetChars: undefined,
    ...over,
});

const tc = (id: string, name: string, args = "{}"): any => ({ id, type: "function", function: { name, arguments: args } });

const harvestSchedule = async (assistantMessage: any, message: any[], ctx: any) => {
    const gen = scheduleToolCalls(assistantMessage, message, ctx);
    const yielded: any[] = [];
    let v = await gen.next();
    while (!v.done) { yielded.push(v.value); v = await gen.next(); }
    return { yielded, result: v.value };
};

describe("B 批：并行批异常隔离", () => {
    it("同批 3 工具第 2 个 execute 抛错：1/3 正常、2 ok:false + 异常文案", async () => {
        const tools = [
            okTool("iso_a", "ok-1"),
            {
                type: "function",
                function: {
                    name: "iso_boom", description: "", parameters: { type: "object", properties: {} },
                    safetyLevel: "safe", isSync: true,
                    execute: async () => { throw new Error("模拟未预期异常"); },
                },
            },
            okTool("iso_c", "ok-3"),
        ];
        const ctx = makeCtx(tools);
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const { yielded, result } = await harvestSchedule(
            { role: "assistant", content: null, tool_calls: [tc("i1", "iso_a"), tc("i2", "iso_boom"), tc("i3", "iso_c")] },
            message, ctx);
        assert.equal(result.kind, "completed", "批次不因单工具失败而中断");
        const ends = yielded.filter((e) => e.type === "tool.end");
        assert.deepEqual(ends.map((e) => e.toolCallId), ["i1", "i2", "i3"]);
        assert.equal(ends[0].ok, true);
        assert.equal(ends[0].result, "ok-1");
        assert.equal(ends[1].ok, false, "第 2 个 ok:false");
        assert.match(ends[1].result, /模拟未预期异常/, "异常文案透出");
        assert.equal(ends[2].ok, true);
        assert.equal(ends[2].result, "ok-3");
    });

    it("无孤儿：批结束后每个 tool_call_id 都有对应 tool 消息", async () => {
        const tools = [
            okTool("orphan_a", "ok-1"),
            {
                type: "function",
                function: {
                    name: "orphan_boom", description: "", parameters: { type: "object", properties: {} },
                    safetyLevel: "safe", isSync: true,
                    execute: async () => { throw new Error("boom"); },
                },
            },
            okTool("orphan_c", "ok-3"),
        ];
        const ctx = makeCtx(tools);
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const tcs = [tc("o1", "orphan_a"), tc("o2", "orphan_boom"), tc("o3", "orphan_c")];
        await harvestSchedule({ role: "assistant", content: null, tool_calls: tcs }, message, ctx);
        const toolMsgIds = message.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
        for (const t of tcs) assert.ok(toolMsgIds.includes(t.id), `tool_call ${t.id} 有配对结果（无孤儿）`);
        assert.equal(toolMsgIds.length, 3);
    });

    it("顶层包装：未预期异常收敛成隔离 outcome（ok:false + 已隔离文案 + tool.failed 埋点）", async () => {
        // 逃逸注入：事件通道同步抛错（executeTool 首行 events(tool.execute.start) 在 try 内抛出后，
        // catch 块的 events(tool.failed) 再次抛出 → 逃逸 executeTool → 命中 B 批顶层包装）
        const captured: any[] = [];
        const ctx = makeCtx([okTool("wrap_a", "ok")], {
            events: (b: any) => {
                captured.push(b);
                if (b.eventType === "tool.execute.start" || b.eventType === "tool.failed") throw new Error("注入：事件通道异常");
                return Promise.resolve();
            },
        });
        const oc = await processToolCall(tc("w1", "wrap_a"), ctx);
        assert.equal(oc.ok, false, "隔离 outcome ok:false（R7：不被模型当正常返回）");
        assert.equal(oc.toolCallId, "w1");
        assert.equal(oc.calledName, "wrap_a");
        assert.match(oc.resultForModel, /已隔离，其他工具结果不受影响/, "文案明确「已隔离」");
        assert.match(oc.resultForUser, /工具执行异常/);
        assert.equal(oc.aborted, undefined, "未中止时不误标 aborted");
        assert.ok(captured.some((e) => e.eventType === "tool.failed" && e.metadata?.ok === false), "tool.failed 埋点照发（R7）");
    });

    it("R6 不吞 abort：signal.aborted 时异常 outcome 带 aborted:true，调度层走 aborted 分支", async () => {
        // 单元侧：wrapper 契约——逃逸发生时若 signal 已中止，outcome.aborted=true
        const controller = new AbortController();
        controller.abort();
        const ctxAborted = makeCtx([okTool("wrap_aborted", "ok")], {
            signal: controller.signal,
            events: () => { throw new Error("注入：中止期间异常"); },
        });
        const oc = await processToolCall(tc("wa1", "wrap_aborted"), ctxAborted);
        assert.equal(oc.aborted, true, "不吞 abort（R6）");
        assert.equal(oc.ok, false);

        // E2E 侧：批内首个工具 execute 中止 signal，其余工具逃逸后的隔离 outcome 带 aborted → 调度层 aborted 分支
        const tools = ["ab_a", "ab_b", "ab_c"].map((n) => ({
            type: "function",
            function: {
                name: n, description: "", parameters: { type: "object", properties: {} },
                safetyLevel: "safe", isSync: true,
                execute: async () => { controller2.abort(); return `ok-${n}`; },
            },
        }));
        const controller2 = new AbortController();
        const ctx2 = makeCtx(tools, {
            signal: controller2.signal,
            events: (b: any) => {
                // executeTool catch 块内会二次调 events(tool.failed)——两处都抛才能逃逸到 B 批 wrapper，
                // outcome 才带 aborted:true（只抛 tool.execute.end 会被 catch 的 failResult 优雅收掉）
                if (b.eventType === "tool.execute.end" || b.eventType === "tool.failed") throw new Error("注入：事件通道异常");
                return Promise.resolve();
            },
        });
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const { result } = await harvestSchedule(
            { role: "assistant", content: null, tool_calls: [tc("ab1", "ab_a"), tc("ab2", "ab_b"), tc("ab3", "ab_c")] },
            message, ctx2);
        assert.equal(result.kind, "aborted", "调度层走 aborted 分支（不被当成普通失败吞掉）");
    });

    it("异常保留参数线索：大参数截断预览带「共 N 字符」，小参数原样保留", async () => {
        const throwEvents = (): any => makeCtx([okTool("p_a", "ok")], { events: () => { throw new Error("注入"); } });
        // 大参数（>300 字符原始 arguments 串）
        const bigArgs = JSON.stringify({ path: "a".repeat(400) });
        assert.ok(bigArgs.length > 300);
        const big = await processToolCall(tc("p1", "p_a", bigArgs), throwEvents());
        assert.equal(big.calledName, "p_a");
        const preview = big.calledArgs?._preview;
        assert.equal(typeof preview, "string");
        assert.ok(preview.length < bigArgs.length, "预览短于原文");
        assert.ok(preview.startsWith(bigArgs.slice(0, 300)), "预览=前 300 字符");
        assert.match(preview, /…（共 \d+ 字符）$/, "带「共 N 字符」标记");
        assert.ok(preview.includes(`共 ${bigArgs.length} 字符`), "N=原始长度");
        // 小参数原样保留
        const smallArgs = '{"path":"a.ts"}';
        const small = await processToolCall(tc("p2", "p_a", smallArgs), throwEvents());
        assert.equal(small.calledArgs?._preview, smallArgs, "小参数原样保留");
        // 畸形 toolCall（null）不炸 wrapper：降级 unknown 占位
        const malformed = await processToolCall(null, throwEvents());
        assert.equal(malformed.ok, false);
        assert.equal(malformed.toolCallId, "");
        assert.equal(malformed.calledName, "unknown");
    });
});
