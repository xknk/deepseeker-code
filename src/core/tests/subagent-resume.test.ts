/**
 * @file tests/subagent-resume.test.ts
 * @description 子 Agent 续跑 + 血缘判定（2026-08-21）回归：
 *  1) lineage 纯函数 —— parentOfSubsession / stringAncestorsOf / ownerCanApprove 基础语义；
 *  2) fork 链 —— state.forkedFrom 让 fork 新会话可管原时间线子 agent（审批归属 / 续跑归属共用）；
 *  3) approvalGate —— 跨会话审批越权仍拒、fork 血缘内放行（修 fork 后子 agent 审批死锁）；
 *  4) runSubagent 续跑前置校验 —— 非 __sub__ 形态 / 不归属 / 转录不存在三连拒（均在驱动 LLM 前返回）。
 *
 *  沙盒惯例：dataDir 指向临时目录；@/ 别名导入与 core 内部同 specifier 同实例（双实例坑见 replay.test.ts）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-sub-resume-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { parentOfSubsession, stringAncestorsOf, ownerCanApprove } = await import("@/session/lineage.ts");
const { writeStore } = await import("@/session/store.ts");
const { waitForUserApproval, resolveUserApprovalLock } = await import("@/tool/approvalGate.ts");
const { runSubagent } = await import("@/agent/subagent.ts");

describe("lineage 纯函数（字符串派生链）", () => {
    it("parentOfSubsession：剥最后一段 __sub__；主形态返回 undefined", () => {
        assert.equal(parentOfSubsession("p1__sub__u1"), "p1");
        assert.equal(parentOfSubsession("p1__sub__u1__sub__u2"), "p1__sub__u1");
        assert.equal(parentOfSubsession("p1"), undefined);
    });

    it("stringAncestorsOf：嵌套链全展开（含自身，最左为根）", () => {
        assert.deepEqual(stringAncestorsOf("p1__sub__u1__sub__u2"), ["p1__sub__u1__sub__u2", "p1__sub__u1", "p1"]);
        assert.deepEqual(stringAncestorsOf("p1"), ["p1"]);
    });

    it("ownerCanApprove 基础语义：自身 ✓ / 直接父 ✓ / 祖父（嵌套子）✓ / 无关会话 ✗ / 主会话条目仅自身 ✓", () => {
        assert.ok(ownerCanApprove("p1__sub__u1", "p1__sub__u1"), "自身");
        assert.ok(ownerCanApprove("p1__sub__u1", "p1"), "直接父");
        assert.ok(ownerCanApprove("p1__sub__u1__sub__u2", "p1"), "祖父可管嵌套孙（旧 startsWith 语义保持）");
        assert.ok(!ownerCanApprove("p1__sub__u1", "p2"), "无关会话拒");
        assert.ok(!ownerCanApprove("p2", "p1"), "主会话形态条目仅自身可管");
    });
});

describe("lineage fork 链（state.forkedFrom 回溯）", () => {
    it("fork 新会话可管原时间线子 agent；无 forkedFrom 则拒", async () => {
        await writeStore("f1", { sessionId: "f1", forkedFrom: "p1" });
        assert.ok(ownerCanApprove("p1__sub__u1", "f1"), "f1 fork 自 p1 → 可管 p1 的子 agent");
        assert.ok(ownerCanApprove("p1__sub__u1__sub__u2", "f1"), "嵌套孙同理（字符串祖先展开）");
        assert.ok(!ownerCanApprove("p2__sub__u1", "f1"), "fork 链外仍拒");
        assert.ok(!ownerCanApprove("p1__sub__u1", "f2"), "无 forkedFrom 的无关会话拒");
    });

    it("多级 fork 链逐级回溯；fork 目标为子会话时其字符串祖先同样并入闭包", async () => {
        await writeStore("g1", { sessionId: "g1", forkedFrom: "f1" }); // g1 ← f1 ← p1
        assert.ok(ownerCanApprove("p1__sub__u1", "g1"), "两级 fork 仍可溯到 p1");
        await writeStore("h1", { sessionId: "h1", forkedFrom: "p1__sub__u1" }); // fork 了子会话本体
        assert.ok(ownerCanApprove("p1__sub__u1__sub__u9", "h1"), "fork 子会话 → 其孙可管");
    });

    it("环链不死循环（c1 ↔ c2，expand 集合守卫终止）", async () => {
        await writeStore("c1", { sessionId: "c1", forkedFrom: "c2" });
        await writeStore("c2", { sessionId: "c2", forkedFrom: "c1" });
        assert.ok(!ownerCanApprove("p1__sub__u1", "c1"), "环链不含 p1 → 拒且不死循环");
    });
});

describe("approvalGate（fork 血缘归属）", () => {
    it("跨会话越权仍拒；fork 会话可批原时间线子 agent 的工具", async () => {
        // 挂起一个 p1 子 agent 的审批
        const pending = waitForUserApproval("p1__sub__u1", "tk-cross-1");
        assert.equal(resolveUserApprovalLock("p2", "tk-cross-1", "allow-once"), false, "无关会话越权拒");
        assert.equal(resolveUserApprovalLock("f1", "tk-cross-1", "allow-once"), true, "f1（fork 自 p1）放行");
        assert.equal(await pending, "allow-once");
    });

    it("未挂起 / 已决的 toolsId 二次 resolve 返回 false", async () => {
        const pending = waitForUserApproval("p1__sub__u2", "tk-cross-2");
        assert.equal(resolveUserApprovalLock("p1", "tk-cross-2", "deny"), true);
        assert.equal(await pending, "deny");
        assert.equal(resolveUserApprovalLock("p1", "tk-cross-2", "allow-once"), false, "已决锁再 resolve 拒");
    });
});

describe("runSubagent 续跑前置校验（LLM 驱动前拒绝，不触达模型）", () => {
    const fakeCtx: any = { sessionId: "p1", depth: 0 };

    it("非 __sub__ 形态的 resumeSessionId → 拒", async () => {
        const res = await runSubagent({ task: "继续", resumeSessionId: "p1" }, fakeCtx, () => []);
        assert.equal(res.ok, false);
        assert.match(res.output, /不是子 Agent 会话 ID/);
    });

    it("不归属（跨会话复活）→ 拒", async () => {
        const res = await runSubagent({ task: "继续", resumeSessionId: "p2__sub__u1" }, fakeCtx, () => []);
        assert.equal(res.ok, false);
        assert.match(res.output, /不属于当前会话/);
    });

    it("归属通过但转录不存在 → 拒（fork 血缘 f1 → p1 同样走到存在性检查）", async () => {
        const direct = await runSubagent({ task: "继续", resumeSessionId: "p1__sub__ghost" }, fakeCtx, () => []);
        assert.equal(direct.ok, false);
        assert.match(direct.output, /转录不存在或为空/);

        const forkCtx: any = { sessionId: "f1", depth: 0 }; // f1 fork 自 p1（上一 describe 已写 state）
        const viaFork = await runSubagent({ task: "继续", resumeSessionId: "p1__sub__ghost" }, forkCtx, () => []);
        assert.equal(viaFork.ok, false);
        assert.match(viaFork.output, /转录不存在或为空/, "fork 会话续跑原时间线子会话：归属过、卡在存在性（而非归属拒）");
    });
});
