/**
 * @file tests/batch-admin-p2.test.ts
 * @description P2 batch 管理命令 argv 解析守门：pr（票 id 必填 + 多余参数 fail-closed，无豁免旗标）/
 *  status（零参数 + 多余参数 fail-closed）；同时钉 usage 文案与新命令的存在性。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const { parseBatchArgv } = await import("../src/batchAdmin.ts");
const { batchT } = await import("../src/batchStrings.ts");

/** pr 分支收窄：非 pr 返回 "<not-pr>"（区分「解析失败」与「ticketId 置空」）。 */
const prId = (argv: string[]): string | undefined => {
    const a = parseBatchArgv(argv);
    return a?.sub === "pr" ? a.ticketId : "<not-pr>";
};

test("argv pr：票 id 必填；多余参数 fail-closed（无任何豁免旗标）", () => {
    assert.deepEqual(parseBatchArgv(["batch", "pr", "20261105-120000-abc"]), { sub: "pr", ticketId: "20261105-120000-abc" });
    assert.equal(prId(["batch", "pr"]), undefined, "缺 id → 打用法");
    assert.equal(prId(["batch", "pr", "a", "b"]), undefined, "多余位置参数 → fail-closed");
    assert.equal(prId(["batch", "pr", "--force"]), undefined, "不支持 flag：needs-review 无豁免，--force 之类一律不当参数");
    assert.equal(prId(["batch", "pr", "--dry-run"]), undefined, "外发命令无 dry-run 变体（显式命令=显式审批）");
});

test("argv status：零参数；多余参数 fail-closed；非 batch / 未知子命令不受影响", () => {
    assert.deepEqual(parseBatchArgv(["batch", "status"]), { sub: "status" });
    const bad = parseBatchArgv(["batch", "status", "all"]);
    assert.equal(bad?.sub, "status");
    assert.equal((bad as any)?.extraArg, "all", "多余参数 → 打用法（exitCode 2 在 handler）");
    assert.equal(parseBatchArgv(["run"]), null, "非 batch 命令走正常 TUI");
    assert.deepEqual(parseBatchArgv(["batch", "whatever"]), { sub: "help" }, "未知子命令 → 帮助");
    // 既有子命令不受 P2 改动影响
    assert.deepEqual(parseBatchArgv(["batch", "clean"]), { sub: "clean" });
    assert.deepEqual(parseBatchArgv(["batch", "add", "x.md"]), { sub: "add", files: ["x.md"] });
});

test("batchStrings：pr/status 用法与数字行文案双语齐全（缺键会被 batchT fallback 暴露）", async () => {
    for (const locale of ["zh", "en"] as const) {
        const T = batchT(locale);
        assert.ok(T.prUsage.length > 0 && T.prBadArgs.length > 0);
        assert.ok(T.statusUsage.length > 0 && T.statusBadArgs.length > 0 && T.statusEmpty.length > 0);
        assert.match(T.statusLine(2, 5, 3, 2, "1.2500"), /2/);
        assert.match(T.usage, /pr </, `${locale} usage 含 batch pr`);
        assert.match(T.usage, /status/, `${locale} usage 含 batch status`);
    }
    // runner 侧新文案（续修基座 / 降级 / 账本）存在性
    const src = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/batchRunner.ts"), "utf-8");
    for (const key of ["contBaseNote", "downgradedNote", "ledgerFail", "continuationBaseBranch", "appendLedgerEntry", "isTestPath"]) {
        assert.ok(src.includes(key), `batchRunner 引用 ${key}`);
    }
});
