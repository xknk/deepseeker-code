/**
 * @file tests/batch-sync-cap.test.ts
 * @description 多入口工单流水线 P1-M6：sync 侧每日建票上限（maxTicketsPerDay，§5.2.3）守门测试。
 *
 *  覆盖：maxTicketsPerDay 全链路（超限不建票、上限文案只打一次、摘要带 capSuffix）/
 *  计数含当日 state 存量（todayTicketCount）/ 被上限拦下的候选不记 state（明日上限重置自然重进
 *  管线，不丢票）/ dry-run 不查上限（预演零副作用）。
 *  maxTicketsPerDay 的配置校验（正整数、未知键）在 config fail-closed 测试（batch-sync.test.ts）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const state = await import("@/batch/sync/state.ts");
const { runSync } = await import("@/batch/sync/sync.ts");
const queue = await import("@/batch/queue.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-cap-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const writeConfig = async (dir: string, obj: any): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "sync.json"), JSON.stringify(obj), "utf-8");
};

const mkIssue = (n: number, title = `bug ${n}`) => ({
    number: n, title, body: `修复它 ${n}`, url: `https://github.com/o/r/issues/${n}`,
    updatedAt: "2026-11-04T10:00:00Z", author: { login: "alice" },
});

const mkExec = (issues: any[]) => async () => ({ code: 0, stdout: JSON.stringify(issues), stderr: "" });

test("上限全链路：maxTicketsPerDay=1 + 3 新候选 → 建 1 拦 2；上限文案只打一次；摘要带 capSuffix", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), {
            github: { repos: ["o/r"], label: "agent" },
            defaultAccept: "pnpm test",
            maxTicketsPerDay: 1,
        });
        const lines: string[] = [];
        const r = await runSync({ exec: mkExec([mkIssue(1), mkIssue(2), mkIssue(3)]), out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00"), projectRoot: dir });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.capped], [1, 2], "建 1 张、拦 2 张");
        const text = lines.join("\n");
        assert.equal((text.match(/已达上限 1（maxTicketsPerDay）/g) ?? []).length, 1, "「已达上限」提示只打一次（不逐候选刷屏；capSuffix 是另一条独立文案）");
        assert.match(text, /2 个候选未建票/, "摘要 capSuffix 带被拦数量");
        const snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 1);
        // 被上限拦下的候选不记 state：明日上限重置后自然重进管线（不丢票）
        const m = await state.loadSyncState();
        assert.equal(m.has("github:o/r#1"), true);
        assert.equal(m.has("github:o/r#2"), false, "capped 候选无 state 条目");
        assert.equal(m.has("github:o/r#3"), false, "capped 候选无 state 条目");
    });
});

test("计数含当日存量：state 已有 1 张今日 work 票 → maxTicketsPerDay=1 时新候选全被拦", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), {
            github: { repos: ["o/r"], label: "agent" },
            defaultAccept: "pnpm test",
            maxTicketsPerDay: 1,
        });
        await state.appendSyncState({ sourceId: "github:o/r#old", seenAt: new Date("2026-11-04T09:00:00").toISOString(), fingerprint: "f", verdict: "work", ticketId: "t-old" });
        const lines: string[] = [];
        const r = await runSync({ exec: mkExec([mkIssue(9)]), out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00"), projectRoot: dir });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.capped], [0, 1], "存量计入当日上限");
        assert.equal((await queue.snapshotQueue()).pending.length, 0);
        assert.equal((await state.loadSyncState()).has("github:o/r#9"), false);
    });
});

test("昨日存量不计入：昨日 work 票占位，今天仍可建满上限", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), {
            github: { repos: ["o/r"], label: "agent" },
            defaultAccept: "pnpm test",
            maxTicketsPerDay: 1,
        });
        await state.appendSyncState({ sourceId: "github:o/r#yesterday", seenAt: new Date("2026-11-03T09:00:00").toISOString(), fingerprint: "f", verdict: "work", ticketId: "t-y" });
        const r = await runSync({ exec: mkExec([mkIssue(10)]), out: () => { }, now: () => new Date("2026-11-04T12:00:00"), projectRoot: dir });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.capped], [1, 0], "上限按本机日历日重置");
    });
});

test("dry-run 不查上限：超限也如实预演全部候选（零落盘语义不变）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), {
            github: { repos: ["o/r"], label: "agent" },
            defaultAccept: "pnpm test",
            maxTicketsPerDay: 1,
        });
        const lines: string[] = [];
        const r = await runSync({ dryRun: true, exec: mkExec([mkIssue(1), mkIssue(2)]), out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00"), projectRoot: dir });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.capped], [2, 0], "dry-run 全部预演，不触上限");
        assert.doesNotMatch(lines.join("\n"), /已达上限/, "dry-run 不打上限文案");
        assert.equal((await queue.snapshotQueue()).pending.length, 0);
    });
});
