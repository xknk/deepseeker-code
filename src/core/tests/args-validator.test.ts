/**
 * @file tests/args-validator.test.ts
 * @description validateToolArgs（#8c 运行时参数校验）单测：放行/拒绝/coerce 容错/fail-open/缓存。
 *  执行层接线（toolExecution 保护路径检查前的早退）由全量回归 + tool-declaration-drift 覆盖控制流，
 *  本文件钉住校验器本身的纯函数契约。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateToolArgs } from "@/tool/argsValidator.ts";

describe("argsValidator（#8c 运行时参数校验）", () => {
    it("合法入参放行", () => {
        const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
        assert.deepEqual(validateToolArgs(schema, { path: "src/a.ts" }), { ok: true });
    });

    it("缺必填 → ok:false，message 含字段名（面向模型自纠）", () => {
        const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
        const v = validateToolArgs(schema, {});
        assert.ok(!v.ok && v.message.includes("path"), v.ok ? "" : v.message);
    });

    it("coerceTypes：数字字符串化就地修正（此前能跑的调用不被拒）", () => {
        const schema = { type: "object", properties: { line: { type: "number" } }, required: ["line"] };
        const args: any = { line: "3" };
        assert.deepEqual(validateToolArgs(schema, args), { ok: true });
        assert.equal(args.line, 3, "ajv 应就地把 \"3\" 修正为 3");
    });

    it("类型不符且不可 coerce → ok:false，message 带路径与 ajv 说明", () => {
        const schema = { type: "object", properties: { path: { type: "string" } } };
        // 注：标量间 coerce 是特性（42 → "42" 放行），对象 → string 不可 coerce 才判失败
        const v = validateToolArgs(schema, { path: { nested: true } });
        assert.ok(!v.ok && v.message.includes("path") && v.message.includes("must be"), v.ok ? "" : v.message);
    });

    it("schema 本身编译失败 → fail-open 放行（坏 schema 不打死工具）", () => {
        const bad = { type: "object", properties: { x: { type: "nonsense" } } } as any;
        assert.deepEqual(validateToolArgs(bad, { x: 1 }), { ok: true });
    });

    it("同一 schema 引用重复校验走缓存（WeakMap 命中，行为一致）", () => {
        const schema = { type: "object" } as any;
        assert.deepEqual(validateToolArgs(schema, {}), { ok: true });
        assert.deepEqual(validateToolArgs(schema, {}), { ok: true });
        assert.deepEqual(validateToolArgs(schema, { a: 1 }), { ok: true });
    });
});
