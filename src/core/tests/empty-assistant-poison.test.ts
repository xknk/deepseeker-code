/**
 * @file tests/empty-assistant-poison.test.ts
 * @description 空断流 → 空 assistant 消息毒化会话 三层修复守门（2026-11-03 生产 0d245bd0 实证）。
 *  故障链：DS 服务故障期流"干净"结束但 0 内容 0 usage → 旧逻辑记 ok:true completed → content:null
 *  的 assistant 消息 push 进上下文 + 落盘 → 后续每轮请求 400 "Invalid assistant message: content or
 *  tool_calls must be set"（探针原样复现），会话永久报废（服务恢复也救不回）。
 *  三层修复各自的回归钉：
 *  1) 根（streamInference）：空断流按 stall 同款重试（共享 idleRetries 预算，2 次封顶）；耗尽仍空则
 *     completed 如实带 emptyStream 标记（不再是看不出异常的裸 ok:true）。
 *  2) 防御（runAgent）：content 空(null)且无 tool_calls 的 assistant 消息不 push 不落盘 → PHANTOM
 *     nudge 接管重试；端到端：空断流轮后 transcript 零空 assistant 行、下一轮请求消息数不膨胀。
 *  3) 自愈（deepseek/stream.ts 出口）：stripHistoricalReasoning 整条丢弃历史中的空 assistant——
 *     修复前已落盘的受害会话无需迁移即恢复；正常历史零扰动（引用原样）；不受 PASSTHROUGH 门控。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-empty-assistant-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { streamInference } = await import("@/agent/streamInference.ts");
const { runAgent } = await import("@/agent/runAgent.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { stripHistoricalReasoning } = await import("@/llm/providers/deepseek/stream.ts");
const { readTranscriptLines } = await import("@/session/transcript.ts");

type Step = "empty" | "text";

/** 按调用次序回放的桩 provider："empty" = 流零 chunk 干净结束（当日故障形态：无异常无 usage），
 *  "text" = 正常文本 + usage 末包。deepseek 同形 buildAssistantMessage（content:null 路径要走到）。 */
const makeStubProvider = (script: Step[]): { provider: any; calls: () => number } => {
    let n = 0;
    const provider = {
        streamChat: async function* () {
            const step = script[n];
            n++;
            if (step === "empty") return;   // 0 chunk、0 usage、不抛错——服务端断流形态
            yield { kind: "text", text: "已完成验证" };
            yield { kind: "usage", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        },
        summarize: async () => ({ id: "s", object: "chat.completion", created: 0, model: "stub",
            choices: [{ index: 0, message: { role: "assistant", content: "（测试摘要）", refusal: null }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }),
        classifyRisk: async () => "safe" as const,
        buildAssistantMessage: (parts: any) => {
            const m: any = { role: "assistant", content: parts.content };
            if (parts.reasoning) m.reasoning_content = parts.reasoning;
            if (parts.toolCalls?.length) m.tool_calls = parts.toolCalls;
            return m;
        },
        isContextLengthError: () => false,
        isTransientError: () => false,
        isImageUnsupportedError: () => false,
    };
    return { provider, calls: () => n };
};

const driveInference = async (provider: any) => {
    setActiveProvider(provider);
    const captured: any[] = [];
    try {
        const ctx: any = {
            message: [{ role: "system", content: "s" }, { role: "user", content: "q" }],
            nudgeMsg: null, sessionId: `empty-inf-${Date.now()}`, depth: 0, round: 1, startTime: performance.now(),
            userDecisionSource: "llm", llmDecisionSource: "llm", signal: undefined,
            cleanedToolSchemas: [], model: undefined, thinkingLevel: undefined,
            events: (b: any) => { captured.push(b); return Promise.resolve(); },
            keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000, toolsTokens: 0,
        };
        const gen = streamInference(ctx);
        const yielded: any[] = [];
        let v = await gen.next();
        while (!v.done) { yielded.push(v.value); v = await gen.next(); }
        return { yielded, result: v.value, captured };
    } finally {
        resetActiveProvider();
    }
};

// ============ 1) 根：streamInference 空断流重试 ============
describe("空断流防御（streamInference）", () => {
    it("空×2 → 文本：按 stall 同款预算重试后恢复（共享 idleRetries，首跑+2 重试共 3 次调用）", async () => {
        const { provider, calls } = makeStubProvider(["empty", "empty", "text"]);
        const { result } = await driveInference(provider);
        assert.equal(result.kind, "completed", "空断流重试后应正常完成");
        assert.equal(result.assistantMessage?.content, "已完成验证");
        assert.equal(calls(), 3, "首跑 + 2 次空断流重试");
    });

    it("空×3：预算封顶后如实返回 completed + emptyStream 标记（不再是裸 ok:true 的静默谎言）", async () => {
        const { provider, calls } = await Promise.resolve(makeStubProvider(["empty", "empty", "empty"]));
        const { result, captured } = await driveInference(provider);
        assert.equal(calls(), 3, "MAX_STREAM_RETRIES=2 封顶，不放大请求");
        assert.equal(result.kind, "completed", "耗尽后交主循环空响应防御 + PHANTOM 接管（不在此处判死）");
        assert.equal(result.assistantMessage?.content, null, "content 仍为 null——由防御层拒之门外");
        const resp = captured.filter((e) => e.eventType === "llm.response");
        assert.equal(resp.length, 1);
        assert.equal(resp[0].metadata.emptyStream, true, "llm.response 带空断流标记（trace 取证通道）");
    });

    it("有 usage 的空响应不触发断流重试（模型层空回复归 PHANTOM 域，传输层断流才归本防御）", async () => {
        const p: any = {
            streamChat: async function* () {
                yield { kind: "usage", usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } };
            },
            summarize: async () => { throw new Error("不应触发"); },
            classifyRisk: async () => "safe" as const,
            buildAssistantMessage: (parts: any) => ({ role: "assistant", content: parts.content }),
            isContextLengthError: () => false, isTransientError: () => false, isImageUnsupportedError: () => false,
        };
        let calls = 0;
        const orig = p.streamChat;
        p.streamChat = async function* (...a: any[]) { calls++; yield* orig(...a); };
        const { result, captured } = await driveInference(p);
        assert.equal(calls, 1, "有 usage 即非断流，零重试");
        assert.equal(result.kind, "completed");
        const resp = captured.filter((e) => e.eventType === "llm.response");
        assert.ok(!resp[0].metadata.emptyStream, "有 usage 不打 emptyStream 标记");
    });
});

// ============ 2) 防御：runAgent 空 assistant 不 push 不落盘（端到端） ============
describe("空 assistant 落盘防御（runAgent 端到端）", () => {
    it("空断流轮不落盘空 assistant、不膨胀上下文；PHANTOM nudge 后正常收尾", async () => {
        // 桩序列：round1 = empty×3（断流重试耗尽）→ 防御跳过落盘 → PHANTOM nudge；round2 = text → 收尾
        const { provider } = makeStubProvider(["empty", "empty", "empty", "text"]);
        setActiveProvider(provider);
        const sid = `e2e-empty-${Date.now()}`;
        const captured: any[] = [];
        try {
            const options: any = {
                sessionId: sid, cwd: SANDBOX, toolSchemas: [], modelWindow: 10_000_000,
                keepRecentUnits: 9999, compactRatio: 1.4, parentSystemPrompt: "【测试规范】仅用于守门回归。",
                events: async (b: any) => { captured.push(b); },
                depth: 0,
            };
            const events: any[] = [];
            for await (const e of runAgent([{ role: "system", content: "s" }, { role: "user", content: "验证任务" }], options)) {
                events.push(e);
            }
            const finals = events.filter((e) => e.type === "final");
            const final = finals[finals.length - 1];
            assert.equal(final?.text, "已完成验证", "PHANTOM nudge 后第二轮正常收尾");

            // 落盘侧：transcript 不含任何 content 空且无 tool_calls 的 assistant 行（毒化源头封死）
            const lines = await readTranscriptLines(sid).catch(() => [] as any[]);
            const emptyAssistantRows = lines.filter((l: any) => l?.role === "assistant"
                && !(typeof l.content === "string" && l.content.length > 0)
                && !(Array.isArray(l.tool_calls) && l.tool_calls.length > 0));
            assert.equal(emptyAssistantRows.length, 0, "空 assistant 绝不落盘（会话毒化根源）");

            // 上下文侧：round2 请求消息数不因空 assistant 膨胀（旧逻辑会 push null assistant +1）
            const reqs = captured.filter((e) => e.eventType === "llm.request");
            assert.ok(reqs.length >= 2, "至少两轮请求");
            assert.equal(reqs[1].metadata.msgCount, reqs[0].metadata.msgCount,
                "空断流轮未向 message 数组塞 null assistant");
        } finally {
            resetActiveProvider();
        }
    });
});

// ============ 3) 自愈：请求出口清洗历史存量 ============
describe("空 assistant 出口自愈（stripHistoricalReasoning）", () => {
    const poison = { role: "assistant", content: null } as any;
    const withReasoning = { role: "assistant", content: "正文", reasoning_content: "思考" } as any;

    it("中毒历史：空 assistant 整条丢弃，其余消息原样（引用不变）", () => {
        const msgs: any[] = [
            { role: "system", content: "s" },
            { role: "user", content: "q1" },
            poison,
            { role: "user", content: "q2" },
            withReasoning,
        ];
        const out = stripHistoricalReasoning(msgs) as any[];
        assert.equal(out.length, 4, "空 assistant 被丢弃");
        assert.ok(!out.some((m) => m.role === "assistant" && m.content === null));
        assert.equal(out[0], msgs[0], "非命中消息引用原样（缓存前缀零扰动）");
        assert.equal(poison.content, null, "入参不被 mutate（入参即落盘本体）");
    });

    it("严格档形状（末条非 system 为空 assistant）同样先清洗再判档", () => {
        const msgs: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }, poison];
        const out = stripHistoricalReasoning(msgs) as any[];
        assert.equal(out.length, 2);
        assert.equal(out[out.length - 1]?.role, "user");
    });

    it("正常历史零扰动：无空 assistant 时非 assistant 消息引用原样、reasoning 照常剥离", () => {
        // 宽松档形状：末条非 system 为 user（assistant 带思考放中间）——末条是 assistant 会走严格档全量回传
        const msgs: any[] = [{ role: "system", content: "s" }, { role: "user", content: "q" }, withReasoning, { role: "user", content: "q2" }];
        const out = stripHistoricalReasoning(msgs) as any[];
        assert.equal(out.length, 4);
        assert.equal(out[0], msgs[0]);
        assert.equal(out[2].content, "正文");
        assert.ok(!("reasoning_content" in out[2]), "宽松档 reasoning 剥离行为不变");
    });

    it("PASSTHROUGH=1 仍清洗空 assistant（正确性修复不受协议实验开关门控）", () => {
        process.env.DEEP_SEEK_REASONING_PASSTHROUGH = "1";
        try {
            const msgs: any[] = [{ role: "user", content: "q" }, poison, { role: "user", content: "q2" }, withReasoning];
            const out = stripHistoricalReasoning(msgs) as any[];
            assert.equal(out.length, 3, "空 assistant 仍被丢弃");
            assert.equal(out[out.length - 1].reasoning_content, "思考", "PASSTHROUGH 下 reasoning 照常全量回传");
        } finally {
            delete process.env.DEEP_SEEK_REASONING_PASSTHROUGH;
        }
    });
});
