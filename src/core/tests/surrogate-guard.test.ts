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

describe("classifyRisk 第三通道守门（2026-11-13 事故终防线收口，2026-11-20 补齐）", () => {
    // 背景：streamChat / summarize 两条出口已接 sanitizeChatMessages，唯分类器自拼 messages 直发漏接
    //（登记级剩余③——异常仅降级 risky 多一次审批不崩，故低危）。本组钉死「分类器请求体也过守门」。
    it("detail 含存量孤立代理 → 出站请求体净除且 verdict 正常；成对 emoji 原样保留", async () => {
        process.env.DEEP_SEEK_API_KEY ||= "test-key-guard";   // 懒加载单例构造需要（真请求不会发出——create 已被 stub）
        const { getModel } = await import("@/llm/providers/deepseek/client.ts");
        const { deepseekProvider } = await import("@/llm/providers/deepseek/index.ts");

        const client = getModel();
        const origCreate = client.chat.completions.create.bind(client);
        let captured: any = null;
        (client.chat.completions as any).create = async (body: any) => {
            captured = body;
            return { choices: [{ message: { content: "SAFE" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
        };
        try {
            const verdict = await deepseekProvider.classifyRisk(
                "run_command", { command: "npm test" }, `diff 预览${loneHigh}与成对${emoji}`,
            );
            // ★ 夹具只用孤立高代理（勿用 loneHigh+loneLow 相邻——两半截恰相邻在码元层=合法代理对，守门会当正常文本保留）
            assert.equal(verdict, "safe", "stub 返回 SAFE → 分类器判 safe");
            assert.ok(captured, "请求体已被捕获");
            const sent = JSON.stringify(captured.messages);
            const cleaned = sent.replace(/\\ud[89ab][0-9a-f]{2}\\ud[c-f][0-9a-f]{2}/gi, "");
            assert.ok(!/\\ud[89abc-f][0-9a-f]{2}/i.test(cleaned), "出站消息无孤立代理转义（净除生效）");
            const userMsg = captured.messages.find((m: any) => m.role === "user")?.content ?? "";
            assert.ok(userMsg.includes(emoji), "成对 emoji 原样保留（守门不误伤正常文本）");
        } finally {
            (client.chat.completions as any).create = origCreate;
        }
    });
});
