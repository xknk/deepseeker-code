/**
 * @file cli/tests/batch-watchdog.test.ts
 * @description batch 看门狗（进展感知，.ai-docs/Batch看门狗进展感知方案.md §10）守门测试。
 *
 *  计时敏感用例全部走可注入假时钟（opts.now）+ 手动 tick 驱动，禁真 sleep——全量并发下
 *  计时敏感用例会 flake（.ai-docs/后续路线.md 次生效应备忘）。调度器注入 no-op（生产缺省
 *  setInterval，测试不依赖它）。AUX 二层裁决注入 mock，不打真 API。
 *
 *  runner 装配面（retry 循环 / 开关关 / 状态分支）按 kernel-audit 既有风格做宿主源码扫描——
 *  runOneTask 全链路 E2E 需真 LLM + 真 worktree，不在单测射程。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 判定层已上收 core（agent/stallDetector.ts，影子方案 §4）：本文件只测政策层（BatchWatchdog 公开 API），
// 判定面（StallEvaluation/R1-R6 求值）守门在 core/tests/stall-detector.test.ts。
const { BatchWatchdog, parseVerdictJson, buildRetryTaskContent, sharedBudgetYuan, RETRY_MAX } = await import("../src/batchWatchdog.ts");
const { parseNumstatNet, extractTargetPaths } = await import("@/agent/stallDetector.ts"); // 与 batchWatchdog 内部同 specifier（防 tsx 双实例）
const { batchT } = await import("../src/batchStrings.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fs.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");

const MIN = 60_000;

// ============ 测试具构：假时钟 + no-op 调度器 + mock 二层 ============

interface Harness {
    wd: InstanceType<typeof BatchWatchdog>;
    nowMs: () => number;
    advance: (min: number) => void;
    auxCalls: string[];
    setAuxReply: (r: string | Error) => void;
    nudges: string[];
    kills: { msg: string; verdict: string }[];
    net: { value: number; newFiles: string[] };
}

/** 标准事件形状：R1 强信号（同参 edit_file ×3 跨 2 轮）在当前假时刻喂入。 */
const feedR1 = (h: Harness, args: any = { path: "src/a.ts", old_str: "x", new_str: "y" }): void => {
    h.wd.feed({ type: "round.start", round: 1 });
    h.wd.feed({ type: "tool.start", toolCallId: "c1", toolName: "edit_file", args });
    h.wd.feed({ type: "tool.start", toolCallId: "c2", toolName: "edit_file", args });
    h.wd.feed({ type: "round.start", round: 2 });
    h.wd.feed({ type: "tool.start", toolCallId: "c3", toolName: "edit_file", args });
};

const makeWatchdog = (over: Partial<ConstructorParameters<typeof BatchWatchdog>[0]> & { ac?: AbortController } = {}): Harness => {
    let cur = 1_000_000_000_000; // 假时钟起点（epoch ms）
    const auxCalls: string[] = [];
    let auxReply: string | Error = JSON.stringify({ verdict: "idle", evidence: "轨迹显示原地打转" });
    const nudges: string[] = [];
    const kills: { msg: string; verdict: string }[] = [];
    const net = { value: 100, newFiles: [] as string[] };
    const ac = over.ac ?? new AbortController();
    const wd = new BatchWatchdog({
        sessionId: "batch-test",
        ticketTitle: "修复日期解析",
        acceptCmd: "npm test",
        targetText: "修复 utils/date.ts 的解析 bug\nnpm test",
        ac,
        worktreePath: "D:/nonexistent-worktree",
        budgetYuan: 1,
        getCost: async () => ({ costYuan: 0.01, rounds: 3 }),
        onNudge: (text) => nudges.push(text),
        onKill: (err, info) => kills.push({ msg: err.message, verdict: info.verdict }),
        auxAdjudicate: async (prompt) => {
            auxCalls.push(prompt);
            if (auxReply instanceof Error) throw auxReply;
            return auxReply;
        },
        sampleDiff: async () => ({ net: net.value, newFiles: net.newFiles }),
        now: () => cur,
        schedule: () => () => {}, // no-op：测试手动驱动 tick，不依赖真 interval
        ...over,
    } as ConstructorParameters<typeof BatchWatchdog>[0]);
    wd.start();
    return {
        wd,
        nowMs: () => cur,
        advance: (min: number) => { cur += min * MIN; },
        auxCalls,
        setAuxReply: (r) => { auxReply = r; },
        nudges,
        kills,
        net,
    };
};

// ============ R1 重复（强信号，单独触发二层） ============

test("R1 重复：同 tool+args ×3 跨轮 → 嫌疑置位、二层被调、nudge-1 下发", async () => {
    const h = makeWatchdog();
    h.advance(6); // 过起步宽限
    feedR1(h);   // 先推进再喂：feed 刷新 lastEventAt，R3 断流不抢跑
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 1, "强信号应触发且仅触发一次二层");
    assert.match(h.auxCalls[0], /R1/);
    assert.match(h.auxCalls[0], /修复日期解析/);
    assert.equal(h.nudges.length, 1);
    assert.match(h.nudges[0], /⚠️/);
    assert.match(h.nudges[0], /换思路/);
    assert.equal(h.kills.length, 0);
});

// ============ R2 只读空转（弱信号：单独命中不动作） ============

test("R2 弱信号单独命中：只记录不动作（不触发二层）", async () => {
    const h = makeWatchdog();
    h.advance(6);
    // 同目录同形 read_file ×4（sig 归一后同形）→ R2 命中，但无强信号
    for (const [id, off] of [["r1", 1], ["r2", 5], ["r3", 9], ["r4", 13]] as const) {
        h.wd.feed({ type: "tool.start", toolCallId: id, toolName: "read_file", args: { path: "src/a.ts", offset: off, limit: 50 } });
    }
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 0, "弱信号不得单独触发二层");
    assert.equal(h.nudges.length, 0);
    const snap = h.wd.snapshot();
    assert.ok(snap.records.some((r) => r.kind === "suspicion"), "弱信号应留嫌疑记录");
});

test("R2 防误伤：只读但 args 持续变化（不同目录/搜索词）→ 不触发", async () => {
    const h = makeWatchdog();
    h.advance(6);
    const reads = [
        { path: "src/utils/date.ts" },
        { path: "src/http/client.ts" },
        { pattern: "parseDate", path: "src" },
        { pattern: "strftime", path: "docs" },
    ];
    reads.forEach((args, i) => h.wd.feed({ type: "tool.start", toolCallId: `r${i}`, toolName: i < 2 ? "read_file" : "search_grep", args }));
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 0);
    const snap = h.wd.snapshot();
    assert.ok(!snap.records.some((r) => r.kind === "suspicion" && (r.text ?? "").includes("R2")), "args 在变=正当调研，不算相似度高");
});

// ============ R3 断流（唯一直杀，不经 nudge） ============

test("R3 断流直杀：零事件 5 分钟 → onKill 被调、不 nudge、错误消息带 watchdog: 前缀", async () => {
    const h = makeWatchdog();
    h.advance(6); // 过起步宽限且距构造时 lastEventAt ≥5 分钟
    await h.wd.tick();
    assert.equal(h.kills.length, 1);
    assert.equal(h.kills[0].verdict, "stall");
    assert.match(h.kills[0].msg, /^watchdog: stall/);
    assert.equal(h.nudges.length, 0, "断流不经 nudge（卡死场景喊话听不见）");
    assert.equal(h.wd.getKill()?.rule, "R3");
});

// ============ R5 写入方向偏差（弱信号，进二层证据；提取不到→关闭） ============

test("R5 方向偏差：edit 全落目标集合外 → R5 证据进二层 prompt", async () => {
    const h = makeWatchdog();
    h.advance(6);
    feedR1(h, { path: "src/other/unrelated.js", old_str: "a", new_str: "b" }); // R1 强信号同触发
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 1);
    assert.match(h.auxCalls[0], /R5/);
    assert.match(h.auxCalls[0], /src\/other\/unrelated\.js/);
});

test("R5 提取不到目标路径 → 整条关闭（缺省保守）", async () => {
    assert.equal(extractTargetPaths("修复日期解析的边界 bug，跑 npm test 确认").size, 0);
    const h = makeWatchdog({ targetText: "修复日期解析的边界 bug，跑 npm test 确认" });
    h.advance(6);
    feedR1(h, { path: "src/whatever.js", old_str: "a", new_str: "b" });
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 1, "R1 仍触发二层");
    assert.doesNotMatch(h.auxCalls[0], /R5/, "但 prompt 不含 R5 证据");
});

// ============ R6 净进展停滞（强信号）+ 健康短路 ============

/** 心跳事件：只刷新 lastEventAt（R3 不抢跑），不产生工具/轮次记录。 */
const beat = (h: Harness): void => h.wd.feed({ type: "text.delta", text: "…" });

test("R6 净进展停滞：diff 两窗口 ±3 内 + edit 调用 >0 → 二层被调", async () => {
    const h = makeWatchdog();
    h.advance(6); beat(h);
    await h.wd.tick(); // 采样 #1（净 100）
    h.advance(1); beat(h);
    await h.wd.tick(); // 采样 #2（净 100）
    h.wd.feed({ type: "tool.start", toolCallId: "e1", toolName: "edit_file", args: { path: "src/a.ts" } }); // 窗口内有 edit
    h.advance(1); beat(h);
    await h.wd.tick(); // 采样 #3 → 连续 2 窗口 ±3 内 + 同期 edit >0 → R6
    assert.equal(h.auxCalls.length, 1);
    assert.match(h.auxCalls[0], /R6/);
    assert.match(h.auxCalls[0], /100→100→100/);
});

test("健康短路：diff 增长 >20 行 → 直接 normal、二层未被调", async () => {
    const h = makeWatchdog();
    h.advance(6); beat(h);
    await h.wd.tick(); // 采样 #1（净 100）
    h.net.value = 200; // 窗口净增 100 行
    h.advance(1); beat(h);
    await h.wd.tick(); // 采样 #2 → 健康短路
    assert.equal(h.auxCalls.length, 0, "健康信号短路省掉二层调用");
    const snap = h.wd.snapshot();
    assert.ok(snap.records.some((r) => r.kind === "health"));
});

test("健康短路：新文件出现 → 直接 normal、二层未被调", async () => {
    const h = makeWatchdog();
    h.advance(6); beat(h);
    await h.wd.tick();
    h.net.newFiles = ["src/new-module.ts"];
    h.advance(1); beat(h);
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 0);
    assert.ok(h.wd.snapshot().records.some((r) => r.kind === "health"));
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

    const h = makeWatchdog();
    h.wd.feed({ type: "tool.start", toolCallId: "e1", toolName: "edit_file", args: { path: "src/a.ts" } });
    h.advance(6); beat(h);
    await h.wd.tick(); // 基线后仅 1 个采样窗口 → 序列不足 3
    assert.equal(h.auxCalls.length, 0, "基线取 setup 完成后首读，两窗口未满不触发");
    assert.equal(h.kills.length, 0, "并非 R3 抢跑（事件流活跃）");
});

// ============ 三级动作序列（nudge-1 → nudge-2+冻结 → abort；nudge 上限 2） ============

test("三级动作：1 次非 normal→nudge-1；2 次→nudge-2+冻结；3 次→abort；nudge 全程 ≤2", async () => {
    const h = makeWatchdog();
    // 第 1 次
    h.advance(6);
    feedR1(h);
    await h.wd.tick();
    assert.equal(h.nudges.length, 1);
    assert.match(h.nudges[0], /⚠️/);
    // nudge 后宽限期内不再判定
    h.advance(2);
    feedR1(h);
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 1, "nudge 后 5 分钟内不再次判定");
    // 第 2 次（宽限已过）
    h.advance(4);
    feedR1(h);
    await h.wd.tick();
    assert.equal(h.nudges.length, 2);
    assert.match(h.nudges[1], /⛔/);
    assert.match(h.nudges[1], /收尾/);
    // 收尾冻结窗口内：嫌疑只记录，不动作
    h.advance(2);
    feedR1(h);
    await h.wd.tick();
    assert.equal(h.kills.length, 0, "冻结窗口防收尾中被杀");
    assert.equal(h.auxCalls.length, 2, "冻结期跳过二层调用");
    // 冻结过期后第 3 次非 normal → abort
    h.advance(6);
    feedR1(h);
    await h.wd.tick();
    assert.equal(h.kills.length, 1);
    assert.equal(h.kills[0].verdict, "idle");
    assert.match(h.kills[0].msg, /^watchdog: idle/);
    assert.equal(h.nudges.length, 2, "nudge 上限 2");
});

test("连续语义：normal 裁决清零 streak，阶梯重走", async () => {
    const h = makeWatchdog();
    h.advance(6);
    feedR1(h);
    await h.wd.tick(); // streak 1 → nudge-1
    assert.equal(h.nudges.length, 1);
    h.advance(6);
    feedR1(h);
    h.setAuxReply(JSON.stringify({ verdict: "normal", evidence: "正在写新模块" }));
    await h.wd.tick(); // normal → streak 清零
    h.advance(6);
    feedR1(h);
    h.setAuxReply(JSON.stringify({ verdict: "idle", evidence: "又空转了" }));
    await h.wd.tick(); // streak 1（非 2）→ 仍是 nudge-1
    assert.equal(h.nudges.length, 2);
    assert.match(h.nudges[1], /⚠️/, "normal 后阶梯重走，第二次非 normal 仍是纠偏而非通牒");
    assert.equal(h.kills.length, 0);
});

// ============ 软着陆归途（runner 装配面：源码扫描钉分支序） ============

test("软着陆归途：runner 无 watchdog 终止时照常跑 accept（status ≠ watchdog-killed）", () => {
    assert.match(RUNNER_SRC, /if \(wdKill\) \{[\s\S]*?status = "watchdog-killed"/, "wdKill 分支在前");
    assert.match(RUNNER_SRC, /软着陆归途[\s\S]*?runAcceptCommand\(t\.accept, wt\.path\)/, "非终止轮走正常验收判定");
    // 终止分支不落 accept：watchdog-killed 与 timeout/error 同结构 break 出去，accept 仅在 else 路径
    const wdBranch = /if \(wdKill\) \{[\s\S]*?\n        \}/.exec(RUNNER_SRC)?.[0] ?? "";
    assert.ok(wdBranch.length > 0 && !wdBranch.includes("runAcceptCommand(t.accept"), "watchdog-killed 分支不跑 accept（改动不完整，跑了也是噪声）");
});

// ============ 带证据重试（§6.1） ============

test("带证据重试：二轮 task 前置证据段（verdict+evidence+finalText 摘要+换思路锚）", () => {
    const content = buildRetryTaskContent(
        "原始任务正文",
        { verdict: "idle", rule: "R1", evidence: "近 10 分钟 edit_file 同参数调用 3 次" },
        "已完成解析器主体；卡在时区边界用例；建议改用 dayjs。",
    );
    assert.match(content, /watchdog 终止/);
    assert.match(content, /idle/);
    assert.match(content, /同参数调用 3 次/);
    assert.match(content, /dayjs/, "上轮 finalText 摘要注入");
    assert.match(content, /勿重复上次路径/, "强制换思路锚");
    assert.match(content, /原始任务正文\s*$/, "原任务正文在后");
});

test("重试预算跨轮累计共享：传剩余预算；不限预算原样透传；耗尽→0", () => {
    assert.equal(sharedBudgetYuan(0.5, 0.3), 0.2);
    assert.equal(sharedBudgetYuan(undefined, 5), undefined);
    assert.equal(sharedBudgetYuan(0.5, 0.6), 0);
    assert.equal(sharedBudgetYuan(1, null), 1);
});

test("retry 装配（源码扫描）：同 worktree 续跑（循环内不再建树）、预算累计、证据链跨轮聚合", () => {
    assert.match(RUNNER_SRC, /const maxRounds = 1 \+ Math\.min\(Math\.max\(0, Math\.floor\(t\.retry \?\? 0\)\), RETRY_MAX\)/, "retry 默认 0 → 单轮（杀即终态）");
    assert.match(RUNNER_SRC, /content = buildRetryTaskContent\(t\.body, wdKill, finalText\)/, "二轮注入上轮证据");
    assert.match(RUNNER_SRC, /roundBudget = nextBudget/, "budget-yuan 跨轮累计共享");
    assert.match(RUNNER_SRC, /if \(round === 1 && t\.setup\)/, "setup 仅首轮（重试轮同 worktree，环境已在）");
    assert.match(RUNNER_SRC, /wdSnapshots\.push\(wd\.snapshot\(\)\)/, "证据链跨轮累计进报告");
    // 重试轮循环体内不得出现 createWorktree（同 worktree 续跑是硬约定）
    const loopStart = RUNNER_SRC.indexOf("for (let round = 1");
    const cleanupAt = RUNNER_SRC.indexOf("killBackgroundTasksUnder(wt.path)", loopStart);
    assert.ok(loopStart > 0 && cleanupAt > loopStart);
    assert.ok(!RUNNER_SRC.slice(loopStart, cleanupAt).includes("createWorktree"), "重试不建新 worktree");
    assert.ok(RETRY_MAX === 3);
});

// ============ 宽限期 ============

test("宽限期：起步 5 分钟内 R1 命中也不判定", async () => {
    const h = makeWatchdog();
    feedR1(h); // 事件在 t0 喂入（同批事件留待宽限后判定）
    h.advance(4); beat(h); // beat 只为压住 R3 断流时钟；宽限检查仍拦在判定之前
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 0, "起步读码阶段天然无产出，不判定");
    assert.equal(h.nudges.length, 0);
    h.advance(2);
    await h.wd.tick();
    assert.equal(h.auxCalls.length, 1, "宽限过后同批事件仍可判定");
});

// ============ 二层故障安全（watchdog 自身故障不得变成误杀器） ============

test("二层故障安全：AUX 抛异常/返回非法 JSON → 降级 normal、任务继续", async () => {
    for (const bad of [new Error("网络炸了"), "这不是 JSON", JSON.stringify({ verdict: "乱码" }), ""] as const) {
        const h = makeWatchdog();
        h.advance(6);
        feedR1(h);
        h.setAuxReply(bad as any);
        await h.wd.tick();
        assert.equal(h.nudges.length, 0, `故障输入 ${String(bad).slice(0, 12)} 不得触发 nudge`);
        assert.equal(h.kills.length, 0, "更不得触发 kill");
        assert.ok(h.wd.snapshot().records.some((r) => r.kind === "aux-fail"));
    }
});

test("二层输出解析：容忍围栏夹带，严格校验 verdict 枚举", () => {
    assert.deepEqual(parseVerdictJson('```json\n{"verdict":"offtrack","evidence":"写错了模块"}\n```'), { verdict: "offtrack", evidence: "写错了模块" });
    assert.deepEqual(parseVerdictJson('前言 {"verdict":"normal","evidence":"x"} 后记'), { verdict: "normal", evidence: "x" });
    assert.equal(parseVerdictJson('{"verdict":"WARP"}'), null);
    assert.equal(parseVerdictJson("没有 json"), null);
});

// ============ 开关关：DEEP_SEEK_BATCH_WATCHDOG=0 → 行为与现状一致（源码扫描钉死） ============

test("开关关：env=0 时不装配看门狗，全部触点可选链化（零看门狗路径与现状逐字节一致）", () => {
    assert.match(RUNNER_SRC, /watchdogEnabled = process\.env\.DEEP_SEEK_BATCH_WATCHDOG !== "0"/);
    assert.match(RUNNER_SRC, /const wd = watchdogEnabled \? new BatchWatchdog\(/);
    // wd 的全部方法触点必须可选链（watchdog 关闭时完全旁路）；`if (wd) wd…` 形式的显式判空等同可选链
    const stripped = RUNNER_SRC.replace(/if \(wd\)\s*wdSnapshots\.push\(wd\.snapshot\(\)\);?/g, "");
    const bare = /[^?.\w]wd\.\w/.exec(stripped);
    assert.equal(bare?.[0], undefined, `发现未可选链的 wd 触点：${bare?.[0]}`);
    assert.doesNotMatch(RUNNER_SRC, /DEEP_SEEK_BATCH_WATCHDOG[^&\n]*=== "0"/, "开关语义：仅 \"0\" 关闭，其余值（含未设）均开启");
});

// ============ 状态与报告 ============

test("状态标签：watchdog-killed 两语言可渲染不崩", () => {
    assert.match(batchT("zh").statusLabel("watchdog-killed"), /看门狗/);
    assert.match(batchT("en").statusLabel("watchdog-killed"), /watchdog/i);
});

test("报告：watchdog-killed 含 watchdog 段且不跑验收；无看门狗任务的报告零新增段", async () => {
    const { buildReport } = await import("../src/batchRunner.ts");
    const T = batchT("zh");
    const base = {
        id: "t1", ticket: { title: "x", accept: "npm test", body: "正文" }, budgetTruncated: false,
        cost: { rounds: 3, mainRounds: 3, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0.02, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 60_000 },
        receipt: undefined, finalText: "",
        deniedTools: [] as { tool: string; detail: string }[], diff: "（无）", wt: null,
    };
    const killed = buildReport({
        ...base, status: "watchdog-killed", accept: null, errorMessage: "watchdog: idle — 空转",
        watchdogLines: [T.wdKillRec("idle", "近 10 分钟 edit_file 同参数调用 3 次"), T.wdNudgeRec(2, "⛔ …"), T.wdAtKillRec(7, "0.0200"), T.wdRetryRec(1)],
    });
    assert.match(killed, /status: watchdog-killed/);
    assert.match(killed, /## 看门狗（进展感知）/);
    assert.match(killed, /⛔ 终止：idle/);
    assert.match(killed, /带证据重试：共 2 轮/);
    assert.match(killed, /未执行验收/, "被杀不跑 accept");
    const plain = buildReport({ ...base, status: "passed", accept: { cmd: "npm test", code: 0, output: "ok", timedOut: false } });
    assert.doesNotMatch(plain, /看门狗/, "无看门狗参与的报告与现状一致（零新增段）");
});

// ============ 暂停豁免（setup/accept 执行期 PAUSED，断流不误杀） ============

test("暂停豁免：PAUSED 期间断流不判定；解除后宽限与断流时钟重置", async () => {
    const h = makeWatchdog();
    h.wd.setPaused(true); // setup 执行期
    h.advance(10);
    await h.wd.tick();
    assert.equal(h.kills.length, 0, "豁免期静默不计入断流");
    h.wd.setPaused(false); // setup 完成
    h.advance(3);
    await h.wd.tick();
    assert.equal(h.kills.length, 0, "解除后起步宽限重置");
    h.advance(6);
    await h.wd.tick();
    assert.equal(h.kills.length, 1, "豁免结束后断流时钟从解除时刻起算");
});
