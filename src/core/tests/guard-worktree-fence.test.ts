/**
 * @file tests/guard-worktree-fence.test.ts
 * @description P0-B worktree 围栏修复守门（评审修复批 2026-11-19）。
 *  根因：VSCode 多根工作区下 allowedRootsReal 非空时 allowedBoundaryRoots() 完全屏蔽活动根，
 *  而 worktree 落在 os.tmpdir()（不在任何注册文件夹内）→ enter_worktree / run_workflow 之后
 *  edit_file/create_file 等写工具必现 SECURITY ALERT（读得到写不进）。
 *  修法：getActiveWorktreeRoot() 精确取源（仅 ALS.workspaceRoot 与 session 注册表两档、
 *  禁止 env/cwd 兜底）∪ 进 allowedBoundaryRoots() 围栏根集。
 *  红线断言：①围栏 fail-closed 方向不弱化（非 worktree 场景 union 是 no-op、越界恒拦）；
 *            ②getActiveWorktreeRoot 永不回退 env/cwd。
 *  ★ 场景一（VSCode 复现）按生产调用序列逐字镜像：extension.ts setAllowedWorkspaceRoots(全部
 *    工作区文件夹) → enter_worktree 写 session 注册表 → chatProcessing 的 runWithSessionContext
 *    外裹 → processToolCall 内 resolveSafePath（edit_file 的路径入口）。
 *  全程真实临时目录，不 mock 文件系统。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
    setAllowedWorkspaceRoots,
    getActiveWorktreeRoot,
    runWithWorkspaceRoot,
    runWithSessionContext,
    resolveSafePath,
    assertWithinWorkspace,
} from "@/tool/guard.ts";
import { setSessionWorktree, clearSessionWorktree } from "@/tool/worktree/sessionRegistry.ts";

// 真实目录：rootA/rootB 模拟 VSCode 两个工作区文件夹；wtRoot 模拟 manager 建的 worktree（tmp 下、不在注册集内）
const mk = (tag: string): { raw: string; real: string } => {
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), `dsc-fence-${tag}-`));
    return { raw, real: fs.realpathSync(raw) };
};
const rootA = mk("wsa");
const rootB = mk("wsb");
const wt = mk("wt");
fs.writeFileSync(path.join(wt.raw, "a.txt"), "hello worktree");
fs.writeFileSync(path.join(rootA.raw, "main.ts"), "x");
fs.writeFileSync(path.join(rootB.raw, "other.ts"), "x");

after(() => {
    for (const d of [rootA, rootB, wt]) fs.rmSync(d.raw, { recursive: true, force: true });
});

describe("getActiveWorktreeRoot — 精确取源（两档安全源、禁 env/cwd 兜底）", () => {
    it("无 ALS store：undefined（绝不回退 env WORKSPACE_ROOT / cwd）", () => {
        assert.equal(getActiveWorktreeRoot(), undefined);
    });

    it("ALS.workspaceRoot 命中（run_workflow 源）", () => {
        const r = runWithWorkspaceRoot(wt.raw, () => getActiveWorktreeRoot());
        assert.equal(r, wt.raw);
    });

    it("session 注册表命中（enter_worktree 源）", () => {
        const sid = "fence-sid-reg";
        setSessionWorktree(sid, { path: wt.raw, branch: "b", baseSha: "x" });
        const r = runWithSessionContext(sid, () => getActiveWorktreeRoot());
        assert.equal(r, wt.raw);
        clearSessionWorktree(sid);
    });

    it("显式 workspaceRoot 优先于 session 注册表（与 getActiveWorkspaceRoot 同序）", () => {
        const sid = "fence-sid-prio";
        setSessionWorktree(sid, { path: rootB.raw, branch: "b", baseSha: "x" });
        const r = runWithSessionContext(sid, () => runWithWorkspaceRoot(wt.raw, () => getActiveWorktreeRoot()));
        assert.equal(r, wt.raw);
        clearSessionWorktree(sid);
    });

    it("session 上下文但未 enter_worktree：undefined（union 退化为 no-op）", () => {
        const sid = "fence-sid-empty";
        clearSessionWorktree(sid);
        const r = runWithSessionContext(sid, () => getActiveWorktreeRoot());
        assert.equal(r, undefined);
    });
});

describe("P0-B 场景一（VSCode 复现）：注册集非空 + session worktree 激活 → 写工具放行", () => {
    it("resolveSafePath 解析 worktree 内相对路径不再 SECURITY ALERT（修复前必抛）", () => {
        const sid = "fence-vscode-sid";
        setAllowedWorkspaceRoots([rootA.raw]); // extension.ts:977 同款：只注册工作区文件夹
        setSessionWorktree(sid, { path: wt.raw, branch: "b", baseSha: "x" }); // enter_worktree 同款
        try {
            const resolved = runWithSessionContext(sid, () => resolveSafePath("a.txt"));
            assert.equal(resolved, path.join(wt.real, "a.txt"));
            // 绝对路径入口（edit_file 容错路径 / assertWithinWorkspace 二次围栏）同样放行
            assert.doesNotThrow(() =>
                runWithSessionContext(sid, () => assertWithinWorkspace(path.join(wt.real, "a.txt"))),
            );
        } finally {
            clearSessionWorktree(sid);
        }
    });

    it("run_workflow 源（ALS.workspaceRoot）同样放行", () => {
        setAllowedWorkspaceRoots([rootA.raw]);
        const resolved = runWithWorkspaceRoot(wt.raw, () => resolveSafePath("a.txt"));
        assert.equal(resolved, path.join(wt.real, "a.txt"));
    });

    it("红线：注册集 + worktree 激活下，逃出【全部】根（注册集与 wt 之外）仍拦", () => {
        const sid = "fence-vscode-esc";
        setAllowedWorkspaceRoots([rootA.raw]);
        setSessionWorktree(sid, { path: wt.raw, branch: "b", baseSha: "x" });
        try {
            // rootB 未注册、也非活动 worktree → 对旧围栏是越界，对新 union 仍是越界
            assert.throws(
                () => runWithSessionContext(sid, () => resolveSafePath(path.join(rootB.real, "other.ts"))),
                /SECURITY/,
            );
            assert.throws(
                () => runWithSessionContext(sid, () => resolveSafePath("../outside.txt")),
                /SECURITY/,
            );
        } finally {
            clearSessionWorktree(sid);
        }
    });
});

describe("union no-op 红线：非 worktree 场景围栏语义与旧实现逐字节一致", () => {
    it("注册集非空、无 worktree：注册根内放行、注册根外恒拦", () => {
        setAllowedWorkspaceRoots([rootA.raw, rootB.raw]);
        // ★ 相对路径按活动根解析（既定语义，注册集只放大绝对路径放行面）——放行断言用绝对路径
        assert.doesNotThrow(() => resolveSafePath(path.join(rootA.real, "main.ts")));
        assert.doesNotThrow(() => resolveSafePath(path.join(rootB.real, "other.ts")));
        assert.throws(() => resolveSafePath(path.join(wt.real, "a.txt")), /SECURITY/);
        assert.throws(() => resolveSafePath("../../escape.txt"), /SECURITY/);
    });

    it("CLI 回归：无注册集 + session worktree 激活 → 围栏锚定 wt（既有行为不破）", () => {
        setAllowedWorkspaceRoots([]);
        const sid = "fence-cli-sid";
        setSessionWorktree(sid, { path: wt.raw, branch: "b", baseSha: "x" });
        try {
            const resolved = runWithSessionContext(sid, () => resolveSafePath("a.txt"));
            assert.equal(resolved, path.join(wt.real, "a.txt"));
            assert.throws(
                () => runWithSessionContext(sid, () => resolveSafePath(path.join(rootA.real, "main.ts"))),
                /SECURITY/,
                "wt 激活时 CLI 围栏仍锚定 wt，注册外的主仓文件不因 union 放行",
            );
        } finally {
            clearSessionWorktree(sid);
        }
    });

    it("恢复全局态：清空注册集（不影响同进程其他用例的默认假设）", () => {
        setAllowedWorkspaceRoots([]);
        assert.equal(getActiveWorktreeRoot(), undefined);
    });
});
