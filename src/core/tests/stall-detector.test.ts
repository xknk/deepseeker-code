/**
 * @file tests/stall-detector.test.ts
 * @description 空转判定层（StallDetector）守门测试：判定面自 cli batch-watchdog 迁移（交互空转
 *  影子方案 §9）——规则级断言保持原文口径，消费面从政策层动作（aux 调用/nudge/kill）换成
 *  StallEvaluation 结构断言（detector 只出「面」不出「动作」，动作归政策层）。
 *
 *  计时敏感用例全走可注入假时钟（opts.now）+ 手动 tick 驱动，禁真 sleep——全量并发下计时敏感
 *  用例会 flake（.ai-docs/后续路线.md 次生效应备忘）。调度器注入 no-op（生产缺省 setInterval，
 *  测试不依赖它）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { StallEvaluation } from "@/agent/stallDetector.ts";

const { StallDetector, parseNumstatNet } = await import("@/agent/stallDetector.ts");

const MIN = 60_000;

// ============ 测试具构：假时钟 + no-op 调度器 + 假 diff 采样 ============

interface Harness {
    det: InstanceType<typeof StallDetector>;
    evals: StallEvaluation[];
    nowMs: () => number;
    advance: (min: number) => void;
    net: { value: number; newFiles: string[] };
}

const makeDetector = (over: Partial<ConstructorParameters<typeof StallDetector>[0]> = {}): Harness => {
    let cur = 1_000_000_000_000; // 假时钟起点（epoch ms）
    const evals: StallEvaluation[] = [];
    const net = { value: 100, newFiles: [] as string[] };
    const det = new StallDetector({
        worktreePath: "D:/nonexistent-worktree",
        targetText: "修复日期解析的边界 bug，跑 npm test 确认", // 无路径线索 → R5 整条关（结构测试只看规则面）
        budgetYuan: 1,
        getCost: async () => ({ costYuan: 0.01, rounds: 3 }),
        sampleDiff: async () => ({ net: net.value, newFiles: net.newFiles }),
        onEvaluation: (e) => { evals.push(e); },
        now: () => cur,
        schedule: () => () => {}, // no-op：测试手动驱动 tick，不依赖真 interval
        ...over,
    });
    det.start();
    return {
        det,
        evals,
        nowMs: () => cur,
        advance: (min: number) => { cur += min * MIN; },
        net,
    };
};

/** 标准事件形状：R1 强信号（同参 edit_file ×3 跨 2 轮）在当前假时刻喂入。 */
const feedR1 = (h: Harness, args: any = { path: "src/a.ts", old_str: "x", new_str: "y" }): void => {
    h.det.feed({ type: "round.start", round: 1 });
    h.det.feed({ type: "tool.start", toolCallId: "c1", toolName: "edit_file", args });
    h.det.feed({ type: "tool.start", toolCallId: "c2", toolName: "edit_file", args });
    h.det.feed({ type: "round.start", round: 2 });
    h.det.feed({ type: "tool.start", toolCallId: "c3", toolName: "edit_file", args });
};

/** 心跳事件：只刷新 lastEventAt（R3 面不触发），不产生工具/轮次记录。 */
const beat = (h: Harness): void => h.det.feed({ type: "text.delta", text: "…" });

// ============ R1 重复（强信号） ============

test("R1 重复：同 tool+args ×3 跨轮 → 强命中 R1，证据子句带窗口/次数/轮数", async () => {
    const h = makeDetector();
    h.advance(6); // 过起步宽限
    feedR1(h);   // 先推进再喂：feed 刷新 lastEventAt，R3 面不抢跑
    await h.det.tick();
    assert.equal(h.evals.length, 1);
    const e = h.evals[0];
    assert.equal(e.skipped, null);
    assert.equal(e.silenceMin, null);
    assert.equal(e.health, null);
    assert.deepEqual(e.strong.map((r) => r.rule), ["R1"]);
    assert.match(e.strong[0].evidence, /近 10 分钟 edit_file 同参数调用 3 次（跨 2 轮）/);
    assert.deepEqual(e.weak, []);
});

// ============ R2 只读空转（弱信号） ============

test("R2 弱信号：strong 为空、weak 仅 R2——弱信号不单独触发动作（政策层职责）", async () => {
    const h = makeDetector();
    h.advance(6);
    // 同目录同形 read_file ×4（sig 归一后同形）→ R2 命中，但无强信号
    for (const [id, off] of [["r1", 1], ["r2", 5], ["r3", 9], ["r4", 13]] as const) {
        h.det.feed({ type: "tool.start", toolCallId: id, toolName: "read_file", args: { path: "src/a.ts", offset: off, limit: 50 } });
    }
    await h.det.tick();
    const e = h.evals[0];
    assert.deepEqual(e.strong, [], "弱信号不得进 strong（不得触发二层）");
    assert.deepEqual(e.weak.map((r) => r.rule), ["R2"]);
    assert.match(e.weak[0].evidence, /近 15 分钟 4 次调用全为只读且同形/);
});

test("R2 防误伤：只读但 args 持续变化（不同目录/搜索词）→ 不命中", async () => {
    const h = makeDetector();
    h.advance(6);
    const reads = [
        { path: "src/utils/date.ts" },
        { path: "src/http/client.ts" },
        { pattern: "parseDate", path: "src" },
        { pattern: "strftime", path: "docs" },
    ];
    reads.forEach((args, i) => h.det.feed({ type: "tool.start", toolCallId: `r${i}`, toolName: i < 2 ? "read_file" : "search_grep", args }));
    await h.det.tick();
    assert.equal(h.evals[0].weak.length, 0, "args 在变=正当调研，不算相似度高");
});

// ============ R6 净进展停滞（强信号）+ 健康短路 ============

test("R6 净进展停滞：diff 两窗口 ±3 内 + edit 调用 >0 → 强命中 R6", async () => {
    const h = makeDetector();
    h.advance(6); beat(h);
    await h.det.tick(); // 采样 #1（净 100）
    h.advance(1); beat(h);
    await h.det.tick(); // 采样 #2（净 100）
    h.det.feed({ type: "tool.start", toolCallId: "e1", toolName: "edit_file", args: { path: "src/a.ts" } }); // 窗口内有 edit
    h.advance(1); beat(h);
    await h.det.tick(); // 采样 #3 → 连续 2 窗口 ±3 内 + 同期 edit >0 → R6
    assert.equal(h.evals.length, 3);
    const e = h.evals[2];
    assert.deepEqual(e.strong.map((r) => r.rule), ["R6"]);
    assert.match(e.strong[0].evidence, /净变更 100→100→100 行（连续 2 窗口 ±3 内）期间 1 次 edit/);
});

test("健康短路（增长面）：diff 增长 >20 行 → health 文案、strong/weak 恒空", async () => {
    const h = makeDetector();
    h.advance(6); beat(h);
    await h.det.tick(); // 采样 #1（净 100）
    h.net.value = 200; // 窗口净增 100 行
    h.advance(1); beat(h);
    await h.det.tick(); // 采样 #2 → 健康短路
    const e = h.evals[1];
    assert.match(e.health ?? "", /净变更增长 \+100 行（> 20）/, "R2/R4 的反证：正在产出的慢任务");
    assert.deepEqual(e.strong, []);
    assert.deepEqual(e.weak, []);
    assert.equal(e.silenceMin, null);
});

test("健康短路（新文件面）：新文件出现 → health 文案", async () => {
    const h = makeDetector();
    h.advance(6); beat(h);
    await h.det.tick();
    h.net.newFiles = ["src/new-module.ts"];
    h.advance(1); beat(h);
    await h.det.tick();
    assert.match(h.evals[1].health ?? "", /新文件出现：src\/new-module\.ts/);
});

test("R6 基线/排除：lockfile 不计入净变更；基线后采样不足两窗口不触发", async () => {
    const numstat = [
        "10\t5\tsrc/a.ts",
        "2\t0\tpackage-lock.json",
        "5\t1\tpnpm-lock.yaml",
        "1\t0\tsub/dir/yarn.lock",
        "-\t-\tassets/logo.png",
        "",
    ].join("\n");
    assert.equal(parseNumstatNet(numstat), 15, "lockfile 与二进制行不计入");
    assert.equal(parseNumstatNet("3\t2\tpackage-lock.json\n"), 0);

    const h = makeDetector();
    h.det.feed({ type: "tool.start", toolCallId: "e1", toolName: "edit_file", args: { path: "src/a.ts" } });
    h.advance(6); beat(h);
    await h.det.tick(); // 基线后仅 1 个采样窗口 → 序列不足 3
    assert.deepEqual(h.evals[0].strong, [], "序列不足 3，R6 不触发");
    assert.equal(h.evals[0].silenceMin, null, "并非断流（事件流活跃）");
});

// ============ 宽限期 ============

test("宽限期：起步 5 分钟内不判定（skipped=grace-start），宽限过后同批事件仍可判定", async () => {
    const h = makeDetector();
    feedR1(h); // 事件在 t0 喂入（同批事件留待宽限后判定）
    h.advance(4); beat(h); // beat 只为压住 R3 断流时钟；宽限检查仍拦在判定之前
    await h.det.tick();
    assert.equal(h.evals.length, 1);
    assert.equal(h.evals[0].skipped, "grace-start", "起步读码阶段天然无产出，不判定");
    assert.deepEqual(h.evals[0].strong, []);
    h.advance(2);
    await h.det.tick();
    assert.equal(h.evals[1].skipped, null);
    assert.deepEqual(h.evals[1].strong.map((r) => r.rule), ["R1"], "宽限过后同批事件仍可判定");
});

// ============ 抑制窗（政策层 setSuppressUntil：batch nudge 宽限 / 影子强命中去重） ============

test("抑制窗：suppressUntil 内 skipped=suppressed 零判定；过期恢复", async () => {
    const h = makeDetector();
    h.advance(6);
    feedR1(h);
    h.det.setSuppressUntil(h.nowMs() + 5 * MIN);
    await h.det.tick();
    assert.equal(h.evals[0].skipped, "suppressed", "抑制窗内不判定（也不采样）");
    assert.deepEqual(h.evals[0].strong, []);
    h.advance(6); // 过抑制窗
    feedR1(h);   // 刷新事件时钟，R3 面不抢跑
    await h.det.tick();
    assert.equal(h.evals[1].skipped, null);
    assert.deepEqual(h.evals[1].strong.map((r) => r.rule), ["R1"], "抑制窗过期恢复判定");
});

// ============ R3 断流面（判定层只出 silenceMin，动作归政策层） ============

test("R3 断流面：零事件 ≥5 分钟 → silenceMin 非 null、strong/weak 恒空", async () => {
    const h = makeDetector();
    h.advance(6); // 过起步宽限且距构造时 lastEventAt ≥5 分钟
    await h.det.tick();
    const e = h.evals[0];
    assert.equal(e.skipped, null);
    assert.ok(e.silenceMin !== null && e.silenceMin >= 5, `silenceMin=${e.silenceMin}`);
    assert.deepEqual(e.strong, []);
    assert.deepEqual(e.weak, []);
    assert.equal(e.health, null);
});

test("R3 反面：事件流活跃（text.delta 心跳）→ silenceMin 恒 null", async () => {
    const h = makeDetector();
    h.advance(6); beat(h);
    await h.det.tick();
    assert.equal(h.evals[0].silenceMin, null);
});

// ============ 暂停豁免（交互审批/提问挂起与 batch setup/accept 同语义） ============

test("PAUSED 豁免：暂停期 tick 零求值零采样；解除后宽限与断流时钟重置", async () => {
    const h = makeDetector();
    h.det.setPaused(true); // setup/审批挂起
    h.advance(10);
    await h.det.tick();
    assert.equal(h.evals.length, 0, "暂停期 tick 直接返回，零求值");
    h.det.setPaused(false); // 解除
    h.advance(3);
    await h.det.tick();
    assert.equal(h.evals[0].skipped, "grace-start", "解除后起步宽限重置");
    h.advance(6);
    await h.det.tick();
    assert.ok(h.evals[1].silenceMin !== null, "豁免结束后断流时钟从解除时刻起算");
});

// ============ 结构化输出与生命周期 ============

test("evaluate 结构化输出：StallEvaluation 字段齐备且各面互斥", async () => {
    const h = makeDetector();
    h.advance(6);
    feedR1(h);
    await h.det.tick();
    const e = h.evals[0];
    assert.deepEqual(Object.keys(e).sort(), ["health", "silenceMin", "skipped", "strong", "t", "weak"]);
    assert.equal(typeof e.t, "number");
    assert.ok(Array.isArray(e.strong) && Array.isArray(e.weak));
    for (const r of [...e.strong, ...e.weak]) {
        assert.deepEqual(Object.keys(r).sort(), ["evidence", "rule"]);
    }
    // 各面互斥：silence 面与 health 面产出时 strong+weak 恒空
    const silent = makeDetector();
    silent.advance(6);
    await silent.det.tick();
    assert.ok(silent.evals[0].silenceMin !== null);
    assert.deepEqual(silent.evals[0].strong, []);
    assert.deepEqual(silent.evals[0].weak, []);
    assert.equal(silent.evals[0].health, null);
});

test("stop 后 tick 静默：零求值零采样（run 收尾路径）", async () => {
    const h = makeDetector();
    h.det.stop();
    h.advance(6);
    feedR1(h);
    await h.det.tick();
    assert.equal(h.evals.length, 0);
});
