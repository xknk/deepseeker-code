/**
 * @file cli/tests/batch-baseline.test.ts
 * @description 多入口工单流水线 P1-M4：runner 基线三态校验装配面（§5.2.1）守门测试。
 *
 *  runOneTask 全链路需真 LLM + 真 worktree，不在单测射程（同 batch-watchdog 范式）：装配面做
 *  宿主源码扫描钉死关键顺序——基线门禁在 agent 阶段之前（基线红零 agent 花费的结构性保证）、
 *  manual 票零改动（t.source !== "manual" 条件）、探测备好环境不重跑 setup、报告列触碰的测试文件。
 *  判定与缓存逻辑（classifyProbe/缓存/键）在 core/tests/batch-sync-accept.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { batchT } = await import("../src/batchStrings.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fs.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");

// ============ 装配面源码扫描 ============

test("装配：基线门禁在 agent 阶段之前（基线红零 agent 花费是结构性保证，不靠纪律）", () => {
    const gateIdx = RUNNER_SRC.indexOf("readBaselineCache(key");
    assert.ok(gateIdx > 0, "基线门禁调用点存在");
    const firstAgentCall = RUNNER_SRC.indexOf("await handleUnifiedChat(");
    assert.ok(firstAgentCall > gateIdx, "readBaselineCache 必须先于第一处 handleUnifiedChat 调用");
    assert.match(RUNNER_SRC, /writeBaselineCache\(key, verdict/, "探测结论必须落缓存（当日同基座免重跑）");
    assert.match(RUNNER_SRC, /classifyProbe\(\{ code: probe\.code/, "探测结果必须归类（ok/baseline-broken/watch-suspect）");
});

test("装配：门禁仅作用于外部源工单（manual 票零改动，不改 batch 既有语义）", () => {
    const gateIdx = RUNNER_SRC.indexOf("let setupDoneByProbe");
    const gateBody = RUNNER_SRC.slice(gateIdx, gateIdx + 600);
    assert.match(gateBody, /t\.source !== "manual"/, "门禁条件必须是 source !== manual");
    assert.match(RUNNER_SRC, /round === 1 && t\.setup && !setupDoneByProbe/, "探测已备好环境时首轮 setup 不重跑");
});

test("装配：探测超时走 watch-suspect 分支（与普通验收失败分开报）；缓存命中非 ok 连 setup 都不装", () => {
    const gateIdx = RUNNER_SRC.indexOf("let setupDoneByProbe");
    const gateBody = RUNNER_SRC.slice(gateIdx, RUNNER_SRC.indexOf("agent 阶段", gateIdx));
    assert.match(gateBody, /verdict !== "ok"/);
    assert.match(gateBody, /status: "baseline-broken"/, "基线红必须以 baseline-broken 终态出报告");
    assert.match(gateBody, /cached\.verdict !== "ok"/);
    assert.match(gateBody, /killBackgroundTasksUnder\(wt\.path\)/, "探测/终止路径必须清理遗留后台进程（watch 残留）");
});

test("报告：触碰的测试文件段 + needs-review 头字段（双语词表齐备）", async () => {
    assert.match(batchT("zh").statusLabel("baseline-broken"), /基线未过/);
    assert.match(batchT("en").statusLabel("baseline-broken"), /baseline broken/i);
    assert.match(batchT("zh").testFilesH, /触碰的测试文件/);
    assert.match(batchT("en").testFilesH, /[Tt]ouched test files/);

    const { buildReport } = await import("../src/batchRunner.ts");
    const base = {
        id: "t1", ticket: { title: "x", accept: "npm test", body: "正文", source: "github" as const, sourceId: "github:o/r#1" }, budgetTruncated: false,
        cost: { rounds: 1, mainRounds: 1, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 1000 },
        receipt: undefined, finalText: "",
        deniedTools: [] as { tool: string; detail: string }[], diff: "（无）", wt: null,
        accept: { cmd: "npm test", code: 0, output: "ok", timedOut: false },
    };
    const withTests = buildReport({ ...base, status: "passed", touchedTestFiles: ["src/core/tests/a.test.ts", "packages/lib/x.spec.ts"] });
    assert.match(withTests, /## 触碰的测试文件（信息标注）/);
    assert.match(withTests, /- `src\/core\/tests\/a\.test\.ts`/);
    assert.match(withTests, /- `packages\/lib\/x\.spec\.ts`/);
    const noTests = buildReport({ ...base, status: "passed" });
    assert.doesNotMatch(noTests, /触碰的测试文件/, "无测试文件改动不渲染该段（零新增噪声）");

    const reviewed = buildReport({ ...base, status: "baseline-broken", accept: null, ticket: { ...base.ticket, needsReview: true } });
    assert.match(reviewed, /^needs-review: true$/m, "needs-review 工单在报告头可见（人工复核不漏）");
    assert.match(reviewed, /status: baseline-broken/);

    const withImgs = buildReport({ ...base, status: "passed", imagesRead: 2 });
    assert.match(withImgs, /图片读取：2 张/, "read_image 统计进报告（§5.2.2 落地要求 6：人要能判断该翻案还是换模型）");
    const noImgs = buildReport({ ...base, status: "passed" });
    assert.match(noImgs, /图片读取：0 张/, "缺省 0 张也可见（0 且票里有图 = 疑似无视觉未读）");
});

test("报告：changed-file 清单固化进 frontmatter（改动清单交接，2026-11-05 打磨第一批）", async () => {
    const { buildReport, numstatToChangedFiles } = await import("../src/batchRunner.ts");
    const base = {
        id: "t1", ticket: { title: "x", accept: "npm test", body: "正文", source: "github" as const, sourceId: "github:o/r#1" }, budgetTruncated: false,
        cost: { rounds: 1, mainRounds: 1, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 1000 },
        receipt: undefined, finalText: "",
        deniedTools: [] as { tool: string; detail: string }[], diff: "（无）", wt: null,
        accept: { cmd: "npm test", code: 0, output: "ok", timedOut: false },
    };
    // numstat 原始输出 → 行：普通 / 二进制 / 改名（git 原样）
    assert.deepEqual(
        numstatToChangedFiles(["12\t3\tsrc/a.ts", "-\t-\tbin.dat", "1\t0\tsrc/{old => new}.ts"].join("\n")),
        ["src/a.ts (+12/-3)", "bin.dat (binary)", "src/{old => new}.ts (+1/-0)"],
    );
    // frontmatter 固化：branch/continues 之后、闭合 --- 之前；无改动不写行
    const fmOf = (report: string): string => {
        const m = /^---\n([\s\S]*?)\n---/.exec(report);
        return m?.[1] ?? "";
    };
    const withChanged = buildReport({ ...base, status: "passed", changedFiles: ["src/a.ts (+12/-3)", "bin.dat (binary)"] });
    const fm1 = fmOf(withChanged);
    assert.match(fm1, /^changed-file: src\/a\.ts \(\+12\/-3\)$/m);
    assert.match(fm1, /^changed-file: bin\.dat \(binary\)$/m);
    assert.ok(fm1.indexOf("changed-file:") > fm1.indexOf("branch:") && fm1.indexOf("changed-file:") < fm1.length, "changed-file 在 branch 之后（frontmatter 内）");
    const none = buildReport({ ...base, status: "passed" });
    assert.doesNotMatch(fmOf(none), /^changed-file:/m, "无改动路径不写行");

    // 封顶 30：超出末尾省略行带余量
    const many = Array.from({ length: 33 }, (_, i) => `f${i}.ts (+1/-0)`);
    const capped = buildReport({ ...base, status: "passed", changedFiles: many });
    const fm2 = fmOf(capped);
    assert.equal((fm2.match(/^changed-file: f\d+\.ts/gm) ?? []).length, 30, "清单封顶 30 条");
    assert.match(fm2, /^changed-file: …（其余 3 个略）$/m, "省略行带余量");
});
