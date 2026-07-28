/**
 * @file tests/hooks.test.ts
 * @description hooks/registry.ts 的 matches（工具名匹配器）单测。
 *  匹配器决定哪些 hook 对哪些工具生效，是声明式 hook 的核心路由逻辑。
 *  注：dispatch 的并发/fail-closed 行为涉及异步与全局 rules 状态，留作后续集成测试。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matches } from "@/hooks/registry.ts";

describe("matches（hook 工具名匹配器）", () => {
    it("string：精确名匹配", () => {
        assert.equal(matches("edit_file", "edit_file"), true);
        assert.equal(matches("edit_file", "read_file"), false);
    });
    it("string：通配 '*' 匹配任意工具名", () => {
        assert.equal(matches("*", "edit_file"), true);
        assert.equal(matches("*", "anything_at_all"), true);
    });
    it("RegExp：正则匹配", () => {
        assert.equal(matches(/^edit/, "edit_file"), true);
        assert.equal(matches(/^edit/, "write_file"), false);
        assert.equal(matches(/file$/, "edit_file"), true);
    });
    it("谓词：返回布尔判定", () => {
        assert.equal(matches((n) => n.includes("_"), "a_b"), true);
        assert.equal(matches((n) => n.startsWith("x"), "abc"), false);
    });
    it("谓词抛错 → 安全降级为 false（不击垮分发）", () => {
        assert.equal(matches(() => { throw new Error("boom"); }, "edit_file"), false);
    });
});
