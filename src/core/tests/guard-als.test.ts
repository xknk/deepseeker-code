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
    resolveSafePath,
    assertWithinWorkspace,
    initializeWorkspaceIgnore,
    checkIsPathIgnored,
} from "@/tool/guard.ts";

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
