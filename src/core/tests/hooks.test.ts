/**
 * @file tests/hooks.test.ts
 * @description hooks/registry.ts 的 matches（工具名匹配器）单测。
 *  匹配器决定哪些 hook 对哪些工具生效，是声明式 hook 的核心路由逻辑。
 *  注：dispatch 的并发/fail-closed 行为涉及异步与全局 rules 状态，留作后续集成测试。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matches, registerHook, clearHooks, dispatch } from "@/hooks/registry.ts";
import { compileRule, validateRule, parseAgentDecision } from "@/hooks/loader.ts";
import { executeHttpHook } from "@/hooks/httpExecutor.ts";
import { requestApproval } from "@/tool/guard.ts";
import { ToolSafetyLevel } from "@/tool/type.ts";

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

describe("dispatch PreCompact/PostCompact/PermissionRequest（P1-8 压缩与权限审计 · 观察事件）", () => {
    it("PreCompact 携带 tokensBefore/tokensThreshold/depth", async () => {
        clearHooks();
        let captured: any = null;
        registerHook({ event: 'PreCompact', run: (ctx: any) => { captured = ctx; }, source: 'builtin' });
        const res = await dispatch('PreCompact', { sessionId: 's', depth: 0, tokensBefore: 220000, tokensThreshold: 212500 });
        assert.equal(captured?.tokensBefore, 220000);
        assert.equal(captured?.tokensThreshold, 212500);
        assert.equal(res.deny, false);
        clearHooks();
    });

    it("PostCompact 携带 tokensBefore/tokensAfter", async () => {
        clearHooks();
        let captured: any = null;
        registerHook({ event: 'PostCompact', run: (ctx: any) => { captured = ctx; }, source: 'builtin' });
        await dispatch('PostCompact', { sessionId: 's', depth: 0, tokensBefore: 220000, tokensAfter: 80000 });
        assert.equal(captured?.tokensBefore, 220000);
        assert.equal(captured?.tokensAfter, 80000);
        clearHooks();
    });

    it("PermissionRequest 携带 toolName/toolCallId/detail/safetyLevel", async () => {
        clearHooks();
        let captured: any = null;
        registerHook({ event: 'PermissionRequest', run: (ctx: any) => { captured = ctx; }, source: 'builtin' });
        await dispatch('PermissionRequest', { sessionId: 's', cwd: '/tmp', toolName: 'run_command', toolCallId: 'c1', detail: '申请执行', safetyLevel: 'danger', args: { command: 'rm -rf x' } });
        assert.equal(captured?.toolName, 'run_command');
        assert.equal(captured?.toolCallId, 'c1');
        assert.equal(captured?.safetyLevel, 'danger');
        clearHooks();
    });

    it("三者均为观察事件（deny 被忽略，返回 deny:false）", async () => {
        clearHooks();
        for (const ev of ['PreCompact', 'PostCompact', 'PermissionRequest'] as const) {
            registerHook({ event: ev, run: () => ({ deny: true, reason: '试图拦截' }), source: 'builtin' });
            const res = await dispatch(ev, { sessionId: 's', depth: 0, tokensBefore: 1, tokensAfter: 1, tokensThreshold: 1, toolName: 't', toolCallId: 'c', detail: '' });
            assert.equal(res.deny, false, `${ev} 不应被拦截`);
            clearHooks();
        }
    });

    it("guard.requestApproval 集成：派发 PermissionRequest（host deny → approved=false，无 LLM）", async () => {
        clearHooks();
        let captured: any = null;
        registerHook({ event: 'PermissionRequest', run: (ctx: any) => { captured = ctx; }, source: 'builtin' });
        const ctx: any = { sessionId: 's', cwd: '/tmp', requestApproval: async () => 'deny' as const, onUIEvent: () => {} };
        const approved = await requestApproval('run_command', 'call_1', '申请执行 echo', ctx, ToolSafetyLevel.DANGER, { command: 'echo hi' });
        assert.equal(captured?.toolName, 'run_command');
        assert.equal(captured?.toolCallId, 'call_1');
        assert.equal(captured?.safetyLevel, 'danger');
        assert.equal(approved, false, 'host deny → approved=false');
        clearHooks();
    });
});

describe("dispatch contextAdditions（prompt 注入通道 · P1-8）", () => {
    it("可拦截事件：多 rule 的 contextAdditions 累积带出（不 deny）", async () => {
        clearHooks();
        registerHook({ event: 'UserPromptSubmit', run: () => ({ contextAdditions: ['提示A'] }), source: 'builtin' });
        registerHook({ event: 'UserPromptSubmit', run: () => ({ contextAdditions: ['提示B'] }), source: 'builtin' });
        const res = await dispatch('UserPromptSubmit', { sessionId: 's', prompt: 'hi' });
        assert.equal(res.deny, false);
        assert.deepEqual(res.contextAdditions, ['提示A', '提示B']);
        clearHooks();
    });

    it("deny 时已累积的 contextAdditions 仍随返回带出（短路前已注入的保留）", async () => {
        clearHooks();
        registerHook({ event: 'UserPromptSubmit', run: () => ({ contextAdditions: ['先注入'] }), source: 'builtin' });
        registerHook({ event: 'UserPromptSubmit', run: () => ({ deny: true, reason: '拦截' }), source: 'builtin' });
        const res = await dispatch('UserPromptSubmit', { sessionId: 's', prompt: 'hi' });
        assert.equal(res.deny, true);
        assert.deepEqual(res.contextAdditions, ['先注入']);
        clearHooks();
    });

    it("无注入 → contextAdditions 为 undefined（向后兼容）", async () => {
        clearHooks();
        registerHook({ event: 'UserPromptSubmit', run: () => ({ deny: false }), source: 'builtin' });
        const res = await dispatch('UserPromptSubmit', { sessionId: 's', prompt: 'hi' });
        assert.equal(res.contextAdditions, undefined);
        clearHooks();
    });

    it("观察事件也收集 contextAdditions（仅 UserPromptSubmit 消费，但收集口径一致）", async () => {
        clearHooks();
        registerHook({ event: 'Stop', run: () => ({ contextAdditions: ['x'] }), source: 'builtin' });
        const res = await dispatch('Stop', { sessionId: 's', lastText: '', reason: 'normal' });
        assert.deepEqual(res.contextAdditions, ['x']);
        clearHooks();
    });
});

// —— executeHttpHook / compileRule 单测：mock 全局 fetch，避免真实网络 ——
const origFetch = globalThis.fetch;
/** 临时替换 globalThis.fetch；返回恢复函数。impl 抛错模拟网络失败/超时。 */
const mockFetch = (impl: (url: string, init?: any) => Promise<{ status: number; text: () => Promise<string> }>): (() => void) => {
    globalThis.fetch = ((url: string, init?: any) => impl(url, init)) as any;
    return () => { globalThis.fetch = origFetch; };
};

describe("executeHttpHook（http 执行器 · P1-8）", () => {
    it("2xx 响应：ok=true，返回状态码与响应体", async () => {
        const restore = mockFetch(async () => ({ status: 200, text: async () => '{"deny":true}' }));
        const r = await executeHttpHook({ url: 'https://x/hook', body: { a: 1 } });
        assert.equal(r.ok, true);
        assert.equal(r.status, 200);
        assert.equal(r.responseBody, '{"deny":true}');
        restore();
    });

    it("网络失败（fetch 抛错）：ok=false，带 error", async () => {
        const restore = mockFetch(async () => { throw new Error('ECONNREFUSED'); });
        const r = await executeHttpHook({ url: 'https://x/hook' });
        assert.equal(r.ok, false);
        assert.equal(r.status, 0);
        assert.match(r.error || '', /ECONNREFUSED/);
        restore();
    });

    it("超时（TimeoutError）：ok=false，error 含超时", async () => {
        const restore = mockFetch(async () => { const e = new Error('timeout'); (e as any).name = 'TimeoutError'; throw e; });
        const r = await executeHttpHook({ url: 'https://x/hook', timeoutMs: 5000 });
        assert.equal(r.ok, false);
        assert.match(r.error || '', /超时/);
        restore();
    });

    it("大响应体截断到 ~4KB", async () => {
        const restore = mockFetch(async () => ({ status: 200, text: async () => 'x'.repeat(10000) }));
        const r = await executeHttpHook({ url: 'https://x/hook' });
        assert.ok(r.responseBody.length < 10000, '应被截断');
        assert.match(r.responseBody, /响应截断/);
        restore();
    });
});

describe("compileRule（执行类型分支 · P1-8）", () => {
    it("prompt 类型：run → contextAdditions（不 deny）", async () => {
        const rule = compileRule('UserPromptSubmit', { type: 'prompt', text: '注入文本' });
        const res: any = await rule.run({});
        assert.deepEqual(res, { contextAdditions: ['注入文本'] });
    });

    it("http 类型：响应 JSON {deny:true,reason} → deny 采纳并透传 reason", async () => {
        const restore = mockFetch(async () => ({ status: 200, text: async () => JSON.stringify({ deny: true, reason: '不允许' }) }));
        const rule = compileRule('PreToolUse', { type: 'http', url: 'https://x/h', matcher: 'edit_file' });
        const res: any = await rule.run({ toolName: 'edit_file' });
        assert.equal(res.deny, true);
        assert.match(res.reason, /不允许/);
        restore();
    });

    it("http 类型：非 2xx + PreToolUse 默认 denyOnNonZero → deny（状态码）", async () => {
        const restore = mockFetch(async () => ({ status: 500, text: async () => 'err' }));
        const rule = compileRule('PreToolUse', { type: 'http', url: 'https://x/h' });
        const res: any = await rule.run({ toolName: 't' });
        assert.equal(res.deny, true);
        assert.match(res.reason, /状态码 500/);
        restore();
    });

    it("http 类型：2xx 且无 deny JSON → 放行", async () => {
        const restore = mockFetch(async () => ({ status: 200, text: async () => JSON.stringify({ ok: true }) }));
        const rule = compileRule('PreToolUse', { type: 'http', url: 'https://x/h' });
        const res: any = await rule.run({ toolName: 't' });
        assert.equal(res.deny, false);
        restore();
    });

    it("http 类型：网络失败 + denyOnNonZero=false → 放行", async () => {
        const restore = mockFetch(async () => { throw new Error('down'); });
        const rule = compileRule('PostToolUse', { type: 'http', url: 'https://x/h', denyOnNonZero: false });
        const res: any = await rule.run({ toolName: 't' });
        assert.equal(res.deny, false);
        restore();
    });

    it("command 类型：既有行为保留（exitCode 0 + denyOnNonZero → 放行）", async () => {
        // command 走 shellExecutor（真实 spawn），此处只验证 compileRule 产出结构正确、type 落 command
        const rule = compileRule('PostToolUse', { type: 'command', command: 'exit 0', matcher: 'read_file' });
        assert.equal(rule.event, 'PostToolUse');
        assert.equal((rule as any).matcher, 'read_file');
        assert.equal(rule.source, 'config');
        const res: any = await rule.run({ toolName: 'read_file', cwd: process.cwd() });
        assert.equal(res.deny, false);
    });
});

describe("validateRule（执行类型校验 · P1-8）", () => {
    const SRC = 'test', IDX = 0;

    it("command 类型缺 command → null", () => {
        assert.equal(validateRule({ type: 'command' }, 'PreToolUse', SRC, IDX), null);
    });

    it("无 type 默认 command，有 command → 通过", () => {
        const r = validateRule({ command: 'echo hi' }, 'PreToolUse', SRC, IDX);
        assert.equal(r?.type, 'command');
        assert.equal(r?.command, 'echo hi');
    });

    it("http 类型缺 url → null", () => {
        assert.equal(validateRule({ type: 'http' }, 'PreToolUse', SRC, IDX), null);
    });

    it("http 类型非 http(s) 协议 → null", () => {
        assert.equal(validateRule({ type: 'http', url: 'ftp://x' }, 'PreToolUse', SRC, IDX), null);
        assert.equal(validateRule({ type: 'http', url: 'not-a-url' }, 'PreToolUse', SRC, IDX), null);
    });

    it("http 类型合法 → 通过，method 大写、headers 透传", () => {
        const r = validateRule({ type: 'http', url: 'https://x/h', method: 'post', headers: { 'x-token': 't' } }, 'PreToolUse', SRC, IDX);
        assert.equal(r?.type, 'http');
        assert.equal(r?.url, 'https://x/h');
        assert.equal(r?.method, 'POST');
        assert.deepEqual(r?.headers, { 'x-token': 't' });
    });

    it("prompt 类型缺 text → null", () => {
        assert.equal(validateRule({ type: 'prompt' }, 'UserPromptSubmit', SRC, IDX), null);
    });

    it("prompt 类型仅 UserPromptSubmit 合法；其余事件 → null", () => {
        assert.equal(validateRule({ type: 'prompt', text: 'x' }, 'PreToolUse', SRC, IDX), null);
        assert.equal(validateRule({ type: 'prompt', text: 'x' }, 'Stop', SRC, IDX), null);
    });

    it("prompt 类型合法 → 通过，denyOnNonZero/onError 被忽略", () => {
        const r = validateRule({ type: 'prompt', text: '注入', denyOnNonZero: true, onError: 'deny' }, 'UserPromptSubmit', SRC, IDX);
        assert.equal(r?.type, 'prompt');
        assert.equal(r?.text, '注入');
        assert.equal(r?.denyOnNonZero, undefined, 'prompt 不消费 denyOnNonZero');
        assert.equal(r?.onError, undefined, 'prompt 不消费 onError');
    });

    it("agent 类型缺 task → null", () => {
        assert.equal(validateRule({ type: 'agent' }, 'PreToolUse', SRC, IDX), null);
    });

    it("agent 类型仅 PreToolUse 合法；其余事件 → null", () => {
        assert.equal(validateRule({ type: 'agent', task: 'x' }, 'PostToolUse', SRC, IDX), null);
        assert.equal(validateRule({ type: 'agent', task: 'x' }, 'UserPromptSubmit', SRC, IDX), null);
        assert.equal(validateRule({ type: 'agent', task: 'x' }, 'Stop', SRC, IDX), null);
    });

    it("agent 类型合法（PreToolUse + task）→ 通过", () => {
        const r = validateRule({ type: 'agent', task: '审查安全性', matcher: 'run_command' }, 'PreToolUse', SRC, IDX);
        assert.equal(r?.type, 'agent');
        assert.equal(r?.task, '审查安全性');
        assert.equal(r?.matcher, 'run_command');
    });
});

describe("parseAgentDecision（agent hook DECISION 协议解析）", () => {
    it("DENY 带理由 → deny + reason", () => {
        const d = parseAgentDecision("分析...\nDENY: 命令含 rm -rf，高危");
        assert.equal(d.deny, true);
        assert.equal(d.reason, "命令含 rm -rf，高危");
        assert.equal(d.explicit, true);
    });
    it("ALLOW → 放行 + explicit", () => {
        const d = parseAgentDecision("看起来安全\nALLOW");
        assert.equal(d.deny, false);
        assert.equal(d.explicit, true);
    });
    it("无 DECISION 行 → explicit:false（调用方按 denyOnNonZero 兜底）", () => {
        const d = parseAgentDecision("只是分析，没有给结论");
        assert.equal(d.deny, false);
        assert.equal(d.explicit, false);
    });
    it("多次出现 → 取最后一行决策", () => {
        const d = parseAgentDecision("DENY: 第一次想法\n重新考虑后\nALLOW");
        assert.equal(d.deny, false, "取最后一条 ALLOW");
    });
    it("大小写不敏感 + 中文冒号兼容", () => {
        assert.equal(parseAgentDecision("deny：危险").deny, true);
        assert.equal(parseAgentDecision("allow").explicit, true);
    });
    it("DENY 无理由 → deny + reason undefined", () => {
        const d = parseAgentDecision("DENY");
        assert.equal(d.deny, true);
        assert.equal(d.reason, undefined);
    });
});

describe("compileRule agent 分支（深度门控防递归 · P1-8）", () => {
    it("depth>0（子 agent 的工具调用）→ 直接放行，不 spawn 子 agent（防 fan-out）", async () => {
        const rule = compileRule('PreToolUse', { type: 'agent', task: '审查', matcher: 'edit_file' });
        // depth=1 模拟子 agent 的工具调用：必须短路返回 deny:false，绝不进入 runSubagent
        const res: any = await rule.run({ toolName: 'edit_file', toolContext: { depth: 1 } });
        assert.equal(res.deny, false, '子 agent 深度应跳过 agent hook');
    });

    it("toolContext 缺失 → 安全放行（无 ctx.toolContext 无法 spawn）", async () => {
        const rule = compileRule('PreToolUse', { type: 'agent', task: '审查', matcher: 'edit_file' });
        const res: any = await rule.run({ toolName: 'edit_file' });
        assert.equal(res.deny, false);
    });
});
