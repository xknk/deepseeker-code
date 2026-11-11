/**
 * @file cli/tests/batch-budget.test.ts
 * @description 多入口工单流水线 P1-M6：总量硬闸（--max-total-yuan / maxTicketsPerDay）CLI 侧守门测试。
 *
 *  覆盖：batch run 参数解析 fail-closed（--max-total-yuan 数值校验 / 未知 flag / 缺值）/ 双语文案
 *  （runUsage/runBadFlag/budgetStop/usage 块）/ 装配面源码扫描——花费检查在每票开始【前】
 *  （peekNextTicket 窥视不取走，票留在 pending/）、main 在 key 校验前拒绝坏参数。
 *  sync 侧上限逻辑在 core/tests/batch-sync-cap.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { parseBatchArgv } = await import("../src/batchAdmin.ts");
const { batchT } = await import("../src/batchStrings.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fs.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");
const MAIN_SRC = fs.readFileSync(path.join(CLI_ROOT, "src", "main.tsx"), "utf-8");

// ============ batch run 参数解析（fail-closed） ============

test("parseBatchArgv：run 解析 --wait-window / --max-total-yuan / 无参", () => {
    assert.deepEqual(parseBatchArgv(["batch", "run"]), { sub: "run", waitWindow: undefined, maxTotalYuan: undefined, unknownFlag: undefined });
    assert.deepEqual(
        parseBatchArgv(["batch", "run", "--wait-window", "23:30-06:30"]),
        { sub: "run", waitWindow: "23:30-06:30", maxTotalYuan: undefined, unknownFlag: undefined },
    );
    assert.deepEqual(
        parseBatchArgv(["batch", "run", "--max-total-yuan", "1.5"]),
        { sub: "run", waitWindow: undefined, maxTotalYuan: 1.5, unknownFlag: undefined },
    );
    assert.deepEqual(
        parseBatchArgv(["batch", "run", "--wait-window", "23:30-06:30", "--max-total-yuan", "3"]),
        { sub: "run", waitWindow: "23:30-06:30", maxTotalYuan: 3, unknownFlag: undefined },
    );
});

test("parseBatchArgv：run 非法值 fail-closed（未知 flag / 缺值 / 负数 / 非数值）", () => {
    const cases: [string[], RegExp][] = [
        [["batch", "run", "--wat"], /--wat/],
        [["batch", "run", "--max-total-yuan"], /缺值/],
        [["batch", "run", "--max-total-yuan", "-1"], /-1/],
        [["batch", "run", "--max-total-yuan", "abc"], /abc/],
        [["batch", "run", "--max-total-yuan", "NaN"], /NaN/],
        [["batch", "run", "--wait-window"], /缺值/],
    ];
    for (const [argv, re] of cases) {
        const r = parseBatchArgv(argv);
        assert.equal(r?.sub, "run");
        assert.ok(r?.sub === "run" && r.unknownFlag && re.test(r.unknownFlag), `应拒收：${argv.join(" ")}`);
    }
});

// ============ 双语文案 ============

test("batchStrings：runUsage / runBadFlag / budgetStop 双语齐备；usage 块含 --max-total-yuan", () => {
    for (const locale of ["zh", "en"] as const) {
        const T = batchT(locale);
        assert.match(T.runUsage, /--max-total-yuan/);
        assert.match(T.runBadFlag("--wat"), /--wat/);
        const stop = T.budgetStop("0.5", "2", "20261104-120000-a1b2");
        assert.match(stop, /0\.5/);
        assert.match(stop, /2/);
        assert.match(stop, /20261104-120000-a1b2/);
        assert.match(T.usage, /--max-total-yuan/, "batch help 总用法块必须列出总量上限");
    }
    assert.match(batchT("zh").budgetStop("0.5", "2", "t1"), /已停在票 `t1` 之前/, "工单文档钉死的措辞");
    assert.match(batchT("en").budgetStop("0.5", "2", "t1"), /stopped before ticket `t1`/);
});

// ============ 装配面源码扫描 ============

test("装配：花费检查在每票开始前（超限停在下一票之前，peek 不取走）", () => {
    // 检查点必须先于 takeNextTicket（取走即开跑——绝不允许跑到 accept 中途才砍）
    const guardIdx = RUNNER_SRC.indexOf("costSum >= opts.maxTotalYuan");
    assert.ok(guardIdx > 0, "总量硬闸检查点存在");
    const takeIdx = RUNNER_SRC.indexOf("await takeNextTicket()");
    assert.ok(takeIdx > guardIdx, "硬闸必须先于 takeNextTicket（超限停在下一票之前）");
    assert.match(RUNNER_SRC, /peekNextTicket\(\)/, "超限时要窥视队首拿「停在谁之前」");
    assert.match(RUNNER_SRC, /emit\(T\.budgetStop\(/, "超限必须产出 budgetStop 文案");
    // 检查点在 runOneTask 之前（结构性保证：超限零 agent 花费）
    const runOneIdx = RUNNER_SRC.indexOf("await runOneTask(");
    assert.ok(runOneIdx > guardIdx, "硬闸必须先于第一处 runOneTask");
});

test("装配：main 在 key 校验前拒绝 run 坏参数；runBatchQueue 收 maxTotalYuan", () => {
    const badFlagIdx = MAIN_SRC.indexOf("batchArgv.unknownFlag");
    assert.ok(badFlagIdx > 0, "main 有 run 未知 flag 拒绝分支");
    const keyIdx = MAIN_SRC.indexOf("process.env.DEEP_SEEK_API_KEY");
    assert.ok(keyIdx > badFlagIdx, "坏参数拒绝必须在 key 校验之前（拼错参数不该要求 API key）");
    assert.match(MAIN_SRC, /maxTotalYuan: batchArgv\.maxTotalYuan/, "runBatchQueue 必须收到总量上限");
    assert.match(RUNNER_SRC, /maxTotalYuan\?: number/, "runBatchQueue opts 声明含 maxTotalYuan");
});
