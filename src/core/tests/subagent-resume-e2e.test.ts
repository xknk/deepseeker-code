/**
 * @file tests/subagent-resume-e2e.test.ts
 * @description 子 Agent 续跑端到端（ReplayProvider 驱动 runAgent 真实主循环，零 API 成本）：
 *  A) 新建派生 → final 采集 + transcript 落盘；
 *  B) 同 ID 续跑 → ★核心断言：第二次模型调用的 messages 里恢复出第一轮完整历史
 *     （user 任务 + assistant 结论）且末尾是新指令，系统词注入【续跑说明】；
 *  C) fork 时间线续跑 → forkSession(p1) 出的 f1 续跑原时间线子会话，血缘归属放行（本次改动核心验收点）。
 *
 *  断言依据 ReplayProvider.calls：每次 streamChat 的入参快照（模型实际看到了什么）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-sub-resume-e2e-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");
const { setActiveProvider } = await import("@/llm/model.ts");
const { runSubagent } = await import("@/agent/subagent.ts");
const { appendMessage, readTranscriptLines } = await import("@/session/transcript.ts");
const { forkSession } = await import("@/session/fork.ts");
const { createNudgeScheduler } = await import("@/agent/agentNudges.ts");

// 三轮剧本（每场景一轮）：文本【故意不含】looksComplete 完成声明词（告一段落/处理好了/推进中…）——
// 子 agent 经 noEarlyFinal 关闭了 EARLY_FINAL 早收尾守护（runSubagent 置位），无声明词也单轮干净收尾；
// 若守护回退（误开），每场景将被多推一轮 → calls 数变 6、final 错位，D 项断言即红。
const replay = createReplayProvider({ turns: [
    { kind: "reply", content: "第一轮汇报：任务A的前半部分告一段落，产出已就位。" },
    { kind: "reply", content: "续跑汇报：剩余部分也处理好了，此前进展回顾见上。" },
    { kind: "reply", content: "fork 时间线续跑汇报：基于磁盘最新状态继续推进。" },
] });
setActiveProvider(replay);

const makeCtx = (sessionId: string): any => ({
    sessionId,
    depth: 0,
    cwd: SANDBOX,
    keepRecentUnits: 9999,   // 压缩不触发（聚焦续跑链路；压缩路径另有专项测试）
    compactRatio: 1.4,
    modelWindow: 10_000_000,
    parentSystemPrompt: "【测试规范】仅用于端到端回归。",
    events: async () => { }, // 观测埋点 no-op
});

describe("子 Agent 续跑端到端（ReplayProvider）", () => {
    const ctx = makeCtx("p1");
    let agentId = "";

    it("A. 新建派生：final 采集 + transcript 落盘 + 首轮上下文布局", async () => {
        const res = await runSubagent({ task: "执行任务A" }, ctx, () => []);
        assert.equal(res.ok, true, `应成功：${res.output}`);
        assert.match(res.output, /第一轮汇报/, "final 文本透传");
        assert.match(res.sessionId, /^p1__sub__/, "子会话 ID 形态");

        agentId = res.sessionId;
        const lines = await readTranscriptLines(agentId);
        assert.ok(lines.length >= 2, "transcript 已落盘（user + assistant 至少两行）");

        const msgs = replay.calls[0]!.messages;
        assert.equal(msgs[0]!.role, "system", "[0]=system 布局");
        assert.equal(msgs[1]!.role, "system", "[1]=摘要槽布局");
        assert.doesNotMatch(String(msgs[0]!.content), /续跑说明/, "新建路径不注入续跑说明");
        const last = msgs[msgs.length - 1]! as any;
        assert.equal(last.role, "user");
        assert.equal(last.content, "执行任务A", "末尾为本次任务指令");
    });

    it("B. 同 ID 续跑：模型实际看到第一轮历史 + 新指令 + 续跑说明注入", async () => {
        const before = (await readTranscriptLines(agentId)).length;
        const res = await runSubagent({ task: "继续完成任务A的剩余部分", resumeSessionId: agentId }, ctx, () => []);
        assert.equal(res.ok, true, `续跑应成功：${res.output}`);
        assert.equal(res.sessionId, agentId, "复用同一子会话 ID");
        assert.match(res.output, /续跑汇报/);
        assert.ok((await readTranscriptLines(agentId)).length > before, "同一 transcript 追加增长");

        // ★ 核心断言：续跑场景首次模型调用的上下文 = 历史完整恢复（A 消耗 calls[0]，B 首轮 = calls[1]）
        const msgs = replay.calls[1]!.messages;
        const flat = msgs.map((m: any) => `${m.role}:${typeof m.content === "string" ? m.content : ""}`).join("\n");
        assert.ok(flat.includes("执行任务A"), "第一轮 user 任务恢复在上下文");
        assert.ok(flat.includes("第一轮汇报"), "第一轮 assistant 结论恢复在上下文");
        assert.match(String(msgs[0]!.content), /【续跑说明】/, "系统词注入续跑回顾提示");
        const last = msgs[msgs.length - 1]! as any;
        assert.equal(last.content, "继续完成任务A的剩余部分", "末尾为续跑新指令");
    });

    it("C. fork 时间线续跑原子会话：血缘归属放行（f1 ← p1）", async () => {
        // 造父会话历史并 fork（f1 的 state 落盘 forkedFrom=p1）
        await appendMessage({ sessionId: "p1", role: "user", content: "父会话的一轮提问" });
        const { sessionId: f1 } = await forkSession("p1");

        const res = await runSubagent(
            { task: "在 fork 时间线上继续任务A", resumeSessionId: agentId },
            makeCtx(f1),
            () => [],
        );
        assert.equal(res.ok, true, `fork 会话续跑原时间线子会话应放行：${res.output}`);
        assert.match(res.output, /fork 时间线续跑汇报/);
        assert.equal(res.sessionId, agentId, "仍复用原子会话 ID（不新建）");

        const flat = replay.calls[2]!.messages.map((m: any) => `${m.role}:${typeof m.content === "string" ? m.content : ""}`).join("\n");
        assert.ok(flat.includes("第一轮汇报"), "fork 时间线续跑同样恢复完整历史");
    });

    it("D. 游标 sanity：无完成声明词仍每场景单轮收尾（noEarlyFinal 生效），无多余模型调用", () => {
        assert.equal(replay.calls.length, 3);
        assert.equal(replay.cursor, 3);
    });
});

describe("createNudgeScheduler noEarlyFinal 开关（守护分层对照）", () => {
    const shortNoDeclare = "任务做了一部分，先这样。"; // 无完成声明词、非空
    const complexTask = "请帮我实现用户登录功能，涉及多个文件的改动"; // 命中 looksComplex（多个文件、≥20 字）

    it("缺省（主 agent）+ 明确实现型任务：EARLY_FINAL 拦截无声明早收尾", () => {
        assert.equal(createNudgeScheduler({ firstPrompt: complexTask }).interceptFinal(shortNoDeclare, 1), true);
    });

    it("非任务型输入（寒暄/闲聊提问/含糊短句）：零工具轮不武装、放行收尾", () => {
        // 2026-09-11「你好」被逼写结题报告事故：非任务型输入枚举不完，按信号武装（开过工/实现型任务）而非白名单
        assert.equal(createNudgeScheduler({ firstPrompt: "你好" }).interceptFinal("你好！我是 DeepSeeker-Code。", 1), false);
        assert.equal(createNudgeScheduler({ firstPrompt: "hi!" }).interceptFinal(shortNoDeclare, 1), false);
        assert.equal(createNudgeScheduler({ firstPrompt: "你觉得 AI 会取代程序员吗" }).interceptFinal(shortNoDeclare, 1), false);
        // 有意收窄：模糊短任务零工具轮不再拦（救回责任交还用户追问），复杂任务仍拦（见上一条）
        assert.equal(createNudgeScheduler({ firstPrompt: "做个小任务" }).interceptFinal(shortNoDeclare, 1), false);
    });

    it("开过工（本 run 有工具调用）：长文本零声明收尾仍武装（长文本不触发 TOOL_DIGEST，此处靠 EARLY_FINAL）", () => {
        const longNoDeclare = "让我梳理一下目前的进展和思路，整体情况比较复杂，涉及多个层面的问题还需要进一步分析。";
        const s = createNudgeScheduler({});
        s.noteToolCall(1, [{ function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]);
        assert.equal(s.interceptFinal(longNoDeclare, 2), true);
    });

    it("noEarlyFinal（子 agent）：守护武装时同文本放行真实收尾", () => {
        assert.equal(createNudgeScheduler({ noEarlyFinal: true, firstPrompt: complexTask }).interceptFinal(shortNoDeclare, 1), false);
    });

    it("PHANTOM 不受开关影响：空 content 仍拦截（正确性兜底保留）", () => {
        assert.equal(createNudgeScheduler({ noEarlyFinal: true }).interceptFinal("", 1), true);
    });
});
