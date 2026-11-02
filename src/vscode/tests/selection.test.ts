/**
 * @file vscode/tests/selection.test.ts
 * @description 选区注入（selection.ts）回归：构建/反解 round-trip、截断、形状校验。
 *  运行：cd src/vscode && node --import tsx --test tests/selection.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelectionBlock,
  appendSelectionBlock,
  parseSelectionBlock,
  parseInboundSelection,
  selectionRefLabel,
  clipSelectionText,
  MAX_SELECTION_CHARS,
} from "../src/selection.ts";

const SEL = { path: "d:\\code\\自研\\llm-learning\\04c-fenci.py", startLine: 22, endLine: 23, text: "]\n]" };

test("round-trip：拼接后反解还原原文与选区", () => {
  const wire = appendSelectionBlock("这个词怎么切的？", SEL);
  assert.ok(wire.includes("<ide_selection>"));
  const parsed = parseSelectionBlock(wire);
  assert.ok(parsed);
  assert.equal(parsed.text, "这个词怎么切的？");
  assert.deepEqual(parsed.sel, SEL);
});

test("round-trip：原文尾部空白被掐，标签块独立成段", () => {
  const wire = appendSelectionBlock("看看这段  \n\n", SEL);
  const parsed = parseSelectionBlock(wire);
  assert.ok(parsed);
  assert.equal(parsed.text, "看看这段");
  assert.ok(wire.includes("看看这段\n\n<ide_selection>"));
});

test("头行锚定：选区原文含冒号+换行（python 代码）不误切", () => {
  const sel = { path: "d:\\code\\x.py", startLine: 1, endLine: 2, text: "def f():\n    return {'a': 1}\n" };
  const parsed = parseSelectionBlock(appendSelectionBlock("问", sel));
  assert.ok(parsed);
  assert.deepEqual(parsed.sel, sel);
});

test("反解：普通消息/残缺标签返回 null", () => {
  assert.equal(parseSelectionBlock("普通消息"), null);
  assert.equal(parseSelectionBlock("前文 <ide_selection>没头行</ide_selection>"), null);
  assert.equal(parseSelectionBlock(buildSelectionBlock(SEL).replace("The user selected", "改坏的头行")), null);
});

test("截断：超限取前缀并标注，round-trip 仍闭合", () => {
  const big = "x".repeat(MAX_SELECTION_CHARS + 100);
  const clipped = clipSelectionText(big);
  assert.equal(clipped.length, MAX_SELECTION_CHARS + "\n…(truncated)".length);
  assert.ok(clipped.endsWith("…(truncated)"));
  const sel = { path: "p.py", startLine: 1, endLine: 2, text: big };
  const parsed = parseSelectionBlock(appendSelectionBlock("问", sel));
  assert.ok(parsed);
  assert.equal(parsed.sel.text, clipped);
});

test("label：basename 兼容双分隔符 + 行段", () => {
  assert.equal(selectionRefLabel(SEL), "04c-fenci.py#L22-23");
  assert.equal(selectionRefLabel({ path: "/home/u/a/b.ts", startLine: 1, endLine: 1, text: "x" }), "b.ts#L1-1");
});

test("入站校验：形状不符/空文本/行号非法一律 null", () => {
  assert.equal(parseInboundSelection(null), null);
  assert.equal(parseInboundSelection("str"), null);
  assert.equal(parseInboundSelection({ path: "", startLine: 1, endLine: 1, text: "x" }), null);
  assert.equal(parseInboundSelection({ path: "a.py", startLine: 3, endLine: 2, text: "x" }), null);
  assert.equal(parseInboundSelection({ path: "a.py", startLine: 1, endLine: 2, text: "   \n  " }), null);
  assert.deepEqual(parseInboundSelection({ path: "a.py", startLine: "2", endLine: 3.7, text: "x" }), {
    path: "a.py",
    startLine: 2,
    endLine: 3,
    text: "x",
  });
});
