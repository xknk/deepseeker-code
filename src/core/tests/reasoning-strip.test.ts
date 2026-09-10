/**
 * @file tests/reasoning-strip.test.ts
 * @description 历史轮 reasoning_content 出口剥离回归（DS 特性：2026-09-10 协议探针证实服务端不强制回传，
 *  剥历史省 ~25% 请求体积且窗口瘦身 → 压缩更晚触发）。
 *  1) stripHistoricalReasoning 单测：剥 assistant 思考字段、其余字段/消息原样、非 string 值不剥、
 *     env DEEP_SEEK_REASONING_PASSTHROUGH=1 直通还原、绝不原地改（入参即落盘消息本体）；
 *  2) fetch 桩直打 streamChat / summarize 出站请求体：默认剥离、env=1 回传、tool_calls/content 不受损。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（同 retry-unify.test.ts 惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-rstrip-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;
process.env.DEEP_SEEK_API_KEY ??= "test-key";
delete process.env.DEEP_SEEK_PROVIDER;
delete process.env.DEEP_SEEK_REASONING_PASSTHROUGH;   // 默认口径 = 剥离
// ★ baseURL 指向本地不可达地址：桩漏接也绝不外呼真实 API（同 retry-unify.test.ts）
process.env.DEEP_SEEK_API_URL = "http://127.0.0.1:9";

// ★ fetch 桩必须在 import client 之前装（SDK 构造时捕获 fetch 引用）；记录最近一次出站请求体。
let lastBody: any = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: any, init: any): Promise<Response> => {
    lastBody = JSON.parse(String(init?.body ?? "{}"));
    const stream = lastBody?.stream === true;
    if (stream) {
        const chunk = (delta: any, extra: any = {}): any =>
            JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "deepseek-test", choices: [{ index: 0, delta, finish_reason: null }], ...extra });
        const body =
            `data: ${chunk({ content: "OK" })}\n\n` +
            `data: ${chunk({}, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n` +
            `data: [DONE]\n\n`;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }), {
        status: 200, headers: { "content-type": "application/json" },
    });
}) as unknown as typeof globalThis.fetch;

const { stripHistoricalReasoning } = await import("@/llm/providers/deepseek/stream.ts");
const { streamChat } = await import("@/llm/providers/deepseek/stream.ts");
const { streamInference } = await import("@/agent/streamInference.ts");
const { deepseekProvider } = await import("@/llm/providers/deepseek/index.ts");

// 带 reasoning_content 的工具轮（产品真实形态：content:null + tool_calls，见 buildAssistantMessage）
const makeMsgs = (): any[] => [
    { role: "system", content: "s" },
    { role: "user", content: "q" },
    {
        role: "assistant", content: null, reasoning_content: "先想一下再动手",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "calc", arguments: '{"expr":"2+2"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "4" },
];

/** 驱动 streamChat 消费完整个流（只关心出站请求体，不关心 yield 内容）。 */
const driveStream = async (msgs: any[]) => {
    for await (const _c of streamChat(msgs, undefined, {} as any)) { /* 消费至结束 */ }
};

// ============ 单测 ============

describe("stripHistoricalReasoning（出口剥离历史思考记录）", () => {
    it("剥 assistant 的 reasoning_content，其余字段与其它角色消息原样", () => {
        const msgs = makeMsgs();
        const out = stripHistoricalReasoning(msgs);
        assert.equal(out.length, msgs.length);
        assert.ok(!("reasoning_content" in out[2]), "assistant 思考字段应被剥除");
        assert.equal((out[2] as any).tool_calls.length, 1, "tool_calls 不受损");
        assert.equal(out[2].content, null, "content 不受损");
        assert.equal(out[0], msgs[0], "system 原对象透传");
        assert.equal(out[3], msgs[3], "tool 原对象透传");
    });

    it("绝不原地改：入参对象保持携带 reasoning_content（落盘/UI 依赖）", () => {
        const msgs = makeMsgs();
        const snapshot = JSON.stringify(msgs);
        stripHistoricalReasoning(msgs);
        assert.equal(JSON.stringify(msgs), snapshot, "入参不得被变异");
        assert.equal(msgs[2].reasoning_content, "先想一下再动手");
    });

    it("reasoning_content 非 string（缺省/undefined）时原对象透传", () => {
        const m: any = { role: "assistant", content: "x" };
        const out = stripHistoricalReasoning([m]);
        assert.equal(out[0], m, "无思考字段 → 原对象透传（不产生多余拷贝）");
    });

    it("★ 请求以 assistant 结尾（守护轮续写形状）→ 整请求回退全量回传（严格档）", () => {
        // 协议实证（scripts/reasoning-guard-probe.ts）：最后一条【非 system】消息是 assistant 时，
        // 任何一条 assistant 缺 reasoning_content 即 400（混合态也炸），全带才 200 —— 剥离器必须整体放行。
        const msgs = makeMsgs();
        const draft: any = { role: "assistant", content: "结论草稿", reasoning_content: "草稿思考" };
        // 形状一：草稿即末条
        const bareDraft = [...msgs, draft];
        let out = stripHistoricalReasoning(bareDraft);
        assert.equal(out, bareDraft, "草稿结尾 → 原数组返回（全量回传）");
        assert.equal((out[2] as any).reasoning_content, "先想一下再动手", "历史 assistant 的思考字段也保留");
        // 形状二（守护轮真实线形状）：草稿后跟尾部临时 system nudge —— 末条虽是 system，仍属严格档
        const nudgedDraft = [...msgs, draft, { role: "system", content: "⟦DSC:EARLY_FINAL⟧ 自检是否过早收尾" }];
        out = stripHistoricalReasoning(nudgedDraft);
        assert.equal(out, nudgedDraft, "草稿+尾部 system nudge → 原数组返回（全量回传）");
        assert.equal((out[2] as any).reasoning_content, "先想一下再动手");
    });

    it("末条非 system 为 tool（正常轮 + 尾部 nudge）→ 照常剥离（宽松档）", () => {
        const msgs = [...makeMsgs(), { role: "system", content: "⟦DSC:NUDGE⟧ 继续推进" }];
        const out = stripHistoricalReasoning(msgs);
        assert.ok(!("reasoning_content" in out[2]), "宽松档照剥");
    });

    it("env DEEP_SEEK_REASONING_PASSTHROUGH=1 → 直通还原（全量回传）", () => {
        const msgs = makeMsgs();
        process.env.DEEP_SEEK_REASONING_PASSTHROUGH = "1";
        try {
            const out = stripHistoricalReasoning(msgs);
            assert.equal(out, msgs, "直通时原数组返回");
            assert.equal((out[2] as any).reasoning_content, "先想一下再动手");
        } finally {
            delete process.env.DEEP_SEEK_REASONING_PASSTHROUGH;
        }
    });
});

// ============ 集成：fetch 桩抓出站请求体 ============

describe("出站请求体剥离（streamChat 流式 / summarize 非流式）", () => {
    it("streamChat 默认剥离：出站 assistant 无 reasoning_content", async () => {
        await driveStream(makeMsgs());
        const wire = lastBody.messages;
        assert.ok(!("reasoning_content" in wire[2]), "出站请求不得携带历史思考记录");
        assert.deepEqual(wire[2].tool_calls, makeMsgs()[2].tool_calls);
        assert.equal(wire[3].content, "4");
    });

    it("streamChat env=1：出站请求回传 reasoning_content（还原旧行为）", async () => {
        process.env.DEEP_SEEK_REASONING_PASSTHROUGH = "1";
        try {
            await driveStream(makeMsgs());
            assert.equal(lastBody.messages[2].reasoning_content, "先想一下再动手");
        } finally {
            delete process.env.DEEP_SEEK_REASONING_PASSTHROUGH;
        }
    });

    it("summarize（压缩摘要，全价计费）出站同样剥离", async () => {
        await deepseekProvider.summarize(makeMsgs() as any, undefined, {});
        assert.ok(lastBody.stream === false);
        assert.ok(!("reasoning_content" in lastBody.messages[2]), "压缩输入不得携带历史思考记录");
    });

    it("streamChat 守护轮形状（草稿 assistant + 尾部 system nudge）：出站保持全量回传", async () => {
        const guardShaped = [
            ...makeMsgs(),
            { role: "assistant", content: "草稿", reasoning_content: "草稿思考" },
            { role: "system", content: "⟦DSC:EARLY_FINAL⟧ 自检" },
        ];
        await driveStream(guardShaped);
        const wire = lastBody.messages;
        assert.equal((wire[2] as any).reasoning_content, "先想一下再动手", "严格档：历史思考保留");
        const draft = wire[wire.length - 2] as any;
        assert.equal(draft.reasoning_content, "草稿思考", "严格档：草稿思考保留");
    });

    it("★ streamInference 守护轮（nudge 跟在 assistant 草稿后）：nudge 改写为 user → 宽松档", async () => {
        // 严格档兜底仍会漏「草稿天然无思考字段」的形态（模型简答时 round reasoning=0chars 实测），
        // 根治 = nudge 角色改 user，请求以 user 结尾落宽松档（withNudgeTail）。
        const ctx = {
            message: [...makeMsgs(), { role: "assistant", content: "草稿结论" }],   // 草稿无思考字段（最刁形态）
            nudgeMsg: { role: "system", content: "⟦DSC:EARLY_FINAL⟧ 自检是否过早收尾" },
            sessionId: `rstrip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            depth: 0, round: 2, startTime: performance.now(),
            userDecisionSource: "user" as const, llmDecisionSource: "llm" as const,
            cleanedToolSchemas: [], events: (async () => { }) as any,
            keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000,
        };
        const gen = streamInference(ctx as any);
        let v = await gen.next();
        while (!v.done) v = await gen.next();
        const wire = lastBody.messages;
        assert.equal(wire[wire.length - 1].role, "user", "nudge 已改写为 user（宽松档，绕开严格校验）");
        assert.match(String(wire[wire.length - 1].content), /EARLY_FINAL/);
        assert.ok(!("reasoning_content" in wire[2]), "宽松档下历史思考照常剥离");
    });
});
