/**
 * @file tests/overlength-forced-compact.test.ts
 * @description 评审修复施工单 B1（2026-11-23，C2）守门：streamInference 的「API 400 超长 → 强制压缩重试」
 *  兜底必须给 ensureFitsWindow 传 forceCompact: true。
 *
 *  修前口子：兜底调用不传 forceCompact，判定用 est×1.4+T ≤ modelWindow×阈值——真实窗口低于约 13 万
 *  token 的模型（est 远小于本地 250K 级窗口）此判定必然 noop，重试后再次 400（物理熔断前最后一次
 *  自救机会被白白放掉）。
 *
 *  判定原理（夹具自证两态）：history est ≈10K token、threshold = 30K×0.5×1.0 = 15K →
 *  est×1.4(缺省 correctionRatio)=14K ≤ 15K → 修前 noop（连 context.check 事件都不发，事件仅
 *  decision≠noop 才发）；修后 forceCompact 直通压缩 → context.check windowDecision='compact' +
 *  摘要请求真实发生。「context.check(compact) 存在」即 forceCompact 传导的机器判定。
 *
 *  沙盒惯例：dataDir 先于动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-overlength-b1-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑）。
const { streamInference } = await import("@/agent/streamInference.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");

/** 假 provider：首次 streamChat 抛 context_length 400，此后正常出文本。summarize 记录每次请求。 */
const makeProvider = () => {
    const streamCalls: number[] = [];
    const summarizeSizes: number[] = [];
    const provider: any = {
        id: "fake", displayName: "Fake", modelLabel: "Fake",
        streamChat: async function* (messages: any[], _tools: any, _opts: any) {
            streamCalls.push(messages.length);
            if (streamCalls.length === 1) {
                const err: any = new Error("This model's maximum context length is exceeded");
                err.status = 400;
                err.code = "context_length_exceeded";
                throw err;
            }
            yield { kind: "text", text: "压缩后重试成功" };
            yield { kind: "usage", usage: { prompt_tokens: 12, completion_tokens: 4 } };
        },
        isContextLengthError: (e: any) => e?.status === 400,
        isTransientError: () => false,
        isImageUnsupportedError: () => false,
        classifyRisk: async () => "risky",
        summarize: async (m: any[]) => {
            summarizeSizes.push(JSON.stringify(m).length);
            return { choices: [{ message: { content: "Fake 摘要：历史已归档" } }] } as any;
        },
        buildAssistantMessage: (p: any) => ({ role: "assistant", content: p.content ?? "" }) as any,
    };
    return { provider, streamCalls, summarizeSizes };
};

/** est ≈10K token 的历史（40K ASCII ÷4）：阈值 = 30K×0.5×1.0 = 15K，est×1.4(缺省)=14K ≤ 15K →
 *  修前无 forceCompact 必 noop；这是「forceCompact 传导」判定的成立前提。 */
const buildHistory = (): any[] => [
    { role: "system", content: "SYS" },
    { role: "system", content: "" },   // 摘要槽
    { role: "user", content: "读大日志并总结要点" },
    {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"cat huge.log"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "A".repeat(40_000) },
    { role: "assistant", content: "已读取完毕，开始整理" },
    { role: "user", content: "继续" },
];

describe("streamInference 超长降级兜底 forceCompact（评审修复 B1）", () => {
    it("API 400 超长 → ensureFitsWindow 收到 forceCompact（context.check windowDecision='compact'）→ 压缩后重试成功", async () => {
        const { provider, streamCalls, summarizeSizes } = makeProvider();
        const message = buildHistory();
        const evts: any[] = [];
        setActiveProvider(provider);
        let result;
        try {
            const gen = streamInference({
                message: message as any,
                nudgeMsg: null,
                sessionId: "overlength-b1",
                depth: 0,
                round: 1,
                startTime: performance.now(),
                userDecisionSource: "user" as any,
                llmDecisionSource: "llm" as any,
                signal: undefined,
                cleanedToolSchemas: [],
                events: (e: any) => { evts.push(e); },
                keepRecentUnits: 1,
                compactRatio: 0.5,
                modelWindow: 30_000,
            } as any);
            // 驱动 generator 至终态并取 return value
            result = (await gen.next()).value as any;
            while (true) {
                const n = await gen.next();
                if (n.done) { result = n.value; break; }
            }
        } finally { resetActiveProvider(); }

        assert.equal(result?.kind, "completed", `降级重试应完成，实际 ${result?.kind}`);
        assert.equal((result as any)?.assistantMessage?.content, "压缩后重试成功");
        assert.equal(streamCalls.length, 2, "首请求 400 后重试恰一次");
        // 降级分支确实走过（llm.contextDowngraded 落 trace）
        assert.ok(evts.some((e) => e.eventType === "llm.contextDowngraded"), "超长降级分支已触发");
        // ★ B1 机器判定：est(≈10K)×1.4=14K ≤ 阈值 15K，自动判定必 noop（修前连 context.check 事件都不发）；
        //   context.check 且 windowDecision='compact' 出现 = forceCompact 直通压缩被传导（修前此断言必红）。
        const check = evts.find((e) => e.eventType === "context.check");
        assert.ok(check, "应发出 context.check（noop 不发——出现即证非 noop）");
        assert.equal(check.metadata.windowDecision, "compact", "windowDecision='compact' = forceCompact 已传导");
        // 压缩真实发生：摘要请求 ≥1 次、历史收缩、摘要槽更新
        assert.ok(summarizeSizes.length >= 1, "压缩应发起摘要请求");
        assert.ok(message.length < 7, `历史应收缩（修前 noop 保持 7 条），实际 ${message.length}`);
        assert.ok(String((message[1] as any)?.content).includes("Fake 摘要"), "摘要槽应写入合成产物");
    });
});
