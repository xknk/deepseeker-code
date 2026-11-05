/**
 * @file tests/batch-ledger.test.ts
 * @description P2 挂机账本守门测试：追加 + 滚动窗口汇总 + 损坏行计数 + 零记录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { appendLedgerEntry, ledgerPath, summarizeLedger } = await import("@/batch/ledger.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-ledger-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

test("ledger：append + 滚动窗口汇总（窗口外不入账、损坏行计数、未来 1 分钟容忍）", async () => {
    await withTempBatchDir(async (dir) => {
        const now = new Date("2026-11-05T12:00:00Z");
        const day = 24 * 3600 * 1000;
        await appendLedgerEntry({ at: new Date(now.getTime() - 8 * day).toISOString(), tickets: 1, green: 1, red: 0, costYuan: 0.5 }); // 窗口外
        await appendLedgerEntry({ at: new Date(now.getTime() - 2 * day).toISOString(), tickets: 3, green: 2, red: 1, costYuan: 1.25 });
        await appendLedgerEntry({ at: new Date(now.getTime() - 3600 * 1000).toISOString(), tickets: 2, green: 1, red: 1, costYuan: 0.75 });
        await appendLedgerEntry({ at: new Date(now.getTime() + 30 * 1000).toISOString(), tickets: 1, green: 0, red: 1, costYuan: 0 }); // 未来 30s：容忍
        await appendLedgerEntry({ at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(), tickets: 99, green: 0, red: 0, costYuan: 0 }); // 未来 5min：不算
        await fs.appendFile(ledgerPath(), "{broken json\n", "utf-8");
        await fs.appendFile(ledgerPath(), "\n", "utf-8"); // 空行静默跳过
        const s = await summarizeLedger(now);
        assert.deepEqual([s.runs, s.tickets, s.green, s.red], [3, 6, 3, 3], "窗口 [now-7d, now+1min] 三行入账（+30s 容忍行计入、+5min 与 8d 前不算）");
        assert.ok(Math.abs(s.costYuan - 2.0) < 1e-9, `窗口内合计 1.25+0.75+0，实际 ${s.costYuan}`);
        assert.equal(s.badLines, 1);
        assert.equal(new Date(s.since).getTime(), now.getTime() - 7 * day);
        void dir;
    });
});

test("ledger：lines 注入路径（不读文件）；缺字段当 0", async () => {
    const now = new Date("2026-11-05T12:00:00Z");
    const s = await summarizeLedger(now, 7, [
        JSON.stringify({ at: now.toISOString(), tickets: 1, green: 0, red: 1, costYuan: 0 }),
        JSON.stringify({ at: now.toISOString() }), // 缺字段
        "",
    ]);
    assert.deepEqual([s.runs, s.tickets, s.green, s.red, s.costYuan], [2, 1, 0, 1, 0]);
});

test("ledger：零记录 → 全零汇总（首次 status 不炸）；红绿自洽（green+red 可小于 tickets）", async () => {
    await withTempBatchDir(async () => {
        const s = await summarizeLedger(new Date("2026-11-05T12:00:00Z"));
        assert.deepEqual([s.runs, s.tickets, s.green, s.red, s.costYuan, s.badLines], [0, 0, 0, 0, 0, 0]);
    });
    const s2 = await summarizeLedger(new Date("2026-11-05T12:00:00Z"), 7, [JSON.stringify({ at: "2026-11-05T11:00:00Z", tickets: 4, green: 2, red: 1, costYuan: 0.1 })]);
    assert.deepEqual([s2.tickets, s2.green, s2.red], [4, 2, 1], "red 是「没过」粗粒度，不必等于 tickets-green（还有 reject 等态）");
});
