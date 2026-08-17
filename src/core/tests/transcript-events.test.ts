/**
 * @file tests/transcript-events.test.ts
 * @description 事件日志化单测（第二梯队 #1）：事件行读写与过滤、中断判定三档、孤儿修复双档、
 *  recoverSession 幂等补闭墓、压缩 desync 交叉校验（信 state）、buildContextMessages 端到端接线、
 *  fork 前缀派生 + 字节级拷贝 + state 派生、listSessions 事件行不计数。
 *  沙盒隔离：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前指向临时目录（appConfig 模块加载期读 env），
 *  故全部 core 模块走动态 import。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-tev-"));
// ★ 动态 import：appConfig / store 在模块加载期固化 dataDir，必须先设 env 再加载
const { appendMessage, appendEvent, readTranscriptLines, readMessages, isEventLine } = await import("../src/session/transcript.ts");
const { detectInterruption, repairOrphanToolCalls, reconcileCompaction, recoverSession } = await import("../src/session/recovery.ts");
const { buildContextMessages } = await import("../src/session/content.ts");
const { derivePrefix, forkSession } = await import("../src/session/fork.ts");
const { getRollingState, setRollingState, updateCalibration, listSessions, getTranscriptPath } = await import("../src/session/store.ts");

// —— fixture 构造 ——
let seq = 0;
const sid = (): string => `tevsess${++seq}`;
const userMsg = (text: string): any => ({ role: "user", content: text });
const assistantWithCalls = (...ids: string[]) => ({
    role: "assistant",
    content: "",
    tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "demo_tool", arguments: "{}" } })),
});
const toolResult = (id: string, content = "ok") => ({ role: "tool", tool_call_id: id, content });
/** 无悬空 tool_call 校验：每个 assistant.tool_calls[].id 必须被紧随的 tool 行应答 */
const findDangling = (msgs: any[]): string[] => {
    const dangling: string[] = [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
            const answered = new Set<string>();
            let j = i + 1;
            while (j < msgs.length && msgs[j].role === "tool") { answered.add(msgs[j].tool_call_id); j++; }
            for (const tc of m.tool_calls) if (tc.id && !answered.has(tc.id)) dangling.push(tc.id);
        }
    }
    return dangling;
};

describe("transcript 事件行（appendEvent / readTranscriptLines / readMessages 过滤）", () => {
    it("事件行追加保序；readMessages 过滤后只余消息行", async () => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("hi") } as any);
        await appendEvent(s, { dscEvent: "run.start", runId: "r1", depth: 0 });
        await appendMessage({ sessionId: s, role: "assistant", content: "ok" } as any);
        await appendEvent(s, { dscEvent: "round.end", runId: "r1", round: 1, usage: { prompt_tokens: 10, completion_tokens: 5 } });
        await appendEvent(s, { dscEvent: "run.end", runId: "r1", stopReason: "normal", rounds: 1, usage: { prompt_tokens: 10 } });
        const lines = await readTranscriptLines(s);
        assert.equal(lines.length, 5, "5 行全量保序");
        assert.equal(isEventLine(lines[1]), true);
        assert.equal(isEventLine(lines[0]), false);
        assert.deepEqual((await readMessages(s)).map((m: any) => m.role), ["user", "assistant"], "readMessages 只回消息行");
    });
});

describe("detectInterruption（中断判定三档）", () => {
    it("clean / crashed / legacy", () => {
        const runStart = { id: "e1", ts: "t", dscEvent: "run.start", runId: "ra", depth: 0 };
        const runEnd = { id: "e2", ts: "t", dscEvent: "run.end", runId: "ra", stopReason: "normal", rounds: 1 };
        assert.equal(detectInterruption([userMsg("q"), runStart, { role: "assistant", content: "a" }, runEnd] as any).kind, "clean");
        const crashed = detectInterruption([userMsg("q"), runStart, { role: "assistant", content: "a" }] as any);
        assert.equal(crashed.kind, "crashed");
        assert.equal((crashed as any).runId, "ra");
        // run.abandoned 同样闭合（恢复层补写后不再误报）
        assert.equal(detectInterruption([runStart, { id: "e3", ts: "t", dscEvent: "run.abandoned", runId: "ra", reason: "x" }] as any).kind, "clean");
        assert.equal(detectInterruption([userMsg("q"), { role: "assistant", content: "a" }] as any).kind, "legacy", "无事件行 = 旧会话");
    });
});

describe("recoverSession（幂等补闭墓 + 孤儿修复双档）", () => {
    it("崩溃 run → 补 run.abandoned 一次且仅一次；二次打开判 clean", async () => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("任务") } as any);
        await appendEvent(s, { dscEvent: "run.start", runId: "runX", depth: 0 });
        await appendMessage({ sessionId: s, ...assistantWithCalls("c1", "c2") } as any);
        await appendMessage({ sessionId: s, ...toolResult("c1") } as any); // c2 未应答 = 崩溃孤儿
        const first = await recoverSession(s);
        assert.equal(first.interruption.kind, "crashed");
        const abandoned1 = (await readTranscriptLines(s)).filter((l: any) => l?.dscEvent === "run.abandoned");
        assert.equal(abandoned1.length, 1);
        assert.equal((abandoned1[0] as any).runId, "runX");
        const second = await recoverSession(s);
        assert.equal(second.interruption.kind, "clean", "闭墓后不再误报 crashed");
        assert.equal((await readTranscriptLines(s)).filter((l: any) => l?.dscEvent === "run.abandoned").length, 1, "幂等：不重复补写");
    });

    it("孤儿修复双档：confirmedCrash 文案精确 / 启发式档文案与改造前黄金一致", async () => {
        const msgs: any = [userMsg("q"), assistantWithCalls("c1", "c2"), toolResult("c1")];
        const confirmed = repairOrphanToolCalls(msgs, true);
        assert.deepEqual(confirmed.repairedToolCallIds, ["c2"]);
        const heuristic = repairOrphanToolCalls(msgs, false);
        assert.deepEqual(heuristic.repairedToolCallIds, ["c2"]);
        const confirmedText = (confirmed.msgs.find((m: any) => m.role === "tool" && m.tool_call_id === "c2") as any).content;
        const heuristicText = (heuristic.msgs.find((m: any) => m.role === "tool" && m.tool_call_id === "c2") as any).content;
        assert.ok(confirmedText.includes("崩溃"), "崩溃确认档文案");
        assert.equal(heuristicText, "（该工具调用因上次会话异常中断未留下结果，已跳过。）", "启发式档 = 改造前文案（黄金）");
    });
});

describe("buildContextMessages（恢复接线端到端）", () => {
    it("崩溃会话续接：产出无悬空 tool_call，布局 [system, 摘要槽, ...active, 本次 user]", async () => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("任务") } as any);
        await appendEvent(s, { dscEvent: "run.start", runId: "runY", depth: 0 });
        await appendMessage({ sessionId: s, ...assistantWithCalls("k1", "k2") } as any);
        await appendMessage({ sessionId: s, ...toolResult("k1") } as any);
        const messages: any = await buildContextMessages(s, userMsg("继续"), "SYS");
        assert.equal(messages[0].role, "system");
        assert.equal(messages[0].content, "SYS");
        assert.equal(messages[1].role, "system");
        assert.equal(messages[messages.length - 1].content, "继续");
        assert.equal(findDangling(messages).length, 0, "崩溃孤儿已被补占位，无悬空 tool_call_id");
        // 崩溃确认档已生效（文案区分）且 run.abandoned 已由本次调用补写（契约允许的一次有界写）
        assert.ok((messages.find((m: any) => m.role === "tool" && m.tool_call_id === "k2") as any).content.includes("崩溃"));
        assert.equal((await readTranscriptLines(s)).some((l: any) => l?.dscEvent === "run.abandoned"), true);
    });

    it("legacy 无事件会话：启发式档（= 改造前行为），零碰盘副作用", async () => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("老会话") } as any);
        await appendMessage({ sessionId: s, ...assistantWithCalls("o1", "o2") } as any);
        await appendMessage({ sessionId: s, ...toolResult("o1") } as any);
        const before = (await readTranscriptLines(s)).length;
        const messages: any = await buildContextMessages(s, userMsg("go"), "SYS");
        assert.equal((messages.find((m: any) => m.role === "tool" && m.tool_call_id === "o2") as any).content,
            "（该工具调用因上次会话异常中断未留下结果，已跳过。）", "legacy 档文案与改造前一致");
        assert.equal((await readTranscriptLines(s)).length, before, "不追加任何事件行");
    });

    it("desync 时 slice 信 state：事件说 1、state 说 2 → active 取后 2 条", async () => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("1") } as any);
        await appendMessage({ sessionId: s, role: "assistant", content: "a1" } as any);
        await appendEvent(s, { dscEvent: "compaction", archivedMessageCount: 1, summary: "S" }); // 事件镜像偏旧
        await appendMessage({ sessionId: s, ...userMsg("2") } as any);
        await appendMessage({ sessionId: s, role: "assistant", content: "a2" } as any);
        await setRollingState(s, { rollingSummary: "SUM", archivedMessageCount: 2, consecutiveFailures: 0 });
        const messages: any = await buildContextMessages(s, userMsg("next"), "SYS");
        assert.equal(messages[1].content, "SUM");
        assert.equal(messages.length, 5, "2 槽 + 2 条 active + 本次 user");
        assert.equal(findDangling(messages).length, 0);
    });
});

describe("reconcileCompaction（纯函数）", () => {
    it("state-ahead / none / legacy", () => {
        const evts = [{ id: "e1", ts: "t", dscEvent: "compaction", archivedMessageCount: 8, summary: "S" }] as any;
        const ahead = reconcileCompaction({ archivedMessageCount: 10, rollingSummary: "S2" }, evts);
        assert.equal(ahead.desync, "state-ahead");
        assert.equal(ahead.archivedMessageCount, 10, "信 state（slice 执行闸门）");
        assert.equal(reconcileCompaction({ archivedMessageCount: 8, rollingSummary: "S" }, evts).desync, "none");
        assert.equal(reconcileCompaction({ archivedMessageCount: 0, rollingSummary: "" }, []).desync, "legacy");
    });
});

describe("derivePrefix / forkSession（会话分叉）", () => {
    /** 标准源：turn1 完整闭合 + turn2 未闭合（含 compaction） */
    const buildSource = async (): Promise<string> => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("a") } as any);
        await appendEvent(s, { dscEvent: "run.start", runId: "f1", depth: 0 });
        await appendMessage({ sessionId: s, role: "assistant", content: "ans1" } as any);
        await appendEvent(s, { dscEvent: "run.end", runId: "f1", stopReason: "normal", rounds: 1 });
        await appendMessage({ sessionId: s, ...userMsg("b") } as any);
        await appendEvent(s, { dscEvent: "run.start", runId: "f2", depth: 0 });
        await appendEvent(s, { dscEvent: "compaction", archivedMessageCount: 3, summary: "SUM3" });
        await appendMessage({ sessionId: s, role: "assistant", content: "ans2" } as any);
        return s;
    };

    it("derivePrefix：缺省 = 最后一个已完成 turn；显式锚点派生 compaction；未闭合携带 runId", async () => {
        const s = await buildSource();
        const lines = await readTranscriptLines(s);
        const def = derivePrefix(lines);
        assert.equal(def.lines.length, 4, "切到 turn1 的 run.end（turn2 未闭合，不进缺省前缀）");
        assert.equal(def.archivedMessageCount, 0);
        assert.equal(def.rollingSummary, "");
        assert.equal(def.unclosedRunId, undefined, "前缀内无未闭合 run");
        const lastLineId = (lines[lines.length - 1] as any).id;
        const explicit = derivePrefix(lines, lastLineId);
        assert.equal(explicit.lines.length, lines.length);
        assert.equal(explicit.archivedMessageCount, 3, "compaction 派生自前缀内末个事件");
        assert.equal(explicit.rollingSummary, "SUM3");
        assert.equal(explicit.unclosedRunId, "f2", "fork 点落在未闭合 run 内 → 携带 runId");
        assert.throws(() => derivePrefix(lines, "no-such-line"), /未找到/);
    });

    it("forkSession：前缀字节级一致 + state 派生（校准透传/标题）+ 未闭合补闭墓", async () => {
        const s = await buildSource();
        const lines = await readTranscriptLines(s);
        const lastLineId = (lines[lines.length - 1] as any).id;
        // ★ setRollingState 只落 3 个核心字段；calibRatio 走 updateCalibration（与产线同路径）
        await setRollingState(s, { rollingSummary: "OLD", archivedMessageCount: 0, consecutiveFailures: 0 });
        await updateCalibration(s, { calibRatio: 1.7 });
        const fork = await forkSession(s, lastLineId);
        assert.equal(fork.copiedLines, lines.length);
        assert.equal(fork.archivedMessageCount, 3, "state 派生自前缀内 compaction 事件（不信源 state）");
        const st = await getRollingState(fork.sessionId);
        assert.equal(st.rollingSummary, "SUM3");
        assert.equal(st.calibRatio, 1.7, "校准数据从源透传");
        // 字节级一致：目标前 copiedLines 行与源原始文本前缀逐行相等（未重新序列化）
        const srcRaw = (await fs.readFile(getTranscriptPath(s), "utf-8")).split("\n");
        const dstRaw = (await fs.readFile(getTranscriptPath(fork.sessionId), "utf-8")).split("\n");
        const dstLines = await readTranscriptLines(fork.sessionId);
        assert.equal(dstLines.length, lines.length + 1, "拷贝行 + 恰好一行 run.abandoned");
        assert.equal((dstLines[dstLines.length - 1] as any).dscEvent, "run.abandoned");
        assert.equal((dstLines[dstLines.length - 1] as any).runId, "f2");
        for (let i = 0; i < srcRaw.length; i++) {
            if (srcRaw[i].trim() === "") continue;
            assert.equal(dstRaw[i], srcRaw[i], `第 ${i} 行应字节级一致（无重序列化）`);
        }
    });

    it("forkSession：legacy 源缺省 = state 克隆；错误路径（源不存在/锚点未找到）", async () => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("仅消息") } as any);
        await appendMessage({ sessionId: s, role: "assistant", content: "回" } as any);
        await setRollingState(s, { rollingSummary: "LEG", archivedMessageCount: 1, consecutiveFailures: 0 });
        const f = await forkSession(s);
        const st = await getRollingState(f.sessionId);
        assert.equal(st.archivedMessageCount, 1, "legacy 整文件 fork → state 克隆");
        assert.equal(st.rollingSummary, "LEG");
        await assert.rejects(() => forkSession("tevsessNotExist404"), /不存在/);
        await assert.rejects(() => forkSession(s, "no-such-line"), /未找到/);
    });
});

describe("listSessions（事件行不计数）", () => {
    it("messageCount 只数消息行", async () => {
        const s = sid();
        await appendMessage({ sessionId: s, ...userMsg("计数") } as any);
        await appendEvent(s, { dscEvent: "run.start", runId: "n1", depth: 0 });
        await appendMessage({ sessionId: s, role: "assistant", content: "ok" } as any);
        await appendEvent(s, { dscEvent: "run.end", runId: "n1", stopReason: "normal", rounds: 1 });
        const item = (await listSessions()).find((x) => x.sessionId === s);
        assert.ok(item, "会话应被枚举到");
        assert.equal(item?.messageCount, 2, "事件行不计入消息数");
        assert.equal(item?.preview, "计数", "首条 user 预览正常");
    });
});
