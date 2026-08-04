/**
 * @file tests/workflow.test.ts
 * @description P0-3 多 subagent 并行编排（run_workflow）的纯逻辑单测：
 *  1) createSemaphore —— 并发节流上限 / max=1 互斥退化；
 *  2) validateWorkflowArgs —— 空 / 超限 / 空白 task / 合法；
 *  3) stepLabel —— key > name > 任务片段回退与截断；
 *  4) buildPipelineTask —— 上阶段成功 / 失败的上下文拼接；
 *  5) formatWorkflowResult —— parallel（全成功 / 含失败）与 pipeline（最终产出尾）。
 *
 *  不触达 LLM / runAgent：派生内核（runSubagent）与端到端由真实会话冒烟覆盖（同 spawn_agent）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore } from "@/common/index.ts";
import {
    validateWorkflowArgs,
    stepLabel,
    buildPipelineTask,
    formatWorkflowResult,
    type StepOutcome,
} from "@/tool/registry/workflowHelpers.ts";

describe("common/createSemaphore（并发信号量）", () => {
    it("并发数不超过上限，且全部任务完成", async () => {
        const max = 3;
        const sem = createSemaphore(max);
        let active = 0;
        let peak = 0;
        const done: number[] = [];
        await Promise.all(Array.from({ length: 10 }, (_, i) => i).map(async (i) => {
            await sem.acquire();
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 5));
            done.push(i);
            active--;
            sem.release();
        }));
        assert.ok(peak <= max, `peak(${peak}) 应 <= max(${max})`);
        assert.equal(done.length, 10, "全部任务应完成");
    });

    it("max=1 退化为互斥（严格串行，peak=1）", async () => {
        const sem = createSemaphore(1);
        let active = 0;
        let peak = 0;
        await Promise.all([0, 1, 2, 3].map(async () => {
            await sem.acquire();
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 2));
            active--;
            sem.release();
        }));
        assert.equal(peak, 1, "max=1 时任意时刻仅 1 个在飞");
    });

    it("max<1 视为 1（防御）", async () => {
        const sem = createSemaphore(0);
        let active = 0;
        let peak = 0;
        await Promise.all([0, 1].map(async () => {
            await sem.acquire();
            active++;
            peak = Math.max(peak, active);
            await new Promise(r => setTimeout(r, 2));
            active--;
            sem.release();
        }));
        assert.equal(peak, 1);
    });
});

describe("workflow/validateWorkflowArgs（参数校验）", () => {
    const maxSteps = 8;
    it("非数组 / 空 steps → 报错", () => {
        assert.ok(validateWorkflowArgs({}, maxSteps));
        assert.ok(validateWorkflowArgs({ steps: [] }, maxSteps));
        assert.ok(validateWorkflowArgs({ steps: "nope" }, maxSteps));
        assert.ok(validateWorkflowArgs(null, maxSteps));
    });
    it("超过 maxSteps → 报错", () => {
        const steps = Array.from({ length: maxSteps + 1 }, () => ({ task: "x" }));
        const err = validateWorkflowArgs({ steps }, maxSteps);
        assert.ok(err && err.includes("超过上限"));
    });
    it("某步 task 空白 → 报错（带下标）", () => {
        const err = validateWorkflowArgs({ steps: [{ task: "ok" }, { task: "   " }] }, maxSteps);
        assert.ok(err && err.includes("steps[1].task"));
    });
    it("合法（多步、可选字段齐全）→ null", () => {
        const err = validateWorkflowArgs({
            steps: [{ task: "a", name: "x", role: "r", key: "k" }, { task: "b" }],
            mode: "parallel",
        }, maxSteps);
        assert.equal(err, null);
    });
});

describe("workflow/stepLabel（标签回退）", () => {
    it("key 优先于 name / 任务片段", () => {
        assert.equal(stepLabel({ task: "t", name: "n", key: "k" }, 0), "k");
    });
    it("无 key 时用 name", () => {
        assert.equal(stepLabel({ task: "t", name: "reviewer" }, 1), "reviewer");
    });
    it("无 key/name 时用任务片段", () => {
        assert.equal(stepLabel({ task: "审查认证模块" }, 0), "审查认证模块");
    });
    it("超长任务片段截断并加 …", () => {
        const long = "这是一段超过四十二个字符长度的任务描述用来测试截断逻辑的边界情况需要足够长才行哦继续加长";
        const label = stepLabel({ task: long }, 0);
        assert.ok(label.endsWith("…"), `应以 … 结尾，实际: ${label}`);
        assert.ok(label.length <= 43, `截断后应 <=43 字符，实际 ${label.length}`);
    });
    it("空任务 → 回退到 步骤N", () => {
        assert.equal(stepLabel({ task: "" }, 3), "步骤4");
    });
});

describe("workflow/buildPipelineTask（流水线上下文拼接）", () => {
    it("上阶段成功 → 拼入产出 + 本阶段任务", () => {
        const prior: StepOutcome = { ok: true, output: "抽取了 3 个要点", label: "抽取" };
        const task = buildPipelineTask({ task: "按主题归类" }, prior);
        assert.match(task, /【上一阶段产出·抽取】/);
        assert.match(task, /抽取了 3 个要点/);
        assert.match(task, /按主题归类/);
    });
    it("上阶段失败 → 标注失败并透传错误产出", () => {
        const prior: StepOutcome = { ok: false, output: "❌ 超时", label: "抽取" };
        const task = buildPipelineTask({ task: "重试" }, prior);
        assert.match(task, /【上一阶段失败·抽取】/);
        assert.match(task, /含错误/);
        assert.match(task, /❌ 超时/);
    });
});

describe("workflow/formatWorkflowResult（聚合格式化）", () => {
    it("parallel 全成功：标题含全部成功、无 ❌", () => {
        const out = formatWorkflowResult("parallel", [
            { ok: true, output: "r1", label: "A" },
            { ok: true, output: "r2", label: "B" },
        ]);
        assert.match(out, /并行结果/);
        assert.match(out, /全部成功/);
        assert.doesNotMatch(out, /❌/);
        assert.match(out, /\[1\] A/);
        assert.match(out, /\[2\] B/);
    });
    it("parallel 含失败：标题统计失败数、失败项标 ❌", () => {
        const out = formatWorkflowResult("parallel", [
            { ok: true, output: "r1", label: "A" },
            { ok: false, output: "boom", label: "B" },
        ]);
        assert.match(out, /1 个失败/);
        assert.match(out, /\[2\] B ❌/);
    });
    it("pipeline：含阶段标题与最终产出尾", () => {
        const out = formatWorkflowResult("pipeline", [
            { ok: true, output: "阶段一产出", label: "抽取" },
            { ok: true, output: "阶段二产出", label: "总结" },
        ]);
        assert.match(out, /流水线结果/);
        assert.match(out, /阶段 \[1\] 抽取/);
        assert.match(out, /阶段 \[2\] 总结/);
        assert.match(out, /流水线最终产出（阶段 2）/);
        assert.match(out, /阶段二产出/);
    });
    it("空结果 → 兜底文案", () => {
        assert.match(formatWorkflowResult("parallel", []), /无结果/);
    });
});
