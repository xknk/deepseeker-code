/**
 * @file tests/retry-unify.test.ts
 * @description 瞬态重试单层化回归（DS 特性：账号级限流下重试放大是自伤）。
 *  1) extractRetryAfterMs 单测：retry-after 秒 / retry-after-ms / Headers 实例 / HTTP 日期 / 垃圾值；
 *  2) fetch 桩直打 DeepSeek provider 流式路径（stream.ts maxRetries: 0）：
 *     - 429×2 后成功 → 恰 3 次出站请求（SDK 层不叠加）、退避真实休眠（≥1s+2s）；
 *     - 429 携带 retry-after-ms=1300 → 退避以 Retry-After 为准（≥1.3s > 指数底 1s）；
 *     - 429 恒定 → 恰 1+MAX_API_RETRIES=4 次出站请求（若 SDK 内建重试回归则恒 >4，直接红）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（同 replay.test.ts 惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-retry-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;
process.env.DEEP_SEEK_API_KEY ??= "test-key"; // client 构造需要非空 key（fetch 桩下无真实网络）
delete process.env.DEEP_SEEK_PROVIDER;        // 确保默认 provider = deepseek（fetch 桩测的就是这条路径）
// ★ baseURL 指向本地不可达地址：即使桩漏接（SDK 变更内部 fetch 解析路径），也是毫秒级本地
//   connection refused，绝不外呼真实 API。
process.env.DEEP_SEEK_API_URL = "http://127.0.0.1:9";

// ★ fetch 桩必须在 import client 之前装：OpenAI SDK 在构造 client 时捕获 fetch 引用，
//   事后替换 globalThis.fetch 拦不到（首次跑实证 count=0、请求漏到真实网络）。
let stubQueue: Response[] = [];
let stubCount = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (): Promise<Response> => {
    stubCount++;
    const next = stubQueue.shift();
    if (!next) throw new Error("fetch 桩队列耗尽（出站请求多于预期——检查重试是否叠加）");
    return next;
}) as unknown as typeof globalThis.fetch;

const { extractRetryAfterMs } = await import("@/agent/streamInference.ts");
const { streamInference } = await import("@/agent/streamInference.ts");
const { activeProvider } = await import("@/llm/model.ts");

// ============ fetch 桩 ============

/** SSE 成功响应：两段 content delta + 末包 usage（对齐 DS 流式末包形态 choices:[]）。 */
const sseOkResponse = (): Response => {
    const chunk = (delta: any, extra: any = {}): any =>
        JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "deepseek-test", choices: [ { index: 0, delta, finish_reason: null }, ], ...extra });
    const body =
        `data: ${chunk({ content: "OK-" })}\n\n` +
        `data: ${chunk({ content: "TOKEN" })}\n\n` +
        `data: ${chunk({}, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n` +
        `data: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

/** 429 响应工厂：可携带 retry-after 头（headers 值经 APIError.headers 透传给 extractRetryAfterMs）。 */
const rateLimitResponse = (headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify({ error: { message: "rate limited (stub)", code: "rate_limit" } }), {
        status: 429,
        headers: { "content-type": "application/json", ...headers },
    });

/** 为单个用例装载响应队列并清零计数（桩本体已在 import 前全局安装）。 */
const installFetchStub = (queue: Response[]) => {
    stubQueue = queue;
    stubCount = 0;
    return { get count() { return stubCount; }, restore: () => { stubQueue = []; } };
};

/** 最小 StreamInferenceContext（同 replay.test.ts makeInfCtx）。 */
const makeInfCtx = (): any => ({
    message: [{ role: "system", content: "s" }, { role: "user", content: "q" }],
    nudgeMsg: null,
    sessionId: `retry-unify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    depth: 0,
    round: 1,
    startTime: performance.now(),
    userDecisionSource: "user" as const,
    llmDecisionSource: "llm" as const,
    cleanedToolSchemas: [],
    events: (async () => { }) as any,
    keepRecentUnits: 5,
    compactRatio: 0.72,
    modelWindow: 250000,
});

/** 驱动 streamInference 至 return（不消费 yield 事件流）。 */
const drive = async (ctx: any) => {
    const gen = streamInference(ctx);
    let v = await gen.next();
    while (!v.done) v = await gen.next();
    return v.value;
};

// ============ 单测 ============

describe("extractRetryAfterMs（Retry-After 头解析）", () => {
    it("retry-after 数字秒 → 毫秒；retry-after-ms → 原值毫秒", () => {
        assert.equal(extractRetryAfterMs({ headers: { "retry-after": "2" } }), 2000);
        assert.equal(extractRetryAfterMs({ headers: { "retry-after": "0.5" } }), 500);
        assert.equal(extractRetryAfterMs({ headers: { "retry-after-ms": "250" } }), 250);
    });

    it("Headers 实例同样可读；retry-after-ms 优先于 retry-after", () => {
        const h = new Headers({ "retry-after": "3", "retry-after-ms": "800" });
        assert.equal(extractRetryAfterMs({ headers: h }), 800);
        assert.equal(extractRetryAfterMs({ headers: new Headers({ "retry-after": "3" }) }), 3000);
    });

    it("秒值 0 合法（返回 0，由调用方 max(指数, 0) 回落）；缺失/HTTP日期/垃圾值/null headers → null", () => {
        assert.equal(extractRetryAfterMs({ headers: { "retry-after": "0" } }), 0);
        assert.equal(extractRetryAfterMs({ headers: {} }), null);
        assert.equal(extractRetryAfterMs({ headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }), null);
        assert.equal(extractRetryAfterMs({ headers: { "retry-after": "soon" } }), null);
        assert.equal(extractRetryAfterMs({}), null);
        assert.equal(extractRetryAfterMs(null), null);
        assert.equal(extractRetryAfterMs(undefined), null);
    });
});

// ============ 集成：fetch 桩直打 DeepSeek provider 流式路径 ============

describe("流式重试单层化（stream.ts maxRetries:0 + streamInference 应用层）", () => {
    it("默认 provider 是 deepseek（测的就是真实厂商路径，不是 replay）", () => {
        assert.equal(activeProvider.id, "deepseek");
    });

    it("429×2 后成功：恰 3 次出站请求（SDK 不叠加）+ 退避真实休眠（1s+2s）", async () => {
        const stub = installFetchStub([rateLimitResponse(), rateLimitResponse(), sseOkResponse()]);
        try {
            const t0 = performance.now();
            const result = await drive(makeInfCtx());
            const elapsed = performance.now() - t0;
            assert.equal(stub.count, 3, "1 次首发 + 2 次应用层重试；SDK 内建重试必须为 0 次");
            assert.equal(result.kind, "completed");
            assert.equal((result as any).assistantMessage.content, "OK-TOKEN");
            assert.equal((result as any).usage?.prompt_tokens, 5);
            assert.ok(elapsed >= 2500, `两次指数退避（1s+2s）应真实休眠，实测 ${Math.round(elapsed)}ms`);
        } finally {
            stub.restore();
        }
    });

    it("429 携带 retry-after-ms=1300：退避以 Retry-After 为准（≥1.3s，高于指数底 1s）", async () => {
        const stub = installFetchStub([
            rateLimitResponse({ "retry-after-ms": "1300" }),
            sseOkResponse(),
        ]);
        try {
            const t0 = performance.now();
            const result = await drive(makeInfCtx());
            const elapsed = performance.now() - t0;
            assert.equal(stub.count, 2);
            assert.equal(result.kind, "completed");
            assert.ok(elapsed >= 1250, `应遵 Retry-After=1300ms（指数底仅 1000ms），实测 ${Math.round(elapsed)}ms`);
            assert.ok(elapsed < 5000, `不应过度等待，实测 ${Math.round(elapsed)}ms`);
        } finally {
            stub.restore();
        }
    });

    it("429 恒定：恰 1+3=4 次出站请求后 error 收尾（SDK 叠加回归则必然 >4 次直接红）", async () => {
        const stub = installFetchStub([rateLimitResponse(), rateLimitResponse(), rateLimitResponse(), rateLimitResponse()]);
        try {
            const t0 = performance.now();
            const result = await drive(makeInfCtx());
            const elapsed = performance.now() - t0;
            assert.equal(stub.count, 4, "单层预算：首发 + MAX_API_RETRIES=3；若 SDK 内建 4 次回归则此处为 16+");
            assert.equal(result.kind, "error");
            assert.equal((result as any).error?.status, 429);
            assert.ok(elapsed >= 6500, `三次退避（1s+2s+4s）应真实休眠，实测 ${Math.round(elapsed)}ms`);
        } finally {
            stub.restore();
        }
    });
});
