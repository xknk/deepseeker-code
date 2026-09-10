/**
 * @file tests/bash-direct.test.ts
 * @description `!` shell 直执行（commands/bashDirect.ts）契约测试：
 *  - truncateOutput 截断保头尾（防超大日志灌爆上下文/终端）；
 *  - formatBashEntry 落盘格式（!bash $ 前缀 + 状态标注 + 空输出兜底）——模型据此识别输出源于用户直跑命令；
 *  - runBashDirect 真实执行（成功/非零退出码/超时）——exec 包装的语义不走样；
 *  - recordBashEntry 以 user 消息落 transcript（下轮 buildContextMessages 自然带入的关键落点）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒惯例：dataDir 指向临时目录，防模块初始化读真实 ~/.deepseeker-code。
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-bash-direct-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { truncateOutput, formatBashEntry, runBashDirect, recordBashEntry } =
    await import("@/commands/bashDirect.ts");
const { readMessages } = await import("@/session/transcript.ts");

const OK = { ok: true, output: "done", exitCode: 0, timedOut: false, durationMs: 12 };

describe("truncateOutput 输出截断", () => {
    it("短输出原样透传", () => {
        assert.equal(truncateOutput("hello"), "hello");
    });
    it("超长输出保头尾、标省略、长度有界", () => {
        const big = "A".repeat(3000) + "MIDDLE".repeat(1000) + "Z".repeat(3000);
        const out = truncateOutput(big);
        assert.ok(out.startsWith("A".repeat(100)), "应保留头部");
        assert.ok(out.endsWith("Z".repeat(100)), "应保留尾部");
        assert.ok(out.includes("中段省略"), "应标注省略字符数");
        assert.ok(out.length < 6000, `截断后应有界，实际 ${out.length}`);
    });
});

describe("formatBashEntry 落盘格式", () => {
    it("成功：!bash $ 前缀 + 输出", () => {
        const s = formatBashEntry("git status", OK);
        assert.ok(s.startsWith("!bash $ git status\n"), "前缀须可让模型识别为用户直跑命令");
        assert.ok(s.includes("done"));
    });
    it("非零退出码标注；空输出兜底 (无输出)", () => {
        const s = formatBashEntry("exit 3", { ...OK, ok: false, exitCode: 3, output: "" });
        assert.ok(s.includes("[退出码 3]"), "失败状态须可见");
        assert.ok(s.includes("(无输出)"));
        assert.ok(!s.includes("超时"));
    });
    it("超时标注优先呈现", () => {
        const s = formatBashEntry("sleep 999", { ...OK, ok: false, exitCode: null, timedOut: true, durationMs: 60_000 });
        assert.ok(s.includes("[超时中止（>60s）]"));
    });
});

describe("runBashDirect 真实执行", () => {
    it("成功执行并捕获 stdout", async () => {
        const r = await runBashDirect(`"${process.execPath}" -e "console.log('bang-ok')"`, os.tmpdir());
        assert.equal(r.ok, true);
        assert.equal(r.exitCode, 0);
        assert.ok(r.output.includes("bang-ok"), `应含 stdout，实际：${r.output}`);
    });
    it("非零退出码 → ok=false 且 exitCode 保留", async () => {
        const r = await runBashDirect(`"${process.execPath}" -e "process.exit(3)"`, os.tmpdir());
        assert.equal(r.ok, false);
        assert.equal(r.exitCode, 3);
    });
    it("超时 → timedOut=true 且快速返回", async () => {
        process.env.DEEP_SEEK_BANG_TIMEOUT_MS = "200";
        try {
            const r = await runBashDirect(`"${process.execPath}" -e "setTimeout(()=>{},60000)"`, os.tmpdir());
            assert.equal(r.timedOut, true, "应被超时杀掉");
            assert.equal(r.ok, false);
        } finally {
            delete process.env.DEEP_SEEK_BANG_TIMEOUT_MS;
        }
    });
});

describe("recordBashEntry transcript 落盘", () => {
    it("以 user 消息写入会话历史（下轮模型可见的落点契约）", async () => {
        const sid = "bang-test-session";
        await recordBashEntry(sid, formatBashEntry("echo hi", OK));
        const msgs = await readMessages(sid);
        const last = msgs[msgs.length - 1] as { role: string; content: string };
        assert.equal(last.role, "user");
        assert.ok(last.content.includes("!bash $ echo hi"));
        assert.ok(last.content.includes("done"));
    });
});
