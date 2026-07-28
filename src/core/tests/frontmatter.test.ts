/**
 * @file tests/frontmatter.test.ts
 * @description SKILL.md frontmatter 解析器单测（skills/frontmatter.ts）。
 *  覆盖：合法解析、值含冒号、缺闭合、缺首行 ---、空 frontmatter、无冒号行忽略、正文 trim。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillFile } from "@/skills/frontmatter.ts";

describe("parseSkillFile", () => {
    it("合法 frontmatter + 正文正确切分", () => {
        const r = parseSkillFile("---\nname: foo\ndescription: a skill\n---\nbody line1\nbody line2");
        assert.deepEqual(r?.frontmatter, { name: "foo", description: "a skill" });
        assert.equal(r?.body, "body line1\nbody line2");
    });
    it("值中含冒号：仅在首个冒号切分", () => {
        const r = parseSkillFile("---\nname: foo:bar:baz\n---\n");
        assert.equal(r?.frontmatter.name, "foo:bar:baz");
    });
    it("首行非 --- → 返回 null", () => {
        assert.equal(parseSkillFile("hello\n---\n"), null);
        assert.equal(parseSkillFile(""), null);
    });
    it("缺闭合 --- → 返回 null", () => {
        assert.equal(parseSkillFile("---\nname: foo\nbody without closer"), null);
    });
    it("空 frontmatter（--- 紧跟 ---）→ 空对象 + 正文", () => {
        const r = parseSkillFile("---\n---\nbody");
        assert.deepEqual(r?.frontmatter, {});
        assert.equal(r?.body, "body");
    });
    it("无冒号的行被忽略（不写入 frontmatter）", () => {
        const r = parseSkillFile("---\nname: foo\njunkline-no-colon\n---\n");
        assert.deepEqual(r?.frontmatter, { name: "foo" });
    });
    it("key 为空的行（如 ': value'）不写入", () => {
        const r = parseSkillFile("---\n: orphan\nname: foo\n---\n");
        assert.deepEqual(r?.frontmatter, { name: "foo" });
    });
    it("正文首尾空白被 trim", () => {
        const r = parseSkillFile("---\nname: foo\n---\n\n\n  body  \n\n");
        assert.equal(r?.body, "body");
    });
    it("兼容 CRLF 换行", () => {
        const r = parseSkillFile("---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody");
        assert.deepEqual(r?.frontmatter, { name: "foo", description: "bar" });
        assert.equal(r?.body, "body");
    });
});
