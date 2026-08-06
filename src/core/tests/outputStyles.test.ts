/**
 * @file tests/outputStyles.test.ts
 * @description 输出风格注入单测（outputStyles/inject.ts + registry.ts，P2-16）。
 *  核心保证：injectOutputStyle 经 injectMarkedBlock 的 fence 机制实现
 *   - 幂等：同名重复注入 → system prompt 逐字节不变（保 DeepSeek 隐式前缀缓存）；
 *   - 切换：换风格 → 旧块被切除、新块接上（不累积）；
 *   - no-op：未设 / 未命中名 → 不动 system prompt。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { injectOutputStyle } from "@/outputStyles/inject.ts";
import { registerOutputStyle, clearOutputStyles } from "@/outputStyles/registry.ts";

const mk = (): any[] => [{ role: "system", content: "BASE" }];

before(() => {
    clearOutputStyles();
    registerOutputStyle({ name: "a", description: "风格A", body: "BODY_A_RULES", source: "builtin" });
    registerOutputStyle({ name: "b", description: "风格B", body: "BODY_B_RULES", source: "builtin" });
});
after(() => clearOutputStyles());

describe("injectOutputStyle", () => {
    it("命中风格 → 注入 persona 正文与标记", () => {
        const msg = mk();
        injectOutputStyle(msg, "a");
        assert.ok(msg[0].content.includes("BODY_A_RULES"), "含 body");
        assert.ok(msg[0].content.includes("【输出风格】"), "含标记");
        assert.ok(msg[0].content.startsWith("BASE"), "原 system 内容保留在前");
    });

    it("幂等：同名重复注入 → 逐字节不变（保前缀缓存）", () => {
        const msg = mk();
        injectOutputStyle(msg, "a");
        const once = msg[0].content;
        injectOutputStyle(msg, "a");   // 再注入同名
        assert.equal(msg[0].content, once, "重复注入后字节稳定");
    });

    it("切换风格：旧块切除、新块接上（不累积）", () => {
        const msg = mk();
        injectOutputStyle(msg, "a");
        injectOutputStyle(msg, "b");
        assert.ok(msg[0].content.includes("BODY_B_RULES"), "含新风格 body");
        assert.ok(!msg[0].content.includes("BODY_A_RULES"), "旧风格 body 已切除");
    });

    it("no-op：未设 styleName → 不动 system prompt", () => {
        const msg = mk();
        injectOutputStyle(msg, undefined);
        assert.equal(msg[0].content, "BASE");
    });

    it("no-op：未命中风格名 → 不动 system prompt", () => {
        const msg = mk();
        injectOutputStyle(msg, "does-not-exist");
        assert.equal(msg[0].content, "BASE");
    });
});
