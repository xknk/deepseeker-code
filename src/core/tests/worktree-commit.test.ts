/**
 * @file tests/worktree-commit.test.ts
 * @description worktree 收尾快照提交（tool/worktree/manager.ts commitWorktreeChanges）守门测试。
 *
 *  为什么被测函数必须存在：batch 的 worktree 目录落在 os.tmpdir()，进程重启时
 *  sweepOrphanedWorktrees 会 `worktree remove --force` 清目录——只有把改动 commit 到分支，
 *  产物才跨重启存活（次日 `batch pr` 才有的可交付）。
 *
 *  测法：临时 git 仓库直接当 worktree 路径（git -C 语义与真实 worktree 一致），
 *  不依赖 worktree add/清扫，也不碰本仓。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const { commitWorktreeChanges } = await import("@/tool/worktree/manager.ts");

const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });

/** 建一个有 1 个 commit 的临时仓库，返回 { dir, baseSha }。 */
const makeRepo = async (): Promise<{ dir: string; baseSha: string }> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-wt-commit-"));
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    git(dir, "config", "user.name", "test");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "commit.gpgsign", "false");
    await fs.writeFile(path.join(dir, "a.txt"), "base\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return { dir, baseSha: git(dir, "rev-parse", "HEAD").trim() };
};

const cleanup = (dir: string) => fs.rm(dir, { recursive: true, force: true });

test("有改动：全部改动固化成一个 commit，HEAD 前移且信息透传", async () => {
    const { dir, baseSha } = await makeRepo();
    try {
        await fs.writeFile(path.join(dir, "a.txt"), "changed\n");
        await fs.mkdir(path.join(dir, "sub"));
        await fs.writeFile(path.join(dir, "sub", "b.txt"), "new\n");

        const r = await commitWorktreeChanges({ path: dir, branch: "dsc-wt-t-1", baseSha }, "batch: t1 修 bug");

        assert.equal(r.committed, true);
        assert.equal(r.noChanges, false);
        assert.equal(r.error, undefined);
        assert.notEqual(r.sha, baseSha, "HEAD 应前移");
        assert.equal(git(dir, "rev-parse", "HEAD").trim(), r.sha);
        assert.equal(git(dir, "log", "-1", "--format=%s").trim(), "batch: t1 修 bug");
        // 修改与新增文件都要进同一个 commit（git add -A 语义）
        assert.equal(git(dir, "show", "HEAD:sub/b.txt").trim(), "new");
        assert.equal(git(dir, "status", "--porcelain").trim(), "", "提交后工作区应干净");
    } finally { await cleanup(dir); }
});

test("无改动：不产生空提交（noChanges=true）", async () => {
    const { dir, baseSha } = await makeRepo();
    try {
        const r = await commitWorktreeChanges({ path: dir, branch: "dsc-wt-t-2", baseSha }, "batch: t2");
        assert.equal(r.committed, false);
        assert.equal(r.noChanges, true);
        assert.equal(r.sha, baseSha);
        assert.equal(git(dir, "rev-parse", "HEAD").trim(), baseSha, "HEAD 不应移动");
    } finally { await cleanup(dir); }
});

test("agent 自己提交过：不再新建 commit，noChanges=false（有可交付改动）", async () => {
    const { dir, baseSha } = await makeRepo();
    try {
        await fs.writeFile(path.join(dir, "a.txt"), "agent\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "agent self commit");
        const agentSha = git(dir, "rev-parse", "HEAD").trim();

        const r = await commitWorktreeChanges({ path: dir, branch: "dsc-wt-t-3", baseSha }, "batch: t3");

        assert.equal(r.committed, false, "工作区干净就不该再 commit");
        assert.equal(r.noChanges, false, "相对基座仍有改动（agent 的提交）");
        assert.equal(r.sha, agentSha);
        assert.equal(git(dir, "rev-parse", "HEAD").trim(), agentSha);
        assert.equal(git(dir, "log", "--oneline", `${baseSha}..HEAD`).trim().split("\n").length, 1);
    } finally { await cleanup(dir); }
});

test("提交失败：不抛错，error 带回原因（改动仍在工作区，由报告提示会丢）", async () => {
    const { dir, baseSha } = await makeRepo();
    try {
        await fs.writeFile(path.join(dir, "a.txt"), "changed\n");
        // index.lock 占位 → git add 直接失败（模拟并发写/只读盘等真实故障）
        await fs.writeFile(path.join(dir, ".git", "index.lock"), "");

        const r = await commitWorktreeChanges({ path: dir, branch: "dsc-wt-t-4", baseSha }, "batch: t4");

        assert.equal(r.committed, false);
        assert.equal(r.noChanges, false);
        assert.ok(r.error && r.error.length > 0, "应带回失败原因");
        assert.equal(git(dir, "rev-parse", "HEAD").trim(), baseSha, "失败时 HEAD 不动");
    } finally { await cleanup(dir); }
});

test("无 git 身份也能提交（无人值守机器/CI 常无 user.name，显式身份兜底）", async () => {
    const { dir, baseSha } = await makeRepo();
    const emptyCfg = path.join(dir, ".gitconfig-empty");
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    try {
        await fs.writeFile(emptyCfg, "");
        git(dir, "config", "--unset", "user.name");
        git(dir, "config", "--unset", "user.email");
        // 屏蔽全局/系统 gitconfig：此时仓库里没有任何身份配置
        process.env.GIT_CONFIG_GLOBAL = emptyCfg;
        process.env.GIT_CONFIG_NOSYSTEM = "1";

        await fs.writeFile(path.join(dir, "a.txt"), "changed\n");
        const r = await commitWorktreeChanges({ path: dir, branch: "dsc-wt-t-5", baseSha }, "batch: t5");

        assert.equal(r.committed, true, "显式 user.name/email 必须让提交成功");
        assert.equal(git(dir, "log", "-1", "--format=%an").trim(), "deepseeker-code");
    } finally {
        if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
        if (saved.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
        else process.env.GIT_CONFIG_NOSYSTEM = saved.GIT_CONFIG_NOSYSTEM;
        await cleanup(dir);
    }
});
