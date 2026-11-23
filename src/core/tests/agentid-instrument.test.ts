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

const { runAgent, wrapRunEvents } = await import("@/agent/runAgent.ts");
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

// ============ ★ 评审修复 A8（2026-11-23）：wrapRunEvents 嵌套——子 run 的 agentId 不被父覆盖 ============
//
// 真实拓扑：子 run 拿到的 events 是父 run 已包装的那层（subagent 透传），子 run 再包一层。
// 执行序 = 外层（子）先、内层（父）后——metadata 最终胜出方是内层：
//   - runId 被内层（父）覆盖 → 子 run 事件归入父 run 的 trace 切片（既有设计）；
//   - agentId 外层注入后内层不再覆盖（`??` 保留）→ 子 run 的 agentId 存活。
// 修前 `{ ...base.metadata, runId, agentId }` 的父包装后执行会抹掉子 run 的 agentId
// （当日会话实测：转录 run.start 14 个 agentId，trace 1,368 条带 runId 事件仅 5 个 agentId）。
describe("wrapRunEvents 嵌套（评审修复 A8）", () => {
    it("wrap(wrap(collect, r1, a1), r2, a2)：runId === r1（父切片）、agentId === a2（子存活）", async () => {
        const collected: any[] = [];
        const collect = async (e: any) => { collected.push(e); };
        const r1 = "run-parent", a1 = "agent-parent", r2 = "run-child", a2 = "agent-child";
        const events = wrapRunEvents(wrapRunEvents(collect, r1, a1), r2, a2);
        await events({ sessionId: "s", eventType: "llm.request", metadata: { depth: 1 } } as any);
        assert.equal(collected.length, 1);
        assert.equal(collected[0].metadata.runId, r1, "runId 被内层（父）覆盖——子 run 归入父切片（既有设计）");
        assert.equal(collected[0].metadata.agentId, a2, "agentId 保留外层（子）的值——不被父覆盖（A8 修复点）");
    });

    it("单层包装：runId/agentId 均注入；metadata 已带 agentId 时保留原值", async () => {
        const collected: any[] = [];
        const events = wrapRunEvents(async (e: any) => { collected.push(e); }, "run-x", "agent-x");
        await events({ sessionId: "s", eventType: "llm.request", metadata: { depth: 0 } } as any);
        assert.equal(collected[0].metadata.runId, "run-x");
        assert.equal(collected[0].metadata.agentId, "agent-x");
        await events({ sessionId: "s", eventType: "llm.request", metadata: { depth: 0, agentId: "agent-preexisting" } } as any);
        assert.equal(collected[1].metadata.agentId, "agent-preexisting", "已存在的 agentId 保留（?? 语义）");
    });

    it("内层抛错被吞掉不冒泡（旁路埋点不拖垮主业务，既有铁律经包装层保持）", async () => {
        const boom = async () => { throw new Error("trace disk full"); };
        const events = wrapRunEvents(boom, "run-y", "agent-y");
        await assert.doesNotReject(() => events({ sessionId: "s", eventType: "llm.request", metadata: { depth: 0 } } as any));
    });
});
