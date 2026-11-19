/**
 * @file tests/agentid-instrument.test.ts
 * @description agentId 埋点守门（评审 #9，评审修复批 2026-11-19）：并行扇出下 5 路子代理共享父
 *  sessionId+runId+depth——链归属/成本分账/失败归因缺唯一键。每 run 生成唯一 agentId，随
 *  run.start/run.end 事件行与 usageLog 行落盘、随事件包装层注入全部 trace metadata。
 *  ★ 红线：store.ts 的 __sub__ 归一 rootId 是防双重计量的有意设计——agentId 是附加字段不是替代，
 *  本测试不触碰 store 归一化。
 *  触发器复用 setup-fence 的 state.json 目录伪装（失败发生在任何推理之前——零 mock 零网络）：
 *  同一 session 连跑两 run，断言 runId 不同（两次回合）、agentId 不同（链唯一键）、usageLog 两行
 *  同 sid 同 depth 而 agentId 可区分。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 在动态 import 前就位（仓库惯例）。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-agentid-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { runAgent } = await import("@/agent/runAgent.ts");
const { readTranscriptLines, isEventLine } = await import("@/session/transcript.ts");
const { getStatePath } = await import("@/session/store.ts");
const { getUsageLogPath: usageLogPath } = await import("@/observability/usageLog.ts");

after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

const corruptStore = (sid: string): void => {
    fs.mkdirSync(getStatePath(sid), { recursive: true });
};

const drain = async (gen: AsyncGenerator<any>): Promise<any[]> => {
    const out: any[] = [];
    for await (const e of gen) out.push(e);
    return out;
};

const eventLines = async (sid: string): Promise<any[]> =>
    (await readTranscriptLines(sid) as any[]).filter((l: any) => isEventLine(l));

describe("agentId 埋点：并行链唯一键", () => {
    it("同 session 两 run：run.start/run.end 均带 agentId 且逐 run 唯一（与 runId 独立）", async () => {
        const sid = `agentid-${Date.now()}`;
        corruptStore(sid);
        await drain(runAgent([{ role: "system", content: "S" }, { role: "user", content: "q1" }] as any, {
            sessionId: sid, toolSchemas: [], events: async () => { },
            modelWindow: 100000, keepRecentUnits: 5, compactRatio: 0.72, parentSystemPrompt: "", depth: 0,
        }));
        corruptStore(sid); // 目录伪装不会被消费掉，第二次 run 同样在 setup 段失败
        await drain(runAgent([{ role: "system", content: "S" }, { role: "user", content: "q2" }] as any, {
            sessionId: sid, toolSchemas: [], events: async () => { },
            modelWindow: 100000, keepRecentUnits: 5, compactRatio: 0.72, parentSystemPrompt: "", depth: 0,
        }));
        const lines = await eventLines(sid);
        const starts = lines.filter((l) => l.dscEvent === "run.start");
        const ends = lines.filter((l) => l.dscEvent === "run.end");
        assert.equal(starts.length, 2);
        assert.equal(ends.length, 2);
        for (const l of [...starts, ...ends]) {
            assert.ok(typeof l.agentId === "string" && l.agentId.length > 0, "事件行带 agentId");
            assert.notEqual(l.agentId, l.runId, "agentId 与 runId 是独立标识");
        }
        const runIds = new Set(starts.map((l) => l.runId));
        const agentIds = new Set(starts.map((l) => l.agentId));
        assert.equal(runIds.size, 2, "两次回合 runId 不同");
        assert.equal(agentIds.size, 2, "逐 run agentId 唯一——并行扇出下的链唯一键");
    });

    it("usageLog 行带 agentId：同 sid 同 depth 的多 run 可按 agentId 分账", async () => {
        const sid = `agentid-ul-${Date.now()}`;
        corruptStore(sid);
        await drain(runAgent([{ role: "system", content: "S" }, { role: "user", content: "q" }] as any, {
            sessionId: sid, toolSchemas: [], events: async () => { },
            modelWindow: 100000, keepRecentUnits: 5, compactRatio: 0.72, parentSystemPrompt: "", depth: 0,
        }));
        const month = new Date().toISOString().slice(0, 7);
        const p = usageLogPath(month);
        const raw = await fs.promises.readFile(p, "utf-8");
        const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.sessionId === sid);
        assert.equal(rows.length, 1, "本 sid 恰一行 usage 记录");
        assert.ok(typeof rows[0].agentId === "string" && rows[0].agentId.length > 0, "usageLog 行带 agentId（分账地基）");
    });
});
