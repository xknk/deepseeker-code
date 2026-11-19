/**
 * @file tests/constraint-guard.test.ts
 * @description P1-B 约束保护位守门（评审修复批 2026-11-19）：「越聊越不听话」根治位的结构性契约。
 *  摘要槽第三段 ⟦DSC:CONSTRAINTS⟧ 与实体索引同构——LLM 经检查点「约束与偏好」段发现约束、
 *  代码侧 union 合并只增不删、压缩改写不触及；立即缓解内置：压缩产物约束段缩水即 splice 回旧行。
 *  钉死：三段解析与向后兼容 / union 保序去重封顶 / 缩水回补 / 迁移种子 / 段透传（mergeSummarySlot）
 *  / 检查点 prompt 对保护位的指引。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 在动态 import 前就位（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-constraint-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const {
    parseSummarySlot, mergeSummarySlot, applyConstraintProtection,
    extractConstraintLines, checkpointPrompt,
} = await import("@/agent/truncate.ts");

const ASSEMBLE = (index: string[], notes: string, constraints: string[] = []): string => {
    const parts = [
        '⟦DSC:ARCHIVE-INDEX⟧ 精确细节可用 recall 工具检索本会话全量历史；以下为归档实体索引（检索关键词线索）：',
        index.join(' | '),
        '⟦DSC:ARCHIVE-NOTES⟧',
        notes,
    ];
    if (constraints.length > 0) parts.push('⟦DSC:CONSTRAINTS⟧', ...constraints);
    return parts.join('\n');
};

describe("P1-B 三段槽解析与向后兼容", () => {
    it("三段全在：index/notes/constraints 各归各位", () => {
        const slot = ASSEMBLE(["a.ts", "b.ts"], "## 目标\n- x", ["- 只接 API", "- 不动布局"]);
        const p = parseSummarySlot(slot);
        assert.deepEqual(p.index, ["a.ts", "b.ts"]);
        assert.equal(p.notes, "## 目标\n- x");
        assert.deepEqual(p.constraints, ["- 只接 API", "- 不动布局"]);
    });

    it("旧双段格式（无 CONSTRAINTS）：constraints=[]，notes 到串尾（零回归）", () => {
        const legacy = ASSEMBLE(["a.ts"], "旧检查点\n- 行");
        const p = parseSummarySlot(legacy);
        assert.deepEqual(p.index, ["a.ts"]);
        assert.equal(p.notes, "旧检查点\n- 行");
        assert.deepEqual(p.constraints, []);
    });

    it("无标记旧格式：整体当叙述（兼容不变）", () => {
        const p = parseSummarySlot("纯文本叙述");
        assert.deepEqual(p.index, []);
        assert.deepEqual(p.constraints, []);
        assert.equal(p.notes, "纯文本叙述");
    });
});

describe("P1-B extractConstraintLines 抽取", () => {
    it("段内行保序抽取；遇下一标题即止；列表符保留", () => {
        const notes = "## 目标\n- 改列表页\n## 约束与偏好\n- 只接 API 和数据层\n- 不要动页面布局\n## 进度\n- [ ] x";
        assert.deepEqual(extractConstraintLines(notes), ["- 只接 API 和数据层", "- 不要动页面布局"]);
    });

    it("(无) 占位与空段 → 空数组（占位不入保护位）", () => {
        assert.deepEqual(extractConstraintLines("## 约束与偏好\n- (无)\n## 进度"), []);
        assert.deepEqual(extractConstraintLines("## 目标\n- x"), []);
        assert.deepEqual(extractConstraintLines("## 约束与偏好\n(无)"), []);
    });
});

describe("P1-B applyConstraintProtection（合成出口）", () => {
    it("立即缓解：新检查点约束缩水 → 旧行 splice 回（自身不缩水），保护位段同步 union", () => {
        const oldNotes = "## 目标\n- 改列表页\n## 约束与偏好\n- 只接 API 和数据层\n- 不要动页面布局\n## 进度\n- [ ] 联调中";
        const oldSlot = ASSEMBLE(["a.ts"], oldNotes);
        // LLM 重写丢了「不要动页面布局」
        const newNotes = "## 目标\n- 改列表页\n## 约束与偏好\n- 只接 API 和数据层\n## 进度\n- [ ] 联调中";
        const out = applyConstraintProtection(oldSlot, ["a.ts"], newNotes);
        const p = parseSummarySlot(out);
        assert.match(p.notes, /不要动页面布局/, "缩水的旧行已补回检查点");
        assert.match(p.notes, /只接 API 和数据层/);
        assert.match(p.notes, /联调中/, "其余叙述不被改动");
        assert.deepEqual(p.constraints, ["- 只接 API 和数据层", "- 不要动页面布局"], "保护位段 = union");
        // 索引段原样回写（无损硬约束不回归）
        assert.deepEqual(p.index, ["a.ts"]);
    });

    it("迁移种子：旧双段存量会话首轮即收编（检查点约束 → 保护位段）", () => {
        const legacy = ASSEMBLE(["a.ts"], "## 目标\n- x\n## 约束与偏好\n- 历史约束甲\n## 进度\n- [ ] y");
        const newNotes = "## 目标\n- x\n## 约束与偏好\n- (无)\n## 进度\n- [ ] y";
        const out = applyConstraintProtection(legacy, ["a.ts"], newNotes);
        const p = parseSummarySlot(out);
        assert.deepEqual(p.constraints, ["- 历史约束甲"], "存量约束进保护位");
        assert.match(p.notes, /历史约束甲/, "新检查点丢段时整段重建");
    });

    it("追加不删：LLM 换措辞 = 保留双形态；同义归一不重复", () => {
        const slot = ASSEMBLE([], "## 约束与偏好\n- 不要动页面布局", ["- 不要动页面布局"]);
        const out = applyConstraintProtection(slot, [], "## 约束与偏好\n- 布局保持原样别动\n- 不要动页面布局\n## 进度");
        const p = parseSummarySlot(out);
        assert.equal(p.constraints.length, 2, "同义键「不要动页面布局」归一，新措辞追加");
        assert.match(p.constraints.join("\n"), /布局保持原样别动/);
    });

    it("无任何约束：保护位段整段省略（槽格式对旧会话零增量）", () => {
        const out = applyConstraintProtection(ASSEMBLE([], "## 目标\n- x"), [], "## 目标\n- x\n## 约束与偏好\n- (无)");
        const p = parseSummarySlot(out);
        assert.deepEqual(p.constraints, []);
        assert.ok(!out.includes("⟦DSC:CONSTRAINTS⟧"), "空段不落槽");
    });

    it("无段重建：插在「## 进度」之前（保持检查点骨架序）", () => {
        const oldSlot = ASSEMBLE([], "## 目标\n- x\n## 约束与偏好\n- 红线一\n## 进度\n- [ ] y");
        const newNotes = "## 目标\n- x\n## 进度\n- [ ] y"; // LLM 丢了整段
        const out = applyConstraintProtection(oldSlot, [], newNotes);
        const notes = parseSummarySlot(out).notes;
        const gi = notes.indexOf("## 目标");
        const ci = notes.indexOf("## 约束与偏好");
        const pi = notes.indexOf("## 进度");
        assert.ok(gi < ci && ci < pi, "重建段位于目标与进度之间");
        assert.match(notes, /红线一/);
    });

    it("封顶保先：约束超 40 条时旧约束优先于新表述（只增不删的上界）", () => {
        const oldCons = Array.from({ length: 40 }, (_, i) => `- 旧约束${String(i).padStart(2, "0")}`);
        const slot = ASSEMBLE([], "## 约束与偏好\n" + oldCons.join("\n"));
        const out = applyConstraintProtection(slot, [], "## 约束与偏好\n- 全新的约束表述\n## 进度");
        const p = parseSummarySlot(out);
        assert.equal(p.constraints.length, 40);
        assert.ok(!p.constraints.some(c => c.includes("全新的约束表述")), "封顶时新表述让位旧约束");
        assert.match(p.constraints[0]!, /旧约束00/);
    });
});

describe("P1-B mergeSummarySlot 保约束段透传", () => {
    it("实体合并时约束段原样保留（索引先行落位与约束解耦）", () => {
        const slot = ASSEMBLE(["a.ts"], "## 目标\n- x", ["- 只接 API"]);
        const merged = mergeSummarySlot(slot, "", ["b.ts"]);
        const p = parseSummarySlot(merged);
        assert.deepEqual(p.index, ["b.ts", "a.ts"]);
        assert.deepEqual(p.constraints, ["- 只接 API"], "约束段不丢不改");
        assert.equal(p.notes, "## 目标\n- x");
    });
});

describe("P1-B 检查点 prompt 对保护位的指引", () => {
    it("prompt 提及 CONSTRAINTS 段为系统维护（LLM 无写权契约钉死）", () => {
        assert.match(checkpointPrompt(true), /CONSTRAINTS/);
        assert.match(checkpointPrompt(true), /无需你输出/);
        assert.match(checkpointPrompt(false), /如实整理本轮可见的用户约束/);
    });
});
