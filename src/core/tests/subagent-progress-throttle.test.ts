/**
 * @file tests/subagent-progress-throttle.test.ts
 * @description P3-7 子 agent 进度节流器（createProgressThrottler 纯函数）行为锁。
 *  覆盖：节流窗口、取最后完整行（未落 \n 的当前行不取）、空行过滤、120 字符限宽、检查即武装。
 *  假时钟注入（now 参数），不触真实时间；import 链含 config 读 env → env 先行 + 动态 import。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-spt-"));
const { createProgressThrottler } = await import("../src/agent/subagent.ts");

describe("createProgressThrottler（P3-7 进度节流器）", () => {
    it("窗口内不发送；到期检查取最后「完整」行（未落换行的当前行不取）", () => {
        let t = 0;
        const got: string[] = [];
        const p = createProgressThrottler((l) => got.push(l), 1000, () => t);
        p.push("第一行\n第二行未完");
        assert.deepEqual(got, [], "初始窗口内不发送");
        t = 1500;
        p.push("成的一半");
        assert.deepEqual(got, ["第一行"], "只取已落 \\n 的完整行");
        t = 3000;
        p.push("\n第三行\n");
        assert.deepEqual(got, ["第一行", "第三行"], "未完行落定后取最新完整行");
    });

    it("纯空白完整行跳过；超 120 字符限宽截断", () => {
        let t = 0;
        const got: string[] = [];
        const p = createProgressThrottler((l) => got.push(l), 1000, () => t);
        p.push("\n\n   \n" + "x".repeat(130) + "\n尾");
        t = 2000;
        p.push("");
        assert.equal(got.length, 1);
        assert.equal(got[0].length, 120, "119 字符 + … 共 120");
        assert.ok(got[0].endsWith("…"));
    });

    it("检查即武装：无完整行的到期检查也推进节流点（节奏恒 ≤1 条/窗口）", () => {
        let t = 0;
        const got: string[] = [];
        const p = createProgressThrottler((l) => got.push(l), 1000, () => t);
        p.push("没有完整行");       // t=0：窗口内不检查（lastAt 仍为 0）
        t = 1000; p.push("");       // 到期检查（武装），仍无完整行 → 不发送（节流点推进到 1000）
        t = 1500; p.push("\nabc");  // 距节流点 500ms → 不检查
        t = 2500; p.push("\n");     // 到期 → 此刻最后完整行为 abc → 发送
        assert.deepEqual(got, ["abc"]);
    });
});
