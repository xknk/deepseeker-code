/**
 * @file tests/surrogate-slice.test.ts
 * @description 防劈代理对切点助手函数级测试（2026-11-13 事故回归，session/content.ts 导出对）：
 *  sliceHeadNoSplit / sliceTailNoSplit 的边界——keep=0、全 emoji 串（切点必劈）、尾切起点恰在低代理、
 *  输入自带孤立代理时的契约（只护切缘、不清存量——存量是 surrogateGuard 出口守门的事）。
 *  补 truncateToolResult 代理对用例（此前全 ASCII，劈对回归零覆盖）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-surr-slice-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { sliceHeadNoSplit, sliceTailNoSplit } = await import("@/session/content.ts");
const { truncateToolResult } = await import("@/agent/truncate.ts");

const loneHigh = "\ud83d";   // 孤立高代理（emoji 前半被劈）
const loneLow = "\udc4d";    // 孤立低代理（emoji 后半被劈）
const emoji = "📋";          // U+1F4CB，完整代理对 = 📋（2 个 UTF-16 码元）

/** 串内不得含孤立代理（DeepSeek 400 的直接诱因——事故形态的机器判定）。
 *  ★ 直接按码元扫原串，不走 JSON.stringify+正则：原方案的两处缺陷——①曾试图先 .replace(/\\\\/g) 摘
 *  转义反斜杠，但那是个恒等变换（什么都没防）；②串含字面 "\\ud83d" 文本（贴日志即现）时 stringify
 *  成 \\\\ud83d，正则从第二个反斜杠起仍误命中。码元直扫零误报零歧义。 */
const noLoneEscape = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && !(s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return false;
        if (code >= 0xdc00 && code <= 0xdfff && !(s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff)) return false;
    }
    return true;
};

describe("sliceHeadNoSplit", () => {
    it("基础切：纯 ASCII 与预期一致", () => {
        assert.equal(sliceHeadNoSplit("abcdef", 3), "abc");
    });

    it("keep=0 → 空串（切缘在起点，无代理可劈）", () => {
        assert.equal(sliceHeadNoSplit(`${emoji}abc`, 0), "");
    });

    it("keep 大于长度 → 原样返回", () => {
        assert.equal(sliceHeadNoSplit("ab", 99), "ab");
    });

    it("★ 切点落在代理对中间 → 回退一位，emoji 整体舍去不劈半（499+emoji 事故形态）", () => {
        const s = "x".repeat(499) + emoji + "y".repeat(300);
        const out = sliceHeadNoSplit(s, 500);   // 500 恰落在 emoji 第二码元
        assert.equal(out, "x".repeat(499), "回退到代理对之前");
        assert.ok(noLoneEscape(out), "序列化无孤立代理转义");
    });

    it("★ 全 emoji 串：切点必然劈对 → 回退保整对，结果只含完整 emoji", () => {
        const s = emoji.repeat(20);
        const out = sliceHeadNoSplit(s, 21);    // 奇数切点必劈
        assert.equal(out.length % 2, 0, "长度必为偶数（码元成对）");
        assert.equal(out, emoji.repeat(10), "恰含 10 个完整 emoji");
    });

    it("契约钉死：切缘之外的存量孤立代理不被清理（那是 surrogateGuard 出口守门的事）", () => {
        const s = `${loneLow}ab`;               // 输入本身带孤立低代理
        const out = sliceHeadNoSplit(s, 2);     // 切缘在 'a'（ASCII），不触发回退
        assert.equal(out, `${loneLow}a`, "切点助手只护切缘，不越权清存量");
    });
});

describe("sliceTailNoSplit", () => {
    it("基础切：纯 ASCII 与预期一致", () => {
        assert.equal(sliceTailNoSplit("abcdef", 3), "def");
    });

    it("keep 大于长度 → 原样返回", () => {
        assert.equal(sliceTailNoSplit("ab", 99), "ab");
    });

    it("★ 尾切起点恰在低代理 → 前进一位，不产出孤立低代理", () => {
        const s = "ab" + emoji + "yz";          // 码元: a b [高 低] y z（共 6）
        assert.equal(sliceTailNoSplit(s, 3), "yz", "keep=3 → 起点码元 3=低代理 → 前进到 4");
        assert.equal(sliceTailNoSplit(s, 4), `${emoji}yz`, "keep=4 → 起点码元 2=高代理（成对起始）→ 原样");
        assert.ok(noLoneEscape(sliceTailNoSplit(s, 3)), "序列化无孤立代理转义");
    });

    it("契约钉死：切缘上的存量孤立被前进跳过（丢弃、输出干净）；内部存量不越权清理", () => {
        // 码元: a0 b1 c2 d3 e4 [孤立低]5 f6 g7（共 8）
        const s = `abcde${loneLow}fg`;
        assert.equal(sliceTailNoSplit(s, 3), "fg", "keep=3 → 起点码元 5=孤立低 → 前进跳过（输出干净）");
        assert.equal(sliceTailNoSplit(s, 4), `e${loneLow}fg`, "keep=4 → 起点码元 4='e'（ASCII）→ 内部存量孤立原样保留");
    });
});

describe("truncateToolResult 代理对回归（此前全 ASCII 零覆盖）", () => {
    it("截断切点不劈 emoji：头尾产物序列化均无孤立代理转义", () => {
        const body = "x".repeat(499) + emoji + "y".repeat(9000) + emoji + "z".repeat(9000);
        const out = truncateToolResult(body, 500);
        assert.ok(out.length < body.length, "确实发生了截断");
        assert.ok(noLoneEscape(out), `头缘不劈：${JSON.stringify(out).slice(0, 80)}`);
    });
});
