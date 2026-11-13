/**
 * @file tests/fork-anchors.test.ts
 * @description listForkAnchors（会话历史 UX ③ 分叉选择器数据源，2026-08-18；2026-11-13 UX 修订）纯函数回归：
 *  锚点 = **每 run 的最后一条 assistant 行**（旧口径每条 assistant 一锚，长 run 渲染成几十条同题重复行）；
 *  事件行/工具行/user 行跳过；纯工具轮末条用工具名序列作预览；
 *  userPreview 取该轮之前最近 user 提问（跨轮保持）；空转录 → 空列表。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒惯例：dataDir 指向临时目录，防模块初始化读真实 ~/.deepseeker-code（config 链无害但保持隔离）。
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-fork-anc-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

// ★ "@/" 别名导入：与 core 内部同 specifier 同实例（双实例坑见 replay.test.ts 头注释）。
const { listForkAnchors, derivePrefix } = await import("@/session/fork.ts");

describe("listForkAnchors（分叉锚点派生）", () => {
    it("多轮 transcript：每 run 只留末条 assistant 锚点（2026-11-13 UX 修订，长 run 不再渲染成同题重复行）", () => {
        const lines: any[] = [
            { id: "u1", role: "user", content: "帮我读 fixture 并汇报" },
            { id: "e1", dscEvent: "run.start", runId: "r1" },
            { id: "a1", role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] },
            { id: "t1", role: "tool", tool_call_id: "c1", content: "文件内容" },
            { id: "e2", dscEvent: "round.end", runId: "r1" },
            { id: "a2", role: "assistant", content: "已完成：文件内容为两行。", reasoning_content: "思考" },
            { id: "e3", dscEvent: "run.end", runId: "r1", stopReason: "normal" },
            { id: "u2", role: "user", content: "再总结一下" },
            { id: "e4", dscEvent: "run.start", runId: "r2" },
            { id: "a3", role: "assistant", content: "总结完毕。" },
        ];
        const anchors = listForkAnchors(lines);
        assert.equal(anchors.length, 2, "两个 run 各一锚（run1 的中间工具轮 a1 不再单独出锚）");
        assert.equal(anchors[0]!.lineId, "a2", "run1 取末条 assistant");
        assert.equal(anchors[0]!.roundNo, 1);
        assert.equal(anchors[0]!.userPreview, "帮我读 fixture 并汇报");
        assert.match(anchors[0]!.assistantPreview, /已完成/, "末条正文预览最有信息量");
        assert.equal(anchors[1]!.lineId, "a3");
        assert.equal(anchors[1]!.roundNo, 2);
        assert.equal(anchors[1]!.userPreview, "再总结一下", "新 run 取新提问");
    });

    it("长 run 全工具轮：末条为纯工具轮时锚点仍产出，预览用工具名序列（不再每轮一行重复）", () => {
        const lines: any[] = [
            { id: "u1", role: "user", content: "跑全量测试" },
            { id: "a1", role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "run_command", arguments: "{}" } }] },
            { id: "t1", role: "tool", tool_call_id: "c1", content: "ok" },
            { id: "a2", role: "assistant", content: null, tool_calls: [{ id: "c2", function: { name: "read_file", arguments: "{}" } }] },
            { id: "t2", role: "tool", tool_call_id: "c2", content: "内容" },
            { id: "a3", role: "assistant", content: null, tool_calls: [{ id: "c3", function: { name: "edit_file", arguments: "{}" } }] },
        ];
        const anchors = listForkAnchors(lines);
        assert.equal(anchors.length, 1, "同 run 三条 assistant 只出一锚");
        assert.equal(anchors[0]!.lineId, "a3", "取末条");
        assert.match(anchors[0]!.assistantPreview, /🔧 edit_file/);
    });

    it("空转录 / 仅事件行 / 仅 user 行 → 空列表（无可分叉检查点）", () => {
        assert.deepEqual(listForkAnchors([]), []);
        // 行对象按宽松 any 构造（TranscriptLine 事件行强类型字段多，测试只关心 role/dscEvent 判别）
        const eventsOnly: any[] = [{ id: "e1", dscEvent: "run.start", runId: "r1" }, { id: "e2", dscEvent: "run.end", runId: "r1" }];
        assert.deepEqual(listForkAnchors(eventsOnly), []);
        const userOnly: any[] = [{ id: "u1", role: "user", content: "q" }];
        assert.deepEqual(listForkAnchors(userOnly), []);
    });

    it("空回复轮（无正文无工具）锚点仍产出，预览 '(空回复)'；user content 非字符串不炸", () => {
        const lines: any[] = [
            { id: "u1", role: "user", content: null },
            { id: "a1", role: "assistant", content: null },
        ];
        const anchors = listForkAnchors(lines);
        assert.equal(anchors.length, 1);
        assert.equal(anchors[0]!.userPreview, "", "非字符串 user content → 空预览");
        assert.equal(anchors[0]!.assistantPreview, "(空回复)");
    });

    it("与 derivePrefix 组合：锚点 lineId 作 upToLineId → 前缀恰含到该 assistant 行", () => {
        // 复用真实派生函数验证锚点语义闭环（upToLineId 含该行；后续 run 的行不进前缀）
        const lines: any[] = [
            { id: "u1", role: "user", content: "q1" },
            { id: "a1", role: "assistant", content: "第一轮答复" },
            { id: "e1", dscEvent: "run.end", runId: "r1" },
            { id: "u2", role: "user", content: "q2" },
            { id: "a2", role: "assistant", content: "第二轮答复" },
            { id: "e2", dscEvent: "run.end", runId: "r2" },
        ];
        const anchors = listForkAnchors(lines);
        const prefix = derivePrefix(lines, anchors[0]!.lineId);
        assert.equal(prefix.lines.length, 2, "前缀恰含 user + 第一个 assistant");
        assert.equal((prefix.lines[1] as any).id, "a1");
    });
});
