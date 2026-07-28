/**
 * @file tests/common.test.ts
 * @description common/index.ts 单测：getFileName（会话归并）、isSafeSessionId / assertSafeSessionId（路径穿越硬守）、createUUID。
 *  这些是安全关键纯函数，优先覆盖。运行：npx tsx --tsconfig src/core/tsconfig.json src/core/tests/common.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFileName, isSafeSessionId, assertSafeSessionId, createUUID } from "@/common/index.ts";

describe("getFileName（会话 ID → 主会话文件夹名归并）", () => {
    it("主 ID 原样返回", () => {
        assert.equal(getFileName("abc123"), "abc123");
        assert.equal(getFileName("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
    });
    it("子 agent ID（__sub__）→ 溯源到父主 ID", () => {
        assert.equal(getFileName("parent__sub__child-uuid"), "parent");
    });
    it("仅切首个 __sub__，保留上级链路前缀", () => {
        assert.equal(getFileName("root__sub__mid__sub__leaf"), "root");
    });
    it("摘要 ID（__rollingSummary）→ 剥离后缀", () => {
        assert.equal(getFileName("sess123__rollingSummary"), "sess123");
    });
});

describe("isSafeSessionId（路径穿越白名单，布尔判定不抛错）", () => {
    it("接受合法 ID（字母/数字/下划线/连字符）", () => {
        for (const id of ["abc", "a-b_c", "ABC123", "550e8400-e29b-41d4-a716-446655440000", "parent__sub__child"]) {
            assert.equal(isSafeSessionId(id), true, `应接受: ${id}`);
        }
    });
    it("拒绝路径元字符（. / \\ : 空格 % 等）—— 拒 '.' 即杀掉 '..'", () => {
        for (const id of ["../etc", "..", "a/b", "a\\b", "a:b", "a b", "a%20b", ".", "./passwd"]) {
            assert.equal(isSafeSessionId(id), false, `应拒绝: ${id}`);
        }
    });
    it("拒绝空串 / 超长（>200）", () => {
        assert.equal(isSafeSessionId(""), false);
        assert.equal(isSafeSessionId("a".repeat(201)), false);
        assert.equal(isSafeSessionId("a".repeat(200)), true);
    });
    it("拒绝非字符串", () => {
        for (const v of [undefined, null, 123, {}, []]) {
            assert.equal(isSafeSessionId(v as unknown as string), false);
        }
    });
});

describe("assertSafeSessionId（存储层硬守，违例抛错）", () => {
    it("合法 ID 不抛错", () => {
        assert.doesNotThrow(() => assertSafeSessionId("good-id_123"));
    });
    it("非法 ID 抛错（含 label）", () => {
        assert.throws(() => assertSafeSessionId("../etc", "traceId"), /SECURITY.*traceId/s);
        assert.throws(() => assertSafeSessionId("a/b"), /SECURITY/s);
        assert.throws(() => assertSafeSessionId(""), /SECURITY/s);
    });
});

describe("createUUID", () => {
    it("返回符合 RFC4122 v4 格式的字符串", () => {
        const id = createUUID();
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
    it("每次调用产生不同值", () => {
        assert.notEqual(createUUID(), createUUID());
    });
});
