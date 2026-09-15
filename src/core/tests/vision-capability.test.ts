/**
 * @file tests/vision-capability.test.ts
 * @description 零配置多模态「乐观直发 + 400 自学习降级」回归（llm/visionCapability.ts + streamInference 降级分支）：
 *  1) 能力缓存单测：peek/learn 同步可见、原子落盘可重读、>100 条裁剪、测试复位隔离；
 *  2) isImageUnsupportedError 分类器：400/422+image 关键词命中；context_length/429/网络/无关 400 不命中；
 *  3) 集成（fetch 桩直打 DeepSeek provider 流式路径）：首发图片 → 400 "does not support image" →
 *     自动折叠为文本占位重试 → completed；第 2 次请求体已无 image part；能力已学习；事件流含 vision.downgraded；
 *  4) 集成（replay provider）：image fault 恒定 → 只降级一次后 error 收尾（预算不放大）；已有部分输出
 *     （afterChars>0，noOutputYet 门控）→ 不降级、不学习。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（同 retry-unify.test.ts 惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-vision-cap-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;
process.env.DEEP_SEEK_API_KEY ??= "test-key"; // client 构造需要非空 key（fetch 桩下无真实网络）
delete process.env.DEEP_SEEK_PROVIDER;        // 默认 provider = deepseek（fetch 桩测的就是这条路径）
delete process.env.DEEP_SEEK_VISION;          // 判定链测试前提：env 不抢优先级
process.env.DEEP_SEEK_API_URL = "http://127.0.0.1:9"; // 本地不可达：桩漏接也绝不外呼真实 API

const {
    peekVisionCapability, learnVisionCapability,
    ensureVisionCacheLoaded, _resetVisionCacheForTest,
} = await import("@/llm/visionCapability.ts");
const { isImageUnsupportedError, setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { streamInference } = await import("@/agent/streamInference.ts");
const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");

/** 轮询等待落盘完成（persistLatest 是异步原子写；本地 tmp 写盘毫秒级，2s 封顶防挂死）。 */
const waitForFile = async (file: string, timeoutMs = 2000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fs.access(file); return; } catch { await new Promise((r) => setTimeout(r, 25)); }
    }
    assert.fail(`等待落盘超时：${file}`);
};

// ============ 1) 能力缓存 ============

describe("visionCapability（能力缓存：乐观直发的判定后盾）", () => {
    it("无记录 → undefined（调用方落乐观默认）；learn 后同步可见；落盘文件可重读", async () => {
        _resetVisionCacheForTest();
        const id = `vcap-basic-${Date.now()}`;
        assert.equal(peekVisionCapability(id), undefined, "无记录应返回 undefined");
        assert.equal(peekVisionCapability("  "), undefined, "空 id 防御");
        learnVisionCapability(id, false);
        assert.equal(peekVisionCapability(id), false, "内存同步生效（streamInference 重试前即见）");
        await ensureVisionCacheLoaded();
        await waitForFile(path.join(SANDBOX, "model-capabilities.json"));
        const raw = JSON.parse(await fs.readFile(path.join(SANDBOX, "model-capabilities.json"), "utf-8"));
        assert.equal(raw[id]?.vision, false, "原子落盘内容可重读");
        assert.ok(typeof raw[id]?.checkedAt === "string");
    });

    it(">100 条按 checkedAt 裁剪最旧（防膨胀），最新记录保留", () => {
        _resetVisionCacheForTest();
        const base = Date.now();
        for (let i = 1; i <= 101; i++) learnVisionCapability(`vcap-prune-${base}-${i}`, i % 2 === 0);
        assert.equal(peekVisionCapability(`vcap-prune-${base}-1`), undefined, "最旧条目应被裁掉");
        assert.equal(peekVisionCapability(`vcap-prune-${base}-101`), false, "最新条目保留");
        assert.equal(peekVisionCapability(`vcap-prune-${base}-100`), true, "次新条目保留");
        _resetVisionCacheForTest();
    });

    it("_resetVisionCacheForTest 清空内存层（用例间隔离）", () => {
        const id = `vcap-reset-${Date.now()}`;
        learnVisionCapability(id, false);
        assert.equal(peekVisionCapability(id), false);
        _resetVisionCacheForTest();
        assert.equal(peekVisionCapability(id), undefined);
    });
});

// ============ 2) 错误分类器 ============

describe("isImageUnsupportedError（「模型不支持图片」分类器，宽匹配容错优先）", () => {
    it("DeepSeek 官方签名 400 + \"This model does not support image\" 命中", () => {
        assert.ok(isImageUnsupportedError({ status: 400, message: "Error 400: This model does not support image" }));
    });

    it("OpenAI 兼容变体命中：422 + message 关键词；400 + error.code 含 image", () => {
        assert.ok(isImageUnsupportedError({ status: 422, message: "image input is not supported by this model" }));
        assert.ok(isImageUnsupportedError({ status: 422, message: "multimodal content rejected" }));
        assert.ok(isImageUnsupportedError({ status: 400, message: "Invalid request", error: { code: "invalid_image" } }));
        assert.ok(isImageUnsupportedError({ status: 400, message: "Invalid request", code: "image_url_not_accepted" }));
    });

    it("不命中：context_length 400 / 429 / 网络复位 / 无关 400 / 空值", () => {
        assert.ok(!isImageUnsupportedError({ status: 400, message: "context_length_exceeded: maximum context length" }), "超长归超长通道");
        assert.ok(!isImageUnsupportedError({ status: 429, message: "image rate limited" }), "429 归瞬时通道");
        assert.ok(!isImageUnsupportedError({ status: 500, message: "image boom" }), "5xx 归瞬时通道");
        assert.ok(!isImageUnsupportedError({ message: "ECONNRESET" }), "网络复位无 status");
        assert.ok(!isImageUnsupportedError({ status: 400, message: "Invalid parameter: 'messages'." }), "无关 400 不吞");
        assert.ok(!isImageUnsupportedError(null));
        assert.ok(!isImageUnsupportedError(undefined));
    });
});

// ============ 3) 集成：fetch 桩直打 DeepSeek 流式路径 ============

// 桩安装时点安全性：client 单例是懒加载（getModel 首次请求时才构造 OpenAI client 并捕获 fetch 引用），
// 本文件桩安装于 import 之后、首次请求之前 → 恰好赶上。DEEP_SEEK_API_URL=127.0.0.1:9 兜底：
// 万一桩漏接，也只是毫秒级本地连接拒绝，绝不外呼真实 API。
let stubQueue: Response[] = [];
let stubCount = 0;
let stubBodies: string[] = [];
globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
    stubCount++;
    const body = typeof init?.body === "string" ? init.body : (input?.body ?? "");
    stubBodies.push(String(body));
    const next = stubQueue.shift();
    if (!next) throw new Error("fetch 桩队列耗尽（出站请求多于预期——检查降级重试是否叠加）");
    return next;
}) as unknown as typeof globalThis.fetch;

/** 400「模型不支持图片」响应（DeepSeek 官方错误签名）。 */
const imageUnsupportedResponse = (): Response =>
    new Response(JSON.stringify({ error: { message: "This model does not support image (stub)", type: "invalid_request_error", code: "image_unsupported" } }), {
        status: 400, headers: { "content-type": "application/json" },
    });

/** SSE 成功响应（同 retry-unify 惯例：两段 content delta + 末包 usage）。 */
const sseOkResponse = (): Response => {
    const chunk = (delta: any, extra: any = {}): any =>
        JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "deepseek-test", choices: [{ index: 0, delta, finish_reason: null }], ...extra });
    const body =
        `data: ${chunk({ content: "OK-" })}\n\n` +
        `data: ${chunk({ content: "TOKEN" })}\n\n` +
        `data: ${chunk({}, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n` +
        `data: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

/** 带图消息的最小 StreamInferenceContext（model 用独一 id，防缓存跨用例污染）。 */
const makeImageCtx = (): any => ({
    message: [
        { role: "system", content: "s" },
        { role: "user", content: [
            { type: "text", text: "看图" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ] },
    ],
    nudgeMsg: null,
    sessionId: `vcap-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    depth: 0,
    round: 1,
    startTime: performance.now(),
    userDecisionSource: "user" as const,
    llmDecisionSource: "llm" as const,
    cleanedToolSchemas: [],
    model: `ds-vision-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    events: (async () => { }) as any,
    keepRecentUnits: 5,
    compactRatio: 0.72,
    modelWindow: 250000,
});

/** 驱动 streamInference，收集 yield 的全部事件并返回 [事件流, 推理结果]。 */
const driveWithEvents = async (ctx: any) => {
    const gen = streamInference(ctx);
    const seen: any[] = [];
    let v = await gen.next();
    while (!v.done) { seen.push(v.value); v = await gen.next(); }
    return { seen, result: v.value };
};

describe("视觉自学习降级（streamInference 降级分支，端到端）", () => {
    it("首发图片 400 → 记能力 + 折叠为文本重试 → completed；第 2 次请求零 image part；事件含 vision.downgraded", async () => {
        _resetVisionCacheForTest();
        const ctx = makeImageCtx();
        stubQueue = [imageUnsupportedResponse(), sseOkResponse()];
        stubCount = 0; stubBodies = [];
        try {
            const { seen, result } = await driveWithEvents(ctx);
            assert.equal(stubCount, 2, "1 次乐观首发 + 1 次降级重试；不得叠加");
            assert.equal(result.kind, "completed");
            assert.equal((result as any).assistantMessage.content, "OK-TOKEN");
            // 第 2 次请求体：同模型、图片消息已折叠为 string（含占位说明与原文本）、零 image_url
            const second: any = JSON.parse(stubBodies[1]);
            assert.equal(second.model, ctx.model);
            const imgMsg = second.messages.find((m: any) => String(m.content ?? "").includes("看图"));
            assert.ok(imgMsg, "折叠后的用户消息应在请求体中");
            assert.equal(typeof imgMsg.content, "string", "image parts 必须折叠为纯 string");
            assert.match(imgMsg.content, /图片未送达/);
            assert.ok(!JSON.stringify(second.messages).includes("image_url"), "重试请求不得残留 image part");
            // 自学习：能力已按生效模型 id 记住
            assert.equal(peekVisionCapability(ctx.model), false, "400 后应立即学习 vision:false");
            // 前端事件：vision.downgraded 恰一次且带模型 id
            const dg = seen.filter((e) => e.type === "vision.downgraded");
            assert.equal(dg.length, 1);
            assert.equal(dg[0].model, ctx.model);
        } finally {
            stubQueue = [];
            _resetVisionCacheForTest();
        }
    });
});

describe("视觉自学习降级（replay provider：预算与门控）", () => {
    it("image fault 恒定：只降级一次，第二次 400 → error 收尾（重试预算不放大）", async () => {
        _resetVisionCacheForTest();
        const provider = createReplayProvider({
            turns: [{ kind: "reply", content: "x", fault: { type: "image_unsupported", times: 99 } }],
        });
        setActiveProvider(provider);
        try {
            const ctx = makeImageCtx();
            const { seen, result } = await driveWithEvents(ctx);
            assert.equal(provider.calls.length, 2, "首发 + 一次降级重试；不得更多");
            assert.equal(result.kind, "error", "降级预算耗尽后应优雅收尾");
            assert.equal(peekVisionCapability(ctx.model), false, "首次 400 已学习");
            assert.equal(seen.filter((e) => e.type === "vision.downgraded").length, 1, "降级事件只发一次");
            // 第 2 次调用看到的 messages：图片已折叠
            const secondMsgs = provider.calls[1].messages;
            assert.ok(!JSON.stringify(secondMsgs).includes("image_url"));
            assert.match(JSON.stringify(secondMsgs), /图片未送达/);
        } finally {
            resetActiveProvider();
            _resetVisionCacheForTest();
        }
    });

    it("已有部分输出（afterChars>0，noOutputYet 门控）→ 不降级不学习，error 收尾", async () => {
        _resetVisionCacheForTest();
        const provider = createReplayProvider({
            turns: [{ kind: "reply", content: "已经想了一半的话", fault: { type: "image_unsupported", afterChars: 5 } }],
        });
        setActiveProvider(provider);
        try {
            const ctx = makeImageCtx();
            const { result } = await driveWithEvents(ctx);
            assert.equal(provider.calls.length, 1, "已有输出时不得重试（防重复显示）");
            assert.equal(result.kind, "error");
            assert.equal(peekVisionCapability(ctx.model), undefined, "非首发失败不学习（可能另有原因）");
        } finally {
            resetActiveProvider();
            _resetVisionCacheForTest();
        }
    });
});
