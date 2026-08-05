/**
 * @file tests/mcp.test.ts
 * @description MCP resources/prompts 结果拼接纯函数单测（tool/mcp/client.ts）。
 *  覆盖 joinResourceContents（text/blob/空）与 joinPromptMessages（string/对象/数组/空）。
 *  client 传输层（stdio/http/sse）与 loader 聚合工具涉及 clients[] 模块态 + 网络，按惯例不单测（serve 冒烟覆盖）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { joinResourceContents, joinPromptMessages } from "@/tool/mcp/client.ts";

describe("joinResourceContents（resources/read 结果 → 文本）", () => {
    it("纯 text 内容：按 \\n\\n 拼接", () => {
        const r = joinResourceContents({ contents: [
            { uri: "a", mimeType: "text/plain", text: "第一段" },
            { uri: "b", mimeType: "text/plain", text: "第二段" },
        ] });
        assert.equal(r, "第一段\n\n第二段");
    });

    it("blob 二进制：置占位（省略 base64），不混入正文", () => {
        const r = joinResourceContents({ contents: [
            { uri: "img", mimeType: "image/png", blob: "iVBORw0KGgo..." },
        ] });
        assert.match(r, /二进制资源/);
        assert.match(r, /image\/png/);
        assert.doesNotMatch(r, /iVBORw0KGgo/);
    });

    it("text + blob 混合：text 拼接、blob 占位", () => {
        const r = joinResourceContents({ contents: [
            { uri: "a", text: "正文" },
            { uri: "b", mimeType: "image/png", blob: "base64" },
        ] });
        assert.match(r, /^正文\n\n\[二进制资源/);
    });

    it("空 contents / 无 text：返回占位（非空串，防误判失败）", () => {
        assert.equal(joinResourceContents({ contents: [] }), "(资源无文本内容)");
        assert.equal(joinResourceContents({}), "(资源无文本内容)");
        assert.equal(joinResourceContents({ contents: [{ uri: "x", mimeType: "image/png", blob: "a" }] }), "[二进制资源 x（mimeType=image/png），已省略 base64 内容]");
    });
});

describe("joinPromptMessages（prompts/get 结果 → 文本）", () => {
    it("content 为字符串：直接拼接", () => {
        const r = joinPromptMessages({ messages: [
            { role: "user", content: "你好" },
            { role: "assistant", content: "请讲" },
        ] });
        assert.equal(r, "你好\n\n请讲");
    });

    it("content 为 {type:'text',text} 单对象：抽 text", () => {
        const r = joinPromptMessages({ messages: [
            { role: "user", content: { type: "text", text: "结构化文本" } },
        ] });
        assert.equal(r, "结构化文本");
    });

    it("content 为数组（ExtractedContent）：仅取 type:text 项", () => {
        const r = joinPromptMessages({ messages: [
            { role: "user", content: [
                { type: "text", text: "第一行" },
                { type: "image", data: "..." },
                { type: "text", text: "第二行" },
            ] },
        ] });
        assert.equal(r, "第一行\n第二行");
    });

    it("混合多种 content 形态", () => {
        const r = joinPromptMessages({ messages: [
            { role: "user", content: "纯字符串" },
            { role: "user", content: { type: "text", text: "对象" } },
            { role: "user", content: [{ type: "text", text: "数组项" }] },
        ] });
        assert.equal(r, "纯字符串\n\n对象\n\n数组项");
    });

    it("空 messages / 无文本：返回占位", () => {
        assert.equal(joinPromptMessages({ messages: [] }), "(prompt 无文本内容)");
        assert.equal(joinPromptMessages({}), "(prompt 无文本内容)");
        assert.equal(joinPromptMessages({ messages: [{ role: "user", content: { type: "image", data: "x" } }] }), "(prompt 无文本内容)");
    });
});
