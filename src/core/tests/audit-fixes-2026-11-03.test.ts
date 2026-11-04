/**
 * @file tests/audit-fixes-2026-11-03.test.ts
 * @description 运维与成本审查报告（.ai-docs/审查报告-2026-11-03-运维与成本视角.md）§6 工单修复守门：
 *  - D3 PreCompact/PostCompact 配对：循环首检 abort / 熔断 throw 两条丢失路径补发 PostCompact；
 *    免费衰减早退路径（PreCompact 之前退出的）不得被错发（少发→错发比不配对更糟）；
 *  - D2 自收敛判据对齐：「索引满编 + 叙述极短」的槽（旧整槽口径必触发）不再白付一次
 *    无收益的 aux 自收敛调用——判据只量叙述段，与「只改叙述段」的动作对齐；
 *  - D5 收尾聚合健康信号：人为让旁路（结算单 UI）抛错 → 聚合 warn 含组件名、主流程不被击垮；
 *  - D5 二轮（4f15287 复核）：外层 catch 是死信号——事件行/trace/用量/inbox 的内层早就吞了错。
 *    二轮内层如实回报（appendEvent/recordUsageRun → boolean、flushTraceBuffer → 失败计数、
 *    flushLeftover → {flushed, failed}），runAgent finally 按返回值聚合。守门用 EISDIR 毒化法
 *    （文件位预建成目录 → appendFile EISDIR，跨平台稳定）打通真实落盘失败路径，反向档断言
 *    「禁用开关 ≠ 降级」（DEEPSEEKER_CODE_USAGE_LOG=0 的加载期快照在独立文件 d5-disabled）；
 *  - D1「不猜原因」的文案断言在 transcript-events.test.ts（recoverSession reason / 孤儿占位档）。
 *
 *  约定：涉及 transcript/store 落盘，静态 import 会先于 env 沙盒设置——故一律在 env 就位后
 *  动态 import（kernel-audit-secondbatch.test.ts 同法）；辅助模型走假 provider（compression-pretruncate 同款）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-audit-fixes-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { ensureFitsWindow, parseSummarySlot, mergeSummarySlot } = await import("@/agent/truncate.ts");
const { registerHook, clearHooks } = await import("@/hooks/registry.ts");
const { estimateTokens } = await import("@/session/contextCore.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");
const { runAgent } = await import("@/agent/runAgent.ts");
const { readTranscriptLines, appendEvent, appendMessage } = await import("@/session/transcript.ts");
const { getTranscriptPath } = await import("@/session/store.ts");
const { getUsageLogPath, recordUsageRun } = await import("@/observability/usageLog.ts");
const { getTraceStorePath } = await import("@/observability/store.ts");
const { appendTraceEvent, flushTraceBuffer } = await import("@/observability/trace.ts");
const { pushSessionInbox, flushLeftoverToTranscript } = await import("@/agent/inbox.ts");
const { appConfig } = await import("@/config/index.ts");

// ==================== 夹具 ====================

/** 挂载假辅助模型 provider 执行 fn，结束复位（compression-pretruncate.test.ts 同款惯例）。 */
const withProvider = async <T>(provider: any, fn: () => Promise<T>): Promise<T> => {
    setActiveProvider(provider);
    try {
        return await fn();
    } finally {
        resetActiveProvider();
    }
};

/** 记录请求体积的假辅助模型：notes = 合成产物（叙述段）文本；alwaysFail = 持续故障（驱动熔断）。 */
const makeAuxProvider = (opts?: { alwaysFail?: boolean; notes?: string }) => {
    const summarizeSizes: number[] = [];
    const provider: any = {
        id: "fake", displayName: "Fake", modelLabel: "Fake",
        streamChat: async function* () { /* 本文件只走 summarize 通道 */ },
        classifyRisk: async () => "risky",
        buildAssistantMessage: (p: any) => ({ role: "assistant", content: p.content ?? "" }) as any,
        isContextLengthError: (e: any) => e?.status === 400,
        isTransientError: () => false,
        isImageUnsupportedError: () => false,
        summarize: async (messages: any[]) => {
            summarizeSizes.push(JSON.stringify(messages).length);
            if (opts?.alwaysFail) throw new Error("模拟辅助模型持续故障");
            return { choices: [{ message: { content: opts?.notes ?? "Fake 摘要" } }] } as any;
        },
    };
    return { provider, summarizeSizes };
};

/** ensureFitsWindow 最小入参（校准系数显式给 1，排除估算噪声；compression-pretruncate 同款）。 */
const buildEvent = (sessionId: string, messageArr: any[], extra: Record<string, any> = {}) => ({
    sessionId,
    messageArr,
    depth: 0,
    keepRecentUnits: 1,
    compactRatio: 0.5,   // 阈值 = 30000 × 0.5 = 15000 token
    modelWindow: 30000,
    correctionRatio: 1,
    toolsTokens: 0,
    events: (() => { }) as any,
    ...extra,
});

/** 注册 Pre/PostCompact 捕获 hook，返回计数与清理句柄（clearHooks 全清——本文件进程内独占）。 */
const captureCompactHooks = () => {
    const pre: any[] = [];
    const post: any[] = [];
    registerHook({ event: 'PreCompact', run: (ctx: any) => { pre.push(ctx); }, source: 'builtin' });
    registerHook({ event: 'PostCompact', run: (ctx: any) => { post.push(ctx); }, source: 'builtin' });
    return { pre, post, cleanup: () => clearHooks() };
};

/** 构造含巨型工具结果的历史：assistant(tool_calls) + tool(超大输出)（compression-pretruncate 同款）。 */
const buildHistoryWithGiantResult = (giantContent: string): any[] => [
    { role: "system", content: "SYS" },
    { role: "system", content: "" }, // 摘要槽
    { role: "user", content: "任务背景：读大日志并总结要点" },
    {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"cat huge.log"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: giantContent },
    { role: "assistant", content: "已读取完毕，开始整理" },
    { role: "user", content: "继续" },
];

// ==================== D3：PreCompact / PostCompact 配对 ====================

describe("D3 PreCompact/PostCompact 配对（审查报告 2026-11-03 §6-2）", () => {
    it("循环首检 abort return → PostCompact 补发配对（Pre/Post 恰各 1，零 aux 调用）", async () => {
        const { pre, post, cleanup } = captureCompactHooks();
        const { provider, summarizeSizes } = makeAuxProvider();
        const ac = new AbortController();
        ac.abort(); // 预先中止：循环首检即 return（旧实现在此漏发 PostCompact）
        try {
            await withProvider(provider, async () => {
                await ensureFitsWindow(buildEvent("d3-abort-first", buildHistoryWithGiantResult("ok"), { forceCompact: true, signal: ac.signal }));
            });
        } finally {
            cleanup();
        }
        assert.equal(pre.length, 1, "压缩已确定触发 → PreCompact 已发");
        assert.equal(post.length, 1, "abort 退出路径仍补发 PostCompact（配对契约）");
        assert.equal(summarizeSizes.length, 0, "中止发生在任何 aux 调用之前");
    });

    it("熔断 throw 越过循环尾 → PostCompact 补发（3 次 Pre 配 3 次 Post）", async () => {
        const { pre, post, cleanup } = captureCompactHooks();
        const { provider } = makeAuxProvider({ alwaysFail: true });
        // ★ 体量取「超压缩阈值(15000)、低于兜底(0.63×30000=18900)」区间（真实熔断可达区，compression-pretruncate 同款）
        const messageArr = buildHistoryWithGiantResult("错".repeat(17_000));
        try {
            await withProvider(provider, async () => {
                // ★ 同一会话：失败计数按 sessionId 落盘累计，分session则永不触线
                await ensureFitsWindow(buildEvent("d3-melt", messageArr)); // 失败 1（catch 后 break）
                await ensureFitsWindow(buildEvent("d3-melt", messageArr)); // 失败 2（catch 后 break）
                await assert.rejects(
                    () => ensureFitsWindow(buildEvent("d3-melt", messageArr)), // 失败 3 → 熔断 throw
                    /压缩熔断/,
                );
            });
        } finally {
            cleanup();
        }
        assert.equal(pre.length, 3, "三次调用各发一次 PreCompact");
        assert.equal(post.length, 3, "熔断 throw 也补发 PostCompact（finally 兜住，不再只有正常路径发）");
    });

    it("免费衰减早退：未发 PreCompact → 不得错发 PostCompact（反向红线）", async () => {
        const { pre, post, cleanup } = captureCompactHooks();
        const { provider, summarizeSizes } = makeAuxProvider();
        // 11 个对话单元（> KEEP_RECENT_UNITS=5 → cutoff=6）：6 个老单元各带 11K ASCII 工具结果
        // （超阈值前 ~16.6K token > 15000；免费衰减折叠后 ~1.7K → 回到阈值内早退，不触发 LLM 压缩）
        const messageArr: any[] = [
            { role: "system", content: "SYS" },
            { role: "system", content: "" },
        ];
        for (let i = 0; i < 6; i++) {
            messageArr.push({
                role: "assistant", content: null,
                tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"old${i}.log"}` } }],
            });
            messageArr.push({ role: "tool", tool_call_id: `c${i}`, content: "L".repeat(11_000) });
        }
        for (let i = 0; i < 5; i++) messageArr.push({ role: "user", content: `recent unit number ${i}` });
        try {
            await withProvider(provider, async () => {
                await ensureFitsWindow(buildEvent("d3-freedecay", messageArr));
            });
        } finally {
            cleanup();
        }
        assert.equal(pre.length, 0, "未触发 LLM 压缩 → 无 PreCompact");
        assert.equal(post.length, 0, "早退路径不得补发 PostCompact（没发过 Pre 就不能发 Post）");
        assert.equal(summarizeSizes.length, 0, "免费衰减成功降级，零 LLM 成本");
        // 衰减确曾生效——证明早退走的是「衰减后回到阈值内」，而非「根本没超阈值」的空转
        assert.ok(
            messageArr.some((m: any) => m.role === "tool" && typeof m.content === "string" && m.content.includes("历史工具输出已折叠")),
            "老工具结果应被折叠（衰减路径证据）",
        );
    });
});

// ==================== D2：自收敛判据对齐（只量叙述段） ====================

describe("D2 自收敛判据对齐（审查报告 2026-11-03 §6-4）", () => {
    it("索引满编 + 短叙述槽（旧整槽口径必触发）→ 不再触发 aux 自收敛调用", async () => {
        const { provider, summarizeSizes } = makeAuxProvider({ notes: "进".repeat(600) }); // 叙述 ~604 token：单独远低于阈值
        // 预置满编索引槽：120 条 × 恰 60 字符 ASCII 实体（ARCHIVE_INDEX_MAX_ENTRIES 满编；单实体长度上限）
        const entities: string[] = [];
        for (let i = 0; i < 120; i++) {
            entities.push(`d${String(i).padStart(3, "0")}/x${"x".repeat(50)}.ts`); // 4 + 1 + 52 + 3 = 60 字符
        }
        const fullSlot = mergeSummarySlot("", "", entities);
        // 待压缩历史刻意全 ASCII 散文（零可提取实体）——满编索引不被新实体挤占，判定只取决于槽自身
        const messageArr: any[] = [
            { role: "system", content: "SYS" },
            { role: "system", content: fullSlot }, // 摘要槽（满编索引 + 空叙述）
            { role: "user", content: "plan the work and verify results" },
            { role: "assistant", content: "done with step one" },
            { role: "user", content: "continue with the rest" },
        ];
        await withProvider(provider, async () => {
            await ensureFitsWindow(buildEvent("d2-straddle", messageArr, { forceCompact: true }));
        });
        // 跨阈值实证：合成后整槽 > 2000（旧「整槽口径」必触发自收敛），叙述段单独 < 2000（新判据不触发）
        const finalSlot = (messageArr[1] as any).content as string;
        const wholeSlotTokens = estimateTokens([{ role: "system", content: finalSlot } as any]);
        const { notes, index } = parseSummarySlot(finalSlot);
        assert.ok(wholeSlotTokens > 2000, `整槽应落在旧口径触发区间（>2000），实得 ${wholeSlotTokens}`);
        assert.ok(estimateTokens([{ role: "system", content: notes } as any]) < 2000, "叙述段单独应低于阈值（新判据口径）");
        assert.equal(index.length, 120, "满编索引在合成重建后原样保留（索引无损）");
        // 恰 1 次 aux 调用（单批直通合成）；旧整槽判据此处会多付第 2 次自收敛调用
        assert.equal(summarizeSizes.length, 1, `只付合成调用本身，实得 ${summarizeSizes.length}`);
    });
});

// ==================== D5：收尾聚合健康信号 ====================

describe("D5 收尾聚合健康信号（审查报告 2026-11-03 §6-3）", () => {
    it("结算单 UI 旁路抛错 → 聚合 warn 含组件名，收尾链路不被击垮", async () => {
        const script = {
            turns: [{
                kind: "reply" as const,
                content: "D5 注入：结算单 onUIEvent 抛错，收尾照常。",
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 0 },
            }],
        };
        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...a: any[]) => { warns.push(a.map(x => (typeof x === "string" ? x : String(x))).join(" ")); };
        const events: any[] = [];
        try {
            const p = createReplayProvider(script as any);
            setActiveProvider(p);
            const message: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "go" }];
            for await (const ev of runAgent(message, {
                sessionId: "d5-degraded-warn", cwd: SANDBOX, events: (async () => { }) as any,
                toolSchemas: [], modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
                parentSystemPrompt: "", depth: 0,
                // 人为让「结算单」旁路抛错：D5 验收口径——聚合 warn 必须点名组件
                onUIEvent: (e: any) => { if (e?.type === "run.receipt") throw new Error("boom-receipt"); },
            } as any)) {
                events.push(ev);
            }
        } finally {
            resetActiveProvider();
            console.warn = origWarn;
            clearHooks();
        }
        assert.ok(events.some((e: any) => e?.type === "final"), "旁路失败不击垮收尾（final 照常 yield）");
        assert.ok(
            warns.some(w => w.includes("降级") && w.includes("run.receipt")),
            `聚合 warn 应含组件名，实得：${JSON.stringify(warns)}`,
        );
        // 结算单之后的收尾段照常执行：run.end 事件行已落盘（顺序：receipt → Stop hook → 校准）
        const lines = await readTranscriptLines("d5-degraded-warn");
        assert.ok(lines.some((l: any) => l?.dscEvent === "run.end"), "run.end 事件行不受结算单失败影响");
    });
});

// ==================== D5 二轮：内层如实回报（EISDIR 毒化守门） ====================

/** recordUsageRun 最小入参（直接单测通道；workspace 由模块统一盖章，调用方不传） */
const makeUsageRecord = (sessionId: string) => ({
    v: 1 as const,
    ts: new Date().toISOString(),
    sessionId,
    runId: `r-${sessionId}`,
    depth: 0,
    model: "fake",
    stopReason: "normal" as const,
    rounds: 1,
    durationMs: 1,
    tools: {},
});

/** EISDIR 毒化：把「本应是文件」的路径预建成目录 → appendFile EISDIR（权限位法跨平台不稳，此法稳定）。
 *  先 rm（file 兼容 dir）再 mkdir——同进程前面的健康用例可能已在同路径写过真文件。 */
const poisonAsDir = async (p: string): Promise<void> => {
    await fs.rm(p, { force: true, recursive: true });
    await fs.mkdir(p, { recursive: true });
};
const usageMonthPath = (): string => getUsageLogPath(new Date().toISOString().slice(0, 7));

describe("D5 二轮单元档：内层吞错组件如实回报成败（外层 catch 是死信号）", () => {
    it("毒化路径上 appendEvent / appendMessage 回 false、flushLeftover 聚合失败数", async () => {
        const sid = `d5u-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid));
        assert.equal(await appendEvent(sid, { dscEvent: "run.end", runId: "r1", stopReason: "normal", rounds: 1 }), false, "事件行落盘失败如实回 false（旧 void 签名外层永远收不到）");
        assert.equal(await appendMessage({ sessionId: sid, role: "user", content: "x" } as any), false, "消息行落盘失败如实回 false");
        // inbox flush 聚合：队列 2 条全部落盘失败 → {flushed:0, failed:2}（不再「2 条已写入」假成功）
        assert.ok(pushSessionInbox(sid, "补充一"));
        assert.ok(pushSessionInbox(sid, "补充二"));
        assert.deepEqual(await flushLeftoverToTranscript(sid), { flushed: 0, failed: 2 }, "失败条数聚合如实上报");
    });

    it("毒化路径上 flushTraceBuffer 回失败计数 1（缓冲后立即毒化、立即 flush——不给 200ms 兜底 timer 竞态窗口）", async () => {
        const tid = `d5u-trace-${Date.now()}`;
        await appendTraceEvent({ sessionId: tid, eventType: "llm.request", metadata: {} } as any); // 普通事件不触发即时档
        await poisonAsDir(await getTraceStorePath(tid));
        assert.equal(await flushTraceBuffer(tid), 1, "毒化会话失败计数 1（健康会话不计入）");
    });

    it("中途丢批粘性：定时器路径丢的批无人接收 → 留标记，由全量 drain 上报一次即清", async () => {
        // 复现真实故障形状：中途（非 reporting 调用）丢批时缓冲被清空，若此刻就是 run 收尾，
        // 旧实现会回 0（「没货」）——丢批事实彻底消失（就是那两个测试时抖时青的根因）。
        // 先全量 drain 一次吸收前序用例遗留的粘性标记（粘性是模块级、跨用例存活，不排空则计数不唯一）。
        await flushTraceBuffer();
        const tid = `d5u-sticky-${Date.now()}`;
        await appendTraceEvent({ sessionId: tid, eventType: "llm.request", metadata: {} } as any);
        await poisonAsDir(await getTraceStorePath(tid));

        // ① 定时器/阈值路径（带 sessionId）：自己上报 1，同时 arm 粘性标记
        assert.equal(await flushTraceBuffer(tid), 1, "非 reporting 调用：本批失败如实回 1");
        // ② 此刻缓冲已空——关键断言：再叫一次带参 flush 仍是 0，且**不会**把粘性标记吃掉
        assert.equal(await flushTraceBuffer(tid), 0, "缓冲空 → 本批零失败（但粘性标记仍留着）");
        // ③ 全量 drain（无参，runAgent finally 就走这条）：不靠缓冲有货，也能把历史丢批算进来
        assert.equal(await flushTraceBuffer(), 1, "全量 drain 必须上报历史丢批（不再依赖 buffered 非空）");
        // ④ 报一次即清：再 drain 不得重复报（防狼来了）
        assert.equal(await flushTraceBuffer(), 0, "粘性标记报一次即清，不重复刷");
    });

    it("健康路径上四个组件如实回成功（毒化对照：同一断言的 green 侧）", async () => {
        const sid = `d5u-ok-${Date.now()}`;
        assert.equal(await appendEvent(sid, { dscEvent: "run.end", runId: "r2", stopReason: "normal", rounds: 1 }), true);
        assert.equal(await appendMessage({ sessionId: sid, role: "user", content: "ok" } as any), true);
        assert.equal(await flushTraceBuffer(`d5u-ok-trace-${Date.now()}`), 0, "空队/全成功 → 计数 0");
        assert.equal(await recordUsageRun(makeUsageRecord(sid)), true);
        // 落盘实证：用量行真的写进了月分片
        const raw = await fs.readFile(usageMonthPath(), "utf-8");
        assert.ok(raw.includes(sid), "recordUsageRun(true) 应有对应盘上行");
    });

    it("毒化路径上 recordUsageRun 回 false（健康用例之后跑——毒化不反噬前面的 green 断言）", async () => {
        await poisonAsDir(usageMonthPath());
        assert.equal(await recordUsageRun(makeUsageRecord(`d5u-${Date.now()}`)), false, "用量落盘失败如实回 false（双重死的内层已修）");
    });
});

describe("D5 二轮集成档：EISDIR 毒化打通四个返回值降级信号（warn + receipt 双通道）", () => {
    it("transcript/trace/usage 三处毒化 + inbox 排队 → degraded 含全部四个组件名，主流程不被击垮", async () => {
        const sid = `d5i-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid));
        await poisonAsDir(await getTraceStorePath(sid));
        await poisonAsDir(usageMonthPath());

        const script = {
            turns: [{
                kind: "reply" as const,
                content: "D5 二轮注入：三处盘上路径毒化，收尾照常。",
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 0 },
            }],
        };
        const warns: string[] = [];
        const receipts: any[] = [];
        const origWarn = console.warn;
        console.warn = (...a: any[]) => { warns.push(a.map(x => (typeof x === "string" ? x : String(x))).join(" ")); };
        let finalSeen = false;
        // trace 缓冲续注：20ms interval 持续向毒化会话缓冲普通事件行，确保 finally drain 时
        // 大概率有货。
        // ★ D5 四轮修正（2026-11-04）：旧注释声称「200ms timer 冲批 → interval 补批 → drain 必撞 EISDIR，
        // 竞态窗口被结构性消除」——**这是错的，已实测打脸**。trace 内部 200ms timer 冲批失败后按
        // §4.2-7 直接丢弃该批，而下一条补货最晚 20ms 后才到；全量并发下事件循环一挤，drain 完全可能
        // 落在「货刚被扔掉、新货未到」的 ≤20ms 缝隙里——缓冲为空 → 如实回 0 失败 → 本用例误判信号丢失。
        // 現在真正的确定性保障在 trace 侧：中途丢过批会留粘性标记，全量 drain 必将其计入返回值
        // （与 drain 那一刻缓冲空不空无关）。本 interval 仍保留——它负责制造“中途必然冲批”的处境。
        const refill = setInterval(() => {
            void appendTraceEvent({ sessionId: sid, eventType: "llm.request", metadata: {} } as any);
        }, 20);
        try {
            setActiveProvider(createReplayProvider(script as any));
            const message: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "go" }];
            for await (const ev of runAgent(message, {
                sessionId: sid, cwd: SANDBOX,
                events: (async () => { }) as any,
                toolSchemas: [], modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
                parentSystemPrompt: "", depth: 0,
                onUIEvent: (e: any) => { if (e?.type === "run.receipt") receipts.push(e); },
            } as any)) {
                if ((ev as any)?.type === "final") {
                    finalSeen = true;
                    // ★ inbox 条目在 final 事件消费点入队：generator 挂起在本循环体、恢复即进 finally——
                    //   此刻入队的条目躲过了轮边界认领，只有收尾 flushLeftover 能认领它（撞毒化路径 → failed=1）。
                    assert.ok(pushSessionInbox(sid, "final 后排队——只有收尾 flush 能带走的补充输入"), "inbox 入队成功");
                }
            }
        } finally {
            clearInterval(refill);
            resetActiveProvider();
            console.warn = origWarn;
            clearHooks();
        }
        assert.ok(finalSeen, "旁路集体降级不击垮收尾（final 照常 yield）");
        const expected = ["flushLeftoverToTranscript", "appendEvent(run.end)", "flushTraceBuffer", "recordUsageRun"];
        const allWarn = warns.join("\n");
        assert.ok(allWarn.includes("降级"), `聚合 warn 应存在，实得：${JSON.stringify(warns)}`);
        for (const name of expected) {
            assert.ok(allWarn.includes(name), `聚合 warn 应含 ${name}`);
        }
        assert.equal(receipts.length, 1, "结算单照常发出（用户可见通道）");
        assert.ok(Array.isArray(receipts[0].degraded), "receipt 应带 degraded 数组");
        for (const name of expected) {
            assert.ok(receipts[0].degraded.includes(name), `receipt.degraded 应含 ${name}`);
        }
    });
});

describe("D5 二轮反向档：禁用开关 ≠ 降级（误报即狼来了）", () => {
    it("transcriptEvents 关闭：毒化路径上 appendEvent 仍回 true（有意 no-op 未触盘）；消息行无开关，对照回 false", async () => {
        const sid = `d5off-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid)); // 路径已坏——若关闭路径仍触盘必回 false
        const prev = appConfig.transcriptEvents;
        appConfig.transcriptEvents = false;
        try {
            assert.equal(await appendEvent(sid, { dscEvent: "run.end", runId: "r3", stopReason: "normal", rounds: 1 }), true, "关闭 = 有意 no-op，返回成功");
            assert.equal(await appendMessage({ sessionId: sid, role: "user", content: "x" } as any), false, "对照组：消息行无禁用开关，同一路径如实回 false");
        } finally {
            appConfig.transcriptEvents = prev;
        }
    });
});

// ==================== D5 三轮：主循环信号采集（round.end / assistant 消息）+ receipt 快照边界 ====================

describe("D5 三轮（8bdb712 遗留项工单）：主循环调用点消费返回值", () => {
    it("EISDIR 毒化 transcript：receipt.degraded 含 appendEvent(round.end) 与 appendMessage(assistant)", async () => {
        const sid = `d5t-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid)); // 主循环与收尾的事件行/消息落盘同批失败
        const script = {
            turns: [{
                kind: "reply" as const,
                content: "D5 三轮注入：主循环信号采集，收尾照常。",
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 0 },
            }],
        };
        const receipts: any[] = [];
        let finalSeen = false;
        try {
            setActiveProvider(createReplayProvider(script as any));
            const message: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "go" }];
            for await (const ev of runAgent(message, {
                sessionId: sid, cwd: SANDBOX, events: (async () => { }) as any,
                toolSchemas: [], modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
                parentSystemPrompt: "", depth: 0,
                onUIEvent: (e: any) => { if (e?.type === "run.receipt") receipts.push(e); },
            } as any)) {
                if ((ev as any)?.type === "final") finalSeen = true;
            }
        } finally {
            resetActiveProvider();
            clearHooks();
        }
        assert.ok(finalSeen, "主循环降级不击垮 run（final 照常 yield）");
        assert.equal(receipts.length, 1, "结算单照常发出");
        assert.ok(Array.isArray(receipts[0].degraded), "receipt.degraded 应存在");
        assert.ok(receipts[0].degraded.includes("appendEvent(round.end)"), `receipt.degraded 应含 appendEvent(round.end)，实得 ${JSON.stringify(receipts[0].degraded)}`);
        assert.ok(receipts[0].degraded.includes("appendMessage(assistant)"), "receipt.degraded 应含 appendMessage(assistant)（对话本体落盘失败）");
        assert.ok(receipts[0].degraded.includes("appendEvent(run.end)"), "收尾 run.end 同批失败一并入快照");
    });

    it("反向红线：健康路径 receipt.degraded 必须为 undefined（防狼来了）", async () => {
        // 防跨用例残留：先排空其它会话的 trace 缓冲尾巴（毒化会话的行会丢弃、队列清空）、
        // 撤销前序用例对 usage 月分片的目录毒化——恢复健康基线后再断言零降级
        await flushTraceBuffer();
        await fs.rm(usageMonthPath(), { recursive: true, force: true });
        const sid = `d5t-ok-${Date.now()}`;
        const script = {
            turns: [{
                kind: "reply" as const,
                content: "D5 三轮反向：健康路径零降级，收尾照常。",
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 0 },
            }],
        };
        const receipts: any[] = [];
        try {
            setActiveProvider(createReplayProvider(script as any));
            const message: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "go" }];
            for await (const ev of runAgent(message, {
                sessionId: sid, cwd: SANDBOX, events: (async () => { }) as any,
                toolSchemas: [], modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
                parentSystemPrompt: "", depth: 0,
                onUIEvent: (e: any) => { if (e?.type === "run.receipt") receipts.push(e); },
            } as any)) { /* drain */ }
        } finally {
            resetActiveProvider();
            clearHooks();
        }
        assert.equal(receipts.length, 1, "结算单照常发出");
        assert.equal(receipts[0].degraded, undefined, "健康路径 degraded 必须缺省（误报=狼来了）");
    });
});
