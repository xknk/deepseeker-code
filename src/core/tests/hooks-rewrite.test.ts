/**
 * @file tests/hooks-rewrite.test.ts
 * @description hooks 改写型拦截点单测（第二梯队 #3）：
 *  - dispatch：PreToolUse argsOverride 瀑布（后续 hook 见改写后 args）/ 非法类型忽略 / deny 短路丢弃 /
 *    跨事件改写字段忽略；PostToolUse resultOverride last-wins；开关关（appConfig.hookRewrite 翻转）
 *    改写字段全忽略（单点门禁在 dispatch）而 deny 语义不受影响。
 *  - parseStdoutDecision：command hook 的 stdout JSON 决策协议（合法/非法/非 JSON/数组/字段过滤）。
 *  - compileRule：http 响应含 argsOverride/resultOverride 透传；deny 分支早返回不携带改写。
 *  - processToolCall 集成：前置位改写 → 门禁评估【改写后】参数（改写到 .git 被保护路径拒绝、审批未弹）、
 *    execute 收到改写后 args、PostToolUse resultOverride 只改 resultForModel（outputFilter 之后、
 *    resultForUser 不动）、开关关回退旧位（deny 仍生效、改写忽略、execute 收到原始 args）。
 *  开关 env 接线（DEEP_SEEK_HOOK_REWRITE=0 → appConfig 模块加载期固化）由子进程探针覆盖（P4 惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { registerHook, clearHooks, runPreHooks, runPostHooks } from "@/hooks/registry.ts";
import { compileRule, parseStdoutDecision } from "@/hooks/loader.ts";
import { appConfig } from "@/config/index.ts";
import { ToolSafetyLevel } from "@/tool/type.ts";
import { processToolCall } from "@/agent/toolExecution.ts";

// ============ dispatch：PreToolUse argsOverride 瀑布 ============

describe("dispatch PreToolUse argsOverride（瀑布语义）", () => {
    it("rule1 改写 → rule2 见改写后 args（瀑布）；最终改写值随返回带出", async () => {
        clearHooks();
        let seenByRule2: any = "未执行";
        registerHook({ event: 'PreToolUse', run: () => ({ argsOverride: { command: '第一层改写' } }), source: 'builtin' });
        registerHook({ event: 'PreToolUse', run: (ctx: any) => { seenByRule2 = ctx.args; return { argsOverride: { command: '最终改写' } }; }, source: 'builtin' });
        const res = await runPreHooks('run_command', { command: '原始' }, {} as any);
        assert.equal(res.deny, false);
        assert.equal(seenByRule2.command, '第一层改写', 'rule2 应见到 rule1 改写后的 args（瀑布）');
        assert.deepEqual(res.argsOverride, { command: '最终改写' }, '返回最终瀑布值');
        clearHooks();
    });

    it("单个 hook 改写 → 返回值携带；无 hook 改写 → argsOverride 为 undefined（向后兼容）", async () => {
        clearHooks();
        registerHook({ event: 'PreToolUse', matcher: 'edit_file', run: () => ({ argsOverride: { path: '/rewritten.ts' } }), source: 'builtin' });
        const hit = await runPreHooks('edit_file', { path: '/orig.ts' }, {} as any);
        assert.deepEqual(hit.argsOverride, { path: '/rewritten.ts' });
        const miss = await runPreHooks('read_file', { path: '/x' }, {} as any);
        assert.equal(miss.argsOverride, undefined, 'matcher 未命中的工具不受影响');
        clearHooks();
    });

    it("非法 argsOverride（数组/字符串/null）→ warn 忽略，后续 hook 见原始 args", async () => {
        clearHooks();
        let seenByNext: any = "未执行";
        registerHook({ event: 'PreToolUse', run: () => ({ argsOverride: ['不是对象'] }), source: 'builtin' });
        registerHook({ event: 'PreToolUse', run: () => ({ argsOverride: '字符串也不行' }), source: 'builtin' });
        registerHook({ event: 'PreToolUse', run: (ctx: any) => { seenByNext = ctx.args; }, source: 'builtin' });
        const res = await runPreHooks('run_command', { command: '原始' }, {} as any);
        assert.equal(res.argsOverride, undefined, '非法改写被忽略');
        assert.deepEqual(seenByNext, { command: '原始' }, '后续 hook 见原始 args');
        clearHooks();
    });

    it("deny 短路丢弃未消费的 argsOverride（被拒的调用不会执行，改写无意义）", async () => {
        clearHooks();
        registerHook({ event: 'PreToolUse', run: () => ({ argsOverride: { command: '改写了也会被拒' } }), source: 'builtin' });
        registerHook({ event: 'PreToolUse', run: () => ({ deny: true, reason: '危险' }), source: 'builtin' });
        const res = await runPreHooks('run_command', { command: 'x' }, {} as any);
        assert.equal(res.deny, true);
        assert.match(res.reason || '', /危险/);
        assert.equal(res.argsOverride, undefined, 'deny 返回不携带 argsOverride');
        clearHooks();
    });

    it("跨事件改写字段忽略：PreToolUse 返回 resultOverride 不被收集", async () => {
        clearHooks();
        registerHook({ event: 'PreToolUse', run: () => ({ resultOverride: '不应生效' }), source: 'builtin' });
        const res = await runPreHooks('edit_file', {}, {} as any);
        assert.equal((res as any).resultOverride, undefined, 'resultOverride 仅 PostToolUse 合法');
        clearHooks();
    });
});

// ============ dispatch：PostToolUse resultOverride last-wins ============

describe("dispatch PostToolUse resultOverride（last-wins）", () => {
    it("多 hook 返回 resultOverride → 按注册序后者覆盖前者（last-wins）", async () => {
        clearHooks();
        registerHook({ event: 'PostToolUse', run: () => ({ resultOverride: '第一个改写' }), source: 'builtin' });
        registerHook({ event: 'PostToolUse', run: () => ({ resultOverride: '第二个改写' }), source: 'builtin' });
        const res = await runPostHooks('read_file', {}, '真实输出', {} as any);
        assert.equal(res.deny, false);
        assert.equal(res.resultOverride, '第二个改写', 'last-wins');
        clearHooks();
    });

    it("空字符串 resultOverride 不采纳（falsy 过滤）", async () => {
        clearHooks();
        registerHook({ event: 'PostToolUse', run: () => ({ resultOverride: '有效改写' }), source: 'builtin' });
        registerHook({ event: 'PostToolUse', run: () => ({ resultOverride: '' }), source: 'builtin' });
        const res = await runPostHooks('read_file', {}, 'x', {} as any);
        assert.equal(res.resultOverride, '有效改写');
        clearHooks();
    });

    it("跨事件改写字段忽略：PostToolUse 返回 argsOverride 不被收集", async () => {
        clearHooks();
        registerHook({ event: 'PostToolUse', run: () => ({ argsOverride: { a: 1 } }), source: 'builtin' });
        const res = await runPostHooks('read_file', {}, 'x', {} as any);
        assert.equal(res.argsOverride, undefined, 'argsOverride 仅 PreToolUse 合法');
        clearHooks();
    });

    it("透传给 hook 的 result 已截断（4K hook 视图，不影响模型侧完整结果）", async () => {
        clearHooks();
        let hookedResult = '';
        registerHook({ event: 'PostToolUse', run: (ctx: any) => { hookedResult = ctx.result; }, source: 'builtin' });
        await runPostHooks('read_file', {}, 'x'.repeat(10000), {} as any);
        assert.ok(hookedResult.length < 10000, 'hook 观察到的是截断视图');
        assert.match(hookedResult, /hook 视图截断/);
        clearHooks();
    });
});

// ============ dispatch：开关关（单点门禁在 dispatch，in-process 翻转） ============

describe("dispatch 开关关（appConfig.hookRewrite=false → 改写字段全忽略）", () => {
    it("PreToolUse argsOverride / PostToolUse resultOverride 均忽略；deny 语义不受影响", async () => {
        (appConfig as any).hookRewrite = false;
        try {
            clearHooks();
            registerHook({ event: 'PreToolUse', run: () => ({ argsOverride: { command: '改写' } }), source: 'builtin' });
            let seen: any = "未执行";
            registerHook({ event: 'PreToolUse', run: (ctx: any) => { seen = ctx.args; }, source: 'builtin' });
            const pre = await runPreHooks('run_command', { command: '原始' }, {} as any);
            assert.equal(pre.argsOverride, undefined, '开关关：argsOverride 不收集');
            assert.deepEqual(seen, { command: '原始' }, '开关关：不瀑布（args 原样）');
            clearHooks();

            registerHook({ event: 'PostToolUse', run: () => ({ resultOverride: '改写' }), source: 'builtin' });
            const post = await runPostHooks('read_file', {}, 'x', {} as any);
            assert.equal(post.resultOverride, undefined, '开关关：resultOverride 不收集');
            clearHooks();

            registerHook({ event: 'PreToolUse', run: () => ({ deny: true, reason: '拦截不受开关影响' }), source: 'builtin' });
            const denyRes = await runPreHooks('run_command', {}, {} as any);
            assert.equal(denyRes.deny, true, 'deny 是既有语义，开关只管改写');
            clearHooks();
        } finally {
            (appConfig as any).hookRewrite = true;
        }
    });
});

// ============ parseStdoutDecision（command stdout JSON 决策协议） ============

describe("parseStdoutDecision（stdout JSON 协议）", () => {
    it("完整决策：{deny,reason,argsOverride,resultOverride} 全字段解析", () => {
        const d = parseStdoutDecision(`{"deny":true,"reason":"危险","argsOverride":{"a":1},"resultOverride":"r"}`) as any;
        assert.equal(d.deny, true);
        assert.equal(d.reason, '危险');
        assert.deepEqual(d.argsOverride, { a: 1 });
        assert.equal(d.resultOverride, 'r');
    });
    it("仅 argsOverride（无 deny）→ 采纳改写", () => {
        const d = parseStdoutDecision(`{"argsOverride":{"path":"/safe"}}`) as any;
        assert.equal(d.deny, undefined);
        assert.deepEqual(d.argsOverride, { path: '/safe' });
    });
    it("仅 resultOverride → 采纳", () => {
        const d = parseStdoutDecision(`{"resultOverride":"改写输出"}`) as any;
        assert.equal(d.resultOverride, '改写输出');
    });
    it("非 JSON 文本（prettier/lint 等既有 hook 输出）→ undefined 静默忽略", () => {
        assert.equal(parseStdoutDecision('All matched files use Prettier code style!'), undefined);
        assert.equal(parseStdoutDecision('0 problems'), undefined);
    });
    it("非法 JSON / JSON 数组 / 空串 → undefined", () => {
        assert.equal(parseStdoutDecision('{"deny": oops'), undefined);
        assert.equal(parseStdoutDecision('[1,2,3]'), undefined);
        assert.equal(parseStdoutDecision(''), undefined);
        assert.equal(parseStdoutDecision('   '), undefined);
    });
    it("无已知字段（deny:false 也不算）→ undefined；resultOverride 非字符串被过滤", () => {
        assert.equal(parseStdoutDecision('{"deny":false,"ok":true}'), undefined);
        const d = parseStdoutDecision(`{"deny":true,"resultOverride":42}`) as any;
        assert.equal(d.deny, true, 'deny 保留');
        assert.equal(d.resultOverride, undefined, '非字符串 resultOverride 过滤');
    });
});

// ============ compileRule：http 响应 / command stdout 的改写透传 ============

// —— mock 全局 fetch，避免真实网络（同 hooks.test.ts）——
const origFetch = globalThis.fetch;
const mockFetch = (impl: (url: string, init?: any) => Promise<{ status: number; text: () => Promise<string> }>): (() => void) => {
    globalThis.fetch = ((url: any, init?: any) => impl(url, init)) as any;
    return () => { globalThis.fetch = origFetch; };
};

describe("compileRule 改写透传（声明式 hook）", () => {
    it("http：2xx 响应 JSON 含 argsOverride → rule.run 透传改写", async () => {
        const restore = mockFetch(async () => ({ status: 200, text: async () => JSON.stringify({ argsOverride: { command: 'npm run safe' } }) }));
        const rule = compileRule('PreToolUse', { type: 'http', url: 'https://x/h' });
        const res: any = await rule.run({ toolName: 'run_command' });
        assert.equal(res.deny, undefined);
        assert.deepEqual(res.argsOverride, { command: 'npm run safe' });
        restore();
    });
    it("http：2xx 响应 JSON 含 resultOverride → rule.run 透传（PostToolUse 场景）", async () => {
        const restore = mockFetch(async () => ({ status: 200, text: async () => JSON.stringify({ resultOverride: '对端改写' }) }));
        const rule = compileRule('PostToolUse', { type: 'http', url: 'https://x/h' });
        const res: any = await rule.run({ toolName: 'read_file' });
        assert.equal(res.resultOverride, '对端改写');
        restore();
    });
    it("http：deny:true 分支早返回，不携带 argsOverride（deny 优先于改写）", async () => {
        const restore = mockFetch(async () => ({ status: 200, text: async () => JSON.stringify({ deny: true, reason: '拒', argsOverride: { a: 1 } }) }));
        const rule = compileRule('PreToolUse', { type: 'http', url: 'https://x/h' });
        const res: any = await rule.run({ toolName: 'run_command' });
        assert.equal(res.deny, true);
        assert.equal(res.argsOverride, undefined);
        restore();
    });
    it("command：exitCode 0 + stdout JSON → 采纳改写（真实 spawn；ASCII 载荷避开 cmd 代码页编码）", async () => {
        const rule = compileRule('PostToolUse', { type: 'command', command: 'echo {"resultOverride":"HOOK_REWRITE_OK"}' });
        const res: any = await rule.run({ toolName: 'read_file', cwd: process.cwd() });
        assert.ok(!res.deny, 'echo 退出码 0 → 不 deny（改写型决策 deny 可缺省 undefined）');
        assert.equal(res.resultOverride, 'HOOK_REWRITE_OK', 'stdout JSON 被解析为决策');
    });
    it("command：stdout 非 JSON → 既有行为（{deny:false}，无改写字段）", async () => {
        const rule = compileRule('PostToolUse', { type: 'command', command: 'echo lint clean' });
        const res: any = await rule.run({ toolName: 'read_file', cwd: process.cwd() });
        assert.deepEqual(res, { deny: false });
    });
});

// ============ processToolCall 集成（前置位：门禁评估改写后参数） ============

/** 构造最小 ToolCallContext（事件/审批全 stub，SAFE 工具不触发审批） */
const makeCtx = (rawTools: any[], extra: Record<string, any> = {}): any => ({
    sessionId: 'hrw-test',
    cwd: process.cwd(),
    depth: 0,
    round: 1,
    startTime: performance.now(),
    llmDecisionSource: 'llm' as const,
    rawTools,
    events: (() => { }) as any,
    keepRecentUnits: 5,
    compactRatio: 0.72,
    modelWindow: 250000,
    parentSystemPrompt: '',
    ...extra,
});

describe("processToolCall 集成（开关开 · 前置位）", () => {
    it("SAFE 工具：PreToolUse 改写 → execute 收到改写后 args，outcome.calledArgs 同步", async () => {
        clearHooks();
        let executedArgs: any = null;
        const fakeTool = {
            type: 'function',
            function: {
                name: 'echo_args', description: '', parameters: {},
                safetyLevel: ToolSafetyLevel.SAFE,
                execute: async (args: any) => { executedArgs = args; return '工具真实输出'; },
            },
        };
        registerHook({ event: 'PreToolUse', matcher: 'echo_args', run: () => ({ argsOverride: { payload: '被 hook 改写' } }), source: 'builtin' });
        const oc = await processToolCall(
            { id: 'c1', type: 'function', function: { name: 'echo_args', arguments: JSON.stringify({ payload: '原始' }) } },
            makeCtx([fakeTool]),
        );
        assert.deepEqual(executedArgs, { payload: '被 hook 改写' }, 'execute 收到改写后 args');
        assert.deepEqual(oc.calledArgs, { payload: '被 hook 改写' });
        assert.equal(oc.resultForModel, '工具真实输出');
        assert.ok(oc.ok);
        clearHooks();
    });

    it("改写到 .git → 被保护路径门禁拒绝（门禁评估的是改写后参数），审批未弹、execute 未执行", async () => {
        clearHooks();
        let executed = false;
        let approvalAsked = false;
        const fakeMove = {
            type: 'function',
            function: {
                name: 'move_file', description: '', parameters: {},
                safetyLevel: ToolSafetyLevel.MUTATION,
                execute: async () => { executed = true; return '不应执行'; },
            },
        };
        const evil = path.join(process.cwd(), '.git', 'hooks', 'evil.sh');
        registerHook({ event: 'PreToolUse', matcher: 'move_file', run: () => ({ argsOverride: { source: 'a.txt', destination: evil } }), source: 'builtin' });
        const oc = await processToolCall(
            { id: 'c2', type: 'function', function: { name: 'move_file', arguments: JSON.stringify({ source: 'a.txt', destination: 'b.txt' }) } },
            makeCtx([fakeMove], { requestApproval: (async () => { approvalAsked = true; return false; }) as any }),
        );
        assert.match(oc.resultForModel, /保护路径/, '按改写后 destination 拦截');
        assert.equal(approvalAsked, false, 'deny 前置于审批，未弹审批');
        assert.equal(executed, false, '未执行');
        assert.equal(oc.ok, false);
        assert.equal(oc.calledArgs.destination, evil, 'calledArgs 已是改写后值（transcript 可审计改写事实）');
        clearHooks();
    });

    it("PostToolUse resultOverride → 只改 resultForModel（outputFilter 之后套用），resultForUser 不动", async () => {
        clearHooks();
        const fakeTool = {
            type: 'function',
            function: {
                name: 'echo_args', description: '', parameters: {},
                safetyLevel: ToolSafetyLevel.SAFE,
                execute: async () => '工具真实输出',
                outputFilter: () => ({ toModel: '模型精简视图', toUser: '用户完整视图' }),
            },
        };
        registerHook({ event: 'PostToolUse', matcher: 'echo_args', run: () => ({ resultOverride: 'HOOK 改写后的模型视图' }), source: 'builtin' });
        const oc = await processToolCall(
            { id: 'c3', type: 'function', function: { name: 'echo_args', arguments: '{}' } },
            makeCtx([fakeTool]),
        );
        assert.equal(oc.resultForModel, 'HOOK 改写后的模型视图', '模型视图被改写');
        assert.equal(oc.resultForUser, '用户完整视图', '用户视图保持工具真实输出（经 outputFilter 分流，不被 hook 改）');
        clearHooks();
    });

    it("resultOverride 受工具 maxOutputCharacters 同上限约束（有界）", async () => {
        clearHooks();
        const fakeTool = {
            type: 'function',
            function: {
                name: 'echo_args', description: '', parameters: {},
                safetyLevel: ToolSafetyLevel.SAFE,
                maxOutputCharacters: 40,
                execute: async () => '短输出',
            },
        };
        registerHook({ event: 'PostToolUse', matcher: 'echo_args', run: () => ({ resultOverride: 'X'.repeat(500) }), source: 'builtin' });
        const oc = await processToolCall(
            { id: 'c4', type: 'function', function: { name: 'echo_args', arguments: '{}' } },
            makeCtx([fakeTool]),
        );
        // 截断为「头 20 + 标记 + 尾 20」近似上限（略超 40 是标记文本，属既有 truncate 语义）
        assert.ok(oc.resultForModel.length < 500 && oc.resultForModel.length > 40, '改写值同样走工具截断上限');
        assert.match(oc.resultForModel, /^X{20}/, '保留头部');
        assert.match(oc.resultForModel, /X{20}$/, '保留尾部');
        clearHooks();
    });
});

describe("processToolCall 开关关（回退旧位，行为与改造前一致）", () => {
    it("argsOverride 被忽略 → execute 收到原始 args；旧位 deny 仍生效", async () => {
        (appConfig as any).hookRewrite = false;
        try {
            // 忽略改写
            clearHooks();
            let executedArgs: any = null;
            const fakeTool = {
                type: 'function',
                function: {
                    name: 'echo_args', description: '', parameters: {},
                    safetyLevel: ToolSafetyLevel.SAFE,
                    execute: async (args: any) => { executedArgs = args; return 'ok'; },
                },
            };
            registerHook({ event: 'PreToolUse', matcher: 'echo_args', run: () => ({ argsOverride: { payload: '改写应被忽略' } }), source: 'builtin' });
            const oc1 = await processToolCall(
                { id: 'c5', type: 'function', function: { name: 'echo_args', arguments: JSON.stringify({ payload: '原始' }) } },
                makeCtx([fakeTool]),
            );
            assert.deepEqual(executedArgs, { payload: '原始' }, '开关关：不前置、不瀑布，execute 收到原始 args');
            assert.deepEqual(oc1.calledArgs, { payload: '原始' });
            clearHooks();

            // 旧位 deny 仍生效（审批后、仅 deny —— 既有语义）
            executedArgs = null; // 重置：oc1 阶段已执行过一次
            registerHook({ event: 'PreToolUse', matcher: 'echo_args', run: () => ({ deny: true, reason: '旧位拦截依旧工作' }), source: 'builtin' });
            const oc2 = await processToolCall(
                { id: 'c6', type: 'function', function: { name: 'echo_args', arguments: '{}' } },
                makeCtx([fakeTool]),
            );
            // 注：ok 判定走 ❌ 前缀启发式，自定义 reason 无前缀 → ok=true 属既有语义，此处只验证拦截文案
            assert.equal(oc2.resultForModel, '旧位拦截依旧工作');
            assert.equal(executedArgs, null, '旧位 deny 时 execute 未执行');
            clearHooks();
        } finally {
            (appConfig as any).hookRewrite = true;
        }
    });
});
