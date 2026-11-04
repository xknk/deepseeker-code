/**
 * @file tests/window-check-events.test.ts
 * @description 窗口治理观测（缓存塌方治理 M1，2026-11-04）守门：
 *  - onWindowCheck 回调：ensureFitsWindow 每轮必报（含 noop），WindowCheckInfo 七字段齐备
 *    （estReal/threshold/correctionRatio/toolsTokens/hitRate/cacheFactor/decision）；
 *  - context.check trace 事件：仅 decision≠noop 发（控体积）；metadata 带触发时刻口径
 *    （estRealAtTrigger + hitRateAtCheck/cacheFactorAtCheck/windowDecision）；
 *  - context.decay trace 事件：免费衰减生效时发，decayTokensBefore/After 快照（r53 实证双盲补课）；
 *  - llm.request 三值增补：runAgent 集成档——estReal/thresholdAtSend/correctionRatioUsed 随每轮
 *    llm.request 落 trace（r53「回算不触发却触发了」类口径出入当场可判）。
 *
 *  约定：涉及 config/落盘链，静态 import 会先于 env 沙盒——一律 env 就位后动态 import；
 *  辅助模型走假 provider（audit-fixes-2026-11-03 同款夹具）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-window-check-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { ensureFitsWindow } = await import("@/agent/truncate.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");
const { runAgent } = await import("@/agent/runAgent.ts");

// ==================== 夹具（audit-fixes-2026-11-03 同款） ====================

const withProvider = async <T>(provider: any, fn: () => Promise<T>): Promise<T> => {
    setActiveProvider(provider);
    try {
        return await fn();
    } finally {
        resetActiveProvider();
    }
};

/** 假辅助模型：notes = 合成产物；alwaysFail = 持续故障。summarizeSizes 记调用次数。 */
const makeAuxProvider = (opts?: { alwaysFail?: boolean; notes?: string }) => {
    const summarizeSizes: number[] = [];
    const provider: any = {
        id: "fake", displayName: "Fake", modelLabel: "Fake",
        streamChat: async function* () { /* 本文件只走 summarize 通道 */ },
        classifyRisk: async () => "risky",
        buildAssistantMessage: (p: any) => ({ role: "assistant", content: p.content ?? "" }) as any,
        isContextLengthError: (e: any) => e?.status === 400,
        isTransientError: () => false,
        isImageUnsupportedError: () => false,
        summarize: async (messages: any[]) => {
            summarizeSizes.push(JSON.stringify(messages).length);
            if (opts?.alwaysFail) throw new Error("模拟辅助模型持续故障");
            return { choices: [{ message: { content: opts?.notes ?? "Fake 摘要" } }] } as any;
        },
    };
    return { provider, summarizeSizes };
};

/** ensureFitsWindow 最小入参：阈值 = 30000 × min(0.5×1.0, 0.82) = 15000 token（首轮 cacheFactor=1.0）。 */
const buildEvent = (sessionId: string, messageArr: any[], extra: Record<string, any> = {}) => ({
    sessionId,
    messageArr,
    depth: 0,
    keepRecentUnits: 1,
    compactRatio: 0.5,
    modelWindow: 30000,
    correctionRatio: 1,
    toolsTokens: 0,
    events: (() => { }) as any,
    ...extra,
});

/** 回调 + trace 双通道采集器：checks 收 WindowCheckInfo，trace 收 events 埋点。 */
const capture = () => {
    const checks: any[] = [];
    const trace: any[] = [];
    return {
        checks, trace,
        events: (e: any) => { trace.push(e); },
        onWindowCheck: (c: any) => { checks.push(c); },
    };
};

/** 免费衰减夹具：6 个老对话单元各带 11K ASCII 工具结果（~16.6K token 超阈值）+ 5 条近期 user（KEEP_RECENT_UNITS=5 保全文）。 */
const decayFixture = (): any[] => {
    const messageArr: any[] = [
        { role: "system", content: "SYS" },
        { role: "system", content: "" },
    ];
    for (let i = 0; i < 6; i++) {
        messageArr.push({
            role: "assistant", content: null,
            tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"old${i}.log"}` } }],
        });
        messageArr.push({ role: "tool", tool_call_id: `c${i}`, content: "L".repeat(11_000) });
    }
    for (let i = 0; i < 5; i++) messageArr.push({ role: "user", content: `recent unit number ${i}` });
    return messageArr;
};

// ==================== noop 路径：回调必发、trace 静默 ====================

describe("窗口治理观测：onWindowCheck 每轮必报（含 noop）", () => {
    it("低于阈值：回调 decision='noop' 七字段齐备；context.check/decay 不落（控体积）", async () => {
        const cap = capture();
        await ensureFitsWindow(buildEvent("wc-noop", [
            { role: "system", content: "SYS" },
            { role: "system", content: "" },
            { role: "user", content: "tiny message" },
        ], { events: cap.events, onWindowCheck: cap.onWindowCheck }));
        assert.equal(cap.checks.length, 1, "noop 也回调（llm.request 三值增补的数据源）");
        const c = cap.checks[0];
        assert.equal(c.decision, "noop");
        assert.equal(c.threshold, 15000, "threshold = round(30000 × min(0.5×1.0, 0.82)) = 15000");
        assert.equal(c.cacheFactor, 1.0, "首轮无真实 usage → cacheFactor 中性 1.0");
        assert.equal(c.hitRate, null, "无上一轮 usage → hitRate null");
        assert.equal(c.correctionRatio, 1, "透传入参校准系数");
        assert.equal(c.toolsTokens, 0);
        assert.equal(typeof c.estReal, "number", "estReal 为发送时刻口径快照");
        assert.equal(c.decayed, undefined, "noop 无衰减语义");
        assert.equal(cap.trace.filter((e: any) => e.eventType === "context.check").length, 0, "noop 不落 context.check");
        assert.equal(cap.trace.filter((e: any) => e.eventType === "context.decay").length, 0);
    });
});

// ==================== decay 路径：context.decay + context.check 双落（r53 双盲补课） ====================

describe("窗口治理观测：免费衰减路径（M1 现行为钉死；M3-1 合并后 decision 变 'compact' 时同步更新本档）", () => {
    it("衰减降回阈值内早退：decision='decay' + decayed=true；context.decay Before>After；context.check 带窗口字段；零 aux 调用", async () => {
        const cap = capture();
        const { provider, summarizeSizes } = makeAuxProvider();
        const messageArr = decayFixture();
        try {
            await withProvider(provider, async () => {
                await ensureFitsWindow(buildEvent("wc-decay", messageArr, { events: cap.events, onWindowCheck: cap.onWindowCheck }));
            });
        } finally {
            // no cleanup needed（无 hook 注册）
        }
        assert.equal(cap.checks.length, 1);
        const c = cap.checks[0];
        assert.equal(c.decision, "decay", "衰减后回到阈值内 → 早退 decision='decay'");
        assert.equal(c.decayed, true, "decay 路径 decayed 恒 true");
        assert.equal(summarizeSizes.length, 0, "免费衰减成功降级，零 LLM 成本");
        // context.decay：衰减前后 token 快照（此前只有 console.log，trace 双盲）
        const decays = cap.trace.filter((e: any) => e.eventType === "context.decay");
        assert.equal(decays.length, 1, "衰减生效恰落一条 context.decay");
        assert.ok(decays[0].metadata.decayTokensBefore > decays[0].metadata.decayTokensAfter,
            `decayTokensBefore 应大于 After，实得 ${decays[0].metadata.decayTokensBefore} → ${decays[0].metadata.decayTokensAfter}`);
        // context.check：仅 decision≠noop 发，带触发时刻口径
        const checks2 = cap.trace.filter((e: any) => e.eventType === "context.check");
        assert.equal(checks2.length, 1);
        assert.equal(checks2[0].metadata.windowDecision, "decay");
        assert.equal(checks2[0].metadata.hitRateAtCheck, null);
        assert.equal(checks2[0].metadata.cacheFactorAtCheck, 1.0);
        assert.equal(typeof checks2[0].metadata.estReal, "number", "触发时刻 estReal 快照（回答『当时为什么触发』）");
        assert.equal(checks2[0].metadata.thresholdAtSend, 15000);
        assert.equal(checks2[0].metadata.correctionRatioUsed, 1);
    });
});

// ==================== compact 路径：forceCompact 直通压缩 ====================

describe("窗口治理观测：LLM 压缩路径", () => {
    it("forceCompact 直通压缩：decision='compact' + decayed=false；context.check windowDecision='compact'；estReal 为压缩后口径", async () => {
        const cap = capture();
        const { provider, summarizeSizes } = makeAuxProvider({ notes: "Fake 压缩摘要" });
        const messageArr: any[] = [
            { role: "system", content: "SYS" },
            { role: "system", content: "" },
            { role: "user", content: "plan the work and verify results" },
            { role: "assistant", content: "done with step one" },
            { role: "user", content: "continue with the rest" },
        ];
        await withProvider(provider, async () => {
            await ensureFitsWindow(buildEvent("wc-compact", messageArr, { forceCompact: true, events: cap.events, onWindowCheck: cap.onWindowCheck }));
        });
        const c = cap.checks[cap.checks.length - 1];
        assert.equal(c.decision, "compact", "压缩循环实际执行 → decision='compact'");
        assert.equal(c.decayed, false, "纯文本历史无衰减对象 → decayed=false");
        assert.ok(summarizeSizes.length >= 1, "压缩走了 aux 合成调用");
        const checks2 = cap.trace.filter((e: any) => e.eventType === "context.check");
        assert.equal(checks2.length, 1);
        assert.equal(checks2[0].metadata.windowDecision, "compact");
        // 双口径语义（微小合成历史上压缩可能不缩反涨，方向断言不成立——只验证字段各归各位）：
        // 回调 estReal = 压缩后快照（描述本轮实际发送的上下文）；事件 estReal = 触发时刻快照（回答为什么触发）。
        assert.equal(typeof c.estReal, "number");
        assert.equal(typeof checks2[0].metadata.estReal, "number");
    });
});

// ==================== runAgent 集成档：llm.request 三值增补 ====================

describe("llm.request 三值增补（r53 口径出入当场可判）", () => {
    it("runAgent 单轮：llm.request metadata 带 estReal/thresholdAtSend/correctionRatioUsed/windowDecision + 四段指纹", async () => {
        const script = {
            turns: [{
                kind: "reply" as const,
                content: "窗口治理观测集成档：单轮回复。",
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 0 },
            }],
        };
        const trace: any[] = [];
        try {
            setActiveProvider(createReplayProvider(script as any));
            const message: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "go" }];
            for await (const _ev of runAgent(message, {
                sessionId: "wc-int", cwd: SANDBOX, events: (async (e: any) => { trace.push(e); }) as any,
                toolSchemas: [], modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
                parentSystemPrompt: "", depth: 0,
            } as any)) { /* drain */ }
        } finally {
            resetActiveProvider();
        }
        const reqs = trace.filter((e: any) => e.eventType === "llm.request");
        assert.equal(reqs.length, 1);
        const m = reqs[0].metadata;
        assert.equal(typeof m.estReal, "number", "三值之一：estReal");
        assert.equal(m.thresholdAtSend, 180000, "thresholdAtSend = round(250000 × 0.72)（首轮 cacheFactor=1.0）");
        assert.equal(typeof m.correctionRatioUsed, "number", "三值之一：correctionRatioUsed");
        assert.ok(m.correctionRatioUsed > 0);
        assert.equal(m.windowDecision, "noop", "首轮小上下文 → noop（字段随回调齐备，缺省不落=首轮无判定）");
        // 前缀指纹照旧随行（P0 诊断四字段）。注意：真实 runAgent 路径 ensureSummarySlot 会给空槽
        // 预置 SLOT_PLACEHOLDER 占位（非空字符串）→ sumHash 是稳定的非空哈希；「空槽 → da39a3ee5e」
        // 的定义钉死在 prefix-fingerprint.test.ts（合成数组直测）。
        assert.equal(typeof m.sysHash, "string");
        assert.match(m.sumHash, /^[0-9a-f]{10}$/, "sumHash 为 10 位十六进制短哈希");
        assert.notEqual(m.sumHash, "da39a3ee5e", "占位槽非空 → 非空哈希");
        assert.equal(m.msgCount, 3, "ensureSummarySlot 在 index 1 预置占位槽 → [system, system 占位槽, user]");
    });
});
