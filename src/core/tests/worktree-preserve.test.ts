/**
 * @file tests/worktree-preserve.test.ts
 * @description 卡 2（评审修复施工单 2026-11-24）worktree 并行写产物保全守门：
 *  - exportPatch：先 add -A 再 diff --cached --binary --output=<绝对路径>——补丁含新文件与全部改动；
 *  - removeWorktree keepBranch：分支改名 dsc-keep-* 保留（tip 含全部改动），worktree 目录删除，
 *    原 dsc-wt-* 分支不复存在；
 *  - 撞名自愈安全：createWorktree 的同名自愈只碰 dsc-wt-*，保留分支不被误删（同一会话连跑两次场景）；
 *  - 基座漂移：git apply --3way 遇冲突退出码非 0、工作区留冲突标记；
 *  - 过期回收：sweepExpiredKeepBranches 只删 >7 天的 dsc-keep-*，dsc-wt-batch-da-* 不动；
 *  - formatArtifactManifest：产物清单逐条完整（补丁路径/分支名不被截断口径吃掉）。
 *
 *  测法：临时 git 仓 + 真 git worktree add（分支检出语义、prune/branch -m 行为与生产一致）；
 *  仓库级 user.name/email 必设（CI runner 无全局 git 身份）。manager 的 branch/prune 操作经
 *  opts.repoRoot 锚定临时仓，绝不触碰本仓。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fss from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import type { StepOutcome } from "@/tool/registry/workflowHelpers.ts";

const { exportPatch, removeWorktree, createWorktree, commitWorktreeChanges, sweepExpiredKeepBranches } =
    await import("@/tool/worktree/manager.ts");
const { formatArtifactManifest } = await import("@/tool/registry/workflowHelpers.ts");

const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: env ? { ...process.env, ...env } : undefined });

/** 建临时主仓（1 个 base commit，仓库级身份），返回 { main, baseSha }。 */
const makeMainRepo = async (): Promise<{ main: string; baseSha: string }> => {
    const main = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-wt-preserve-main-"));
    execFileSync("git", ["init", "-q", "-b", "main", main]);
    git(main, ["config", "user.name", "test"], undefined);
    git(main, ["config", "user.email", "test@example.com"], undefined);
    git(main, ["config", "commit.gpgsign", "false"], undefined);
    await fs.writeFile(path.join(main, "a.txt"), "line-1\nline-2\nline-3\n", "utf-8");
    git(main, ["add", "-A"], undefined);
    git(main, ["commit", "-q", "-m", "base"], undefined);
    return { main, baseSha: git(main, ["rev-parse", "HEAD"], undefined).trim() };
};

/** 在主仓里建真 worktree（分支名与生产同构），返回句柄形状。 */
const addRealWorktree = async (main: string, baseSha: string, id: string): Promise<{ path: string; branch: string; baseSha: string }> => {
    const holder = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-wt-preserve-wt-"));
    const wtPath = path.join(holder, "wt"); // 保证不存在（worktree add 要求）
    git(main, ["worktree", "add", "-b", `dsc-wt-${id}`, wtPath, baseSha], undefined);
    return { path: wtPath, branch: `dsc-wt-${id}`, baseSha };
};

const rmRf = (dir: string): void => { try { fss.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

test("产物保全全链：补丁落盘含新文件、+/- 行数一致、对基座 apply --check 通过；分支保留改名、目录已删、原 dsc-wt 分支消失", async () => {
    const { main, baseSha } = await makeMainRepo();
    const patchDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-wt-preserve-patch-"));
    const wt = await addRealWorktree(main, baseSha, "t-1");
    try {
        // worktree 内 300+ 行改动（含新文件与二进制文件）
        const bigBody = Array.from({ length: 350 }, (_, i) => `new line ${i + 1}`).join("\n") + "\n";
        await fs.writeFile(path.join(wt.path, "a.txt"), bigBody, "utf-8");
        await fs.writeFile(path.join(wt.path, "added.txt"), "brand new file\n", "utf-8");
        await fs.writeFile(path.join(wt.path, "blob.bin"), Buffer.from([0x00, 0x01, 0xff, 0x00, 0x02, 0xfe]), "binary");

        // 补丁导出（绝对路径注入）
        const patchPath = path.join(patchDir, "step.patch");
        await exportPatch(wt, patchPath);
        const patch = await fs.readFile(patchPath, "utf-8");
        assert.ok(patch.includes("diff --git"), "补丁应为 git diff 格式");
        assert.ok(patch.includes("added.txt"), "未跟踪新文件必须进补丁（add -A 前提）");
        assert.ok(patch.includes("GIT binary patch"), "--binary 使二进制文件以 binary patch 形式入库");
        const plus = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const minus = patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        assert.equal(plus, 351, "新增行：350 行改写 + 1 行新文件（二进制段不计 + 行）");
        assert.equal(minus, 3, "删除行：原 a.txt 三行");
        // 对基座可干净应用
        git(main, ["apply", "--check", patchPath], undefined);

        // 分支保底 + 保留改名
        const commit = await commitWorktreeChanges({ ...wt }, "workflow 步骤产物快照");
        assert.equal(commit.committed, true);
        const keep = await removeWorktree({ ...wt }, { keepBranch: true, repoRoot: main });
        assert.ok(keep && keep.startsWith("dsc-keep-"), `保留分支应为 dsc-keep-* 前缀，实得 ${keep}`);

        // worktree 目录已删；dsc-keep-* 存在且 tip 含全部改动；原 dsc-wt-t-1 不存在
        await assert.rejects(() => fs.stat(wt.path), "worktree 目录应已删除");
        const branches = git(main, ["branch", "--format=%(refname:short)"], undefined).trim().split("\n");
        assert.ok(branches.includes(keep!), "保留分支应在主仓分支列表");
        assert.ok(!branches.includes("dsc-wt-t-1"), "原 dsc-wt 分支应已不存在（改名而非复制）");
        assert.equal(git(main, ["show", `${keep}:added.txt`], undefined).trim(), "brand new file", "保留分支 tip 应含全部改动");
    } finally {
        rmRf(patchDir);
        rmRf(path.dirname(wt.path));
        rmRf(main);
        try { git(main, ["worktree", "prune"], undefined); } catch { /* 主仓已删，忽略 */ }
    }
});

test("同一会话连跑两次：第一次保留的 dsc-keep-* 分支仍在，未被撞名自愈删掉", async () => {
    const { main, baseSha } = await makeMainRepo();
    const sessionId = "preserve-samesession";
    let firstKeep = "";
    try {
        // 第一次：真 worktree → 改动 → 快照 → 保留
        const wt1 = await addRealWorktree(main, baseSha, "s-1");
        await fs.writeFile(path.join(wt1.path, "w1.txt"), "run one\n", "utf-8");
        await commitWorktreeChanges({ ...wt1 }, "snapshot run1");
        firstKeep = (await removeWorktree({ ...wt1 }, { keepBranch: true, repoRoot: main }))!;
        assert.ok(firstKeep.startsWith("dsc-keep-"));

        // 第一次保留分支不可能在 1 秒内被第二次同名覆盖——垫 1.1s 保证时间戳推进
        await new Promise((r) => setTimeout(r, 1100));

        // 第二次：同名分支 dsc-wt-s-1 重建（createWorktree 走正常路径或撞名自愈——都不该碰 dsc-keep-*）
        const wt2 = await addRealWorktree(main, baseSha, "s-1");
        await fs.writeFile(path.join(wt2.path, "w2.txt"), "run two\n", "utf-8");
        await commitWorktreeChanges({ ...wt2 }, "snapshot run2");
        const secondKeep = (await removeWorktree({ ...wt2 }, { keepBranch: true, repoRoot: main }))!;
        assert.ok(secondKeep.startsWith("dsc-keep-"));
        assert.notEqual(secondKeep, firstKeep, "两次保留分支名应不同（时间戳防撞）");

        const branches = git(main, ["branch", "--format=%(refname:short)"], undefined).trim().split("\n");
        assert.ok(branches.includes(firstKeep), "第一次保留的分支必须仍在（撞名自愈只碰 dsc-wt-*）");
        assert.ok(branches.includes(secondKeep));
    } finally {
        rmRf(main);
    }
});

test("createWorktree 撞名自愈只删同名 dsc-wt-* 尸体，不碰 dsc-keep-* 保留分支", async () => {
    const { main, baseSha } = await makeMainRepo();
    const sessionId = "preserve-selfheal";
    try {
        // 预置：一条保留分支 + 一条同名尸体 dsc-wt-h-1（上次尝试的残骸）
        git(main, ["branch", "dsc-keep-20261124-120000-h-1"], undefined);
        git(main, ["branch", "dsc-wt-h-1"], undefined);
        // createWorktree（repoRoot 锚定临时主仓）：wtPath 撞 + 分支撞 → 走自愈
        const wt = await createWorktree(sessionId, "h", "HEAD", main);
        try {
            assert.ok(wt.branch.startsWith("dsc-wt-"));
            const branches = git(main, ["branch", "--format=%(refname:short)"], undefined).trim().split("\n");
            assert.ok(branches.includes("dsc-keep-20261124-120000-h-1"), "保留分支必须原样存活");
            assert.ok(branches.includes("dsc-wt-h-1"), "自愈后同名分支重建（worktree 可用）");
        } finally {
            await removeWorktree(wt, { repoRoot: main });
        }
    } finally {
        rmRf(main);
    }
});

test("基座漂移：git apply --3way 留冲突标记、退出码非 0；git apply --check 失败", async () => {
    const { main, baseSha } = await makeMainRepo();
    const patchDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-wt-preserve-conflict-"));
    const wt = await addRealWorktree(main, baseSha, "c-1");
    try {
        // worktree 改 line-2 → 补丁
        await fs.writeFile(path.join(wt.path, "a.txt"), "line-1\nline-2-CHANGED-IN-WT\nline-3\n", "utf-8");
        const patchPath = path.join(patchDir, "step.patch");
        await exportPatch(wt, patchPath);
        // 基座漂移：主仓相邻行被改（worktree 不知情）
        await fs.writeFile(path.join(main, "a.txt"), "line-1-MOVED-BASE\nline-2-CHANGED-IN-WT\nline-3\n", "utf-8");
        git(main, ["add", "-A"], undefined);
        git(main, ["commit", "-q", "-m", "base drift"], undefined);

        // --check 必失败（无法干净应用）
        let checkFailed = false;
        try { git(main, ["apply", "--check", patchPath], undefined); } catch { checkFailed = true; }
        assert.ok(checkFailed, "基座漂移下 apply --check 应失败");

        // --3way：退出码非 0 + 工作区留冲突标记
        let applyFailed = false;
        try { git(main, ["apply", "--3way", patchPath], undefined); } catch { applyFailed = true; }
        assert.ok(applyFailed, "基座漂移下 apply --3way 应以非 0 退出（需人工处理）");
        const content = await fs.readFile(path.join(main, "a.txt"), "utf-8");
        assert.match(content, /<<<<<<<|>>>>>>>/, "工作区应留冲突标记");
    } finally {
        rmRf(path.dirname(wt.path));
        rmRf(main);
        try { git(main, ["worktree", "prune"], undefined); } catch { /* 主仓已删 */ }
    }
});

test("过期回收：8 天前的 dsc-keep-* 被删，dsc-wt-batch-da-* 不动", async () => {
    const { main } = await makeMainRepo();
    try {
        // 8 天前提交时间的保留分支（committerdate 决定 for-each-ref 年龄）
        const oldDate = "2026-11-16T12:00:00 +0800";
        git(main, ["checkout", "-q", "-b", "dsc-keep-20261116-120000-old"], undefined);
        git(main, ["commit", "-q", "--allow-empty", "-m", "old artifact"], { GIT_COMMITTER_DATE: oldDate, GIT_AUTHOR_DATE: oldDate });
        git(main, ["checkout", "-q", "main"], undefined);
        // 批量线分支（不受本回收管辖）
        git(main, ["branch", "dsc-wt-batch-da123456-7"], undefined);

        const deleted = await sweepExpiredKeepBranches(main);

        assert.deepEqual(deleted, ["dsc-keep-20261116-120000-old"], "只回收过期的 dsc-keep-*");
        const branches = git(main, ["branch", "--format=%(refname:short)"], undefined).trim().split("\n");
        assert.ok(!branches.includes("dsc-keep-20261116-120000-old"), "过期保留分支应已删除");
        assert.ok(branches.includes("dsc-wt-batch-da123456-7"), "批量线分支不得被回收触碰");
    } finally {
        rmRf(main);
    }
});

test("formatArtifactManifest：产物清单逐条完整可读，不受输出长度影响；无产物返回空串", () => {
    const longOutput = "x".repeat(25000); // 超过 18000 截断线的单步输出
    const outcomes: StepOutcome[] = [
        { ok: true, output: longOutput, label: "步骤 A", artifact: { patchPath: "D:\\data\\worktree-artifacts\\proj\\sess\\dsc-wt-20261124-160000-0.patch", branch: "dsc-keep-20261124-160000-s-0" } },
        { ok: true, output: "ok", label: "步骤 B" },
    ];
    const manifest = formatArtifactManifest(outcomes);
    assert.match(manifest, /dsc-wt-20261124-160000-0\.patch/, "补丁路径完整出现（含扩展名）");
    assert.match(manifest, /dsc-keep-20261124-160000-s-0/, "分支名完整出现");
    assert.match(manifest, /git apply --3way/, "带真实应用指引");
    assert.match(manifest, /退出码 1/, "带冲突语义说明");
    assert.doesNotMatch(manifest, /步骤 B/, "无产物步骤不进清单");
    assert.equal(formatArtifactManifest([{ ok: true, output: "ok", label: "C" }]), "");
});
