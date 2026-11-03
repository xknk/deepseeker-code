/**
 * @file tests/audit-fixes-2026-11-03.test.ts
 * @description 运维与成本审查报告（.ai-docs/审查报告-2026-11-03-运维与成本视角.md）§6 工单修复守门：
 *  - D3 PreCompact/PostCompact 配对：循环首检 abort / 熔断 throw 两条丢失路径补发 PostCompact；
 *    免费衰减早退路径（PreCompact 之前退出的）不得被错发（少发→错发比不配对更糟）；
 *  - D2 自收敛判据对齐：「索引满编 + 叙述极短」的槽（旧整槽口径必触发）不再白付一次
 *    无收益的 aux 自收敛调用——判据只量叙述段，与「只改叙述段」的动作对齐；
 *  - D5 收尾聚合健康信号：人为让旁路（结算单 UI）抛错 → 聚合 warn 含组件名、主流程不被击垮；
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
const { readTranscriptLines } = await import("@/session/transcript.ts");

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
            warns.some(w => w.includes("旁路降级") && w.includes("run.receipt")),
            `聚合 warn 应含组件名，实得：${JSON.stringify(warns)}`,
        );
        // 结算单之后的收尾段照常执行：run.end 事件行已落盘（顺序：receipt → Stop hook → 校准）
        const lines = await readTranscriptLines("d5-degraded-warn");
        assert.ok(lines.some((l: any) => l?.dscEvent === "run.end"), "run.end 事件行不受结算单失败影响");
    });
});
