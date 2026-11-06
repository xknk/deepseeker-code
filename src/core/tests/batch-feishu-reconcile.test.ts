/**
 * @file tests/batch-feishu-reconcile.test.ts
 * @description 多入口工单流水线 P4：对账兜底（方案 §6——断网重连不丢票）守门测试。
 *
 *  覆盖：游标读写往返与损坏/缺失=首跑语义（60min 回看窗）/ 增量拉取逐条 handle、补建计数 /
 *  游标推进语义（见过即推进——白名单外消息不会造成重拉风暴；拉到更晚消息推到 max，
 *  空窗推进到 endMs）/ 权限缺失 = 游标推进 + 明示降级文案（fail-visible，不对账风暴）/
 *  普通拉取失败 = 游标不动下轮重试 / 私聊登记存储（recordP2pChat 去重幂等、loadP2pChats 往返、
 *  与游标文件互不干扰）。pull/handle 全注入零网络。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { runReconcile, loadCursor, saveCursor, cursorPath, loadP2pChats, recordP2pChat, FIRST_RUN_WINDOW_MS } = await import("@/batch/feishu/reconcile.ts");
const { normalizeMessageEvent } = await import("@/batch/feishu/message.ts");

const withTempBatchDir = async (fn: () => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-rec-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn();
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const NOW = Date.parse("2026-11-05T12:00:00");
const now = (): Date => new Date(NOW);
const candidate = (createTimeMs: string, text = "修复 bug"): any =>
    normalizeMessageEvent({
        message: { message_id: `om_${createTimeMs}`, chat_id: "ou_a", chat_type: "p2p", message_type: "text", create_time: createTimeMs, content: JSON.stringify({ text }) },
        sender: { sender_id: { open_id: "ou_a" } },
    })!;

test("游标：读写往返；缺失/损坏 = null（首跑语义：回看 60 分钟）", async () => {
    await withTempBatchDir(async () => {
        assert.equal(await loadCursor(), null, "无文件 = 无游标");
        await saveCursor("1730800000000", now());
        const c = await loadCursor();
        assert.equal(c?.cursor, "1730800000000");
        assert.equal(c?.updatedAt, now().toISOString());
        await fs.writeFile(cursorPath(), "{broken", "utf-8");
        assert.equal(await loadCursor(), null, "损坏 = 无游标（首跑窗语义，不抛）");
        assert.equal(FIRST_RUN_WINDOW_MS, 60 * 60_000);
    });
});

test("对账：增量拉取逐条 handle——补建计数、跳过计数、游标推到窗口内最大 create_time", async () => {
    await withTempBatchDir(async () => {
        const pulled: string[][] = [];
        const handled: string[] = [];
        const inWindow = (minAgo: number, text?: string): any => candidate(String(NOW - minAgo * 60_000), text);
        const r = await runReconcile({
            pull: async (start, end) => {
                pulled.push([start, end]);
                return { ok: true, messages: [inWindow(10), inWindow(9, "第二个任务"), inWindow(8, "第三个任务")] };
            },
            handle: async (c) => {
                handled.push(c.createTimeMs);
                return { ok: true, action: "created", ticketId: `bt-${c.createTimeMs}` };
            },
            now,
            out: () => { },
        });
        assert.deepEqual(pulled, [[String(NOW - FIRST_RUN_WINDOW_MS), String(NOW)]], "首跑 = [now-60min, now)");
        assert.equal(handled.length, 3);
        assert.deepEqual([r.pulled, r.created, r.skipped], [3, 3, 0]);
        const c = await loadCursor();
        assert.equal(c?.cursor, String(NOW - 8 * 60_000), "游标 = 窗口内最大 create_time");
    });
});

test("对账：已见消息（duplicate/skipped）也推进游标——白名单外消息不会造成重拉风暴；空窗推进到 endMs", async () => {
    await withTempBatchDir(async () => {
        let secondPull = false;
        const r = await runReconcile({
            pull: async () => secondPull
                ? { ok: true, messages: [] }
                : (secondPull = true, { ok: true, messages: [candidate(String(NOW - 10 * 60_000)), candidate(String(NOW - 9 * 60_000))] }),
            handle: async () => ({ ok: true, action: "duplicate" }),
            now,
            out: () => { },
        });
        assert.deepEqual([r.pulled, r.created, r.skipped], [2, 0, 2]);
        assert.equal((await loadCursor())?.cursor, String(NOW - 9 * 60_000), "见过即推进");
        const lines: string[] = [];
        const r2 = await runReconcile({
            pull: async (start) => {
                assert.equal(start, String(NOW - 9 * 60_000), "下轮从游标续拉");
                return { ok: true, messages: [] };
            },
            handle: async () => { throw new Error("空窗不应 handle"); },
            now,
            out: (l) => lines.push(l),
        });
        assert.equal(r2.pulled, 0);
        assert.match(lines.join("\n"), /无新消息/);
        assert.equal((await loadCursor())?.cursor, String(NOW), "空窗推进到 endMs");
    });
});

test("权限缺失：游标推进 + 明示降级文案（fail-visible：断线窗口可能漏票，教人怎么补）", async () => {
    await withTempBatchDir(async () => {
        const lines: string[] = [];
        const r = await runReconcile({
            pull: async () => ({ ok: false, reason: "99991672 permission denied", permissionDenied: true }),
            handle: async () => { throw new Error("拉取失败不应 handle"); },
            now,
            out: (l) => lines.push(l),
        });
        assert.equal(r.ok, true);
        assert.equal(r.degraded, true);
        assert.equal((await loadCursor())?.cursor, String(NOW), "游标推进（不推进会对账风暴）");
        const text = lines.join("\n");
        assert.match(text, /权限/);
        assert.match(text, /补「获取与发送单聊、群组消息」权限/, "给修复指引");
        assert.match(text, /重新 @机器人|手动 batch add/, "给补票指引");
    });
});

test("普通拉取失败：游标不动（下轮重试同窗口）+ 失败日志", async () => {
    await withTempBatchDir(async () => {
        await saveCursor("1730700000000", now());
        const lines: string[] = [];
        const r = await runReconcile({
            pull: async () => ({ ok: false, reason: "ECONNRESET" }),
            handle: async () => { throw new Error("拉取失败不应 handle"); },
            now,
            out: (l) => lines.push(l),
        });
        assert.equal(r.ok, false);
        assert.equal((await loadCursor())?.cursor, "1730700000000", "游标不动");
        assert.match(lines.join("\n"), /ECONNRESET/);
        assert.match(lines.join("\n"), /重试/);
    });
});

test("对账→建票管线串测：handle 走真 handleFeishuMessage——已建票 duplicate 幂等、漏票补建（断网不丢票验收）", async () => {
    await withTempBatchDir(async () => {
        const { handleFeishuMessage } = await import("@/batch/feishu/message.ts");
        const { loadFeishuConfig } = await import("@/batch/feishu/config.ts");
        const { loadSyncConfig } = await import("@/batch/sync/config.ts");
        const queue = await import("@/batch/queue.ts");
        const cfgL = await loadFeishuConfig({ raw: JSON.stringify({ users: ["ou_a"] }) });
        if (!cfgL.ok) throw new Error("cfg");
        const cfg = cfgL.config;
        await fs.writeFile(path.join(process.env.DEEPSEEKER_CODE_BATCH_DIR!, "sync.json"), JSON.stringify({ defaultAccept: "npm test" }), "utf-8");
        const cfgSync = await loadSyncConfig({ raw: JSON.stringify({ defaultAccept: "npm test" }), allowNoSource: true });
        void cfgSync;
        const deps = {
            out: () => { },
            now: () => new Date(NOW),
            queueRoot: process.env.DEEPSEEKER_CODE_BATCH_DIR!,
            projectRoot: await fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-rec-proj-")),
            locale: "zh" as const,
        };
        // 第一轮：实时事件已建过 1 票（handle 直调）
        const first = candidate("1730700100000");
        const c1 = await handleFeishuMessage(first, cfg, deps);
        assert.equal(c1.ok && c1.action, "created");
        // 断线窗口漏了 2 条：对账把 3 条全拉回来——第 1 条 duplicate，第 2/3 条补建
        let pulled = false;
        const r = await runReconcile({
            pull: async () => pulled ? { ok: true, messages: [] } : (pulled = true, { ok: true, messages: [first, candidate("1730700200000", "第二个任务"), candidate("1730700300000", "第三个任务")] }),
            handle: (c) => handleFeishuMessage(c, cfg, deps),
            now,
            out: () => { },
        });
        assert.deepEqual([r.pulled, r.created, r.skipped], [3, 2, 1], "漏票补建、已见去重");
        const snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 3, "断网重连不丢票：共 3 张");
        await fs.rm(deps.projectRoot, { recursive: true, force: true });
    });
});

// ============ 私聊登记存储（复审加固 2026-11-06：白名单私聊纳入对账拉取） ============

test("私聊登记：recordP2pChat 去重幂等 / loadP2pChats 往返 / 损坏文件=空（重学即可）/ 与游标文件互不干扰", async () => {
    await withTempBatchDir(async () => {
        assert.deepEqual(await loadP2pChats(), [], "无文件 = 空登记");
        assert.equal(await recordP2pChat("oc_dm_1"), true, "新登记 = true");
        assert.equal(await recordP2pChat("oc_dm_1"), false, "重复登记 = false（零写入）");
        assert.equal(await recordP2pChat("oc_dm_2"), true);
        assert.deepEqual(await loadP2pChats(), ["oc_dm_1", "oc_dm_2"], "往返一致（保序）");

        await fs.writeFile(path.join(process.env.DEEPSEEKER_CODE_BATCH_DIR!, "feishu-p2p-chats.json"), "{broken", "utf-8");
        assert.deepEqual(await loadP2pChats(), [], "损坏 = 空登记（幂等重学，不炸调用方）");

        // 与游标互不干扰：登记写入不动游标值
        await saveCursor("1730800000000", now());
        await recordP2pChat("oc_dm_3");
        const c = await loadCursor();
        assert.equal(c?.cursor, "1730800000000", "游标值原样");
    });
});
