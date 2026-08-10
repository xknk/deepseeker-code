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

/**
 * 非流式（Promise<string>）安全网超时 + abort 打断（上线前 P0-1 修复）。
 * 钉住的契约：
 *  - 工具 hang（永不 resolve）且不响应 abortSignal 时，安全网超时到点 → 返回超时提示（不抛错，模型据此自决策）；
 *  - 传入 abortSignal 且触发中止 → 抛 'aborted'（冒泡走工具 catch → 主循环 aborted 收尾）。
 * 用 DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS 收到极小值加速，测后恢复避免污染其它用例。
 */
describe("collectToolResult 非流式安全网超时 / abort 打断（P0-1）", () => {
    const envKey = "DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS";
    const setEnv = (v: string) => { process.env[envKey] = v; };
    const restoreEnv = (prev: string | undefined) => {
        if (prev === undefined) delete process.env[envKey];
        else process.env[envKey] = prev;
    };

    it("Promise 永不 resolve → 安全网超时熔断，返回超时提示（不抛错）", async () => {
        const prev = process.env[envKey];
        setEnv("50");
        try {
            const hang = new Promise<string>(() => { /* 永不 resolve，模拟 hang 工具 */ });
            const full = await collectToolResult(hang);
            assert.match(full, /超时/, "应返回超时熔断提示，让模型自行决策下一步");
        } finally {
            restoreEnv(prev);
        }
    });

    it("abortSignal 触发 → 抛 aborted（让主循环走中止收尾，不等超时）", async () => {
        const prev = process.env[envKey];
        setEnv("10000"); // 远大于测试耗时，确保是 abort 而非超时打断
        try {
            const ac = new AbortController();
            const hang = new Promise<string>(() => { /* 永不 resolve */ });
            const p = collectToolResult(hang, undefined, ac.signal);
            // racer 的 abort 监听在 collectToolResult 首个 await 前已同步注册，故此刻 abort 即可生效
            ac.abort();
            await assert.rejects(p, /aborted/, "中止应抛 aborted 而非干等超时");
        } finally {
            restoreEnv(prev);
        }
    });

    it("正常 Promise 仍按原样返回（超时/abort 不影响正常路径）", async () => {
        const prev = process.env[envKey];
        setEnv("50");
        try {
            const full = await collectToolResult(Promise.resolve("ok"));
            assert.equal(full, "ok");
        } finally {
            restoreEnv(prev);
        }
    });
});
