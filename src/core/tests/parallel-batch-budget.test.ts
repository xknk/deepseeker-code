/**
 * @file tests/parallel-batch-budget.test.ts
 * @description A 批（并行批批级上下文预算，方案 §1）守门测试：
 *  1. 单工具不变：batch.length===1 → 不设批级上限，结果与改前逐字节一致（R2 字符级比对）；
 *  2. 分摊正确：computeBatchBudget 纯函数 + E2E 每工具收到 floor(batchCap/N)；
 *  3. 窗口将满收敛：剩余窗口 →0 时批上限收敛到 BATCH_MIN_CHARS；
 *  4. 侧车顺序红线（R3/P2-1）：批预算生效截断时侧车仍是「脱敏后、截断前」的原文（recall with_full 可取回）；
 *  5. 去重不占预算：同签名重复调用只按去重后数量分摊、复用结果不重复执行；
 *  6. 校准埋点：tool.batch.budget 事件字段齐全（§1.4-6，§9 密度校准数据源）；
 *  7. R4：并发批下发用浅拷贝，原 ctx 不被写入 batchBudgetChars。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-batch-budget-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { scheduleToolCalls, computeBatchBudget, BATCH_MIN_CHARS, CHAR_PER_TOKEN, BATCH_WINDOW_SHARE }
    = await import("@/agent/toolScheduling.ts");
const { recallTools } = await import("@/tool/registry/recall.ts");

let sidSeq = 0;
const sid = (): string => `batch-budget-${Date.now()}-${sidSeq++}`;

/** 事件收集器：除捕获 trace 埋点外无行为（不抛错、不拦截）。 */
const makeEventSink = (): { events: any; captured: any[] } => {
    const captured: any[] = [];
    return { events: (b: any) => { captured.push(b); return Promise.resolve(); }, captured };
};

/** 假只读工具：返回定长 'x' 串；可声明 maxOutputCharacters；计数执行次数。 */
const probeTool = (name: string, outChars: number, opts: { maxOutput?: number } = {}): any => ({
    type: "function",
    function: {
        name,
        description: "fake safe read tool（A 批预算守门）",
        parameters: { type: "object", properties: {} },
        safetyLevel: "safe",
        isSync: true,
        ...(opts.maxOutput !== undefined ? { maxOutputCharacters: opts.maxOutput } : {}),
        execute: async () => "x".repeat(outChars),
    },
});

/** ToolCallContext 夹具（字段与 runAgent 构造处一一对应；contextTokensEst 按用例覆盖）。 */
const makeCtx = (rawTools: any[], over: Record<string, any> = {}): any => {
    const sink = makeEventSink();
    return {
        sink, captured: sink.captured,
        sessionId: sid(), cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
        llmDecisionSource: "llm", signal: undefined, rawTools, events: sink.events,
        permissionMode: undefined, planMode: false,
        onUIEvent: undefined, requestApproval: undefined, requestQuestion: undefined, ideAction: undefined,
        keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000, parentSystemPrompt: "",
        contextTokensEst: undefined, readTracker: undefined, reportCost: undefined, toolCostSink: undefined,
        onAuxUsage: undefined, planWriteRejections: undefined, budgetCheck: undefined, batchBudgetChars: undefined,
        ...over,
    };
};

const tc = (id: string, name: string, args = "{}"): any => ({ id, type: "function", function: { name, arguments: args } });

/** 收割 scheduleToolCalls 的 yield 事件与 return value（for-await 取不到 generator return value）。 */
const harvestSchedule = async (assistantMessage: any, message: any[], ctx: any) => {
    const gen = scheduleToolCalls(assistantMessage, message, ctx);
    const yielded: any[] = [];
    let v = await gen.next();
    while (!v.done) { yielded.push(v.value); v = await gen.next(); }
    return { yielded, result: v.value };
};

/** 截断视图断言：truncateToolResult 是头尾对半形态——head=前 floor(budget/2) 个 x，tail=后同长 x，中间无 x。 */
const assertHalfSplit = (content: string, budget: number): void => {
    const half = Math.floor(budget / 2);
    assert.equal(content.slice(0, half), "x".repeat(half), `头部应保留前 ${half} 字符`);
    assert.equal(content.slice(-half), "x".repeat(half), `尾部应保留后 ${half} 字符`);
    assert.ok(!content.slice(half, -half).includes("x"), "中间应为省略标记（无原文残留）");
    assert.match(content, /已省略中间/, "应带截断标记行");
};

/** 通过 recall with_full 取回侧车存档（分页拼接全文）。 */
const recallFull = async (sessionId: string, callId: string): Promise<string> => {
    const recall = recallTools.find((t: any) => t.function.name === "recall")!;
    let out = "";
    let off = 0;
    for (; ;) {
        const r: any = await recall.function.execute({ with_full: callId, full_offset: off }, { sessionId } as any);
        const text = typeof r === "string" ? r : String(r?.content ?? r);
        out += text;
        const m = text.match(/full_offset=(\d+) 取下一段/);
        if (!m) break;
        off = Number(m[1]);
    }
    return out;
};

describe("A 批：并行批批级上下文预算", () => {
    it("纯函数 computeBatchBudget：分摊/保底/收敛三形态", () => {
        // 常规：250K 窗 × 0.72 阈值 = 180K；批前 0 → 剩余 180K token → 批上限 180K×4×0.5 = 360K 字符
        const normal = computeBatchBudget(250000, 0.72, 0, 5);
        assert.equal(normal.batchCapChars, 360000);
        assert.equal(normal.perToolCapChars, 72000);
        assert.ok(normal.batchCapChars >= BATCH_MIN_CHARS);
        // 窗口将满：剩余 →0 → 收敛到 BATCH_MIN_CHARS 保底（12K），不把结果压成碎片
        const full = computeBatchBudget(250000, 0.72, 180000, 5);
        assert.equal(full.batchCapChars, BATCH_MIN_CHARS);
        assert.equal(full.perToolCapChars, Math.floor(BATCH_MIN_CHARS / 5));
        // 已越阈（estimate 超阈值）：同样保底（Math.max(0, 负数) → 0）
        const over = computeBatchBudget(250000, 0.72, 200000, 2);
        assert.equal(over.batchCapChars, BATCH_MIN_CHARS);
        // 估算缺省：按 0 处理
        assert.equal(computeBatchBudget(250000, 0.72, undefined, 2).batchCapChars, 360000);
        // 常量冻结（§1.2 拍定值，改值须过 §9 校准闭环）
        assert.equal(BATCH_MIN_CHARS, 12000);
        assert.equal(BATCH_WINDOW_SHARE, 0.5);
        assert.equal(CHAR_PER_TOKEN, 4);
    });

    it("单工具不变：batch.length===1 不设批级上限，结果与改前逐字节一致（R2）", async () => {
        const tool = probeTool("solo_tool", 50000, { maxOutput: 128000 });
        const ctx = makeCtx([tool], { contextTokensEst: 170000 }); // 高水位：若批预算误下发必截断
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const { yielded, result } = await harvestSchedule(
            { role: "assistant", content: null, tool_calls: [tc("c1", "solo_tool")] }, message, ctx);
        assert.equal(result.kind, "completed");
        const end = yielded.find((e) => e.type === "tool.end");
        assert.equal(end.result, "x".repeat(50000), "50000 字符全文原样（128K 工具上限内，无批级截断）");
        assert.equal(message.filter((m) => m.role === "tool").length, 1);
        assert.equal(message[2].content, "x".repeat(50000), "逐字节一致");
        // 单工具批不发 tool.batch.budget（校准埋点仅并行批 ≥2）
        assert.equal(ctx.captured.filter((e: any) => e.eventType === "tool.batch.budget").length, 0);
        assert.equal(ctx.batchBudgetChars, undefined, "原 ctx 不被写入（R4）");
    });

    it("分摊正确：5 工具批各收到 floor(batchCap/5)=72000 字符上限", async () => {
        const names = ["probe_a", "probe_b", "probe_c", "probe_d", "probe_e"];
        const tools = names.map((n) => probeTool(n, 100000, { maxOutput: 100000 }));
        const ctx = makeCtx(tools, { contextTokensEst: 0 }); // 剩余窗口 180K → 批上限 360K → 每工具 72K
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const { yielded } = await harvestSchedule(
            { role: "assistant", content: null, tool_calls: names.map((n, i) => tc(`c${i}`, n)) },
            message, ctx);
        const ends = yielded.filter((e) => e.type === "tool.end");
        assert.equal(ends.length, 5);
        for (const e of ends) assertHalfSplit(e.result, 72000);
        assert.equal(ctx.batchBudgetChars, undefined, "R4：浅拷贝下发，原 ctx 未被改写");
    });

    it("窗口将满收敛：剩余 0 → 批上限 BATCH_MIN_CHARS=12000 → 每工具 6000", async () => {
        const tools = [probeTool("full_a", 50000, { maxOutput: 50000 }), probeTool("full_b", 50000, { maxOutput: 50000 })];
        // compactRatio=0.3 + contextTokensEst 恰在阈值上 → 剩余 0 → 批上限 12K；fill=0.3≤0.5 不缩放 → 截断恰在 6000
        const ctx = makeCtx(tools, { compactRatio: 0.3, contextTokensEst: 75000 });
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const { yielded } = await harvestSchedule(
            { role: "assistant", content: null, tool_calls: [tc("f1", "full_a"), tc("f2", "full_b")] },
            message, ctx);
        for (const e of yielded.filter((e) => e.type === "tool.end")) assertHalfSplit(e.result, 6000);
    });

    it("侧车顺序红线：批预算截断时侧车仍是截断前全文（recall with_full 可取回）", async () => {
        const tools = [probeTool("sc_a", 30000, { maxOutput: 30000 }), probeTool("sc_b", 30000, { maxOutput: 30000 })];
        // 剩余 20K token → 批上限 40K → 每工具 20000；fill=0.64 → scaled 15200 < 30000 → 截断 + 侧车
        const ctx = makeCtx(tools, { contextTokensEst: 160000 });
        const sessionId = ctx.sessionId;
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const { yielded } = await harvestSchedule(
            { role: "assistant", content: null, tool_calls: [tc("sc1", "sc_a"), tc("sc2", "sc_b")] },
            message, ctx);
        for (const e of yielded.filter((e) => e.type === "tool.end")) {
            assert.ok(e.result.length <= 20000 + 200, `模型视图 ≤ 批上限 + 标记行（实际 ${e.result.length}）`);
            assert.match(e.result, /完整原文已存档/, "带侧车存档提示");
        }
        // 侧车 = 脱敏后、截断前的原文（30000 字符全文）——顺序红线（先算 truncBudget 再判落盘）保证
        const full = await recallFull(sessionId, "sc1");
        assert.match(full, /\[存档原文 sc1 · 第 0-\d+ \/ 30000 字符\]/, "存档总长=原文 30000 字符");
        assert.match(full, /xxxx/, "存档含原文内容（非空档）");
    });

    it("去重不占预算：同签名重复只按去重后数量分摊，复用结果不重复执行", async () => {
        const tools = ["dup_a", "dup_b", "dup_c", "dup_d"].map((n) => probeTool(n, 50000, { maxOutput: 50000 }));
        // 计数执行次数：execute 需要注入计数——包一层
        let execCount = 0;
        for (const t of tools) {
            const inner = t.function.execute;
            t.function.execute = async (...a: any[]) => { execCount++; return inner(...a); };
        }
        // 剩余 20K token → 批上限 40K → 按去重后 4 个分摊 = 每工具 10000（按 5 个分摊则是 8000——可区分）
        const ctx = makeCtx(tools, { contextTokensEst: 160000 });
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        const tcs = [
            tc("d1", "dup_a", '{"path":"1"}'), tc("d2", "dup_b", '{"path":"2"}'),
            tc("d3", "dup_a", '{"path":"1"}'), // 与 d1 完全同签名 → 复用
            tc("d4", "dup_c", '{"path":"3"}'), tc("d5", "dup_d", '{"path":"4"}'),
        ];
        const { yielded } = await harvestSchedule({ role: "assistant", content: null, tool_calls: tcs }, message, ctx);
        assert.equal(execCount, 4, "同签名重复只执行首个（4 个独立签名）");
        assert.equal(yielded.filter((e) => e.type === "tool.end").length, 5, "重复项照发 end（前端卡片收敛）");
        // 预算按去重后 4 个分摊（10000），非 5 个（8000）——fill=0.64 → scaled 7600，头尾各 3800
        for (const e of yielded.filter((e) => e.type === "tool.end" && e.toolCallId !== "d3")) {
            assertHalfSplit(e.result, 7600);
        }
        const dup = yielded.find((e) => e.type === "tool.end" && e.toolCallId === "d3");
        assert.match(dup.result, /同轮重复调用 #2，已复用 #1 的结果/, "重复项复用 #1 结果");
    });

    it("校准埋点：并行批发 tool.batch.budget，字段含批大小/上限/实际注入字符/token 增量", async () => {
        const tools = [probeTool("cal_a", 40000, { maxOutput: 40000 }), probeTool("cal_b", 40000, { maxOutput: 40000 })];
        const ctx = makeCtx(tools, { contextTokensEst: 0 });
        const message: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }];
        await harvestSchedule(
            { role: "assistant", content: null, tool_calls: [tc("k1", "cal_a"), tc("k2", "cal_b")] },
            message, ctx);
        const evts = ctx.captured.filter((e: any) => e.eventType === "tool.batch.budget");
        assert.equal(evts.length, 1);
        const ev = evts[0];
        assert.equal(ev.metadata.batchSize, 2);
        assert.equal(ev.metadata.batchCapChars, 360000);
        assert.equal(ev.metadata.perToolCapChars, 180000);
        const payload = JSON.parse(ev.payload.output);
        assert.deepEqual(payload.injectedChars.length, 2, "各工具实际注入字符数（截断后 resultForModel.length）");
        for (const n of payload.injectedChars) assert.ok(n > 0 && n <= 180000 + 200);
        assert.equal(typeof payload.tokensBefore, "number");
        assert.equal(typeof payload.tokensAfter, "number");
        assert.equal(payload.tokensDelta, payload.tokensAfter - payload.tokensBefore, "批前后 estimateTokens 增量自洽");
    });
});
