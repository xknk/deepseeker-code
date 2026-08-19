/**
 * @file tests/edit-file.test.ts
 * @description edit_file 多级容错匹配的缩进对齐回归（applyOneEditToContent 直驱，纯内存不落盘）。
 *  核心保证：全空白归一路径（模型前导缩进已证明与文件不符）下，new_str 不再保留模型的错误相对缩进，
 *  而是逐行锚定【文件真实缩进】（真实场景：批量编辑第 4 条把 2tab 字段行写成 4tab，写入后错位）。
 *  对照：行尾空白归一路径（前导缩进与文件一致、可信）仍走 reindentToBase 保相对层级。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyOneEditToContent } from "@/tool/registry/fs.ts";

/** trace 实例的最小化复刻：api 1tab、字段行 2tab 的文件片段 */
const FILE = [
    "function submit() {",
    "\tapi.uploadPaymentPlan({",
    "\t\tname: uploadForm.name,",
    "\t\tmonth: uploadForm.month,",
    "\t\tremark: uploadForm.remark,",
    "\t});",
    "}",
].join("\n");

describe("applyOneEditToContent — 全空白归一路径：逐行锚定文件真实缩进", () => {
    it("trace 实例：模型把字段行写成 4tab + 插入新行 → 全部对齐文件 2tab", () => {
        // 模型 old_str/new_str 的字段行整体多缩了两层（4tab），并在 name 后插入 templateType
        const oldStr = "\tapi.uploadPaymentPlan({\n\t\t\t\tname: uploadForm.name,\n\t\t\t\tmonth: uploadForm.month,";
        const newStr = "\tapi.uploadPaymentPlan({\n\t\t\t\tname: uploadForm.name,\n\t\t\t\ttemplateType: uploadForm.templateType,\n\t\t\t\tmonth: uploadForm.month,";
        const r = applyOneEditToContent(FILE, oldStr, newStr, false);
        assert.ok(r.ok, `应命中全空白容错：${r.ok ? "" : r.error}`);
        const lines = r.content.split("\n");
        assert.equal(lines[2], "\t\tname: uploadForm.name,", "锚定行采用文件 2tab");
        assert.equal(lines[3], "\t\ttemplateType: uploadForm.templateType,", "插入行沿用上一锚点 2tab");
        assert.equal(lines[4], "\t\tmonth: uploadForm.month,", "锚定行采用文件 2tab");
        assert.ok(!r.content.includes("\t\t\t\t"), "不应残留模型的 4tab");
        assert.equal(lines[1], "\tapi.uploadPaymentPlan({", "首行锚定文件 1tab");
    });

    it("new_str 顶格（丢全部缩进）→ 仍按文件逐行对齐，不顶格写入", () => {
        const oldStr = "\t\t\tname: uploadForm.name,\n\t\t\tmonth: uploadForm.month,"; // 模型写成 3tab（文件实际 2tab）
        const newStr = "name: uploadForm.name,\nmonth: uploadForm.month,";
        const r = applyOneEditToContent(FILE, oldStr, newStr, false);
        assert.ok(r.ok);
        assert.ok(r.content.includes("\t\tname: uploadForm.name,"), "顶格行被锚回 2tab");
        assert.ok(r.content.includes("\t\tmonth: uploadForm.month,"), "顶格行被锚回 2tab");
    });

    it("零锚点（new_str 与 old_str 无公共行）→ 回退 reindentToBase 基线对齐", () => {
        const oldStr = "\t\t\tname: uploadForm.name,\n\t\t\tmonth: uploadForm.month,"; // 3tab 逼进全空白归一
        const newStr = "replaced line X\n    replaced line Y";
        const r = applyOneEditToContent(FILE, oldStr, newStr, false);
        assert.ok(r.ok);
        const seg = r.content.split("\n").slice(2, 4);
        assert.equal(seg[0], "\t\treplaced line X", "回退：按命中块首非空行基线 2tab 对齐");
        assert.equal(seg[1], "\t\t    replaced line Y", "回退：相对层级保留（4 空格增量不动）");
    });
});

describe("applyOneEditToContent — 行尾空白归一路径：前导缩进可信，保相对层级", () => {
    it("old_str 仅行尾多空格 → 命中行尾容错；new_str 相对缩进原样保留（不走锚定）", () => {
        const oldStr = "\t\tname: uploadForm.name,   \n\t\tmonth: uploadForm.month,"; // name 行尾多 3 空格
        const newStr = "\t\tname: uploadForm.name,\n\t\t\textra: 1,";                 // 模型故意加深一行
        const r = applyOneEditToContent(FILE, oldStr, newStr, false);
        assert.ok(r.ok);
        const lines = r.content.split("\n");
        assert.equal(lines[2], "\t\tname: uploadForm.name,");
        assert.equal(lines[3], "\t\t\textra: 1,", "相对层级可信：3tab 原样保留（非锚定回 2tab）");
    });
});
