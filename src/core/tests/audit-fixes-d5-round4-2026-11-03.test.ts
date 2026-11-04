/**
 * @file tests/audit-fixes-d5-round4-2026-11-03.test.ts
 * @description D5 四轮守门：批量落盘如实回报（appendMessages 返回值 + 调度层降级回传）。
 *  病灶：appendMessages 返回 void，批内逐条失败（含回落路径的二次失败）只能从 warn 看到，
 *  调用点（工具结果落盘）拿不到——而工具结果丢失 = 上下文永久残缺（恢复时补占位、原始结果不可逆），
 *  比边界事件丢失严重一个量级。
 *  守门口径：
 *  1) 单元档 —— appendMessages 返回 {written, failed}：空批/单条/批量/全失败四档语义；
 *  2) 集成档 —— 并行批工具结果落盘失败（EISDIR 毒化）→ 主循环 receipt.degraded 点名
 *     appendMessages(tool-results)，且 final 照常 yield（失败不击垮收尾）；
 *  3) 反向档 —— 正常路径 degraded 不含落盘组件（防「狼来了」误报）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-d5-round4-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { appendMessage, appendMessages, readTranscriptLines } = await import("@/session/transcript.ts");
const { getTranscriptPath } = await import("@/session/store.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");
const { runAgent } = await import("@/agent/runAgent.ts");
const { clearHooks } = await import("@/hooks/registry.ts");
const { globTools } = await import("@/tool/registry/glob.ts");

/** EISDIR 毒化：先 rm（file 兼容 dir）再 mkdir——防同路径已有真文件时 mkdir EEXIST。 */
const poisonAsDir = async (p: string): Promise<void> => {
    await fs.rm(p, { force: true, recursive: true });
    await fs.mkdir(p, { recursive: true });
};

const mkEntries = (sid: string, n: number): any[] =>
    Array.from({ length: n }, (_, i) => ({ sessionId: sid, role: "tool", tool_call_id: `t${i}`, content: `r${i}` }));

/** 驱动一次 runAgent，收集 receipt 与 final 是否到达。 */
const driveRun = async (sid: string, script: any, toolSchemas: any[]): Promise<{ receipts: any[]; finalSeen: boolean }> => {
    const receipts: any[] = [];
    let finalSeen = false;
    const origWarn = console.warn;
    console.warn = () => { /* 收敛噪音：本档只断言 receipt/warn 语义，不回显 */ };
    try {
        setActiveProvider(createReplayProvider(script));
        const message: any[] = [{ role: "system", content: "SYS" }, { role: "user", content: "go" }];
        for await (const ev of runAgent(message, {
            sessionId: sid, cwd: SANDBOX,
            events: (async () => { }) as any,
            toolSchemas, modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
            parentSystemPrompt: "", depth: 0,
            onUIEvent: (e: any) => { if (e?.type === "run.receipt") receipts.push(e); },
        } as any)) {
            if ((ev as any)?.type === "final") finalSeen = true;
        }
    } finally {
        resetActiveProvider();
        console.warn = origWarn;
        clearHooks();
    }
    return { receipts, finalSeen };
};

/** 两个参数不同的 glob 调用 → 不被同轮去重、可并行 → batchEntries ≥ 2 走 appendMessages 批量路径。 */
const twoGlobScript = {
    turns: [
        {
            kind: "reply" as const, content: null,
            toolCalls: [
                { name: "glob", args: { pattern: "**/*.ts" }, id: "call_g1" },
                { name: "glob", args: { pattern: "**/*.md" }, id: "call_g2" },
            ],
        },
        { kind: "reply" as const, content: "检索完成", usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_tokens: 0 } },
    ],
};

describe("D5 四轮：appendMessages 如实回报", () => {
    it("单元档：空批/单条/批量成功 → failed 均为 0，written 与实际条数一致", async () => {
        const sid = `d5r4-ok-${Date.now()}`;

        const empty = await appendMessages(sid, []);
        assert.deepEqual(empty, { written: 0, failed: 0 }, "空批：零写零败");

        const one = await appendMessages(sid, mkEntries(sid, 1));
        assert.deepEqual(one, { written: 1, failed: 0 }, "单条走 appendMessage 委派，回传其成败");

        const many = await appendMessages(sid, mkEntries(sid, 3));
        assert.deepEqual(many, { written: 3, failed: 0 }, "批量成功：全部计入 written");
    });

    it("单元档：路径毒化 → 批量与单条均如实回 failed（不再是 void 静默）", async () => {
        const sid = `d5r4-fail-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid));

        const one = await appendMessages(sid, mkEntries(sid, 1));
        assert.deepEqual(one, { written: 0, failed: 1 }, "单条失败：委派路径回传 false");

        const many = await appendMessages(sid, mkEntries(sid, 3));
        assert.deepEqual(many, { written: 0, failed: 3 }, "批量失败：回落逐条仍全败，failed 计满");
    });

    it("单元档：appendMessage 仍返回 boolean（改动未破坏既有契约）", async () => {
        const sid = `d5r4-bool-${Date.now()}`;
        assert.equal(await appendMessage({ sessionId: sid, role: "user", content: "x" } as any), true, "正常路径 true");
        await poisonAsDir(getTranscriptPath(sid));
        assert.equal(await appendMessage({ sessionId: sid, role: "user", content: "y" } as any), false, "毒化路径 false");
    });

    it("集成档：工具结果批量落盘失败 → receipt.degraded 点名 appendMessages(tool-results)", async () => {
        const sid = `d5r4-int-${Date.now()}`;
        await poisonAsDir(getTranscriptPath(sid));

        const { receipts, finalSeen } = await driveRun(sid, twoGlobScript, globTools as any);

        assert.ok(finalSeen, "落盘失败不击垮收尾（final 照常 yield）");
        assert.equal(receipts.length, 1, "结算单照常发出");
        const degraded: string[] = receipts[0].degraded ?? [];
        assert.ok(
            degraded.includes("appendMessages(tool-results)"),
            `degraded 应点名批量落盘降级，实得：${JSON.stringify(degraded)}`,
        );
    });

    it("反向档：正常路径不得出现落盘组件（防误报狼来了）", async () => {
        const sid = `d5r4-neg-${Date.now()}`;

        const { receipts, finalSeen } = await driveRun(sid, twoGlobScript, globTools as any);

        assert.ok(finalSeen, "正常收尾");
        assert.equal(receipts.length, 1, "结算单照常发出");
        const degraded: string[] = receipts[0].degraded ?? [];
        for (const name of ["appendMessages(tool-results)", "appendMessage(tool-result)", "appendMessage(placeholder)", "appendMessage(assistant)"]) {
            assert.ok(!degraded.includes(name), `正常路径不得报 ${name}，实得：${JSON.stringify(degraded)}`);
        }
        // 防空跑假绿：必须能证明两个工具结果真的落盘了（否则「没报降级」可能只是因为根本没跑）
        const lines = await readTranscriptLines(sid);
        const toolRows = lines.filter((l: any) => l?.role === "tool");
        assert.equal(toolRows.length, 2, `两个工具结果应均已落盘，实得 ${toolRows.length} 条`);
    });
});
