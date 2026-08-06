/**
 * @file tests/guard-als.test.ts
 * @description Phase 1 验证：guard.ts 的 AsyncLocalStorage 化路径解析 + 按 base 多实例 ignore 引擎。
 *  核心断言：无 store 回退 WORKSPACE_ROOT（零回归）；runWithWorkspaceRoot 切换活动根后 resolveSafePath /
 *  assertWithinWorkspace 以该根为围栏（放行内部、拒 .. 越界）；ignore 引擎按 base 各持一份、未初始化 fail-open。
 *
 *  全程用真实临时目录（os.tmpdir）+ 真实 .gitignore 文件断言，不 mock 文件系统。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
    WORKSPACE_ROOT,
    getActiveWorkspaceRoot,
    runWithWorkspaceRoot,
    runWithSessionContext,
    getActiveCwd,
    resolveSafePath,
    assertWithinWorkspace,
    initializeWorkspaceIgnore,
    checkIsPathIgnored,
} from "@/tool/guard.ts";
import {
    setSessionWorktree,
    getSessionWorktree,
    getSessionWorktreeRoot,
    clearSessionWorktree,
    drainAllSessionWorktrees,
} from "@/tool/worktree/sessionRegistry.ts";

// 真实临时工作区：a.txt + sub/(.gitignore 忽略 ignored.log + ignored.log + kept.txt)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-guard-als-"));
fs.writeFileSync(path.join(tmp, "a.txt"), "x");
fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
fs.writeFileSync(path.join(tmp, "sub", ".gitignore"), "ignored.log\n");
fs.writeFileSync(path.join(tmp, "sub", "ignored.log"), "secret");
fs.writeFileSync(path.join(tmp, "sub", "kept.txt"), "x");
const realTmp = fs.realpathSync(tmp);

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("guard ALS — 活动工作区根切换", () => {
    it("无 store 回退全局 WORKSPACE_ROOT（零回归）", () => {
        assert.equal(getActiveWorkspaceRoot(), WORKSPACE_ROOT);
    });

    it("runWithWorkspaceRoot 切换活动根；出作用域即恢复", () => {
        const inside = runWithWorkspaceRoot(tmp, () => getActiveWorkspaceRoot());
        assert.equal(inside, tmp);
        assert.equal(getActiveWorkspaceRoot(), WORKSPACE_ROOT, "出作用域应回退全局");
    });

    it("resolveSafePath 在 worktree 上下文解析到 worktree 内", () => {
        const resolved = runWithWorkspaceRoot(tmp, () => resolveSafePath("a.txt"));
        assert.equal(resolved, path.join(realTmp, "a.txt"));
    });

    it("resolveSafePath 显式 base 参数优先（供单测/显式调用）", () => {
        const resolved = resolveSafePath("a.txt", tmp);
        assert.equal(resolved, path.join(realTmp, "a.txt"));
    });

    it("resolveSafePath 在 worktree 内拒 .. 越界（围栏锚定 worktree）", () => {
        assert.throws(
            () => runWithWorkspaceRoot(tmp, () => resolveSafePath("../escape.txt")),
            /SECURITY/,
        );
    });

    it("assertWithinWorkspace 在 worktree 内放行、越界拒", () => {
        runWithWorkspaceRoot(tmp, () => {
            assert.doesNotThrow(() => assertWithinWorkspace(path.join(realTmp, "a.txt")));
        });
        assert.throws(
            () => runWithWorkspaceRoot(tmp, () => assertWithinWorkspace(path.join(realTmp, "..", "escape.txt"))),
            /SECURITY/,
        );
    });

    it("异步续延继承 store（runAgent async 链模拟）", async () => {
        // 模拟 runAgent：await 边界后活动根仍为 worktree
        const resolved = await runWithWorkspaceRoot(tmp, async () => {
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 1));
            return resolveSafePath("a.txt");
        });
        assert.equal(resolved, path.join(realTmp, "a.txt"));
    });
});

describe("guard ignore 引擎 — 按 base 多实例", () => {
    it("initializeWorkspaceIgnore(base) + checkIsPathIgnored 按 base 判定", async () => {
        await initializeWorkspaceIgnore(tmp);
        assert.equal(checkIsPathIgnored("sub/ignored.log", tmp), true, "命中 sub/.gitignore 的 ignored.log");
        assert.equal(checkIsPathIgnored("sub/kept.txt", tmp), false, "kept.txt 不应被忽略");
    });

    it("主工作区与临时 base 互不污染（各持一份引擎）", () => {
        // 主工作区 key 未必已初始化，但临时 base 已初始化；两者用不同 key，互不影响
        const tmpResult = checkIsPathIgnored("sub/ignored.log", tmp);
        assert.equal(tmpResult, true);
    });

    it("未初始化的 base fail-open（返回 false，不误判忽略）", () => {
        assert.equal(checkIsPathIgnored("whatever", path.join(os.tmpdir(), "dsc-nonexistent-base-zzz")), false);
    });
});

describe("sessionRegistry — per-session 活动 worktree 注册表（P2-13）", () => {
    it("set / get / getSessionWorktreeRoot / clear 基本读写", () => {
        const sid = "test-session-1";
        const wt = { path: "/tmp/wt-1", branch: "dsc-wt-test-1-session", baseSha: "abc123" };
        assert.equal(getSessionWorktree(sid), undefined);
        setSessionWorktree(sid, wt);
        assert.equal(getSessionWorktree(sid), wt);
        assert.equal(getSessionWorktreeRoot(sid), "/tmp/wt-1");
        const cleared = clearSessionWorktree(sid);
        assert.equal(cleared, wt, "clear 返回被清除的句柄");
        assert.equal(getSessionWorktree(sid), undefined, "清除后查不到");
    });

    it("drainAllSessionWorktrees：取出全部并清空", () => {
        setSessionWorktree("s-a", { path: "/tmp/a", branch: "ba", baseSha: "x" });
        setSessionWorktree("s-b", { path: "/tmp/b", branch: "bb", baseSha: "x" });
        const all = drainAllSessionWorktrees();
        assert.equal(all.length, 2, "应取出全部");
        assert.equal(getSessionWorktree("s-a"), undefined, "注册表已清空");
    });
});

describe("guard session 上下文 — runWithSessionContext / getActiveCwd / 优先级（P2-13）", () => {
    it("无 session worktree：runWithSessionContext 内仍回退 WORKSPACE_ROOT（零回归）", () => {
        clearSessionWorktree("als-sid-empty");
        const root = runWithSessionContext("als-sid-empty", () => getActiveWorkspaceRoot());
        assert.equal(root, WORKSPACE_ROOT);
    });

    it("session worktree 激活：getActiveWorkspaceRoot 返回 worktree 根（经 sessionId 命中注册表）", () => {
        const sid = "als-sid-wt";
        const wtPath = "/tmp/fake-worktree-xyz";
        setSessionWorktree(sid, { path: wtPath, branch: "b", baseSha: "x" });
        const root = runWithSessionContext(sid, () => getActiveWorkspaceRoot());
        assert.equal(root, wtPath);
        clearSessionWorktree(sid);
    });

    it("优先级：显式 workspaceRoot > session 注册表（workflow 子 agent 用 wt.path 而非父 session）", () => {
        const sid = "als-sid-prio";
        setSessionWorktree(sid, { path: "/tmp/session-wt", branch: "b", baseSha: "x" });
        // 在 session 上下文里再 runWithWorkspaceRoot（模拟 workflow 子 agent）：workspaceRoot 应胜出
        const root = runWithSessionContext(sid, () =>
            runWithWorkspaceRoot("/tmp/explicit-wt", () => getActiveWorkspaceRoot()),
        );
        assert.equal(root, "/tmp/explicit-wt", "显式 workspaceRoot 优先于 session 注册表");
        clearSessionWorktree(sid);
    });

    it("getActiveCwd：无 session worktree 返回 fallback（零回归）", () => {
        clearSessionWorktree("als-cwd-empty");
        const cwd = runWithSessionContext("als-cwd-empty", () => getActiveCwd("/fallback/cwd"));
        assert.equal(cwd, "/fallback/cwd");
    });

    it("getActiveCwd：session worktree 激活返回 worktree 路径", () => {
        const sid = "als-cwd-wt";
        setSessionWorktree(sid, { path: "/tmp/cwd-wt", branch: "b", baseSha: "x" });
        const cwd = runWithSessionContext(sid, () => getActiveCwd("/fallback/cwd"));
        assert.equal(cwd, "/tmp/cwd-wt");
        clearSessionWorktree(sid);
    });

    it("runWithSessionContext 跨 await 边界继承（for-await runAgent 模拟）", async () => {
        const sid = "als-async";
        const wtPath = "/tmp/async-wt";
        setSessionWorktree(sid, { path: wtPath, branch: "b", baseSha: "x" });
        const root = await runWithSessionContext(sid, async () => {
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 1));
            return getActiveWorkspaceRoot();
        });
        assert.equal(root, wtPath, "await 边界后 session 上下文仍生效");
        clearSessionWorktree(sid);
    });
});
