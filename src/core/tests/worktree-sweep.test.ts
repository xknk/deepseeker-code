/**
 * @file tests/worktree-sweep.test.ts
 * @description 启动期孤儿清扫的年龄护栏（2026-11-10 y38a 实锤）守门测试。
 *
 *  背景：清扫前提「残留=孤儿」只在单进程世界成立。真机是多进程并存——listen 点火的
 *  runner 正在跑，另一进程 boot 即触发 initEngine 清扫，曾把活跃 runner 刚建好的
 *  worktree 连根拔掉（agent 中途 git_status 报「尚未初始化 Git 仓库」、收尾提交
 *  not a git repository、改动失去 git 归属）。护栏=近 60 分钟内有写入的目录跳过。
 *
 *  测法：rootOverride 注入临时根目录真跑（绝不用真实 worktreeRootDir()——共享根上有
 *  用户真实 worktree，测试 sweep 会误删）。目录不是注册过的 git worktree →
 *  `git worktree remove` 失败 → fs.rm 兜底，恰好覆盖降级路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { sweepOrphanedWorktrees } = await import("@/tool/worktree/manager.ts");

const HOUR = 60 * 60 * 1000;

/** 建临时根：<sessionA/{old-only, young}，sessionB/{old1, old2}> 按需自定义，返回根路径。 */
const makeRoot = async (layout: Record<string, string[]>): Promise<string> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-sweep-test-"));
    for (const [session, steps] of Object.entries(layout)) {
        for (const step of steps) {
            const dir = path.join(root, session, step);
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, "probe.txt"), "x");
        }
    }
    return root;
};

/** 把目录 mtime 拨到指定年龄（小时）。 */
const ageDir = async (dir: string, hours: number): Promise<void> => {
    const t = new Date(Date.now() - hours * HOUR);
    await fs.utimes(dir, t, t);
};

test("年轻 worktree 跳过清扫（并行进程在用绝不动），年老的照扫", async () => {
    const root = await makeRoot({ sessA: ["young-step", "old-step"] });
    const young = path.join(root, "sessA", "young-step");
    const old = path.join(root, "sessA", "old-step");
    await ageDir(young, 0.02); // ~1 分钟前：活跃
    await ageDir(old, 2);      // 2 小时前：孤儿

    await sweepOrphanedWorktrees(root);

    await fs.stat(young); // 年轻 worktree 必须存活（不 reject 即通过）
    const oldStat = await fs.stat(old).catch(() => null);
    assert.equal(oldStat, null, "年老 worktree 必须被清扫");
    // 同 session 还有年轻 worktree → 壳目录保留
    await fs.stat(path.join(root, "sessA"));
});

test("session 只剩年老 worktree → 移除后连壳一起清", async () => {
    const root = await makeRoot({ sessB: ["old1", "old2"] });
    await ageDir(path.join(root, "sessB", "old1"), 3);
    await ageDir(path.join(root, "sessB", "old2"), 5);

    await sweepOrphanedWorktrees(root);

    assert.equal(
        await fs.stat(path.join(root, "sessB")).then(() => "exists", () => "gone"),
        "gone",
        "空壳 session 目录应被清理",
    );
});

test("全年轻：一个不扫、壳全留（另一进程刚建好一批 worktree 的场景）", async () => {
    const root = await makeRoot({ sessC: ["a", "b"] });
    await ageDir(path.join(root, "sessC", "a"), 0.01);
    await ageDir(path.join(root, "sessC", "b"), 0.5);

    await sweepOrphanedWorktrees(root);

    await fs.stat(path.join(root, "sessC", "a"));
    await fs.stat(path.join(root, "sessC", "b"));
    await fs.stat(path.join(root, "sessC"));
});
