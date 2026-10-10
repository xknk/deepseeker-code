/**
 * @file tests/tool-scheduling-dedup.test.ts
 * @description P3-6 同轮重复 tool_call 去重（dedupeSameRoundCalls 纯函数）行为锁。
 *  覆盖：完全一致签名去重、参数字节不同不去重、工具名不同不去重、请求序保持、空/单条平凡情形。
 *  dedupeSameRoundCalls 为纯函数；import 链上 toolScheduling 仅模块注册无副作用，本文件不触网。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupeSameRoundCalls } from "@/agent/toolScheduling.ts";

const tc = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });

describe("dedupeSameRoundCalls（P3-6 同轮重复去重）", () => {
    it("name+arguments 完全一致 → 只执行首个，dupOf 指向首个", () => {
        const r = dedupeSameRoundCalls([
            tc("a1", "read_file", '{"path":"a.ts"}'),
            tc("a2", "read_file", '{"path":"a.ts"}'),
            tc("a3", "read_file", '{"path":"a.ts"}'),
        ]);
        assert.deepEqual(r.batch.map((t) => t.id), ["a1"], "仅首个待执行");
        assert.equal(r.plan.length, 3);
        assert.equal(r.plan[0].dupOf, undefined);
        assert.equal(r.plan[1].dupOf, r.batch[0], "a2 复用 a1");
        assert.equal(r.plan[2].dupOf, r.batch[0], "a3 复用 a1");
    });

    it("arguments 字节不同（键序/空白差异）不去重——完全一致才复用", () => {
        const r = dedupeSameRoundCalls([
            tc("b1", "read_file", '{"path":"a.ts"}'),
            tc("b2", "read_file", '{"path": "a.ts"}'),
            tc("b3", "read_file", '{"x":1,"path":"a.ts"}'),
        ]);
        assert.deepEqual(r.batch.map((t) => t.id), ["b1", "b2", "b3"], "字节不同=不同调用");
        assert.ok(r.plan.every((p) => !p.dupOf));
    });

    it("工具名不同 / 请求序保持 / 空与单条平凡", () => {
        const r = dedupeSameRoundCalls([
            tc("c1", "read_file", '{"path":"a.ts"}'),
            tc("c2", "search_grep", '{"path":"a.ts"}'),
            tc("c3", "read_file", '{"path":"b.ts"}'),
        ]);
        assert.deepEqual(r.batch.map((t) => t.id), ["c1", "c2", "c3"]);
        assert.deepEqual(r.plan.map((p) => p.tc.id), ["c1", "c2", "c3"], "plan 请求序=入参序");

        assert.deepEqual(dedupeSameRoundCalls([]), { batch: [], plan: [] });
        const one = dedupeSameRoundCalls([tc("d1", "read_file", "{}")]);
        assert.deepEqual(one.batch.map((t) => t.id), ["d1"]);
        assert.equal(one.plan.length, 1);
    });

    it("两组各自独立去重（不同签名互不干扰）", () => {
        const r = dedupeSameRoundCalls([
            tc("e1", "read_file", '{"path":"a.ts"}'),
            tc("e2", "search_grep", '{"query":"q"}'),
            tc("e3", "read_file", '{"path":"a.ts"}'),
            tc("e4", "search_grep", '{"query":"q"}'),
        ]);
        assert.deepEqual(r.batch.map((t) => t.id), ["e1", "e2"]);
        assert.equal(r.plan[2].dupOf?.id, "e1");
        assert.equal(r.plan[3].dupOf?.id, "e2");
    });
});
