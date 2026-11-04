/**
 * @file tests/audit-fixes-d5-disabled-2026-11-03.test.ts
 * @description D5 二轮反向档独立进程：禁用开关 ≠ 降级（误报即狼来了）。
 *  USAGE_DISABLED（DEEPSEEKER_CODE_USAGE_LOG=0，usageLog.ts 模块加载期 const）与
 *  transcriptEvents（DEEP_SEEK_TRANSCRIPT_EVENTS=0，config 加载期快照）都不可运行时翻转——
 *  node --test 每测试文件独立进程，故本文件在一切动态 import 之前置 env，独占「全关」档。
 *  守门口径：毒化盘上路径（文件位预建成目录 → appendFile EISDIR）后，禁用通道必须返回成功
 *  且 degraded 不得出现其组件名；trace 无禁用开关，毒化后仍须如实报（对照组，防全绿假象）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// —— 禁用开关 + 沙盒，均先于一切动态 import（两个开关都是模块加载期快照）——
process.env.DEEPSEEKER_CODE_USAGE_LOG = "0";
process.env.DEEP_SEEK_TRANSCRIPT_EVENTS = "0";
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-d5-disabled-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { appConfig } = await import("@/config/index.ts");
const { appendEvent, appendMessage } = await import("@/session/transcript.ts");
const { getTranscriptPath } = await import("@/session/store.ts");
const { getUsageLogPath, recordUsageRun } = await import("@/observability/usageLog.ts");
const { getTraceStorePath } = await import("@/observability/store.ts");
const { appendTraceEvent } = await import("@/observability/trace.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");
const { runAgent } = await import("@/agent/runAgent.ts");
const { clearHooks } = await import("@/hooks/registry.ts");

/** EISDIR 毒化：先 rm（file 兼容 dir）再 mkdir——防同路径已有真文件时 mkdir EEXIST。 */
const poisonAsDir = async (p: string): Promise<void> => {
    await fs.rm(p, { force: true, recursive: true });
    await fs.mkdir(p, { recursive: true });
};
const usageMonthPath = (): string => getUsageLogPath(new Date().toISOString().slice(0, 7));
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

describe("D5 二轮反向档（独立进程）：禁用开关 ≠ 降级", () => {
    it("加载期快照确认：本进程 transcriptEvents / usage log 均为关闭态（测试前提自检）", () => {
        assert.equal(appConfig.transcriptEvents, false, "DEEP_SEEK_TRANSCRIPT_EVENTS=0 已生效");
    });

    it("单元档：毒化路径上 appendEvent / recordUsageRun 仍回 true（关闭 = 有意 no-op 未触盘）", async () => {
        const sid = `d5d-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid));
        await poisonAsDir(usageMonthPath());
        assert.equal(await appendEvent(sid, { dscEvent: "run.end", runId: "r1", stopReason: "normal", rounds: 1 }), true, "事件行开关关：返回成功，未触盘");
        assert.equal(await recordUsageRun(makeUsageRecord(sid)), true, "用量日志开关关：返回成功，未触盘");
        assert.equal(await appendMessage({ sessionId: sid, role: "user", content: "x" } as any), false, "对照组：消息行无禁用开关，同一路径如实回 false");
    });

    it("集成档：禁用通道毒化也静默（degraded 不得点名），trace 通道无开关、毒化仍如实报", async () => {
        const sid = `d5di-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid));
        await poisonAsDir(usageMonthPath());
        await poisonAsDir(await getTraceStorePath(sid));

        const script = {
            turns: [{
                kind: "reply" as const,
                content: "D5 反向档：usage/transcript 关闭、trace 毒化。",
                usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 0 },
            }],
        };
        const warns: string[] = [];
        const receipts: any[] = [];
        const origWarn = console.warn;
        console.warn = (...a: any[]) => { warns.push(a.map(x => (typeof x === "string" ? x : String(x))).join(" ")); };
        let finalSeen = false;
        // trace 缓冲续注（20ms interval）：让毒化会话在 run 中途被 200ms 兜底 timer 冲批。
        // ★ D5 四轮修正（2026-11-04）：旧注「drain 时缓冲必有货」是错的——冲批失败会丢批，
        //   drain 可能落在“刚丢完、新货未到”的缝隙里而看到空缓冲。确定性保障已改由 trace 侧粘性
        //   丢批计数提供（丢过批 → 全量 drain 必计数）；本 interval 只负责制造中途冲批。
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
                if ((ev as any)?.type === "final") finalSeen = true;
            }
        } finally {
            clearInterval(refill);
            resetActiveProvider();
            console.warn = origWarn;
            clearHooks();
        }
        assert.ok(finalSeen, "收尾照常完成");
        const allWarn = warns.join("\n");
        assert.ok(allWarn.includes("flushTraceBuffer"), "对照组：trace 无禁用开关，毒化后必须如实报");
        assert.ok(!allWarn.includes("recordUsageRun"), "禁用通道（USAGE_LOG=0）毒化也不得报降级");
        assert.ok(!allWarn.includes("appendEvent(run.end)"), "禁用通道（transcriptEvents 关）毒化也不得报降级");
        assert.equal(receipts.length, 1, "结算单照常发出");
        assert.ok(Array.isArray(receipts[0].degraded), "receipt.degraded 应存在（trace 降级）");
        assert.ok(receipts[0].degraded.includes("flushTraceBuffer"), "receipt.degraded 应含对照组 flushTraceBuffer");
        assert.ok(!receipts[0].degraded.includes("recordUsageRun"), "receipt.degraded 不得含禁用通道");
        assert.ok(!receipts[0].degraded.includes("appendEvent(run.end)"), "receipt.degraded 不得含禁用通道");
    });
});
