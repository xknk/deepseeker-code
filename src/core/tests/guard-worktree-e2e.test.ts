/**
 * @file tests/guard-worktree-e2e.test.ts
 * @description P0-B 工具级端到端守门（评审修复批 2026-11-19）：真 git 仓 → 真 worktree →
 *  真 enter_worktree 工具 → 真 edit_file 工具，按 VSCode 生产环境逐件镜像：
 *    ① setAllowedWorkspaceRoots([主仓])（extension.ts:977 同款——注册集 = 工作区文件夹）；
 *    ② enter_worktree.execute（manager 建 worktree 于 os.tmpdir()、session 注册表登记）；
 *    ③ chatProcessing 的 runWithSessionContext 外裹（ALS.sessionId）→ edit_file.execute
 *       （其内部 resolveSafePath :646 即修复前的报警点）。
 *  断言：worktree 内相对路径编辑成功落 wt、主仓零污染；逃出主仓与 wt 的绝对路径仍 SECURITY
 *  （fail-closed 红线）。修复前本文件第一条断言必红（SECURITY ALERT）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// —— 沙盒：env 必须先于一切 core import（ESM 静态 import 提升；WORKSPACE_ROOT 被 guard.ts 模块
//    加载期冻结、manager 的 admin git 锚定它；appConfig.dataDir 同理）——
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-fence-e2e-data-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-fence-e2e-repo-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = dataDir;
process.env.WORKSPACE_ROOT = repo;

const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.name", "test");
git(repo, "config", "user.email", "test@example.com");
git(repo, "config", "commit.gpgsign", "false");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "main.ts"), "export const answer = 42;\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");

const { setAllowedWorkspaceRoots, runWithSessionContext } = await import("@/tool/guard.ts");
const { worktreeTools } = await import("@/tool/registry/worktree.ts");
const { fsTools } = await import("@/tool/registry/fs.ts");
const { getSessionWorktreeRoot, clearSessionWorktree } = await import("@/tool/worktree/sessionRegistry.ts");

const byName = (tools: any[], name: string) => tools.find((t) => t.function.name === name)!;
const enterTool = byName(worktreeTools, "enter_worktree");
const exitTool = byName(worktreeTools, "exit_worktree");
const editTool = byName(fsTools, "edit_file");
/** 工具结果文本视图：string 原样；结构化 ToolExecuteResult 取 content（toolFailure 出口是对象）。 */
const asText = (r: any): string => (typeof r === "string" ? r : String(r?.content ?? r));

test("P0-B 端到端：注册集=[主仓] + enter_worktree 后 edit_file 落 worktree、不再 SECURITY ALERT", async () => {
    const sid = "e2e-fence-sid";
    setAllowedWorkspaceRoots([repo]); // ★ VSCode 生产同款：注册集 = 工作区文件夹（不含 tmp 下的 wt）
    const enterRet = await enterTool.function.execute({ reason: "P0-B e2e" }, { sessionId: sid } as any);
    assert.match(asText(enterRet), /已进入 worktree/);
    const wtPath = getSessionWorktreeRoot(sid);
    assert.ok(wtPath, "enter_worktree 应在 session 注册表登记");
    assert.notEqual(path.resolve(wtPath!), path.resolve(repo), "worktree 应落主仓之外（tmp）");

    try {
        // ★ 修复前此处必抛 SECURITY ALERT（读得到写不进的死循环起点）
        const editRet = await runWithSessionContext(sid, () =>
            editTool.function.execute({ path: "src/main.ts", old_str: "42", new_str: "424242" }));
        assert.match(asText(editRet), /代码修补成功/);
        // 换行归一：Windows git checkout 写 CRLF，edit_file 保 CRLF 语义（只比内容）
        const norm = (p: string): string => fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
        assert.equal(norm(path.join(wtPath!, "src", "main.ts")), "export const answer = 424242;\n", "编辑应落在 worktree");
        assert.equal(norm(path.join(repo, "src", "main.ts")), "export const answer = 42;\n", "主仓不得被污染（隔离语义）");

        // 红线：逃出【主仓注册集 ∪ wt】的绝对路径仍拦（围栏 fail-closed 不弱化）
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-fence-e2e-out-"));
        try {
            fs.writeFileSync(path.join(outside, "x.ts"), "y");
            const denyRet = await runWithSessionContext(sid, () =>
                editTool.function.execute({ path: path.join(outside, "x.ts"), old_str: "y", new_str: "z" }));
            assert.match(asText(denyRet), /SECURITY/);
            assert.equal(fs.readFileSync(path.join(outside, "x.ts"), "utf-8"), "y", "越界文件不得被写");
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    } finally {
        const exitRet = await exitTool.function.execute({}, { sessionId: sid } as any);
        assert.match(asText(exitRet), /已退出/);
        clearSessionWorktree(sid);
        setAllowedWorkspaceRoots([]);
    }
});
