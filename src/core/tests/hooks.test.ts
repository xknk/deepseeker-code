/**
 * @file tests/hooks.test.ts
 * @description hooks/registry.ts 的 matches（工具名匹配器）单测。
 *  匹配器决定哪些 hook 对哪些工具生效，是声明式 hook 的核心路由逻辑。
 *  注：dispatch 的并发/fail-closed 行为涉及异步与全局 rules 状态，留作后续集成测试。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matches, registerHook, clearHooks, dispatch } from "@/hooks/registry.ts";

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

describe("dispatch SubagentStart/Stop（P1-8 子 agent 生命周期 · 观察事件）", () => {
    it("SubagentStart 派发到注册的 hook，携带 parentSessionId/task/depth/name", async () => {
        clearHooks();
        let captured: any = null;
        registerHook({ event: 'SubagentStart', run: (ctx: any) => { captured = ctx; }, source: 'builtin' });
        const res = await dispatch('SubagentStart', { sessionId: 'sub1', parentSessionId: 'main1', task: '写测试', depth: 1, name: 'tester', cwd: '/tmp' });
        assert.equal(captured?.parentSessionId, 'main1');
        assert.equal(captured?.task, '写测试');
        assert.equal(captured?.depth, 1);
        assert.equal(captured?.name, 'tester');
        assert.equal(res.deny, false, '观察事件 deny 应被忽略');
        clearHooks();
    });

    it("SubagentStop 携带 ok/output", async () => {
        clearHooks();
        let captured: any = null;
        registerHook({ event: 'SubagentStop', run: (ctx: any) => { captured = ctx; }, source: 'builtin' });
        await dispatch('SubagentStop', { sessionId: 'sub1', parentSessionId: 'main1', task: 'x', depth: 2, ok: false, output: '崩溃', cwd: '/tmp' });
        assert.equal(captured?.ok, false);
        assert.equal(captured?.output, '崩溃');
        assert.equal(captured?.depth, 2);
        clearHooks();
    });

    it("观察事件 handler 抛错不击垮 dispatch（best-effort，返回 deny:false）", async () => {
        clearHooks();
        registerHook({ event: 'SubagentStart', run: () => { throw new Error("boom"); }, source: 'builtin' });
        const res = await dispatch('SubagentStart', { sessionId: 's', parentSessionId: 'm', task: 'x', depth: 1 });
        assert.equal(res.deny, false);
        clearHooks();
    });

    it("不影响其它事件（按 event 过滤，非目标 hook 不触发）", async () => {
        clearHooks();
        let startCount = 0;
        registerHook({ event: 'SubagentStart', run: () => { startCount++; }, source: 'builtin' });
        await dispatch('SubagentStop', { sessionId: 's', parentSessionId: 'm', task: 'x', depth: 1, ok: true, output: '' });
        assert.equal(startCount, 0, 'SubagentStop 不应触发 SubagentStart hook');
        clearHooks();
    });
});
