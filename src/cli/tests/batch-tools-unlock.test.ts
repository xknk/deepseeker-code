/**
 * @file cli/tests/batch-tools-unlock.test.ts
 * @description 工单 tools: 通配解锁 + 同票同工具审批记忆（2026-11-10 b00s 实锤 8 卡）守门测试。
 *
 *  背景：浏览器票只解锁 4 个精确工具名，实际调用还要 snapshot/click/wait_for/resize…——每个
 *  未点名的 MCP 工具每次调用都单独弹飞书审批卡，用户 72 秒手点 8 次 allow。两刀：
 *  ① tools: 条目带尾缀 `*` 按前缀匹配（`mcp__playwright__*` 一条解锁整个 MCP 服务的工具集）；
 *  ② 卡片路径人工 allow/deny 一次即票内终身（cardDecisions 记忆），同工具不再重复弹卡。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { matchUnlockedTool } = await import("../src/batchRunner.ts");
const { batchT } = await import("../src/batchStrings.ts");
const { parseBatchTicket } = await import("@/batch/ticket.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fs.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");

// ============ ① matchUnlockedTool 纯函数 ============

test("通配：尾缀 * 条目按前缀命中整族 MCP 工具", () => {
    const entries = ["mcp__playwright__*"];
    assert.equal(matchUnlockedTool("mcp__playwright__browser_navigate", entries), true);
    assert.equal(matchUnlockedTool("mcp__playwright__browser_click", entries), true);
    assert.equal(matchUnlockedTool("mcp__playwright__browser_wait_for", entries), true);
    assert.equal(matchUnlockedTool("mcp__playwright__browser_resize", entries), true);
});

test("通配：前缀边界不误伤（startsWith 是整段前缀，非子串模糊）", () => {
    const entries = ["mcp__playwright__*"];
    assert.equal(matchUnlockedTool("mcp__playwright_x__browser_click", entries), false); // 前缀到 __ 为止
    assert.equal(matchUnlockedTool("xmcp__playwright__browser_click", entries), false);
    assert.equal(matchUnlockedTool("mcp__playwright", entries), false); // 缺尾段 ≠ 前缀命中
});

test("精确条目语义不变：无 * 按全等匹配（b00s 前的既有行为钉死）", () => {
    assert.equal(matchUnlockedTool("delete_path", ["delete_path"]), true);
    assert.equal(matchUnlockedTool("delete_paths", ["delete_path"]), false); // 精确名不吃前缀
    assert.equal(matchUnlockedTool("delete_path", ["delete_pat"]), false);
    assert.equal(matchUnlockedTool("run_command", ["edit_file"]), false);
});

test("interpreter 伪槽位保持精确语义（供应链闸门逃生门不被通配旁路）", () => {
    assert.equal(matchUnlockedTool("interpreter", ["interpreter"]), true);
    assert.equal(matchUnlockedTool("interpreter", ["mcp__*"]), false); // 不以 mcp__ 开头
    assert.equal(matchUnlockedTool("interpreter", []), false);
});

test("裸 * 解锁一切（tools: '*' = 显式全解锁，文档化行为）", () => {
    assert.equal(matchUnlockedTool("anything", ["*"]), true);
    assert.equal(matchUnlockedTool("run_command", ["*"]), true);
});

test("条目中间的 * 不触发通配（仅尾缀语义）；undefined 名恒 false", () => {
    assert.equal(matchUnlockedTool("plXwright", ["pl*wright"]), false);
    assert.equal(matchUnlockedTool("pl*wright", ["pl*wright"]), true); // 字面自匹配，无害
    assert.equal(matchUnlockedTool(undefined, ["*"]), false); // 无名工具（表裁剪回退路径）不命中任何条目
});

// ============ ② 票面解析透传（解析层不吞 *） ============

test("票面 tools: mcp__playwright__* 原样入册", () => {
    const parsed = parseBatchTicket([
        "---",
        "title: 浏览器任务",
        "accept: test -f x",
        "tools: mcp__playwright__*, delete_path",
        "---",
        "正文",
    ].join("\n"));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ticket.tools, ["mcp__playwright__*", "delete_path"]);
});

// ============ ③ 装配面锚点（源码扫描，CRLF 无关） ============

test("装配：工具表裁剪与审批路由判定都走通配匹配", () => {
    assert.match(RUNNER_SRC, /matchUnlockedTool\(x\?\.function\?\.name,\s*unlocked\)/);
    assert.match(RUNNER_SRC, /allowApproval\.has\(meta\.toolName\)\s*\|\|\s*matchUnlockedTool\(meta\.toolName,\s*unlocked\)/);
    // interpreter 逃生门保持精确匹配（unlocked.has，不走通配）
    assert.match(RUNNER_SRC, /!unlocked\.has\("interpreter"\)/);
});

test("装配：卡片路径先查记忆（allow/deny 两分支）再弹卡，人工决定入册", () => {
    assert.ok(RUNNER_SRC.includes('const cardDecisions = new Map<string, "allow-once" | "deny">()'));
    const rememberIdx = RUNNER_SRC.indexOf("cardDecisions.get(meta.toolName)");
    const cardIdx = RUNNER_SRC.indexOf("await requestCardApproval({");
    const setIdx = RUNNER_SRC.indexOf("cardDecisions.set(meta.toolName, card)");
    assert.ok(rememberIdx > -1, "cardDecisions.get 检查存在");
    assert.ok(cardIdx > -1, "requestCardApproval 调用存在");
    assert.ok(setIdx > -1, "cardDecisions.set 入册存在");
    assert.ok(rememberIdx < cardIdx, "记忆命中检查先于弹卡（不再重复打扰）");
    assert.ok(cardIdx < setIdx, "入册发生在人工决定返回之后");
    assert.match(RUNNER_SRC, /cardRememberedAllow/);
    assert.match(RUNNER_SRC, /cardRememberedDeny/);
});

// ============ ④ 文案双表 ============

test("文案：cardRememberedAllow/Deny 双语言齐备且嵌工具名", () => {
    for (const locale of ["zh", "en"] as const) {
        const T = batchT(locale);
        assert.ok(T.cardRememberedAllow("browser_click").includes("browser_click"), `${locale} allow 文案缺工具名`);
        assert.ok(T.cardRememberedDeny("browser_click").includes("browser_click"), `${locale} deny 文案缺工具名`);
    }
});
