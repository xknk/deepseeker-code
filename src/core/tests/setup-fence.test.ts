/**
 * @file tests/setup-fence.test.ts
 * @description P1-D setup 段防护守门（评审修复批 2026-11-19）：prepareToolsAndInjections /
 *  getCalibration 两处 setup await 原在主 try 之外，异常冲出 generator → final 永不发、
 *  run.start 不落盘（trace 断链，排障看不到本次 run 存在过）。修复后：
 *  ① run.start 先落盘（setup 异常时 trace 仍见本次 run）；
 *  ② setup 异常 → 兜底 catch → final 必发（宿主 busy 必清）、文案「初始化失败」；
 *  ③ finally 收尾照常执行 → run.end 落盘 stopReason='error'（异常收尾取证语义与主 try 同款）；
 *  ④ setup 期间用户中止 → 安静收尾（「已中止」），不污染错误文案。
 *  触发器：把 state.json 伪装成目录 → readStore EISDIR（非 ENOENT/SyntaxError → 透传）→
 *  getCalibration 抛错。确定性、零 mock、零网络（失败发生在任何推理之前）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 在动态 import 前就位（仓库惯例）。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-setup-fence-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { runAgent } = await import("@/agent/runAgent.ts");
const { readTranscriptLines, isEventLine } = await import("@/session/transcript.ts");
const { getStatePath } = await import("@/session/store.ts");

after(() => { fs.rmSync(SANDBOX, { recursive: true, force: true }); });

/** 把某 session 的 state.json 伪装成目录（readStore → EISDIR → 非 ENOENT/SyntaxError → 透传抛错）。
 *  路径经 getStatePath 现算（工作区分桶布局不硬编码）。失败发生在任何推理之前——零网络零成本。 */
const corruptStore = (sid: string): void => {
    fs.mkdirSync(getStatePath(sid), { recursive: true });
};

const drain = async (gen: AsyncGenerator<any>): Promise<any[]> => {
    const out: any[] = [];
    for await (const e of gen) out.push(e);
    return out;
};

const baseOptions = (sid: string, over: Record<string, any> = {}): any => ({
    sessionId: sid,
    toolSchemas: [],
    events: async () => { },
    modelWindow: 100000,
    keepRecentUnits: 5,
    compactRatio: 0.72,
    parentSystemPrompt: "",
    depth: 0,
    ...over,
});

const eventLines = async (sid: string): Promise<any[]> =>
    (await readTranscriptLines(sid) as any[]).filter((l: any) => isEventLine(l));

describe("P1-D setup 段防护", () => {
    it("setup 异常：run.start 先落盘 + final 必发（初始化失败）+ run.end stopReason=error", async () => {
        const sid = `p1d-${Date.now()}-a`;
        corruptStore(sid);
        const events = await drain(runAgent(
            [{ role: "system", content: "S" }, { role: "user", content: "hi" }] as any,
            baseOptions(sid),
        ));
        // ① final 必发（修复前：异常冲出 generator，final 永不出现——消费侧 for-await 直接 throw）
        const final = events.find((e) => e?.type === "final");
        assert.ok(final, "final 必发（busy 必清）");
        assert.match(String(final.text), /初始化失败/);
        // ② run.start 先于 setup 失败落盘（trace 不断链——排障能看到本次 run 存在过）
        const starts = (await eventLines(sid)).filter((l) => l.dscEvent === "run.start");
        assert.equal(starts.length, 1, "run.start 恰一条（setup 异常不缺记）");
        // ③ finally 收尾照常 → run.end 带结构化 stopReason（异常收尾取证语义）
        const ends = (await eventLines(sid)).filter((l) => l.dscEvent === "run.end");
        assert.equal(ends.length, 1, "run.end 恰一条");
        assert.equal(ends[0].stopReason, "error");
    });

    it("setup 期间已中止：安静收尾（已中止），不发错误文案", async () => {
        const sid = `p1d-${Date.now()}-b`;
        corruptStore(sid);
        const ac = new AbortController();
        ac.abort();
        const events = await drain(runAgent(
            [{ role: "system", content: "S" }, { role: "user", content: "hi" }] as any,
            baseOptions(sid, { abortSignal: ac.signal }),
        ));
        const final = events.find((e) => e?.type === "final");
        assert.ok(final, "中止路径 final 也必发");
        assert.match(String(final.text), /已中止/);
        assert.doesNotMatch(String(final.text), /初始化失败/, "不污染错误文案");
        const ends = (await eventLines(sid)).filter((l) => l.dscEvent === "run.end");
        assert.equal(ends[0]?.stopReason, "aborted");
    });
});
