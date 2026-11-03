/**
 * @file tests/agent-async-wake.test.ts
 * @description 子代理异步化与完成唤醒（路径 B）守门测试（方案《子代理异步化与完成唤醒》§5 + batch 场景）。
 *
 *  假 LLM = 线路路由门控 provider：主 run / 子 run / 唤醒 run 各占一条「线路」（按上下文特征谓词匹配），
 *  每个 turn 可挂 promise 门控——全部编排由 promise 链驱动，零真 sleep、零轮询。
 *  tsx 双模块实例坑：被测模块全部经 `@/` 同源 specifier 动态导入（env 置位后）。
 *
 *  用例 ↔ 方案 §5 映射：
 *   ① 异步返回（tool 层：首个 next() 即得 agent_id，此刻零 LLM 调用）
 *   ② run 在跑回流（runAgent 直驱：完成汇报在下一轮边界被 claim）
 *   ③ idle 唤醒（handleUnifiedChat 全链：哨兵 user 消息 + 首轮 claim + 追加-only 缓存纪律）
 *   ④ 合并唤醒（两个完成近似同时 idle → 仅一次唤醒 run、一次 claim 两条）
 *   ⑤ 截断保护（buildSubagentDoneReport 纯函数）
 *   ⑥ description 更新（异步/唤醒语义 + 路径 A 轮询工具不存在 + 红线 2 名单不动）
 *   ⑦ 中止语义（spawn generator 被 gen.return → 回调拦截；唤醒 run 被中止 → 无悬挂唤醒、产物保留）
 *   ⑧ 级联收敛（纯确认不再唤醒；新完成事件链路继续一轮后收敛）
 *   ⑨ 既有护栏（同 ID 在飞拒续跑回归）
 *   ⑩ batch 场景（唤醒 run 继承自动应答器与预算）
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-agent-wake-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

// ★ 事件循环保活：门控编排的全部等待都是纯 promise（无 I/O 无定时器），循环会清空导致进程提前退出
//   （真 sleep 是零；此 interval 只当心跳，不参与任何时序判定，文件尾 after 钩子摘除后正常退出）。
const keepAlive = setInterval(() => { }, 100);
after(() => clearInterval(keepAlive));

const { setActiveProvider } = await import("@/llm/model.ts");
const { runAgent } = await import("@/agent/runAgent.ts");
const { buildContextMessages } = await import("@/session/content.ts");
const { appendMessage, readTranscriptLines } = await import("@/session/transcript.ts");
const { getOrCreateSessionId } = await import("@/session/store.ts");
const { createAgentTools } = await import("@/tool/registry/agent.ts");
const { createWorkflowTools } = await import("@/tool/registry/workflow.ts");
const { handleUnifiedChat } = await import("@/serve/chatProcessing.ts");
const { ToolSafetyLevel } = await import("@/tool/type.ts");
const {
    registerWakeDriver, waitSessionQuiescent,
    buildSubagentDoneReport, notifySubagentDone,
    AGENT_DONE_SENTINEL, SUBAGENT_REPORT_MAX_CHARS,
    resetWakeStateForTest,
} = await import("@/agent/agentWake.ts");
const { runSubagent, SUBAGENT_DENYLIST } = await import("@/agent/subagent.ts");

// ============ 线路路由门控 provider（确定性假 LLM） ============

type Turn = { content?: string | null; toolCalls?: { name: string; args?: any }[]; gate?: Promise<void> };
type LaneEntry = { match: (msgs: any[]) => boolean; turn: Turn };
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
};
/** 上下文特征谓词：本组消息里任一条 content 含 marker（且不含 exclude，防前缀串线）。 */
const hasText = (marker: string, exclude?: string) => (msgs: any[]) =>
    msgs.some((m) => {
        const c = typeof m?.content === "string" ? m.content : "";
        return c.includes(marker) && (!exclude || !c.includes(exclude));
    });

const createGatedProvider = () => {
    const pending: LaneEntry[] = [];
    const takers: { match: (e: LaneEntry) => boolean; res: (e: LaneEntry) => void }[] = [];
    const calls: { messages: any[]; turn: Turn }[] = [];
    const callWaiters: { n: number; res: () => void }[] = [];
    const noteCall = () => {
        for (let i = callWaiters.length - 1; i >= 0; i--) {
            if (calls.length >= callWaiters[i]!.n) { callWaiters[i]!.res(); callWaiters.splice(i, 1); }
        }
    };
    const pushLane = (match: (msgs: any[]) => boolean, turn: Turn) => {
        const entry = { match, turn };
        const i = takers.findIndex((t) => t.match(entry));
        if (i >= 0) { const [t] = takers.splice(i, 1); t.res(entry); } else pending.push(entry);
    };
    const take = (msgs: any[]): Promise<LaneEntry> => new Promise<LaneEntry>((res) => {
        const i = pending.findIndex((e) => e.match(msgs));
        if (i >= 0) { const [e] = pending.splice(i, 1); res(e); } else takers.push({ match: (e) => e.match(msgs), res });
    });
    const streamChat = async function* (messages: any[], _tools: any, _opts: any): AsyncGenerator<any> {
        const entry = await take(messages);
        calls.push({ messages: [...messages], turn: entry.turn });
        noteCall();
        if (entry.turn.gate) await entry.turn.gate;
        if (entry.turn.content) yield { kind: "text", text: entry.turn.content };
        const tcs = entry.turn.toolCalls ?? [];
        for (let i = 0; i < tcs.length; i++) {
            const tc = tcs[i]!;
            yield { kind: "tool_call_delta", index: i, id: `call_${calls.length}_${i}`, type: "function", nameDelta: tc.name };
            yield { kind: "tool_call_delta", index: i, argumentsDelta: JSON.stringify(tc.args ?? {}) };
        }
        // ★ wire 保真：末包补 usage——真实 DS（include_usage）任何完成（含空正文收尾轮）都带 usage 末包。
        //   不补的话，空收尾轮 = 0 内容 0 usage，会被 streamInference 空断流防御当服务端断流重试，
        //   多出一次门控外的 streamChat 调用 → take() 等一条不存在的 lane → 与测试互等死锁（2026-11-03 实证）。
        yield { kind: "usage", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    };
    const provider = {
        id: "gated",
        displayName: "Gated",
        modelLabel: "gated",
        streamChat,
        summarize: async () => ({
            id: "s", object: "chat.completion", created: 0, model: "gated",
            choices: [{ index: 0, message: { role: "assistant", content: "（测试摘要）", refusal: null }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        classifyRisk: async () => "safe" as const,
        buildAssistantMessage: (parts: any) => {
            const m: any = { role: "assistant", content: parts.content };
            if (parts.toolCalls?.length) m.tool_calls = parts.toolCalls;
            return m;
        },
        isContextLengthError: () => false,
        isTransientError: () => false,
        isImageUnsupportedError: () => false,
    };
    return {
        provider, pushLane, calls,
        /** 等待第 n 次 LLM 调用发生（promise 门控，零轮询零 sleep）。 */
        waitForCalls: (n: number): Promise<void> =>
            calls.length >= n ? Promise.resolve() : new Promise<void>((res) => callWaiters.push({ n, res })),
    };
};

const makeCtx = (sessionId: string): any => ({
    sessionId,
    depth: 0,
    cwd: SANDBOX,
    keepRecentUnits: 9999,
    compactRatio: 1.4,
    modelWindow: 10_000_000,
    parentSystemPrompt: "【测试规范】仅用于守门回归。",
    events: async () => { },
});

const makeOptions = (sessionId: string, toolSchemas: any[]): any => ({
    sessionId,
    cwd: SANDBOX,
    toolSchemas,
    modelWindow: 10_000_000,
    keepRecentUnits: 9999,
    compactRatio: 1.4,
    parentSystemPrompt: "【测试规范】仅用于守门回归。",
    events: async () => { },
    depth: 0,
});

const noopSend = async (): Promise<void> => { };
/** 从 spawn_agent 首个 yield 文本提取 agent_id。 */
const agentIdOf = (text: string): string => {
    const m = /🆔 ([A-Za-z0-9_\-]+__sub__[0-9a-f\-]+)/.exec(text);
    assert.ok(m, `首 yield 应含 agent_id：${text.slice(0, 80)}`);
    return m![1]!;
};
const transcriptFlat = async (sid: string): Promise<string> => {
    const lines = await readTranscriptLines(sid).catch(() => [] as any[]);
    return lines.map((l: any) => (typeof l?.content === "string" ? l.content : JSON.stringify(l))).join("\n");
};
/** 挂起直到信号被中止（已中止则立即兑付）——⑦ 中止编排用，零轮询。 */
const abortGate = (signal: AbortSignal): Promise<void> => new Promise<void>((r) => {
    if (signal.aborted) r(); else signal.addEventListener("abort", () => r(), { once: true });
});

beforeEach(() => {
    resetWakeStateForTest();
});

// ============ ① 异步返回 ============

describe("① spawn_agent 异步返回", () => {
    it("首个 next() 即得 agent_id（此刻零 LLM 调用、子会话未创建）；第二个 next() 才启动子代理", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = "w1";
        const [spawnTool] = createAgentTools(() => []);
        const gen = (spawnTool.function as any).execute({ task: "耗时的后台任务" }, makeCtx(sid));

        const first = await gen.next();
        const text = typeof first.value === "string" ? first.value : String(first.value?.content ?? "");
        assert.match(text, /✅ 子代理已异步启动/, "首 yield = 启动回执");
        const agentId = agentIdOf(text);
        assert.match(text, /唤醒/, "回执含唤醒语义（防模型旧习惯等待）");
        assert.equal(h.calls.length, 0, "此刻零 LLM 调用（异步语义：不等待子代理）");
        // 注：prepare 阶段即建子会话上下文（buildContextMessages 落盘），故此刻 transcript 文件已存在属预期；异步语义准绳是零 LLM 调用。

        // 续驱：真正启动子代理 run（generator 挂起期间后台执行），完成 → 汇报入主会话 inbox
        h.pushLane(hasText("独立智能体助手"), { content: "子代理汇报：任务已完成" });
        const drain = await gen.next();
        assert.equal(drain.done, true, "generator 排空结束");
        assert.ok((await readTranscriptLines(agentId)).length >= 2, "子代理 run 完成并落盘");
        await waitSessionQuiescent(sid);
        // 无驱动（本用例未注册）：汇报留 inbox 待下次 run 消化，不产生唤醒、不丢失
        const flat = await transcriptFlat(sid);
        assert.doesNotMatch(flat, /子代理汇报：任务已完成/, "无 run 消化前不落主会话 transcript（inbox 承载）");
    });
});

// ============ ② run 在跑回流 ============

describe("② run 在跑时完成回流", () => {
    it("子代理完成 → 汇报入 inbox → 下一轮边界被 claim（inbox.claimed 事件）", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = "w2";
        const [spawnTool] = createAgentTools(() => []);
        // driverEntered 屏障：notify 必先 pump 触发 driver，而 notify 内部 pushSessionInbox 先于 scheduleWake——
        // 「driver 已启动」⟹ 汇报已在 inbox（免 fs 竞速，编排确定性锚）。本用例 driver 不做任何事。
        const driverEntered = deferred();
        registerWakeDriver(sid, async () => { driverEntered.resolve(); });
        // turn2 用无操作工具续轮（final 会直接结束 run、round3 根本不存在——claim 必须挂在下一轮边界）
        const noop = {
            type: "function",
            function: {
                name: "noop", description: "测试用无操作工具", isSync: true,
                parameters: { type: "object", properties: {} },
                safetyLevel: ToolSafetyLevel.SAFE,
                execute: async () => "ok",
            },
        };
        const tools = [spawnTool, noop];

        const gateSub = deferred();   // 挡住子代理回复（此刻完成即过早，会抢在轮边界前被消化）
        const gateMain2 = deferred(); // 挡住主 turn2（保证 round2 claim 先空手而归）
        const mainMarker = hasText("请派子代理并继续主任务-标记", "AGENT-DONE");
        const subMarker = hasText("独立智能体助手");
        h.pushLane(mainMarker, { toolCalls: [{ name: "spawn_agent", args: { task: "后台子任务" } }] });
        h.pushLane(subMarker, { content: "子代理汇报：后台子任务干完了", gate: gateSub.promise });
        h.pushLane(mainMarker, { toolCalls: [{ name: "noop", args: {} }], gate: gateMain2.promise });
        h.pushLane(mainMarker, { content: "主任务收尾全部完成，后台子任务的完成汇报已在本轮边界成功兑付入上下文。" });

        const messages = await buildContextMessages(sid, { role: "user", content: "请派子代理并继续主任务-标记" }, "测试系统词", undefined);
        const seen: any[] = [];
        const drive = (async () => {
            for await (const e of runAgent(messages, makeOptions(sid, tools))) seen.push(e);
        })();

        // round2 的 LLM 调用已发起 ⇒ round2 的 claim 已过（空手）且子代理仍在门控中
        await h.waitForCalls(3);
        gateSub.resolve(); // 子代理完成 → notify → inbox
        await driverEntered.promise; // 确定性锚：pump 被 notify 触发 ⟹ pushSessionInbox 已落地（先于 scheduleWake）
        gateMain2.resolve(); // turn2 流出 → round3 claim 兑付汇报
        await drive;

        const claimed = seen.find((e) => e.type === "inbox.claimed");
        assert.ok(claimed, "存在 inbox.claimed 事件");
        assert.equal(claimed.texts.length, 1);
        assert.match(claimed.texts[0]!, /🤖 \[子代理完成\]/, "汇报形态（结构化消息）");
        assert.match(claimed.texts[0]!, /子代理汇报：后台子任务干完了/);
        assert.match(claimed.texts[0]!, /状态：final/, "终态标注");
    });
});

// ============ ③ idle 唤醒（handleUnifiedChat 全链 + 缓存纪律 + 收敛） ============

describe("③ idle 唤醒全链（handleUnifiedChat）", () => {
    it("主 run 结束后子代理完成 → 程序化唤醒 run：哨兵落盘 + 首轮 claim 汇报 + 前缀追加-only", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = await getOrCreateSessionId(undefined);
        const [spawnTool] = createAgentTools(() => []);
        const opts = { toolSchemas: [spawnTool] };
        let wakes = 0;
        registerWakeDriver(sid, async () => {
            wakes++;
            await handleUnifiedChat({ sessionId: sid, content: AGENT_DONE_SENTINEL }, noopSend, undefined, undefined, opts);
        });

        const mainMarker = hasText("请派个子代理去干活-主标记", "AGENT-DONE");
        const subMarker = hasText("独立智能体助手");
        const wakeMarker = hasText("AGENT-DONE");
        const gateSub = deferred();
        h.pushLane(mainMarker, { toolCalls: [{ name: "spawn_agent", args: { task: "派出去的任务" } }] });
        // final 文案带完成声明词（已全部/已完成）+ ≥30 字——绕开 EARLY_FINAL / TOOL_DIGEST 守护（只拦草率收尾）
        h.pushLane(mainMarker, { content: "子代理已完成派出交接，本阶段准备工作已全部就绪，接下来等待完成汇报自动送达后继续。" });
        h.pushLane(subMarker, { content: "子代理汇报：派出去的任务干完了", gate: gateSub.promise });
        h.pushLane(wakeMarker, { content: "已全部消化汇报内容，无待续事项，本轮唤醒到此收敛。" });

        await handleUnifiedChat({ sessionId: sid, content: "请派个子代理去干活-主标记" }, noopSend, undefined, undefined, opts);
        gateSub.resolve(); // 主 run 已结束（idle）→ 完成 → 唤醒（完成回调先于在飞释放：quiescent 即代表唤醒链已收敛）
        assert.equal(await waitSessionQuiescent(sid), true, "唤醒链收敛");
        assert.equal(wakes, 1, "恰好一次唤醒 run");

        // 哨兵 + 汇报落盘（回放可读）；顺序：哨兵在前、汇报紧随
        const flat = await transcriptFlat(sid);
        assert.ok(flat.includes("⟦DSC:AGENT-DONE⟧"), "哨兵 user 消息落盘（transcript 回放可读性准绳）");
        assert.ok(flat.includes("🤖 [子代理完成]"), "完成汇报以消息落盘");
        assert.ok(flat.includes("状态：final"), "终态标注落盘");
        assert.ok(flat.indexOf("⟦DSC:AGENT-DONE⟧") < flat.indexOf("🤖 [子代理完成]"), "哨兵先于汇报");

        // ★ 缓存纪律：唤醒 run 的 LLM 调用 = 既有前缀之后追加（哨兵 user + claim 的汇报 user），不重排历史
        const wakeCall = h.calls.find((c) => c.messages.some((m: any) => String(m?.content ?? "").includes("AGENT-DONE")));
        assert.ok(wakeCall, "唤醒 run 的 LLM 调用存在");
        const wakes1 = wakeCall!.messages;
        const contents = wakes1.map((m: any) => (typeof m?.content === "string" ? m.content : JSON.stringify(m.content)));
        assert.ok(contents.some((c) => c.includes("已完成派出交接")), "主 run 历史完整保留在唤醒上下文");
        assert.match(contents[contents.length - 1]!, /子代理汇报：派出去的任务干完了/, "末尾 = 首轮 claim 的汇报");
        assert.match(contents[contents.length - 2]!, /AGENT-DONE/, "汇报前一位 = 哨兵 user 消息");

        // 级联收敛：唤醒 run 纯确认（无 spawn、无新完成）→ 不再唤醒
        await waitSessionQuiescent(sid);
        assert.equal(wakes, 1, "纯确认不产生新唤醒");
        assert.equal(h.calls.length, 4, "总调用数收敛：主2 + 子1 + 唤醒1");
    });
});

// ============ ④ 合并唤醒 ============

describe("④ 合并唤醒（风暴防护）", () => {
    it("两个完成近似同时、主会话 idle → 仅一次唤醒 run，一次 claim 兑付两条汇报", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = await getOrCreateSessionId(undefined);
        const [spawnTool] = createAgentTools(() => []);
        const opts = { toolSchemas: [spawnTool] };
        let wakes = 0;
        const driverEntered = deferred();
        const gateDriver = deferred(); // 唤醒驱动在屏障处挂起：保证第二条完成先入队，再放行 claim
        registerWakeDriver(sid, async () => {
            wakes++;
            driverEntered.resolve();
            await gateDriver.promise;
            await handleUnifiedChat({ sessionId: sid, content: AGENT_DONE_SENTINEL }, noopSend, undefined, undefined, opts);
        });

        const mainMarker = hasText("请派子代理做合并演练-主标记", "AGENT-DONE");
        const subMarker = hasText("独立智能体助手");
        const gateSub = deferred();
        h.pushLane(mainMarker, { toolCalls: [{ name: "spawn_agent", args: { task: "合并演练子任务" } }] });
        h.pushLane(mainMarker, { content: "子代理已完成派出交接工作，接下来等待完成汇报自动送达后再继续推进主任务。" });
        h.pushLane(subMarker, { content: "子代理汇报：合并演练完成", gate: gateSub.promise });
        h.pushLane(hasText("AGENT-DONE"), { content: "两条汇报已全部消化完毕，无待续事项。" });

        await handleUnifiedChat({ sessionId: sid, content: "请派子代理做合并演练-主标记" }, noopSend, undefined, undefined, opts);
        gateSub.resolve();               // 甲完成 → notify → 唤醒泵立即单飞（驱动在屏障挂起，零 fs 消耗）
        await driverEntered.promise;     // 泵已占 busy、驱动已启动（⟸ 第一条汇报已入队）
        await notifySubagentDone(sid,    // 乙完成（直接经完成回调同款通道）→ 只入队合并，绝不二次唤醒
            buildSubagentDoneReport(`${sid}__sub__fake-b`, "注入的第二条", { status: "final", output: "乙的汇报正文" }));
        gateDriver.resolve();            // 放行 → 哨兵 + round1 claim 一次兑付两条
        assert.equal(await waitSessionQuiescent(sid), true);
        assert.equal(wakes, 1, "仅一次唤醒 run");

        const wakeCall = h.calls.find((c) => c.messages.some((m: any) => String(m?.content ?? "").includes("AGENT-DONE")));
        const contents = wakeCall!.messages.map((m: any) => (typeof m?.content === "string" ? m.content : ""));
        assert.match(contents[contents.length - 3]!, /AGENT-DONE/, "哨兵");
        assert.match(contents[contents.length - 2]!, /合并演练完成/, "汇报一");
        assert.match(contents[contents.length - 1]!, /乙的汇报正文/, "汇报二");
        const flat = await transcriptFlat(sid);
        assert.equal(flat.split("🤖 [子代理完成]").length - 1, 2, "两条完成汇报均落盘");
    });
});

// ============ ⑤ 截断保护 ============

describe("⑤ 完成汇报截断保护", () => {
    it("超 4KB 截断 + resume 追问提示；未超长不截断；终态标签三分", () => {
        const long = "x".repeat(SUBAGENT_REPORT_MAX_CHARS + 500);
        const r1 = buildSubagentDoneReport("a__sub__1", "长汇报任务", { status: "final", output: long });
        assert.ok(r1.length < long.length, "已截断");
        assert.ok(!r1.includes("x".repeat(SUBAGENT_REPORT_MAX_CHARS + 1)), "正文不超上限");
        assert.match(r1, /截断/, "含截断说明");
        assert.match(r1, /resume_session_id="a__sub__1"/, "含追问提示");

        const r2 = buildSubagentDoneReport("a__sub__2", "", { status: "final", output: "短汇报" });
        assert.doesNotMatch(r2, /截断/, "未超长不截断");
        assert.match(r2, /状态：final（正常完成）/);

        assert.match(buildSubagentDoneReport("a__sub__3", "", { status: "aborted", output: "❌ 中断" }), /状态：aborted（被中止）/);
        assert.match(buildSubagentDoneReport("a__sub__4", "", { status: "error", output: "❌ 崩溃" }), /状态：error（异常）/);
    });
});

// ============ ⑥ description 更新（模型可见行为钉死） ============

describe("⑥ 工具表语义（异步启动 + 完成自动唤醒）", () => {
    it("spawn_agent / run_workflow 均为 isSync:false，description 含异步/唤醒语义；路径 A 轮询工具不存在；红线2 名单不动", async () => {
        const [spawn] = createAgentTools(() => []);
        const spawnFn = spawn.function as any; // CustomTool 联合类型：测试读元数据统一按宽松形态
        assert.equal(spawnFn.isSync, false, "spawn_agent isSync:false");
        assert.match(spawnFn.description, /异步/, "spawn description 含异步");
        assert.match(spawnFn.description, /唤醒/, "spawn description 含唤醒");
        assert.doesNotMatch(spawnFn.description, /等待.*完成后再/, "不引导模型同步等待");

        const [wf] = createWorkflowTools(() => []);
        const wfFn = wf.function as any;
        assert.equal(wfFn.isSync, false, "run_workflow isSync:false");
        assert.match(wfFn.description, /异步/);
        assert.match(wfFn.description, /唤醒|自动送达/, "workflow description 含唤醒/送达语义");
        assert.match(wfFn.description, /中间态不回流/, "只回流终态汇总");

        // 红线 1（路径 A 明确否决）：两个注册文件均不得出现轮询式取结果工具
        const regDir = path.resolve(import.meta.dirname, "..", "src", "tool", "registry");
        const agentSrc = await fs.readFile(path.join(regDir, "agent.ts"), "utf-8");
        const wfSrc = await fs.readFile(path.join(regDir, "workflow.ts"), "utf-8");
        assert.doesNotMatch(agentSrc, /get_agent_result|wait_seconds/, "agent.ts 不得实现轮询式取结果工具");
        assert.doesNotMatch(wfSrc, /get_agent_result|wait_seconds/, "workflow.ts 不得实现轮询式取结果工具");

        // 红线 2：SUBAGENT_DENYLIST 原样（一期不动）
        assert.deepEqual([...SUBAGENT_DENYLIST].sort(), ["delete_path", "run_command", "run_in_background"]);
    });
});

// ============ ⑦ 中止语义 ============

describe("⑦ 中止语义", () => {
    it("宿主中止（gen.return 同款）→ 完成回调被拦截：子代理不启动、零 LLM 调用、无汇报入 inbox、无唤醒", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = "w7a";
        const [spawnTool] = createAgentTools(() => []);
        let wakes = 0;
        registerWakeDriver(sid, async () => { wakes++; });

        const gen = (spawnTool.function as any).execute({ task: "会被中止的任务" }, makeCtx(sid));
        await gen.next(); // 消费首个 yield（启动回执）
        await gen.return(undefined as any); // 宿主中止：执行层 finalize 的 gen.return 通道

        assert.equal(h.calls.length, 0, "子代理从未启动（yield 之后的代码被 return completion 拦截）");
        await waitSessionQuiescent(sid);
        assert.equal(wakes, 0, "无悬挂唤醒");
    });

    it("唤醒 run 被用户中止 → 只断本轮交付：汇报产物保留、无再唤醒、链路收敛", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = await getOrCreateSessionId(undefined);
        const [spawnTool] = createAgentTools(() => []);
        const opts = { toolSchemas: [spawnTool] };
        let wakes = 0;
        let wakeAc: AbortController | null = null; // 测试经此持有唤醒 run 的中止信号（生产路径由宿主持有）
        registerWakeDriver(sid, async () => {
            wakes++;
            wakeAc = new AbortController();
            h.pushLane(hasText("AGENT-DONE"), { content: "汇报已收到，开始继续推进。", gate: abortGate(wakeAc.signal) });
            await handleUnifiedChat({ sessionId: sid, content: AGENT_DONE_SENTINEL }, noopSend, undefined, wakeAc.signal, opts);
        });

        const mainMarker = hasText("请派子代理用于中止演练-主标记", "AGENT-DONE");
        const subMarker = hasText("独立智能体助手");
        const gateSub = deferred();
        h.pushLane(mainMarker, { toolCalls: [{ name: "spawn_agent", args: { task: "中止演练子任务" } }] });
        h.pushLane(mainMarker, { content: "子代理已完成派出交接工作，接下来等待其完成汇报自动送达后再继续推进主任务。" });
        h.pushLane(subMarker, { content: "子代理汇报：中止演练的产物已落盘", gate: gateSub.promise });

        await handleUnifiedChat({ sessionId: sid, content: "请派子代理用于中止演练-主标记" }, noopSend, undefined, undefined, opts);
        gateSub.resolve(); // 完成 → 唤醒 run 启动（其 turn 挂在中止信号上）
        await h.waitForCalls(4); // 唤醒轮 LLM 调用已发起、回合被 abortGate 挡住
        assert.ok((await transcriptFlat(sid)).includes("🤖 [子代理完成]"), "汇报产物已落盘（claim 先于交付，中止不抹产物）");
        wakeAc!.abort(); // 模拟用户中止唤醒 run
        assert.equal(await waitSessionQuiescent(sid), true, "链路收敛");
        assert.equal(wakes, 1, "中止的唤醒 run 不再引发新唤醒");
        assert.ok((await transcriptFlat(sid)).includes("🤖 [子代理完成]"), "产物保留");
    });
});

// ============ ⑧ 级联收敛 + 新完成续链 ============

describe("⑧ 级联收敛", () => {
    it("新完成事件到达 → 链路继续一轮唤醒后收敛；无新事件则静止", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = await getOrCreateSessionId(undefined);
        const [spawnTool] = createAgentTools(() => []);
        const opts = { toolSchemas: [spawnTool] };
        let wakes = 0;
        registerWakeDriver(sid, async () => {
            wakes++;
            h.pushLane(hasText("AGENT-DONE"), { content: "已全部消化本轮汇报，无待续事项。" });
            await handleUnifiedChat({ sessionId: sid, content: AGENT_DONE_SENTINEL }, noopSend, undefined, undefined, opts);
        });

        const mainMarker = hasText("请派子代理用于收敛演练-主标记", "AGENT-DONE");
        const subMarker = hasText("独立智能体助手");
        const gateSub = deferred();
        h.pushLane(mainMarker, { toolCalls: [{ name: "spawn_agent", args: { task: "收敛演练子任务" } }] });
        h.pushLane(mainMarker, { content: "子代理已完成派出交接工作，接下来等待其完成汇报自动送达后再继续推进主任务。" });
        h.pushLane(subMarker, { content: "子代理汇报：收敛演练完成", gate: gateSub.promise });

        await handleUnifiedChat({ sessionId: sid, content: "请派子代理用于收敛演练-主标记" }, noopSend, undefined, undefined, opts);
        gateSub.resolve();
        assert.equal(await waitSessionQuiescent(sid), true);
        assert.equal(wakes, 1);

        // 新完成事件（模拟级联中第二个子代理完成）→ 恰好多唤醒一轮
        await notifySubagentDone(sid, buildSubagentDoneReport(`${sid}__sub__c2`, "级联第二条", { status: "final", output: "级联第二条汇报" }));
        assert.equal(await waitSessionQuiescent(sid), true);
        assert.equal(wakes, 2, "新完成 → 恰好一次新唤醒");
        assert.equal(await waitSessionQuiescent(sid), true);
        assert.equal(wakes, 2, "静止：无事件不再唤醒");
    });
});

// ============ ⑨ 既有护栏回归（红线 2） ============

describe("⑨ 既有护栏：同 ID 在飞拒续跑", () => {
    it("子代理在飞期间对同一子会话发起续跑 → 被拒（transcript 单写者保护原样）", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = "w9";
        const target = `${sid}__sub__fixed-id`;
        await appendMessage({ sessionId: target, role: "user", content: "历史任务" } as any);
        await appendMessage({ sessionId: target, role: "assistant", content: "历史进展汇报" } as any);

        const gateRun = deferred();
        h.pushLane(hasText("独立智能体助手"), { content: "第一个子代理的汇报", gate: gateRun.promise });

        const ctx = makeCtx(sid);
        const first = runSubagent({ task: "长任务A", resumeSessionId: target }, ctx, () => []);
        await h.waitForCalls(1); // 第一个子代理已进入 LLM 调用（在飞）
        const second = await runSubagent({ task: "并发续跑B", resumeSessionId: target }, ctx, () => []);
        assert.equal(second.ok, false, "在飞续跑被拒");
        assert.match(second.output, /正在执行中，禁止并发续跑同一子会话/, "拒绝文案（护栏原样）");

        gateRun.resolve();
        const r1 = await first;
        assert.equal(r1.ok, true, `第一个子代理正常完成：${r1.output}`);
    });
});

// ============ ⑩ batch 场景（唤醒继承自动应答器与预算） ============

describe("⑩ batch 场景：唤醒 run 继承自动应答器与预算", () => {
    it("唤醒轮的编辑工具被自动放行、白名单外被拒并记录；预算随驱动闭包继承", async () => {
        const h = createGatedProvider();
        setActiveProvider(h.provider as any);
        const sid = await getOrCreateSessionId("batch-wake-t");
        const [spawnTool] = createAgentTools(() => []);
        const deniedTools: { tool: string; detail: string }[] = [];
        const allowApproval = new Set(["edit_file"]); // batch 应答器判定表（BATCH_EDIT_TOOLS ∪ 工单解锁的缩影）
        let wakes = 0;
        // batchRunner 的驱动形态缩影：继承应答器 + budgetYuan + toolSchemas；worktree 重挂/独立 ac 在真实 runner 内
        registerWakeDriver(sid, async () => {
            wakes++;
            await handleUnifiedChat({ sessionId: sid, content: AGENT_DONE_SENTINEL }, noopSend, undefined, undefined, {
                budgetYuan: 1, // 继承主轮预算形态（真实 runner 传剩余 roundBudget）
                toolSchemas: [
                    spawnTool,
                    {
                        type: "function",
                        function: {
                            name: "edit_file", description: "test edit", isSync: true,
                            parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
                            safetyLevel: ToolSafetyLevel.MUTATION,
                            execute: async (args: any) => {
                                await fs.writeFile(path.join(SANDBOX, "wake-edit.txt"), String(args.content));
                                return "ok";
                            },
                        },
                    },
                    {
                        type: "function",
                        function: {
                            name: "run_command", description: "test cmd", isSync: true,
                            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
                            safetyLevel: ToolSafetyLevel.DANGER,
                            execute: async () => "不应被执行",
                        },
                    },
                ],
                requestApproval: async (_detail: string, meta: any) => {
                    if (allowApproval.has(meta.toolName)) return "allow-once";
                    deniedTools.push({ tool: meta.toolName, detail: String(_detail).slice(0, 100) });
                    return "deny";
                },
            } as any);
        });

        const mainMarker = hasText("请派子代理用于挂机演练-主标记", "AGENT-DONE");
        const subMarker = hasText("独立智能体助手");
        const gateSub = deferred();
        h.pushLane(mainMarker, { toolCalls: [{ name: "spawn_agent", args: { task: "挂机演练子任务" } }] });
        h.pushLane(mainMarker, { content: "子代理已完成派出交接工作，接下来等待其完成汇报自动送达后再继续推进主任务。" });
        h.pushLane(subMarker, { content: "子代理汇报：挂机演练完成", gate: gateSub.promise });
        h.pushLane(hasText("AGENT-DONE"), {
            toolCalls: [
                { name: "edit_file", args: { path: "wake-edit.txt", content: "唤醒轮写下的验收产物" } },
                { name: "run_command", args: { command: "echo 不该跑" } },
            ],
        });
        h.pushLane(hasText("AGENT-DONE"), { content: "已全部消化子代理完成汇报，验收产物已落盘、危险命令拒绝路径已核对，无待续事项，本轮唤醒到此收敛。" });

        await handleUnifiedChat({ sessionId: sid, content: "请派子代理用于挂机演练-主标记" }, noopSend, undefined, undefined, { toolSchemas: [spawnTool] });
        gateSub.resolve();
        assert.equal(await waitSessionQuiescent(sid), true);
        assert.equal(wakes, 1, "一次唤醒 run");
        const written = await fs.readFile(path.join(SANDBOX, "wake-edit.txt"), "utf-8");
        assert.equal(written, "唤醒轮写下的验收产物", "编辑类工具经自动应答器放行并真实执行");
        assert.equal(deniedTools.length, 1, "白名单外工具被拒");
        assert.equal(deniedTools[0]!.tool, "run_command");
        assert.ok(!(await transcriptFlat(sid)).includes("不应被执行"), "DANGER 工具 execute 未运行");
    });
});
