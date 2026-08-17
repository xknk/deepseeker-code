/**
 * @file tests/inbox.test.ts
 * @description inbox steering 单测（第二梯队 #2）：push/claim FIFO、claim 原子清空、容量上限、
 *  空串拒绝、flush 落盘 user 行 + 队列清空、开关关闭全 no-op（子进程，appConfig 模块加载期固化 env）。
 *  沙盒隔离：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前指向临时目录（appConfig 模块加载期读 env），
 *  故全部 core 模块走动态 import。开关关闭矩阵由独立子进程探针覆盖（P4 惯例，见 .ai-docs 验收记录）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-inbox-"));
// ★ 动态 import：appConfig 在模块加载期固化 dataDir / inboxSteering，必须先设 env 再加载
const { pushSessionInbox, claimSessionInbox, flushLeftoverToTranscript } = await import("../src/agent/inbox.ts");
const { readTranscriptLines } = await import("../src/session/transcript.ts");

describe("pushSessionInbox / claimSessionInbox（队列语义）", () => {
    it("push→claim FIFO；claim 原子取走全量并删键，二次 claim 为空", () => {
        const s = `inbx${Date.now()}a`;
        assert.equal(pushSessionInbox(s, "第一条"), true);
        assert.equal(pushSessionInbox(s, "  第二条  "), true); // 内部 trim
        assert.equal(pushSessionInbox(s, "第三条"), true);
        assert.deepEqual(claimSessionInbox(s), ["第一条", "第二条", "第三条"], "FIFO 全量取走");
        assert.deepEqual(claimSessionInbox(s), [], "claim 后键已删，二次为空");
    });

    it("不同会话互不干扰（per-session 键隔离）", () => {
        const a = `inbx${Date.now()}b`;
        const b = `inbx${Date.now()}c`;
        pushSessionInbox(a, "给 A");
        pushSessionInbox(b, "给 B");
        assert.deepEqual(claimSessionInbox(a), ["给 A"]);
        assert.deepEqual(claimSessionInbox(b), ["给 B"]);
    });

    it("空串 / 纯空白拒绝（返回 false，不入队）", () => {
        const s = `inbx${Date.now()}d`;
        assert.equal(pushSessionInbox(s, ""), false);
        assert.equal(pushSessionInbox(s, "   \n\t "), false);
        assert.deepEqual(claimSessionInbox(s), [], "未入队");
    });

    it("容量上限 50：第 51 条拒绝，前 50 条完好", () => {
        const s = `inbx${Date.now()}e`;
        for (let i = 1; i <= 50; i++) assert.equal(pushSessionInbox(s, `msg${i}`), true, `第 ${i} 条应入队`);
        assert.equal(pushSessionInbox(s, "msg51"), false, "第 51 条拒");
        const q = claimSessionInbox(s);
        assert.equal(q.length, 50);
        assert.equal(q[0], "msg1");
        assert.equal(q[49], "msg50");
    });

    it("未知会话 claim 返回空数组（不抛错）", () => {
        assert.deepEqual(claimSessionInbox(`nobody-${Date.now()}`), []);
    });
});

describe("flushLeftoverToTranscript（收尾落盘）", () => {
    it("未认领条目逐条落盘 user 行 + 队列清空；空队列返回 0 且不写行", async () => {
        const s = `inbx${Date.now()}f`;
        const before = (await readTranscriptLines(s)).length;
        assert.equal(await flushLeftoverToTranscript(s), 0, "空队列 no-op");
        assert.equal((await readTranscriptLines(s)).length, before, "未写任何行");

        pushSessionInbox(s, "遗留一");
        pushSessionInbox(s, "遗留二");
        assert.equal(await flushLeftoverToTranscript(s), 2);
        const lines = await readTranscriptLines(s);
        assert.equal(lines.length, before + 2, "两条 user 行");
        const roles = lines.slice(before).map((l: any) => l.role);
        const contents = lines.slice(before).map((l: any) => l.content);
        assert.deepEqual(roles, ["user", "user"]);
        assert.deepEqual(contents, ["遗留一", "遗留二"], "保序");
        assert.deepEqual(claimSessionInbox(s), [], "flush 后队列已清空");
        // 二次 flush 幂等（不再重复落盘）
        assert.equal(await flushLeftoverToTranscript(s), 0);
        assert.equal((await readTranscriptLines(s)).length, before + 2);
    });
});
