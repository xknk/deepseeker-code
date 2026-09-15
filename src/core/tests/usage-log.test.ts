/**
 * @file tests/usage-log.test.ts
 * @description 使用日志（observability/usageLog.ts，路线 #6 真实使用数据回路）守门测试：
 *  落盘读回字段保真 / 聚合口径（主子拆分·停止原因·工具合并·token 累加）/ days 过滤与受控实验会话剔除 /
 *  坏行容错 / topTools 稳定排序。runAgent finally 挂钩本身不经单测（replay.test.ts 沙盒已覆盖 run 收尾路径）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（同 inbox.test.ts 惯例）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-usage-log-"));

const { recordUsageRun, readUsageRecords, summarizeUsage, topTools, getUsageLogPath } = await import("@/observability/usageLog.ts");

const baseRec = (over: Partial<Record<string, any>> = {}) => ({
    v: 1 as const,
    ts: new Date().toISOString(),
    sessionId: "sess-a",
    runId: "run-1",
    depth: 0,
    model: "deepseek-chat",
    stopReason: "normal" as const,
    rounds: 3,
    durationMs: 1500,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    cachedTokens: 80,
    tools: { read_file: 2 },
    workspace: "test-ws",
    ...over,
});

test("recordUsageRun 落盘月分片文件 + readUsageRecords 读回字段保真", async () => {
    await recordUsageRun(baseRec());
    const month = new Date().toISOString().slice(0, 7);
    const text = await fs.readFile(getUsageLogPath(month), "utf-8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const onDisk = JSON.parse(lines[0]);
    // workspace 由模块统一盖章（调用方不传）
    assert.equal(typeof onDisk.workspace, "string");
    assert.ok(onDisk.workspace.length > 0);
    assert.equal(onDisk.sessionId, "sess-a");
    assert.equal(onDisk.tools.read_file, 2);
    // 读回：排序/过滤后字段保真
    const records = await readUsageRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].sessionId, "sess-a");
    assert.equal(records[0].rounds, 3);
    assert.equal(records[0].cachedTokens, 80);
});

test("summarizeUsage：主/子拆分、停止原因、工具合并、token 累加、首末时间", () => {
    const s = summarizeUsage([
        baseRec({ rounds: 2, depth: 0, stopReason: "normal", promptTokens: 100, cachedTokens: 90, completionTokens: 10, totalTokens: 110, tools: { read_file: 3, edit_file: 1 }, ts: "2026-09-10T01:00:00.000Z" }),
        baseRec({ rounds: 5, depth: 0, stopReason: "aborted", promptTokens: 200, cachedTokens: 100, completionTokens: 20, totalTokens: 220, tools: { read_file: 1 }, ts: "2026-09-11T02:00:00.000Z" }),
        baseRec({ rounds: 4, depth: 1, stopReason: "normal", promptTokens: 300, cachedTokens: 0, completionTokens: 30, totalTokens: 330, tools: { search_grep: 2 }, ts: "2026-09-12T03:00:00.000Z" }),
        baseRec({ rounds: 1, depth: 0, stopReason: "weird" as any, tools: {}, ts: "2026-09-13T04:00:00.000Z" }),
    ]);
    assert.equal(s.runs, 4);
    assert.equal(s.mainRuns, 3);
    assert.equal(s.subRuns, 1);
    assert.equal(s.mainRounds, 8);   // 2+5+1
    assert.equal(s.rounds, 12);      // 含子 agent 4
    assert.equal(s.stopReasons.normal, 2);
    assert.equal(s.stopReasons.aborted, 1);
    assert.equal(s.stopReasons.error, 0);
    assert.equal(s.tools.read_file, 4);   // 3+1 跨 run 合并
    assert.equal(s.tools.search_grep, 2);
    assert.equal(s.toolCalls, 7);    // 4+1+2+0
    assert.equal(s.promptTokens, 700);   // 100+200+300+100（rec4 继承 baseRec 默认 100）
    assert.equal(s.cachedTokens, 270);   // 90+100+0+80
    assert.equal(s.firstTs, "2026-09-10T01:00:00.000Z");
    assert.equal(s.lastTs, "2026-09-13T04:00:00.000Z");
});

test("readUsageRecords：days 过滤剔除旧记录；selftest-/eval- 受控实验会话剔除", async () => {
    const old = new Date();
    old.setDate(old.getDate() - 40);
    await recordUsageRun(baseRec({ sessionId: "sess-old", ts: old.toISOString() }));
    await recordUsageRun(baseRec({ sessionId: "selftest-abc" }));
    await recordUsageRun(baseRec({ sessionId: "eval-foo-123" }));
    await recordUsageRun(baseRec({ sessionId: "sess-recent" }));
    const all = await readUsageRecords();
    assert.ok(all.some(r => r.sessionId === "sess-old"), "全量读取应含 40 天前记录");
    assert.ok(!all.some(r => r.sessionId.startsWith("selftest-")));
    assert.ok(!all.some(r => r.sessionId.startsWith("eval-")));
    const week = await readUsageRecords(7);
    assert.ok(!week.some(r => r.sessionId === "sess-old"), "7 天窗口应剔除 40 天前记录");
    assert.ok(week.some(r => r.sessionId === "sess-recent"));
    // 升序不变式（展示层 slice(-6) 依赖）
    const tsList = week.map(r => r.ts);
    assert.deepEqual([...tsList].sort(), tsList);
});

test("坏行容错：混入非法 JSON / 缺关键字段的行不影响其余记录读回", async () => {
    const before = (await readUsageRecords()).length;
    const month = new Date().toISOString().slice(0, 7);
    await fs.appendFile(getUsageLogPath(month), "{这不是JSON\n" + JSON.stringify({ v: 1, ts: new Date().toISOString() }) + "\n", "utf-8");
    const records = await readUsageRecords();
    assert.equal(records.length, before); // 两行坏记录（解析失败 / 缺 sessionId）均被跳过，不抛错
});

test("topTools：次数降序 + 同次数字典序稳定 + 截断 topN", () => {
    const out = topTools({ zeta: 2, alpha: 3, beta: 2, gamma: 5, delta: 2 }, 3);
    assert.deepEqual(out, [["gamma", 5], ["alpha", 3], ["beta", 2]]);
});
