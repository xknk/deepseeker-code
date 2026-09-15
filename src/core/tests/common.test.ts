/**
 * @file tests/common.test.ts
 * @description common/index.ts 单测：getFileName（会话归并）、isSafeSessionId / assertSafeSessionId（路径穿越硬守）、createUUID。
 *  这些是安全关键纯函数，优先覆盖。运行：npx tsx --tsconfig src/core/tsconfig.json src/core/tests/common.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getFileName, isSafeSessionId, assertSafeSessionId, createUUID, detectTextLocale } from "@/common/index.ts";

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

describe("detectTextLocale（zh/en 语言推断）", () => {
    it("基线：纯中文→zh、纯英文→en、纯符号/空→null", () => {
        assert.equal(detectTextLocale("帮我把这个函数提取到公共模块里"), "zh");
        assert.equal(detectTextLocale("Please refactor this module"), "en");
        assert.equal(detectTextLocale("123 + 456 === 789 !!! ……"), null);
        assert.equal(detectTextLocale(""), null);
    });
    it("中文夹英文术语仍判中文（阈值 ≥0.2）", () => {
        assert.equal(detectTextLocale("帮我把 getUserInfo 提取到 utils"), "zh");
    });
    it("路径/URL 是噪声不参与判定（2026-09-14 贴图存档路径稀释回归钉）", () => {
        // 修复前：标签行 Windows 存档路径 51 个拉丁字母，12/(12+51)≈0.19<0.2 → 中文提问误判 en
        assert.equal(
            detectTextLocale("读取这这张图内容\n🖼 [图片: pasted-20260914-172328.png | 存档: C:\\Users\\24387\\.deepseeker-code\\tmp\\paste\\b2d527a8-f60c-432a-8460-82f519ff05cb.png]"),
            "zh",
        );
        assert.equal(detectTextLocale("看看这个报错 https://example.com/a/b/c/d/very/long/path?q=abcdefghij 高亮在哪"), "zh");
        assert.equal(detectTextLocale("读取 /home/user/.deepseeker-code/tmp/paste/abc12345-def6-7890.png 的内容"), "zh");
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
