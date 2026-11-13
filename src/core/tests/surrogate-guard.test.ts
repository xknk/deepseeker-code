/**
 * @file tests/surrogate-guard.test.ts
 * @description 发送前孤立代理守门回归（2026-11-13 事故终防线，llm/surrogateGuard.ts）：
 *  孤立高/低代理净除、成对 emoji 原样保留、content 字符串/parts 数组/tool_calls.arguments 三路覆盖、
 *  干净消息零改写（引用不变）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-surr-guard-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { stripLoneSurrogates, sanitizeChatMessages } = await import("@/llm/surrogateGuard.ts");

const loneHigh = "\ud83d";          // 孤立高代理（事故形态：emoji 前半截）
const loneLow = "\udc4d";           // 孤立低代理（tail 切法的事故形态：后半截）
const emoji = "📋";                 // 完整代理对

describe("stripLoneSurrogates", () => {
    it("孤立高/低代理净除，成对代理对与常规文本原样保留", () => {
        assert.equal(stripLoneSurrogates(`前${loneHigh}后`), "前后");
        assert.equal(stripLoneSurrogates(`前${loneLow}后`), "前后");
        assert.equal(stripLoneSurrogates(`保留${emoji}正常中文abc`), `保留${emoji}正常中文abc`);
        assert.equal(stripLoneSurrogates(""), "");
    });
});

describe("sanitizeChatMessages（发送前守门）", () => {
    it("content 字符串 / parts 数组 text / tool_calls.function.arguments 三路净除，干净消息引用不变", () => {
        const dirty: any[] = [
            { role: "tool", tool_call_id: "c1", content: `升级→建票+${loneHigh}\n\n[… 已折叠 …]` },
            { role: "user", content: [{ type: "text", text: `图说${loneLow}` }, { type: "image_url", image_url: { url: "x" } }] },
            { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "t", arguments: `{"p":"a${loneHigh}b"}` } }] },
        ];
        const clean = sanitizeChatMessages(dirty);
        assert.equal((clean[0] as any).content, "升级→建票+\n\n[… 已折叠 …]", "content 孤立高代理净除");
        assert.equal((clean[1] as any).content[0].text, "图说", "parts text 孤立低代理净除");
        assert.ok((clean[1] as any).content[1].image_url, "非 text part 原样");
        assert.equal((clean[2] as any).tool_calls[0].function.arguments, '{"p":"ab"}', "arguments 净除");
        assert.equal(dirty[0].content.includes(loneHigh), true, "入参不被原地改写");

        const pristine: any[] = [{ role: "user", content: `干净${emoji}消息` }];
        const kept = sanitizeChatMessages(pristine);
        assert.equal(kept[0], pristine[0], "干净消息引用不变（零拷贝零改写）");
    });

    it("端到端语义：守门后的消息 JSON.stringify 不再含孤立代理转义（DeepSeek 400 的直接诱因）", () => {
        const msgs: any[] = [{ role: "tool", tool_call_id: "c", content: "x".repeat(499) + loneHigh + "y".repeat(10) }];
        const body = JSON.stringify({ messages: sanitizeChatMessages(msgs) });
        const cleaned = body.replace(/\\ud[89ab][0-9a-f]{2}\\ud[c-f][0-9a-f]{2}/gi, "");
        assert.ok(!/\\ud[89abc-f][0-9a-f]{2}/i.test(cleaned), "序列化产物无孤立代理转义");
    });
});
