/**
 * @file tests/stream-retry-budget.test.ts
 * @description C 批（§3 idle/API 重试计数解耦）守门测试：内联桩 provider 按调用次序回放故障序列
 *  （ReplayProvider 不支持同 turn 混合故障序列——单 fault 类型 + times 预算的形态装不下 429→stall）。
 *  1. 混合序列 429×2 → stall → 成功：stall 仍有一次重试机会——改前 streamAttempt 已被两次 API 重试
 *     推到 2（2<2 不再重试）直接 error；改后 idleRetries 独立计数照常重试（本测试的核心回归钉）。
 *  2. 纯 stall 预算仍封顶：stall×3 → 第 3 次 error（解耦不是放开预算，MAX_STREAM_RETRIES=2 不变）。
 *  3. 文档定稿序列 429 → stall → 成功：混合场景端到端可恢复。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-stream-retry-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { streamInference } = await import("@/agent/streamInference.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");

type Step = "429" | "stall" | "ok";

/** 按调用次序回放故障的桩 provider：streamChat 第 N 次调用吃 script[N-1]。 */
const makeStubProvider = (script: Step[]): { provider: any; calls: () => number } => {
    let n = 0;
    const provider = {
        streamChat: async function* () {
            const step = script[n];
            n++;
            if (step === "429") {
                const e: any = new Error("rate limited");
                e.status = 429;
                throw e;
            }
            if (step === "stall") throw new Error("stream_idle_timeout");
            yield { kind: "usage", usage: { prompt_tokens: 10, completion_tokens: 1 } };
        },
        isTransientError: (e: any) => e?.status === 429,
        isContextLengthError: (_e: any) => false,
        isImageUnsupportedError: (_e: any) => false,
        buildAssistantMessage: ({ content, toolCalls }: any) =>
            ({ role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }),
    };
    return { provider, calls: () => n };
};

const driveInference = async (provider: any) => {
    setActiveProvider(provider);
    const captured: any[] = [];
    try {
        const ctx: any = {
            message: [{ role: "system", content: "s" }, { role: "user", content: "q" }],
            nudgeMsg: null, sessionId: `retry-${Date.now()}`, depth: 0, round: 1, startTime: performance.now(),
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

describe("C 批：idle / API 重试计数解耦", () => {
    it("混合序列 429×2 → stall → 成功：API 重试不再挤占 idle 预算", async () => {
        // 改前：两次 429 重试使 streamAttempt=2，stall 时 2<2 不成立 → 直接 error（§3.1 失效路径）
        const { provider, calls } = makeStubProvider(["429", "429", "stall", "ok"]);
        const { result } = await driveInference(provider);
        assert.equal(result.kind, "completed", "stall 应仍有一次重试机会（改前直接 error）");
        assert.equal(calls(), 4, "共 4 次调用：429/429/stall/ok");
        assert.equal(result.assistantMessage?.role, "assistant");
    });

    it("纯 stall 预算仍封顶：stall×3 → 第 3 次 error（解耦不放大预算）", async () => {
        const { provider, calls } = makeStubProvider(["stall", "stall", "stall"]);
        const { result } = await driveInference(provider);
        assert.equal(result.kind, "error", "MAX_STREAM_RETRIES=2 封顶不变");
        assert.match(String(result.error?.message ?? result.error), /stream_idle_timeout/);
        assert.equal(calls(), 3, "首跑 + 2 次 idle 重试");
    });

    it("文档定稿序列 429 → stall → 成功：混合故障端到端可恢复", async () => {
        const { provider, calls } = makeStubProvider(["429", "stall", "ok"]);
        const { result } = await driveInference(provider);
        assert.equal(result.kind, "completed");
        assert.equal(calls(), 3);
    });
});
