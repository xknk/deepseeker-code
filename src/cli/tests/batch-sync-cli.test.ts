/**
 * @file cli/tests/batch-sync-cli.test.ts
 * @description `batch sync` 命令行入口（batchAdmin.parseBatchArgv）与双语文案守门测试。
 *  runSync 全链路在 core/tests/batch-sync.test.ts（假 gh 注入）；此处只测 argv 解析与文案面。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseBatchArgv } = await import("../src/batchAdmin.ts");
const { batchT } = await import("../src/batchStrings.ts");

test("parseBatchArgv：sync 子命令解析 --source / --dry-run / --check / 无参", () => {
    assert.deepEqual(parseBatchArgv(["batch", "sync"]), { sub: "sync", source: undefined, dryRun: false, check: false, unknownFlag: undefined });
    assert.deepEqual(parseBatchArgv(["batch", "sync", "--dry-run"]), { sub: "sync", source: undefined, dryRun: true, check: false, unknownFlag: undefined });
    assert.deepEqual(parseBatchArgv(["batch", "sync", "--source", "github"]), { sub: "sync", source: "github", dryRun: false, check: false, unknownFlag: undefined });
    assert.deepEqual(parseBatchArgv(["batch", "sync", "--source", "gitlab", "--dry-run"]), { sub: "sync", source: "gitlab", dryRun: true, check: false, unknownFlag: undefined });
    assert.deepEqual(parseBatchArgv(["batch", "sync", "--check"]), { sub: "sync", source: undefined, dryRun: false, check: true, unknownFlag: undefined });
    assert.deepEqual(parseBatchArgv(["batch", "sync", "--check", "--dry-run"]), { sub: "sync", source: undefined, dryRun: true, check: true, unknownFlag: undefined });
    const bad = parseBatchArgv(["batch", "sync", "--wat"]);
    assert.equal(bad?.sub, "sync");
    if (bad?.sub === "sync") assert.equal(bad.unknownFlag, "--wat");
    const badVal = parseBatchArgv(["batch", "sync", "--source", "svn"]);
    assert.equal(badVal?.sub, "sync");
    if (badVal?.sub === "sync") assert.match(badVal.unknownFlag ?? "", /svn/);
});

test("parseBatchArgv：非 batch / 其余子命令不受影响", () => {
    assert.equal(parseBatchArgv(["chat"]), null);
    assert.equal(parseBatchArgv(["batch", "list"])?.sub, "list");
    assert.equal(parseBatchArgv(["batch", "clean"])?.sub, "clean");
    assert.equal(parseBatchArgv(["batch", "nope"])?.sub, "help");
});

test("batchStrings：sync 文案 zh/en 双语齐备（usage 含 sync 子命令说明）", () => {
    const zh = batchT("zh");
    const en = batchT("en");
    assert.match(zh.usage, /sync \[--source github\|gitlab\] \[--dry-run\]/);
    assert.match(en.usage, /sync \[--source github\|gitlab\] \[--dry-run\]/);
    assert.match(zh.syncUsage, /sync\.json/);
    assert.match(en.syncUsage, /sync\.json/);
    assert.match(zh.syncBadFlag("--x"), /未知参数/);
    assert.match(en.syncBadFlag("--x"), /Unknown flag/);
});
