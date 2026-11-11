/**
 * @file cli/tests/batch-light-accept.test.ts
 * @description 轻量验收接线（2026-11-11「建个 txt 也等 20 分钟编译」）守门测试。
 *
 *  语义三钉：
 *  ① 豁免只认机器换上的验收（acceptAdapted——跨仓适配 swap 产物）；票面/配置显式写的验收永不豁免。
 *  ② 判定以实际 diff 为准（验收前 pre-numstat vs baseSha）——agent 跑偏动了代码就照常全量编译。
 *  ③ 迟滞复测只对真跑的验收生效（轻量放行 code=0 恒真，天然不进复测）。
 *  另钉：报告侧 skipped 渲染诚实（「未执行」而非伪装 exit 0）、文案双语言、分类器跨包共用（core 单侧边界测试在
 *  core/tests/batch-noncode-diff.test.ts，此处只钉接线）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { buildReport } = await import("../src/batchRunner.ts");
const { batchT } = await import("../src/batchStrings.ts");
const { isNonCodeDiff } = await import("@/batch/sync/accept.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fs.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");

// ============ 装配面锚点（源码扫描，CRLF 无关） ============

test("装配：豁免门=acceptAdapted 且判定用验收前 pre-numstat（实际 diff，不信票面文本）", () => {
    const gateIdx = RUNNER_SRC.indexOf("if (acceptAdapted) {");
    assert.ok(gateIdx > 0, "acceptAdapted 豁免门存在");
    const gateBody = RUNNER_SRC.slice(gateIdx, gateIdx + 1200);
    // 门在收尾提交前跑：agent 新建文件还是 untracked，裸 diff 看不见（028v 真机实锤：空清单误判
    // 「无改动」门关死照跑编译）——必须先 add -A 再 --cached numstat（harvestDiff 同口径）
    const addIdx = gateBody.indexOf('gitSimple(["add", "-A"], wt.path)');
    assert.ok(addIdx > 0, "门内先 add -A（新文件只有 staged 后才进 numstat）");
    assert.ok(addIdx < gateBody.indexOf('"diff", "--cached", "--numstat"'), "add -A 必须先于 numstat（顺序锚）");
    assert.ok(gateBody.includes('"diff", "--cached", "--numstat", wt.baseSha'), "判定读 staged diff vs baseSha（与收尾报告 981 同口径）");
    assert.ok(gateBody.includes("isNonCodeDiff(changedPaths)"), "判定走 core isNonCodeDiff（单一事实源）");
    assert.ok(gateBody.includes("acceptSkipped = true"), "命中即置轻量标志");
    // 票面显式 accept 的路径（else 分支）必须原样真跑
    assert.match(RUNNER_SRC.slice(gateIdx, gateIdx + 1200), /\} else \{\s*\r?\n\s*r = await runAcceptCommand\(t\.accept, wt\.path\);/, "非适配票原样真跑（永不豁免）");
});

test("装配：迟滞复测被轻量标志短路；skipped 落进报告 accept 对象", () => {
    assert.ok(RUNNER_SRC.includes("if (!acceptSkipped && ((r.code ?? 1) !== 0 || r.timedOut))"), "复测门带 !acceptSkipped");
    assert.ok(RUNNER_SRC.includes("skipped: acceptSkipped || undefined"), "skipped 进 accept（报告渲染的数据源）");
});

// ============ 报告渲染：诚实展示 ============

test("报告：skipped 验收渲染「未执行（轻量验收）」而非伪装 exit 0；普通验收渲染不变", async () => {
    const base = {
        id: "t1", ticket: { title: "x", accept: "npm run typecheck", body: "正文", source: "feishu" as const, sourceId: "feishu:ou_x:y" }, budgetTruncated: false,
        cost: { rounds: 1, mainRounds: 1, subRuns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costYuan: 0, toolCostYuan: 0, auxCostYuan: 0, partialPrice: false, durationMs: 1000 },
        receipt: undefined, finalText: "",
        deniedTools: [] as { tool: string; detail: string }[], diff: "（无）", wt: null,
        accept: { cmd: "mvn -q -DskipTests compile", code: 0, output: "ok", timedOut: false },
    };
    const light = buildReport({
        ...base, status: "passed",
        accept: { cmd: "mvn -q -DskipTests compile", code: 0, output: "", timedOut: false, skipped: true },
    });
    assert.match(light, /未执行（轻量验收：实际改动仅含非代码文件/);
    assert.doesNotMatch(light, /→ exit 0/, "轻量行不得出现假 exit");
    assert.doesNotMatch(light, /输出尾部/, "轻量行不挂输出块（无输出可挂）");

    const normal = buildReport({ ...base, status: "passed" });
    assert.match(normal, /命令：`mvn -q -DskipTests compile` → exit 0/);
    assert.match(normal, /输出尾部/);
});

// ============ 文案双语言 ============

test("文案：acceptSkippedLine / acceptLightLine 双语言齐备且嵌命令/明示跑偏兜底", () => {
    for (const locale of ["zh", "en"] as const) {
        const T = batchT(locale);
        const line = T.acceptSkippedLine("mvn -q -DskipTests compile");
        assert.ok(line.includes("mvn -q -DskipTests compile"), `${locale} skipped 行缺命令`);
        assert.ok(locale === "zh" ? line.includes("未执行") : /not run/i.test(line), `${locale} skipped 行必须诚实说未执行`);
        assert.ok(locale === "zh" ? T.acceptLightLine.includes("照常全量验收") : /full check still runs/i.test(T.acceptLightLine), `${locale} 轻量行要带跑偏兜底说明`);
    }
});

// ============ 分类器接线（跨包同源） ============

test("runner 侧与 core 分类器同源：txt 真、java 假、空假", () => {
    assert.equal(isNonCodeDiff(["a.txt"]), true);
    assert.equal(isNonCodeDiff(["a.java"]), false);
    assert.equal(isNonCodeDiff([]), false);
});
