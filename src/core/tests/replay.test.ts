/**
 * @file tests/replay.test.ts
 * @description ReplayProvider（第二梯队 #4）三层回归：零成本确定性驱动 runAgent 全链路。
 *  1) provider 单测：chunk 顺序 / 故障预算与游标 / summarize·classifyRisk / wire 构造 / 剧本录制映射；
 *  2) streamInference 集成：三道重试通道（idle→text.reset 重推、transient 退避重试、context_length 降级重试）；
 *  3) runAgent harness 回归（本特性的存在意义）：PHANTOM / EARLY_FINAL / TOOL_DIGEST 三守护 +
 *     repeat 熔断占位 + abort 收尾——历史控制流 bug（harness-silent-freeze-bugs 全集）的确定性复现。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR / WORKSPACE_ROOT 必须在 import core 之前设置 → 全动态 import。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-replay-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX; // read_file 等工具的根（fixture 放沙盒内）
const FIXTURE = path.join(SANDBOX, "fixture.txt");
await fs.writeFile(FIXTURE, "REPLAY-FIXTURE-CONTENT 第一行\n第二行内容\n");

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例。
//   实证（probe-bind）：alias 与相对路径混用会产生两个 model.ts 实例，setActiveProvider
//   换装的实例不是 streamInference 持有的那个 → 回放失效、误打真实 API。既有 hooks.test.ts 同惯例。
const { createReplayProvider, scriptFromMessages } = await import("@/llm/providers/replay/index.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { streamInference } = await import("@/agent/streamInference.ts");
const { runAgent } = await import("@/agent/runAgent.ts");
const { readTranscriptLines } = await import("@/session/transcript.ts");
const { agentTools } = await import("@/tool/index.ts");

/** 挂载回放 provider 执行 fn，结束复位（防泄漏影响其它测试）。返回 provider 句柄供断言。 */
const withReplay = async <T>(script: any, fn: (p: any) => Promise<T>): Promise<{ handle: any; ret: T }> => {
    const p = createReplayProvider(script);
    setActiveProvider(p);
    try {
        const ret = await fn(p);
        return { handle: p, ret };
    } finally {
        resetActiveProvider();
    }
};

const collectChunks = async (gen: AsyncGenerator<any>): Promise<any[]> => {
    const out: any[] = [];
    for await (const c of gen) out.push(c);
    return out;
};

// ============ 1) provider 单测 ============

describe("ReplayProvider 单测（chunk / 故障 / 游标）", () => {
    it("干净流出：reasoning → text → 每工具两分片 → usage，游标推进", async () => {
        const p = createReplayProvider({
            turns: [{
                kind: 'reply',
                content: '正文内容',
                reasoning: '思考',
                toolCalls: [{ name: 'read_file', args: { path: '/a' } }, { name: 'glob', args: { pattern: '*.ts' } }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 50 },
            }],
        });
        const chunks = await collectChunks(p.streamChat([{ role: 'user', content: 'q' } as any], undefined, {}));
        assert.deepEqual(chunks.map((c) => c.kind), ['reasoning', 'text', 'tool_call_delta', 'tool_call_delta', 'tool_call_delta', 'tool_call_delta', 'usage']);
        assert.equal(chunks[2].nameDelta, 'read_file');
        assert.equal(JSON.parse(chunks[3].argumentsDelta).path, '/a');
        assert.equal(chunks[4].nameDelta, 'glob');
        assert.equal(chunks[6].usage.cached_tokens, 50);
        assert.equal(p.cursor, 1, '完整流完推进游标');
    });

    it("idle 故障（times=1）：首进即抛且游标不动；重入同 turn 干净流出（重试成功）", async () => {
        const p = createReplayProvider({ turns: [{ kind: 'reply', content: '重试后的正文', fault: { type: 'idle' } }] });
        await assert.rejects(() => collectChunks(p.streamChat([], undefined, {})), /stream_idle_timeout/);
        assert.equal(p.cursor, 0, '故障 turn 不推进');
        const chunks = await collectChunks(p.streamChat([], undefined, {}));
        assert.equal(chunks[0].text, '重试后的正文');
        assert.equal(p.cursor, 1);
    });

    it("mid-stream 故障（afterChars）：先吐部分正文再抛 transient（带 status 429）", async () => {
        const p = createReplayProvider({ turns: [{ kind: 'reply', content: '一二三四五六七八九十', fault: { type: 'transient', afterChars: 4 } }] });
        const chunks: any[] = [];
        await assert.rejects(async () => {
            for await (const c of p.streamChat([], undefined, {})) chunks.push(c);
        }, (e: any) => e.replayFault === 'transient' && e.status === 429);
        assert.equal(chunks.length, 1, '先吐 1 个 text 分片');
        assert.equal(chunks[0].text, '一二三四');
    });

    it("fatal 故障：每次重入都抛（游标不动，重试耗尽交 error 收尾）", async () => {
        const p = createReplayProvider({ turns: [{ kind: 'reply', content: '不可达', fault: { type: 'fatal' } }] });
        for (let i = 0; i < 3; i++) {
            await assert.rejects(() => collectChunks(p.streamChat([], undefined, {})), /回放致命错误/);
        }
        assert.equal(p.cursor, 0);
    });

    it("错误分类器自识别回放标记；非标记错误 false", () => {
        const p = createReplayProvider({ turns: [] });
        const mk = (t: string): any => { const e: any = new Error('x'); e.replayFault = t; return e; };
        assert.equal(p.isTransientError(mk('transient')), true);
        assert.equal(p.isContextLengthError(mk('context_length')), true);
        assert.equal(p.isTransientError(new Error('普通错误')), false);
        assert.equal(p.isContextLengthError(mk('transient')), false);
    });

    it("summarize：确定性 ChatCompletion（created=0 + 剧本文本）；classifyRisk：剧本裁决缺省 safe", async () => {
        const p = createReplayProvider({ turns: [], summarizeText: '回放摘要文本', riskVerdict: 'risky' });
        const out = await p.summarize([], undefined, {});
        assert.equal(out.choices[0].message.content, '回放摘要文本');
        assert.equal(out.created, 0, '确定性：无时间戳');
        assert.equal(await p.classifyRisk('t', {}, ''), 'risky');
        assert.equal(await createReplayProvider({ turns: [] }).classifyRisk('t', {}, ''), 'safe', '缺省 safe（免审批）');
    });

    it("buildAssistantMessage：DeepSeek 兼容 wire（reasoning_content / tool_calls）", () => {
        const p = createReplayProvider({ turns: [] });
        const m: any = p.buildAssistantMessage({ content: 'a', reasoning: 'r', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
        assert.equal(m.role, 'assistant');
        assert.equal(m.reasoning_content, 'r');
        assert.equal(m.tool_calls[0].function.name, 'read_file');
    });

    it("剧本耗尽 = 空回复（无 chunk，游标停在末尾；PHANTOM 守护可接管）", async () => {
        const p = createReplayProvider({ turns: [{ kind: 'reply', content: 'x' }] });
        await collectChunks(p.streamChat([], undefined, {}));
        const second = await collectChunks(p.streamChat([], undefined, {}));
        assert.equal(second.length, 0);
        assert.equal(p.cursor, 1);
    });

    it("scriptFromMessages：assistant 轮映射（content/reasoning/tool_calls），空轮与 user/tool 行剔除", () => {
        const script = scriptFromMessages([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'q' },
            { role: 'assistant', content: '先看看', reasoning_content: '思考过程', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '结果' },
            { role: 'assistant', content: null },          // 空轮（PHANTOM 场景）→ 剔除
            { role: 'assistant', content: '最终回答' },
        ]);
        assert.equal(script.turns.length, 2);
        const t0 = script.turns[0]!;
        assert.equal(t0.reasoning, '思考过程');
        assert.equal(t0.toolCalls![0]!.name, 'read_file');
        assert.equal(t0.toolCalls![0]!.args!.path, '/a', 'arguments 解析为对象');
        assert.equal(t0.toolCalls![0]!.id, 'c1', 'call_id 透传');
        assert.equal(script.turns[1]!.content, '最终回答');
    });
});

// ============ 2) streamInference 集成（三道重试通道） ============

/** 构造最小 StreamInferenceContext。 */
const makeInfCtx = (message: any[], round = 1): any => ({
    message,
    nudgeMsg: null,
    sessionId: `replay-inf-${Date.now()}-${round}`,
    depth: 0,
    round,
    startTime: performance.now(),
    userDecisionSource: 'user' as const,
    llmDecisionSource: 'llm' as const,
    cleanedToolSchemas: [],
    events: (async () => { }) as any,
    keepRecentUnits: 5,
    compactRatio: 0.72,
    modelWindow: 250000,
});

/** 驱动一个 yield* 型 generator：收集 yield 事件，取 return 值。 */
const yieldCollect = async <R>(gen: AsyncGenerator<any, R>, events: any[]): Promise<R> => {
    let v = await gen.next();
    while (!v.done) {
        events.push(v.value);
        v = await gen.next();
    }
    return v.value;
};

describe("streamInference × ReplayProvider（重试通道回归）", () => {
    it("正常轮：text/thinking delta 顺序流出，tool_calls 拼装 + usage 透传", async () => {
        const { ret } = await withReplay({
            turns: [{
                kind: 'reply', content: '模型正文', reasoning: '模型思考',
                toolCalls: [{ name: 'read_file', args: { path: '/x' } }],
                usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, cached_tokens: 10 },
            }],
        }, async (p) => {
            const events: any[] = [];
            const msg = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }];
            const result = await yieldCollect(streamInference(makeInfCtx(msg)), events);
            return { events, result, calls: p.calls };
        });
        assert.equal(ret.result.kind, 'completed');
        assert.deepEqual(ret.events.map((e: any) => e.type), ['thinking.delta', 'text.delta']);
        const am: any = ret.result.assistantMessage;
        assert.equal(am.content, '模型正文');
        assert.equal(am.reasoning_content, '模型思考');
        assert.equal(am.tool_calls[0].function.name, 'read_file');
        assert.deepEqual(JSON.parse(am.tool_calls[0].function.arguments), { path: '/x' });
        assert.equal(ret.result.usage?.prompt_tokens, 42);
        assert.equal(ret.calls.length, 1, '无重试');
    });

    it("idle mid-stream（已推部分文本）→ text.reset 后重推全文，最终 content 无重复", async () => {
        const FULL = '让我读取文件看看情况，然后给你结论。';
        const { ret } = await withReplay({
            turns: [{ kind: 'reply', content: FULL, fault: { type: 'idle', afterChars: 8 } }],
        }, async () => {
            const events: any[] = [];
            const result = await yieldCollect(streamInference(makeInfCtx([{ role: 'user', content: 'q' }])), events);
            return { events, result };
        });
        assert.equal(ret.result.kind, 'completed');
        const resets = ret.events.filter((e: any) => e.type === 'text.reset');
        assert.equal(resets.length, 1, '重试前发一次 text.reset（丢弃已推部分文本）');
        assert.equal(ret.result.assistantMessage.content, FULL, '重试后全文，无重复拼接');
    });

    it("transient（429）→ 指数退避后重试成功", async () => {
        const { ret } = await withReplay({
            turns: [{ kind: 'reply', content: '限流后重试成功', fault: { type: 'transient', afterChars: 0 } }],
        }, async () => {
            const events: any[] = [];
            const result = await yieldCollect(streamInference(makeInfCtx([{ role: 'user', content: 'q' }])), events);
            return { events, result };
        });
        assert.equal(ret.result.kind, 'completed');
        assert.equal(ret.result.assistantMessage.content, '限流后重试成功');
    });

    it("context_length（未吐内容）→ 强制压缩降级后重试成功", async () => {
        const { ret } = await withReplay({
            turns: [{ kind: 'reply', content: '压缩后重试成功', fault: { type: 'context_length', afterChars: 0 } }],
        }, async () => {
            const events: any[] = [];
            const result = await yieldCollect(streamInference(makeInfCtx([{ role: 'user', content: 'q' }])), events);
            return { events, result };
        });
        assert.equal(ret.result.kind, 'completed');
        assert.equal(ret.result.assistantMessage.content, '压缩后重试成功');
    });
});

// ============ 3) runAgent harness 回归（守护体系 / 熔断 / abort） ============

/** 构造 runAgent 入参（message 首元素 system、次元素 user；cwd 沙盒）。 */
const makeAgentArgs = (userPrompt: string, sessionId: string): [any[], any] => [
    [
        { role: 'system', content: '你是回归测试用 agent。' },
        { role: 'user', content: userPrompt },
    ],
    {
        sessionId,
        cwd: SANDBOX,
        events: (async () => { }) as any,
        toolSchemas: agentTools, // runAgent 不内置工具表（agent/type.ts 约定）——缺此则 rawTools 为空 → 全部「未知工具」
        modelWindow: 250000,
        keepRecentUnits: 5,
        compactRatio: 0.72,
        parentSystemPrompt: '',
    },
];

/** 跑完 runAgent，收集 AgentEvent + 最终 transcript 行。 */
const driveAgent = async (userPrompt: string, sessionId: string): Promise<{ events: any[]; lines: any[] }> => {
    const [message, opts] = makeAgentArgs(userPrompt, sessionId);
    const events: any[] = [];
    for await (const ev of runAgent(message, opts)) events.push(ev);
    const lines = await readTranscriptLines(sessionId);
    return { events, lines };
};

const finalTextOf = (events: any[]): string => {
    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, '恰好一个 final');
    return finals[0].text;
};

const runEndOf = (lines: any[]): any => lines.find((l: any) => l.dscEvent === 'run.end');

const readFixTurn = { kind: 'reply' as const, content: null, toolCalls: [{ name: 'read_file', args: { path: FIXTURE } }] };

describe("runAgent harness 回归（PHANTOM / EARLY_FINAL / TOOL_DIGEST / repeat / abort）", () => {
    it("TOOL_DIGEST：工具轮后短文本收尾被拦（nudge 注入下轮），实质总结放行", async () => {
        const sid = `hr-tool-digest-${Date.now()}`;
        const { handle, ret } = await withReplay({
            turns: [
                readFixTurn,
                { kind: 'reply', content: '好的' },                                     // <30 字且无完成声明 → 拦
                { kind: 'reply', content: '已完成：文件内容为 REPLAY-FIXTURE-CONTENT 第一行、第二行内容，共两行。' },
            ],
        }, async (p) => driveAgent('读 fixture 并汇报', sid).then((r) => ({ ...r, calls: p.calls })));
        assert.equal(finalTextOf(ret.events).startsWith('已完成：'), true, '最终 final 是实质总结（第 3 轮）');
        assert.equal(handle.calls.length, 3, '短收尾被拦 → 多跑一轮推理');
        const thirdCallTail: any = handle.calls[2].messages[handle.calls[2].messages.length - 1];
        assert.equal(thirdCallTail.role, 'system');
        assert.match(thirdCallTail.content, /⟦DSC:TOOL_DIGEST⟧/, 'nudge 以推理时尾部副本注入（模型可见）');
        const assistants = ret.lines.filter((l: any) => l.role === 'assistant');
        assert.equal(assistants.length, 3, '被拦轮同样落盘（round.end 闭合）');
        assert.equal(ret.lines.filter((l: any) => l.dscEvent === 'round.end').length, 3);
        assert.equal(runEndOf(ret.lines).stopReason, 'normal');
        const toolRows = ret.lines.filter((l: any) => l.role === 'tool');
        assert.equal(toolRows.length, 1, '第 1 轮真实执行 read_file');
        assert.match(toolRows[0].content, /REPLAY-FIXTURE-CONTENT/);
    });

    it("PHANTOM：空回复被拦重试，nudge 注入且最终拿到实质回答", async () => {
        const sid = `hr-phantom-${Date.now()}`;
        const { handle, ret } = await withReplay({
            turns: [
                { kind: 'reply', content: null },                                        // 空包（无正文无工具）
                { kind: 'reply', content: '已完成：这是重试后的实质回答，长度超过三十个字符以免误触发其它守护。' },
            ],
        }, async (p) => driveAgent('随便回答点什么', sid).then((r) => ({ ...r, calls: p.calls })));
        assert.match(finalTextOf(ret.events), /重试后的实质回答/);
        assert.equal(handle.calls.length, 2);
        const secondTail: any = handle.calls[1].messages[handle.calls[1].messages.length - 1];
        assert.match(secondTail.content, /⟦DSC:PHANTOM⟧/);
        assert.equal(runEndOf(ret.lines).stopReason, 'normal');
    });

    it("EARLY_FINAL：首轮无完成声明的草率收尾被拦一次，第二次带完成声明放行", async () => {
        const sid = `hr-early-final-${Date.now()}`;
        const { handle, ret } = await withReplay({
            turns: [
                { kind: 'reply', content: '我觉得大概是这样吧' },                          // round=1、无完成词 → 拦
                { kind: 'reply', content: '已完成：自检后确认全部落地，这是最终回答。' },
            ],
        }, async (p) => driveAgent('做个小任务', sid).then((r) => ({ ...r, calls: p.calls })));
        assert.match(finalTextOf(ret.events), /已完成：自检后/);
        assert.equal(handle.calls.length, 2);
        const secondTail: any = handle.calls[1].messages[handle.calls[1].messages.length - 1];
        assert.match(secondTail.content, /⟦DSC:EARLY_FINAL⟧/);
    });

    it("repeat 熔断：完整签名连续 3 轮相同 → 熔断收尾 + 孤儿占位补齐（无孤儿 run）", async () => {
        const sid = `hr-repeat-${Date.now()}`;
        const { ret } = await withReplay({
            turns: [readFixTurn, readFixTurn, readFixTurn],                              // 第 3 轮 check 触发熔断
        }, () => driveAgent('反复读同一个文件', sid));
        const final = finalTextOf(ret.events);
        assert.match(final, /重复/, '熔断文案收尾');
        assert.equal(runEndOf(ret.lines).stopReason, 'repeat');
        const toolRows = ret.lines.filter((l: any) => l.role === 'tool');
        assert.equal(toolRows.length, 3, '轮1/轮2 真实结果 + 轮3 占位');
        assert.match(toolRows[0].content, /REPLAY-FIXTURE-CONTENT/, '轮1 真实执行');
        assert.match(toolRows[2].content, /重复调用熔断，未执行/, '轮3 补占位（闭合 run 无孤儿）');
        assert.equal(ret.lines.filter((l: any) => l.dscEvent === 'round.end').length, 2, '熔断轮不写 round.end（取证信号）');
    });

    it("abort：工具轮后中止 → 循环顶拦截、final 中止文案、run.end 记 aborted", async () => {
        const sid = `hr-abort-${Date.now()}`;
        const { handle, ret } = await withReplay({
            turns: [readFixTurn, { kind: 'reply', content: '不该被产出的下一轮' }],
        }, async (p) => {
            const [message, opts] = makeAgentArgs('读一下然后我来中止', sid);
            const controller = new AbortController();
            const events: any[] = [];
            for await (const ev of runAgent(message, { ...opts, abortSignal: controller.signal })) {
                events.push(ev);
                if (ev.type === 'tool.end') controller.abort();
            }
            const lines = await readTranscriptLines(sid);
            return { events, lines, calls: p.calls };
        });
        assert.equal(finalTextOf(ret.events), '（已中止）');
        assert.equal(ret.events.filter((e: any) => e.type === 'round.start').length, 1, '中止在循环顶拦截，无第 2 轮');
        assert.equal(handle.calls.length, 1, '中止后不再推理');
        assert.equal(runEndOf(ret.lines).stopReason, 'aborted');
    });

    it("scriptFromMessages 端到端：真跑落盘的 transcript 反录制 → 回放行为一致（录制-回放 round-trip）", async () => {
        const sidRecord = `hr-record-${Date.now()}`;
        // 「录制源」：一次三轮回放跑（工具轮 ×1 + 短收尾被 TOOL_DIGEST 拦 + 实质总结），transcript 落盘
        const recordRun = await withReplay({
            turns: [readFixTurn, { kind: 'reply', content: '好的' }, { kind: 'reply', content: '已完成：文件内容为 REPLAY-FIXTURE-CONTENT 第一行、第二行内容，共两行。' }],
        }, () => driveAgent('读 fixture 并汇报', sidRecord));
        // 反录制：从 transcript 提取 assistant 序列生成新剧本（空轮已被剔除；工具轮带 tool_calls）
        const script2 = scriptFromMessages(recordRun.ret.lines);
        assert.equal(script2.turns.length, 3, '三个 assistant 轮（含被拦的短收尾轮）');
        assert.equal(script2.turns[0].toolCalls?.[0].name, 'read_file');
        // 回放剧本 2：行为一致（同样 3 轮、最终 final 同文本）
        const sidReplay = `hr-replay2-${Date.now()}`;
        const { ret: replayRun } = await withReplay(script2, () => driveAgent('读 fixture 并汇报', sidReplay));
        assert.match(finalTextOf(replayRun.events), /已完成：文件内容为/);
        assert.equal(replayRun.events.filter((e: any) => e.type === 'text.delta').length > 0, true);
    });
});
