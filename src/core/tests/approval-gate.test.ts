/**
 * @file tests/approval-gate.test.ts
 * @description approvalGate 单测：审批栅栏既有语义回归。
 *
 *  契约（有意设计，勿「修复」）：
 *   - signal abort 是唯一取消通道（cc 风格：监听中断为主，不靠短超时判拒绝）——
 *     审批挂起刻意无 TTL：单人本地工具，用户走开多久回来都应能补批；
 *   - 正常路径先到先决：用户批准/拒绝先到即返回（Promise 幂等）；
 *   - 跨会话越权审批被拒（ownerCanApprove）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForUserApproval, resolveUserApprovalLock } from "@/tool/approvalGate.ts";

describe("approvalGate 审批栅栏语义", () => {
    it("正常路径先到先决：用户拒绝后立即返回", async () => {
        const p = waitForUserApproval("sess-a", "tool-decide-1");
        // 微任务让挂起先登记，再立即人工拒绝
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(resolveUserApprovalLock("sess-a", "tool-decide-1", "deny"), true);
        assert.equal(await p, "deny");
    });

    it("abort 主通道：signal 中断即 deny", async () => {
        const ac = new AbortController();
        const p = waitForUserApproval("sess-a", "tool-abort-1", ac.signal);
        await Promise.resolve();
        ac.abort();
        assert.equal(await p, "deny");
    });

    it("挂起前 signal 已 aborted：直接拒绝，不挂起", async () => {
        const ac = new AbortController();
        ac.abort();
        assert.equal(await waitForUserApproval("sess-a", "tool-abort-2", ac.signal), "deny");
    });
});

describe("approvalGate 跨会话越权校验", () => {
    it("B 会话不得批准 A 会话挂起的审批", async () => {
        const p = waitForUserApproval("sess-owner", "tool-xsession-1");
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(resolveUserApprovalLock("sess-stranger", "tool-xsession-1", "allow-once"), false);
        // 清理：以属主身份拒绝，让挂起协程落地
        assert.equal(resolveUserApprovalLock("sess-owner", "tool-xsession-1", "deny"), true);
        assert.equal(await p, "deny");
    });
});
