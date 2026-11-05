/**
 * @file tests/worktree-base-ref.test.ts
 * @description P2 worktree 两项守门测试：baseRef 基座检出（续修链代码基座=前票产物分支）+
 *  Batch-Trace 溯源尾注（快照自提随消息自带 / agent 自 commit 补打 amend / 无改动不误补）。
 *
 *  沙盒仓库在 import manager 之前建好——WORKSPACE_ROOT 与 DEEPSEEKER_CODE_DATA_DIR 都在模块
 *  顶层钉死，env 必须先置（tsx 双模块实例坑：整文件只用同一 specifier）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-wt-base-test-"));
process.env.WORKSPACE_ROOT = root;
process.env.DEEPSEEKER_CODE_DATA_DIR = path.join(root, ".dsc-data");
const git = async (dir: string, args: string[]): Promise<string> => {
    const r = await run("git", ["-C", dir, ...args]);
    return r.stdout;
};

// 主仓：init + 两个提交；再从 main 分出「前票产物分支」并前进一步——HEAD(main) ≠ artifact，
// 若 baseRef 未生效，续修 worktree 会检到 main 而不是 artifact 的内容（这就是要钉死的缺陷）。
const mainFile = path.join(root, "app.txt");
const init = await run("git", ["init", "-b", "main", root]);
assert.ok(init.stderr === "" || !/fatal|error/i.test(init.stderr), init.stderr);
await git(root, ["config", "user.email", "test@example.invalid"]);
await git(root, ["config", "user.name", "tester"]);
await fs.writeFile(mainFile, "base\n");
await git(root, ["add", "app.txt"]);
await git(root, ["commit", "-m", "c1"]);
await fs.writeFile(mainFile, "base2\n");
await git(root, ["add", "app.txt"]);
await git(root, ["commit", "-m", "c2"]); // main HEAD = c2
await git(root, ["branch", "dsc-wt-prev-1"]); // artifact 分支当前也指 c2
await fs.writeFile(path.join(root, "artifact-only.txt"), "prev fix\n");
await git(root, ["add", "artifact-only.txt"]);
await git(root, ["commit", "-m", "prev fix"]); // main 又前进 c3；artifact 停在 c2

const mgr = await import("@/tool/worktree/manager.ts");

const cleanup = async (wt: { path: string; branch: string; baseSha: string }): Promise<void> => {
    await mgr.removeWorktree(wt);
};

test("worktree baseRef：从指定分支检出（续修基座），baseSha/diff 基线都锚定产物分支而非 HEAD", async () => {
    const artifactSha = (await git(root, ["rev-parse", "dsc-wt-prev-1"])).trim();
    const wt = await mgr.createWorktree("sess-cont", "stepA", "dsc-wt-prev-1");
    try {
        assert.equal(wt.baseSha, artifactSha, "baseSha = 产物分支 SHA（非 main HEAD）");
        assert.ok(wt.branch.startsWith("dsc-wt-"));
        const headInWt = (await git(wt.path, ["rev-parse", "HEAD"])).trim();
        assert.equal(headInWt, artifactSha, "检出 HEAD = 产物分支");
        // diff 基线正确：只报 worktree 内新改动，不把 main 独有提交（c3）算进去
        await fs.writeFile(path.join(wt.path, "new-in-wt.txt"), "x\n");
        const diff = await mgr.harvestDiff(wt);
        assert.match(diff, /new-in-wt\.txt/);
        assert.doesNotMatch(diff, /artifact-only\.txt/, "基座内容（前票成果）不在 diff 里");
        await fs.rm(path.join(wt.path, "new-in-wt.txt"), { force: true });
    } finally {
        await cleanup(wt);
    }
});

test("Batch-Trace 快照自提：尾注随提交消息自带；无改动 → noChanges 且不产生提交", async () => {
    const wt = await mgr.createWorktree("sess-snap", "stepB");
    try {
        await fs.writeFile(path.join(wt.path, "fix.txt"), "the fix\n");
        const r = await mgr.commitWorktreeChanges(wt, "batch: snapshot commit", "Batch-Trace: ticket-001");
        assert.equal(r.committed, true);
        assert.ok(r.sha);
        assert.equal(r.noChanges, false);
        const log = (await git(wt.path, ["log", "-1", "--format=%B"])).trim();
        assert.match(log, /batch: snapshot commit/);
        assert.match(log, /Batch-Trace: ticket-001/, "尾注在消息尾部");
        // 二跑（无新改动）：不再产生提交、sha 不动；noChanges 仍 false——语义=「相对基座完全没动过」，
        // 首跑的快照 commit 已使 HEAD ≠ baseSha（接口注释口径，报告侧不误判「全程没干活」）
        const r2 = await mgr.commitWorktreeChanges(wt, "batch: snapshot commit", "Batch-Trace: ticket-001");
        assert.equal(r2.committed, false);
        assert.equal(r2.noChanges, false);
        assert.equal(r2.sha, r.sha);
    } finally {
        await cleanup(wt);
    }
});

test("Batch-Trace agent 自 commit：补打尾注（amend 只改消息）；已带尾注不重复补；全程无改动 → noChanges", async () => {
    // 自 commit 场景
    const wt = await mgr.createWorktree("sess-agent", "stepC");
    try {
        await fs.writeFile(path.join(wt.path, "agent.txt"), "agent work\n");
        await git(wt.path, ["add", "agent.txt"]);
        await git(wt.path, ["-c", "user.email=a@x.invalid", "-c", "user.name=agent", "commit", "-m", "agent's own commit"]);
        const before = (await git(wt.path, ["rev-parse", "HEAD"])).trim();
        const r = await mgr.commitWorktreeChanges(wt, "（ignored）", "Batch-Trace: ticket-002");
        assert.equal(r.committed, false);
        assert.equal(r.noChanges, false);
        assert.equal(r.trailerAdded, true, "补打置位");
        const log = (await git(wt.path, ["log", "-1", "--format=%B"])).trim();
        assert.match(log, /agent's own commit/, "原消息保留");
        assert.match(log, /Batch-Trace: ticket-002/, "尾注补打");
        assert.notEqual((await git(wt.path, ["rev-parse", "HEAD"])).trim(), before, "amend 前移 HEAD");
        assert.equal((await git(wt.path, ["status", "--porcelain"])).trim(), "", "amend 只改消息不动内容");
        // 已带尾注 → 不重复补（includes 检查）
        const r2 = await mgr.commitWorktreeChanges(wt, "x", "Batch-Trace: ticket-002");
        assert.equal(r2.trailerAdded, undefined);
        assert.equal(r2.sha, r.sha);
        // 全程无改动场景：新 worktree 不动任何文件
        const wt2 = await mgr.createWorktree("sess-idle", "stepD");
        try {
            const idle = await mgr.commitWorktreeChanges(wt2, "x", "Batch-Trace: ticket-003");
            assert.equal(idle.committed, false);
            assert.equal(idle.noChanges, true);
            assert.equal(idle.sha, wt2.baseSha);
            assert.equal(idle.trailerAdded, undefined, "无改动不误补尾注");
        } finally {
            await cleanup(wt2);
        }
    } finally {
        await cleanup(wt);
    }
});
