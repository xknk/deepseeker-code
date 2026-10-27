/**
 * @file tests/trace-batch.test.ts
 * @description D 批（§4 trace 批量落盘 + payload 截断 + 顺序保证）守门测试，§4.3 验收 7 条全做：
 *  1. 同会话 FIFO：连续 3 事件落盘顺序与调用顺序一致；
 *  2. 阈值自动 flush（50 行）+ flushTraceBuffer 幂等（重复调用不重复写）；
 *  3. payload 超 2000 截断带标记；≤2000 逐字节不变；
 *  4. 落盘失败（trace 目录被文件占位）不影响事件入队与后续调用（旁路不击垮）；
 *  5. 错误即时落盘：tool.failed / llm.error 入队后不等阈值立即可读（黑匣子尾巴）；
 *  6. 判据覆盖而非清单：ok:true 的 tool.execute.end 不触发即时 flush；ok:false 的未列名事件触发；
 *  7. 水位按批累加 == 行字节之和，且每批至多一次清理触发（§4.2-6）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（仓库惯例）。
 *  ★ 用例 4 破坏 trace 目录，必须声明在最后（node:test 按声明序执行）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-trace-batch-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { emitTrace, appendTraceEvent, flushTraceBuffer, traceBatchTestHooks } = await import("@/observability/trace.ts");
const { getTraceStorePath, getTracePath } = await import("@/observability/store.ts");

let sidSeq = 0;
const sid = (): string => `trace-batch-${Date.now()}-${sidSeq++}`;

const mkEvent = (sessionId: string, eventType: string, metadata: any = {}, payload?: any): any => ({
    sessionId, eventType, timestamp: new Date().toISOString(), metadata, ...(payload ? { payload } : {}),
});

/** 读某会话 trace 文件全文（未落盘 / 不存在 → ''）。 */
const readTrace = async (sessionId: string): Promise<string> => {
    try { return await fs.promises.readFile(await getTraceStorePath(sessionId), "utf-8"); }
    catch { return ""; }
};

const parsedEvents = (raw: string): any[] =>
    raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

describe("D 批：trace 批量落盘", () => {
    it("FIFO 顺序：连续 3 事件落盘顺序与调用顺序一致", async () => {
        const s = sid();
        await appendTraceEvent(mkEvent(s, "llm.request"));
        await appendTraceEvent(mkEvent(s, "tool.execute.start"));
        await appendTraceEvent(mkEvent(s, "llm.response"));
        await flushTraceBuffer(s);
        const types = parsedEvents(await readTrace(s)).map((e) => e.eventType);
        assert.deepEqual(types, ["llm.request", "tool.execute.start", "llm.response"], "同会话 FIFO");
    });

    it("阈值自动 flush（50 行）+ flushTraceBuffer 幂等（重复调用不重复写）", async () => {
        const s = sid();
        for (let i = 0; i < 50; i++) await appendTraceEvent(mkEvent(s, "session.start", { i }));
        // 第 50 行入队即自动 flush——未显式 drain 文件里已有 50 行
        const raw = await readTrace(s);
        assert.equal(parsedEvents(raw).length, 50, "攒满 50 行自动落盘");
        // 幂等：单会话 / 全部会话重复 drain 均不重复写
        await flushTraceBuffer(s);
        await flushTraceBuffer();
        await flushTraceBuffer();
        assert.equal(parsedEvents(await readTrace(s)).length, 50, "重复调用不重复写");
        // 空队会话 drain 也不炸
        await flushTraceBuffer(sid());
    });

    it("payload 截断：超 2000 截断带标记；≤2000 逐字节不变", async () => {
        const s = sid();
        await emitTrace({ sessionId: s, eventType: "llm.response", metadata: { depth: 0 }, payload: { output: "x".repeat(5000) } });
        await emitTrace({ sessionId: s, eventType: "llm.request", metadata: { depth: 0 }, payload: { input: "y".repeat(2000), output: "z".repeat(1999) } });
        await flushTraceBuffer(s);
        const evts = parsedEvents(await readTrace(s));
        const big = evts.find((e) => e.eventType === "llm.response");
        assert.equal(big.payload.output, "x".repeat(2000) + "…[trace 截断 3000 字符（共 5000 字符）]",
            "截断保留前 2000 + 显式标记（被截 N / 共 X）");
        const small = evts.find((e) => e.eventType === "llm.request");
        assert.equal(small.payload.input, "y".repeat(2000), "恰 2000 逐字节不变");
        assert.equal(small.payload.output, "z".repeat(1999), "不足 2000 逐字节不变");
    });

    it("错误即时落盘：tool.failed / llm.error 入队后立即可读（不等阈值）", async () => {
        const s = sid();
        await appendTraceEvent(mkEvent(s, "tool.failed", { ok: false }, { output: "boom" }));
        // 不调用 flushTraceBuffer——写完立即读
        let raw = await readTrace(s);
        assert.match(raw, /"tool.failed"/, "tool.failed 即时落盘（黑匣子尾巴）");
        await appendTraceEvent(mkEvent(s, "llm.error", { ok: false }));
        raw = await readTrace(s);
        assert.match(raw, /"llm\.error"/, "llm.error 即时落盘");
    });

    it("判据覆盖而非清单：ok:true 不触发即时 flush，未列名事件带 ok:false 触发", async () => {
        const s = sid();
        await appendTraceEvent(mkEvent(s, "tool.execute.end", { ok: true }));
        assert.equal(await readTrace(s), "", "ok:true 的 tool.execute.end 不触发即时 flush（互斥双事件恒成功）");
        await flushTraceBuffer(s);
        assert.match(await readTrace(s), /"tool\.execute\.end"/, "显式 drain 后可见");
        // 未列名事件类型 + ok:false → 判据（而非事件名清单）触发即时 flush
        const custom = mkEvent(s, "custom.fail" as any, { ok: false });
        await appendTraceEvent(custom);
        assert.match(await readTrace(s), /"custom\.fail"/, "新增失败事件只要带 ok:false 就被判据覆盖，不会漏接");
    });

    it("水位按批累加 == 行字节之和，且每批至多一次清理触发（§4.2-6）", async () => {
        const s = sid();
        // 预热：确保水位已完成首次目录扫描（增量断言才纯净）
        await appendTraceEvent(mkEvent(s, "session.start", { warmup: true }));
        await flushTraceBuffer(s);
        const wmBefore = traceBatchTestHooks.workspaceTraceBytes;
        const cleanupBefore = traceBatchTestHooks.cleanupTriggerCount;
        assert.ok(wmBefore >= 0, "预热后水位已初始化");

        const lines: string[] = [];
        for (let i = 0; i < 3; i++) {
            const ev = mkEvent(s, "session.start", { seq: i });
            lines.push(JSON.stringify(ev) + "\n");
            await appendTraceEvent(ev);
        }
        await flushTraceBuffer(s);
        const delta = traceBatchTestHooks.workspaceTraceBytes - wmBefore;
        const expected = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf-8"), 0);
        assert.equal(delta, expected, "水位增量 == 3 行字节之和（按批一次累加，非逐事件）");
        assert.equal(traceBatchTestHooks.cleanupTriggerCount - cleanupBefore, 1, "每批至多一次清理触发");
    });

    it("落盘失败（trace 目录被文件占位）不影响入队与后续调用（本用例破坏现场，必须最后跑）", async () => {
        const traceDir = getTracePath();
        fs.rmSync(traceDir, { recursive: true, force: true });
        fs.writeFileSync(traceDir, "此路径现在是文件，appendFile/ensureDir 必失败");
        const s = sid();
        // 入队零 IO，必然成功
        await appendTraceEvent(mkEvent(s, "llm.request", { n: 1 }));
        // flush 失败被吞：不抛错、丢弃该批
        await flushTraceBuffer(s);
        // 后续调用照常可用（仍不抛）
        await appendTraceEvent(mkEvent(s, "llm.request", { n: 2 }));
        await flushTraceBuffer(s);
        await flushTraceBuffer();
        assert.ok(true, "全链路无异常冒泡（旁路绝不击垮主链路）");
    });
});
