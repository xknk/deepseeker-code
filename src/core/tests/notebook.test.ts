/**
 * @file tests/notebook.test.ts
 * @description NotebookEdit 纯函数 applyNotebookEdit 单测（tool/registry/notebook.ts）。
 *  覆盖：replace（cell_id/index、source 形式保留、cell_type 转换）、insert（定位/末尾追加）、
 *  delete、错误（未知 id、越界 index、缺 new_source）。execute 的文件 I/O 走端到端。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyNotebookEdit } from "@/tool/registry/notebook.ts";

/** 构造一个最小合法 notebook（含 code+markdown 两 cell，code 带 id）。 */
const mk = (): any => ({
    cells: [
        { cell_type: "code", id: "abc", source: ["print(1)\n", "print(2)"], execution_count: 1, outputs: [], metadata: {} },
        { cell_type: "markdown", source: "# 标题", metadata: {} },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
});

describe("applyNotebookEdit — replace", () => {
    it("按 cell_id 替换 source，保留数组形式", () => {
        const nb = mk();
        applyNotebookEdit(nb, { cell_id: "abc", new_source: "print(9)\nprint(8)", edit_mode: "replace" });
        assert.deepEqual(nb.cells[0].source, ["print(9)\n", "print(8)"]);
    });
    it("原 source 为字符串形式时替换后仍为字符串", () => {
        const nb = mk();
        nb.cells[1].source = "# 旧标题"; // 字符串形式
        applyNotebookEdit(nb, { cell_index: 1, new_source: "# 新标题", edit_mode: "replace" });
        assert.equal(nb.cells[1].source, "# 新标题", "字符串形式保留");
    });
    it("cell_type 转换 code→markdown：清 execution_count/outputs", () => {
        const nb = mk();
        applyNotebookEdit(nb, { cell_id: "abc", new_source: "**说明**", cell_type: "markdown", edit_mode: "replace" });
        assert.equal(nb.cells[0].cell_type, "markdown");
        assert.equal(nb.cells[0].execution_count, undefined);
        assert.equal(nb.cells[0].outputs, undefined);
    });
    it("cell_type 转换 markdown→code：补 execution_count/outputs", () => {
        const nb = mk();
        applyNotebookEdit(nb, { cell_index: 1, new_source: "x=1", cell_type: "code", edit_mode: "replace" });
        assert.equal(nb.cells[1].cell_type, "code");
        assert.equal(nb.cells[1].execution_count, null);
        assert.deepEqual(nb.cells[1].outputs, []);
    });
    it("未知 cell_id → 抛错", () => {
        const nb = mk();
        assert.throws(() => applyNotebookEdit(nb, { cell_id: "nope", new_source: "x", edit_mode: "replace" }), /未找到 cell_id/);
    });
    it("越界 cell_index → 抛错", () => {
        const nb = mk();
        assert.throws(() => applyNotebookEdit(nb, { cell_index: 99, new_source: "x", edit_mode: "replace" }), /replace 需 cell_id 或有效 cell_index/);
    });
});

describe("applyNotebookEdit — insert", () => {
    it("无定位 → 末尾追加（默认 code 类型）", () => {
        const nb = mk();
        applyNotebookEdit(nb, { new_source: "print(3)", edit_mode: "insert" });
        assert.equal(nb.cells.length, 3);
        assert.equal(nb.cells[2].cell_type, "code");
        assert.deepEqual(nb.cells[2].source, ["print(3)"]);
        assert.equal(nb.cells[2].execution_count, null);
        assert.deepEqual(nb.cells[2].outputs, []);
    });
    it("指定 cell_id → 插在目标 cell 之前", () => {
        const nb = mk();
        applyNotebookEdit(nb, { cell_id: "abc", new_source: "# 导入", cell_type: "markdown", edit_mode: "insert" });
        assert.equal(nb.cells.length, 3);
        assert.equal(nb.cells[0].cell_type, "markdown");
        assert.deepEqual(nb.cells[0].source, ["# 导入"]);
        assert.equal(nb.cells[1].id, "abc", "原 abc cell 后移到 index 1");
    });
    it("缺 new_source → 抛错", () => {
        const nb = mk();
        assert.throws(() => applyNotebookEdit(nb, { edit_mode: "insert" } as any), /insert 需 new_source/);
    });
});

describe("applyNotebookEdit — delete", () => {
    it("按 cell_id 删除", () => {
        const nb = mk();
        applyNotebookEdit(nb, { cell_id: "abc", edit_mode: "delete" });
        assert.equal(nb.cells.length, 1);
        assert.equal(nb.cells[0].cell_type, "markdown");
    });
    it("按 cell_index 删除", () => {
        const nb = mk();
        applyNotebookEdit(nb, { cell_index: 1, edit_mode: "delete" });
        assert.equal(nb.cells.length, 1);
        assert.equal(nb.cells[0].id, "abc");
    });
    it("未定位 → 抛错", () => {
        const nb = mk();
        assert.throws(() => applyNotebookEdit(nb, { edit_mode: "delete" } as any), /delete 需 cell_id 或有效 cell_index/);
    });
});
