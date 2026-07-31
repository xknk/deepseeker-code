/**
 * @file tests/truncate.test.ts
 * @description collectToolResult 的 onChunk 契约单测。
 *  实时 stdout（tool.progress）接线依赖此契约：runAgent 把 onChunk 透传给 collectToolResult，
 *  onChunk 再转发到 toolCtx.emitProgress → tool.progress UIEvent → 前端逐行 stdout。
 *  本测试钉住「AsyncGenerator 每块回调 onChunk 一次、顺序正确、结果为拼接」。
 *  （真实 run_command 随时间逐块产出 stdout 已用 ping 带时间戳手验，见 下一步计划.md。）
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectToolResult } from "@/agent/truncate.ts";

/** 假流式工具：模拟 run_command 逐块 yield stdout。 */
async function* fakeStream(chunks: string[]): AsyncGenerator<string> {
    for (const c of chunks) yield c;
}

describe("collectToolResult onChunk 契约（实时 stdout 接线依赖）", () => {
    it("AsyncGenerator：onChunk 每块回调一次，顺序与内容正确，结果为拼接", async () => {
        const chunks = ["aaa", "bbb", "ccc"];
        const seen: string[] = [];
        const full = await collectToolResult(fakeStream(chunks), (s) => seen.push(s));
        assert.deepEqual(seen, chunks, "onChunk 应每块回调一次，保持顺序");
        assert.equal(full, "aaabbbccc", "结果应为各块拼接");
    });

    it("不传 onChunk：仍正确拼接，不抛错（向后兼容）", async () => {
        const full = await collectToolResult(fakeStream(["x", "y"]));
        assert.equal(full, "xy");
    });

    it("空流：onChunk 不回调，结果为空串", async () => {
        const seen: string[] = [];
        const full = await collectToolResult(fakeStream([]), (s) => seen.push(s));
        assert.equal(seen.length, 0);
        assert.equal(full, "");
    });

    it("Promise<string>（非流式）：不走 generator 分支，不触发 onChunk", async () => {
        const seen: string[] = [];
        const full = await collectToolResult(Promise.resolve("done"), (s) => seen.push(s));
        assert.equal(full, "done");
        assert.equal(seen.length, 0, "Promise 模式不应触发 onChunk");
    });
});
