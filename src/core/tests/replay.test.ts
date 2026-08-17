/**
 * @file tests/replay.test.ts
 * @description buildReplayRows 单测：transcript → 可渲染行重建。
 *  覆盖 user/assistant/thinking 行、tool_calls 与 tool 结果按 id 配对、未配对收尾、损坏降级。
 *  这是 --resume / --continue / /sessions 回放的核心纯逻辑，脱离 TUI 即可验。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildReplayRows } from "../../cli/src/replay.ts";

/** 每个用例独立的 id 生成器（避免跨用例累加，断言只关心 kind/顺序/内容）。 */
const newNid = (): (() => number) => {
    let n = 0;
    return () => ++n;
};

describe("buildReplayRows（transcript → 行重建）", () => {
    it("user/assistant 文本 → 对应行；system 等其它角色跳过", () => {
        const rows = buildReplayRows([
            { role: "system", content: "sys prompt" },
            { role: "user", content: "你好" },
            { role: "assistant", content: "hi" },
        ], newNid());
        assert.equal(rows.length, 2);
        assert.equal(rows[0].kind, "user");
        assert.equal((rows[0] as { text: string }).text, "你好");
        assert.equal(rows[1].kind, "assistant");
        assert.equal((rows[1] as { text: string }).text, "hi");
    });

    it("assistant.reasoning_content → thinking 行（已完成态、无耗时）", () => {
        const rows = buildReplayRows([
            { role: "assistant", reasoning_content: "让我想想", content: "答案" },
        ], newNid());
        assert.equal(rows.length, 2);
        const th = rows[0] as { kind: string; streaming?: boolean; durationMs?: number; text: string };
        assert.equal(th.kind, "thinking");
        assert.equal(th.streaming, false, "回放思考应为已完成态");
        assert.equal(th.durationMs, undefined, "回放思考无耗时，不显示秒数");
        assert.equal(rows[1].kind, "assistant");
    });

    it("tool_calls 与 tool 结果按 tool_call_id 配对：先占位 running，结果回填为 done", () => {
        const rows = buildReplayRows([
            { role: "user", content: "读文件" },
            { role: "assistant", content: "", tool_calls: [
                { id: "call_1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
            ] },
            { role: "tool", tool_call_id: "call_1", content: "file body" },
        ], newNid());
        assert.equal(rows.length, 2, "空 assistant.content 不生成行；user + tool 各一行");
        assert.equal(rows[0].kind, "user");
        const tool = rows[1] as {
            kind: string; toolName: string; toolCallId: string; status: string;
            result?: string; ok?: boolean; args?: unknown;
        };
        assert.equal(tool.kind, "tool");
        assert.equal(tool.toolName, "read_file");
        assert.equal(tool.toolCallId, "call_1");
        assert.equal(tool.status, "done");
        assert.equal(tool.result, "file body");
        assert.equal(tool.ok, true);
        assert.deepEqual(tool.args, { path: "a.ts" });
    });

    it("未配对的 tool_call（被中断、无 tool 结果）→ 收尾 done + ok:false，不永挂 running", () => {
        const rows = buildReplayRows([
            { role: "assistant", tool_calls: [
                { id: "call_x", function: { name: "run_command", arguments: '{"command":"x"}' } },
            ] },
        ], newNid());
        assert.equal(rows.length, 1);
        const tool = rows[0] as { kind: string; status: string; ok?: boolean };
        assert.equal(tool.kind, "tool");
        assert.equal(tool.status, "done", "应被收尾为 done");
        assert.equal(tool.ok, false, "无结果 → 视为未成功");
    });

    it("无配对的 tool 结果消息 → 单独成行（toolName 兜底为 (tool)）", () => {
        const rows = buildReplayRows([
            { role: "tool", tool_call_id: "orphan", content: "stray result" },
        ], newNid());
        assert.equal(rows.length, 1);
        const tool = rows[0] as { kind: string; toolName: string; status: string; result?: string };
        assert.equal(tool.kind, "tool");
        assert.equal(tool.toolName, "(tool)");
        assert.equal(tool.status, "done");
        assert.equal(tool.result, "stray result");
    });

    it("多个 tool_call 乱序回填：按 id 正确配对，不依赖出现顺序", () => {
        const rows = buildReplayRows([
            { role: "assistant", tool_calls: [
                { id: "a", function: { name: "t1", arguments: "{}" } },
                { id: "b", function: { name: "t2", arguments: "{}" } },
            ] },
            { role: "tool", tool_call_id: "b", content: "B" },
            { role: "tool", tool_call_id: "a", content: "A" },
        ], newNid());
        assert.equal(rows.length, 2);
        const byName = Object.fromEntries(rows.map((r) => {
            const t = r as { toolName: string; result?: string };
            return [t.toolName, t.result];
        })) as Record<string, string | undefined>;
        assert.equal(byName.t1, "A");
        assert.equal(byName.t2, "B");
    });

    it("损坏/缺字段静默降级，不抛错", () => {
        const rows = buildReplayRows([
            null,
            { role: "user" },                          // 无 content
            { role: "assistant", content: "   " },      // 空白 content
            { role: "assistant", tool_calls: "不是数组" }, // tool_calls 非数组
        ], newNid());
        assert.equal(rows.length, 0, "全部应被跳过，不抛错");
    });
});

describe("buildReplayRows（事件行：usage 回挂 + 中断标记）", () => {
    it("round.end usage 回挂最近 assistant 行（cached_tokens → prompt_cache_hit_tokens）", () => {
        const rows = buildReplayRows([
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
            { id: "e1", ts: "t", dscEvent: "round.end", runId: "r1", round: 1, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 80 } },
        ] as any, newNid());
        assert.equal(rows.length, 2, "事件行不渲染本体");
        const a = rows[1] as any;
        assert.equal(a.usage.prompt_tokens, 100);
        assert.equal(a.usage.completion_tokens, 20);
        assert.equal(a.usage.total_tokens, 120);
        assert.equal(a.usage.prompt_cache_hit_tokens, 80, "cached_tokens 映射为 TraceBase 口径");
    });

    it("run.end 累计 usage 不覆盖已有轮级 usage", () => {
        const rows = buildReplayRows([
            { role: "assistant", content: "a" },
            { id: "e1", ts: "t", dscEvent: "round.end", runId: "r1", round: 1, usage: { prompt_tokens: 100 } },
            { id: "e2", ts: "t", dscEvent: "run.end", runId: "r1", stopReason: "normal", rounds: 1, usage: { prompt_tokens: 999 } },
        ] as any, newNid());
        assert.equal((rows[0] as any).usage.prompt_tokens, 100, "run.end 仅在行尚无 usage 时兜底回挂");
    });

    it("run.abandoned → 「被中断」info 行；末 run 未闭合 → 收尾补 info 行", () => {
        const closed = buildReplayRows([
            { id: "e1", ts: "t", dscEvent: "run.start", runId: "r1", depth: 0 },
            { role: "assistant", content: "做了一半" },
            { id: "e2", ts: "t", dscEvent: "run.abandoned", runId: "r1", reason: "x" },
        ] as any, newNid());
        assert.equal(closed.length, 2);
        assert.equal((closed[1] as any).kind, "info");
        assert.ok(((closed[1] as any).text).includes("被中断"));
        // 未闭合（进程被杀、闭墓都没来得及补）→ 收尾兜底同样提示
        const unclosed = buildReplayRows([
            { id: "e1", ts: "t", dscEvent: "run.start", runId: "r2", depth: 0 },
            { role: "assistant", content: "做了一半" },
        ] as any, newNid());
        assert.equal(unclosed.length, 2);
        assert.equal((unclosed[1] as any).kind, "info");
        assert.ok(((unclosed[1] as any).text).includes("被中断"));
    });

    it("纯事件行输入 → 零渲染行（除未闭合提示）", () => {
        const rows = buildReplayRows([
            { id: "e1", ts: "t", dscEvent: "run.start", runId: "r1", depth: 0 },
            { id: "e2", ts: "t", dscEvent: "compaction", archivedMessageCount: 3, summary: "S" },
            { id: "e3", ts: "t", dscEvent: "run.end", runId: "r1", stopReason: "normal", rounds: 2 },
        ] as any, newNid());
        assert.equal(rows.length, 0, "闭合 run 的事件流无任何渲染行");
    });
});
