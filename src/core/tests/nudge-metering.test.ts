/**
 * @file tests/nudge-metering.test.ts
 * @description nudge.injected 计量端到端守门（T1，施工单 2026-11-13 §2.4 + 收尾清单「无双计数」项）。
 *  真实驱动 runAgent 全管线（桩 provider 按步回放，零 API 成本），断言两件事：
 *  1) 每次拦截/记账恰发一条 nudge.injected——injected:true 只在 :334（pickNudge 消费 pending）出现、
 *     injected:false 只在 :424（interceptFinal dry-run/解除）出现，绝无双计数；
 *  2) off 档零事件；dry 档 VERIFY 走 :424；on 档 fired 经 pending 下一轮 :334 记账且带 disposition。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-nudge-metering-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { runAgent } = await import("@/agent/runAgent.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { appConfig } = await import("@/config/index.ts");
const { agentTools } = await import("@/tool/index.ts");

type Step = { content?: string; toolCalls?: Array<{ name: string; args: any }> };

/** 按调用次序回放的桩 provider：content → 文本轮；toolCalls → 真实注册表可执行的 tool_call 流。
 *  末包补 usage（wire 保真，防空收尾轮被 streamInference 空断流防御重试——同 agent-async-wake 惯例）。 */
const makeScriptedProvider = (script: Step[]): any => {
    let n = 0;
    return {
        id: "metering-stub",
        modelLabel: "metering-stub",
        streamChat: async function* () {
            const step = script[n++] ?? { content: "已完成。" };
            if (step.content) yield { kind: "text", text: step.content };
            const tcs = step.toolCalls ?? [];
            for (let i = 0; i < tcs.length; i++) {
                const tc = tcs[i]!;
                yield { kind: "tool_call_delta", index: i, id: `call_${n}_${i}`, type: "function", nameDelta: tc.name };
                yield { kind: "tool_call_delta", index: i, argumentsDelta: JSON.stringify(tc.args ?? {}) };
            }
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
};

/** 驱动 runAgent：真实 agentTools（write_file 真执行、真走 onToolOutcome 回调），事件旁路全量捕获。 */
const drive = async (provider: any, userPrompt: string) => {
    setActiveProvider(provider);
    const captured: any[] = [];
    try {
        const options: any = {
            sessionId: `metering-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            cwd: SANDBOX, toolSchemas: agentTools, modelWindow: 10_000_000,
            keepRecentUnits: 9999, compactRatio: 1.4, parentSystemPrompt: "【测试规范】仅用于守门回归。",
            events: async (b: any) => { captured.push(b); },
            requestApproval: async () => "allow-once",   // 无头审批（内存放行，eval 同款，不污染权限配置）
            depth: 0,
        };
        const yielded: any[] = [];
        for await (const e of runAgent([{ role: "system", content: "s" }, { role: "user", content: userPrompt }], options)) {
            yielded.push(e);
        }
        return { captured, yielded };
    } finally {
        resetActiveProvider();
    }
};

const nudgeEvents = (captured: any[]): any[] => captured.filter((e) => e?.eventType === "nudge.injected");

describe("nudge.injected 计量（runAgent 端到端）", () => {
    it("PHANTOM：injected:true 只在 :334 出现——空响应轮拦截恰发一条事件，无双计数", async () => {
        // 步骤1 = 仅 usage 无正文无工具（模型层空回复 → emptyAssistant 防御跳过 → PHANTOM 拦截 continue）；
        // 步骤2 = 正常文本收尾。若 :424 也发 injected:true，本用例会数出 2 条 → 红。
        const { captured, yielded } = await drive(makeScriptedProvider([{ usageOnly: true } as any, { content: "已完成验证" }]), "验证任务");
        const evts = nudgeEvents(captured);
        assert.equal(evts.length, 1, `PHANTOM 一次拦截必须恰发一条 nudge.injected，实际 ${evts.length}`);
        assert.equal(evts[0]!.metadata.fence, "PHANTOM");
        assert.equal(evts[0]!.metadata.injected, true);
        assert.equal(evts[0]!.metadata.depth, 0);
        assert.equal(evts[0]!.metadata.round, 2, "事件在 pending 消费轮（第 2 轮）记账");
        assert.ok(yielded.some((e) => e?.type === "final"), "拦截后正常收尾");
    });

    it("dry 档 VERIFY：write_file 真改代码 → final 无验证 → :424 恰发一条 injected:false（fired）", async () => {
        assert.equal(appConfig.verifyFenceMode, "dry", "本文件 env 未设 DEEP_SEEK_VERIFY_FENCE，默认 dry");
        const { captured, yielded } = await drive(
            makeScriptedProvider([
                { toolCalls: [{ name: "write_file", args: { path: "a.ts", content: "export const x = 1;\n" } }] },
                { content: "已完成，改动如下。" },
            ]),
            "改一下 a.ts",
        );
        const evts = nudgeEvents(captured);
        assert.equal(evts.length, 1, `dry 档 fired 必须恰发一条（:424 出口），实际 ${evts.length}`);
        assert.equal(evts[0]!.metadata.fence, "VERIFY_UNPROVEN");
        assert.equal(evts[0]!.metadata.injected, false, "dry 档不推轮");
        assert.equal(evts[0]!.metadata.disposition, "fired");
        // 真实工具链路证明：write_file 的 ok:true 结局确实经 onToolOutcome 武装了调度器（否则不会有 VERIFY 事件）
        const finalEvt = yielded.find((e) => e?.type === "final");
        assert.ok(finalEvt, "dry 档记账后放行收尾（不 continue）");
    });

    it("off 档：全场景零 nudge.injected 事件（判定全关，§2.4 用例 8 事件层）", async () => {
        const prev = appConfig.verifyFenceMode;
        appConfig.verifyFenceMode = "off";
        try {
            const { captured } = await drive(
                makeScriptedProvider([
                    { toolCalls: [{ name: "write_file", args: { path: "b.ts", content: "export const y = 2;\n" } }] },
                    { content: "已完成，改动如下。" },
                ]),
                "改一下 b.ts",
            );
            assert.equal(nudgeEvents(captured).length, 0, "off 档不发任何 nudge.injected");
        } finally {
            appConfig.verifyFenceMode = prev;
        }
    });

    it("on 档 fired：真推一轮——pending 下一轮 :334 记账，恰一条 injected:true（带 disposition）", async () => {
        const prev = appConfig.verifyFenceMode;
        appConfig.verifyFenceMode = "on";
        try {
            const { captured, yielded } = await drive(
                makeScriptedProvider([
                    { toolCalls: [{ name: "write_file", args: { path: "c.ts", content: "export const z = 3;\n" } }] },
                    { content: "已完成，改动如下。" },                                   // 第 2 轮 final → fired 拦截
                    { content: "已完成。已重读全部改动确认无误，本次验证不适用。" },        // 第 3 轮放行收尾
                ]),
                "改一下 c.ts",
            );
            const evts = nudgeEvents(captured);
            assert.equal(evts.length, 1, `on 档 fired 必须恰发一条（:334 pending 消费），实际 ${evts.length}`);
            assert.equal(evts[0]!.metadata.fence, "VERIFY_UNPROVEN");
            assert.equal(evts[0]!.metadata.injected, true, "on 档真注入");
            assert.equal(evts[0]!.metadata.disposition, "fired", "disposition 经 NudgeMsg 透传（§2.2⑤）");
            assert.equal(evts[0]!.metadata.round, 3, "记账轮 = pending 消费轮");
            const finals = yielded.filter((e) => e?.type === "final");
            assert.equal(finals.length, 1, "拦截轮不产 final，模型获得一次补验证机会后放行");
        } finally {
            appConfig.verifyFenceMode = prev;
        }
    });
});
