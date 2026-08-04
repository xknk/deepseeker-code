/**
 * @file tool/worktree/manager.ts
 * @description P2-13 git worktree 生命周期管理：为 run_workflow 的 worktree 隔离模式提供
 *  create / harvestDiff / remove / sweep 四件套。每个并行子 agent 派生前 create 一个独立 worktree，
 *  子 agent 在其中运行（经 ALS 隔离，改动不污染主工作区），结束 harvestDiff 收割改动，最后 remove 回收。
 *
 *  设计要点：
 *  - worktree 工作树落在仓外 <os.tmpdir()>/deepSeekCode-worktrees/<userWorkspaceDir>/<sessionId>/<stepId>/，
 *    不污染项目目录；admin 元数据由主仓 .git/worktrees/ 管理（git 原生）。置于系统临时目录而非 .deepSeekCode，
 *    避开 isProtectedWrite 的 .deepSeekCode 路径段保护（否则写入会被误杀）。
 *  - git worktree add/remove/prune 在【主仓】执行（cwd=WORKSPACE_ROOT 常量，不走 ALS——admin 操作针对主仓）；
 *    harvestDiff 在 worktree 内执行（git -C <wt>）。
 *  - 移除前 killBackgroundTasksUnder：杀掉 cwd 落在该 worktree 的常驻进程（dev server 等），防悬空 cwd。
 *  - 崩溃孤儿由 sweepOrphanedWorktrees 在 initEngine 启动期回收（进程重启 = 上次所有 worktree 均为孤儿）。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import { appConfig } from "@/config/index.ts";
import { WORKSPACE_ROOT } from "../guard.ts";
import { killBackgroundTasksUnder } from "../registry/background.ts";

const execFileAsync = promisify(execFile);

/** worktree 句柄：create 返回，remove/harvestDiff 消费。 */
export interface WorktreeHandle {
    /** worktree 工作树绝对路径（子 agent 的 cwd / ALS 活动根）。 */
    path: string;
    /** worktree 所在的临时分支名（随 worktree 移除而删）。 */
    branch: string;
    /** 创建时的主仓 HEAD SHA，harvestDiff 据此 diff（子 agent commit 后仍能完整收割）。 */
    baseSha: string;
}

/** 在【主仓】执行 git（worktree admin 操作锚定主仓，不受 ALS 影响）。 */
const runMainGit = (args: string[], maxBuffer = 1024 * 1024 * 5) =>
    execFileAsync("git", args, { cwd: WORKSPACE_ROOT, maxBuffer });

/**
 * worktree 根目录：<os.tmpdir()/deepSeekCode-worktrees>/<userWorkspaceDir>/（按项目隔离，sweep 按此扫）。
 * ★ 必须落在 .deepSeekCode 之外：isProtectedWrite 按「路径段」禁碰 .deepSeekCode/.git/.ssh 等，
 *   若 worktree 置于 ~/.deepSeekCode/worktrees/... 其路径段含 .deepSeekCode → 所有写入被保护规则误杀。
 *   放系统临时目录既避开保护段，又契合 worktree 的临时性（OS 定期清理 + 启动期 sweep 兜底）。
 */
const worktreeRootDir = (): string =>
    path.join(os.tmpdir(), "deepSeekCode-worktrees", appConfig.userWorkspaceDir);

/** 单个 worktree 目录：<worktreeRoot>/<sessionId>/<stepId>/。 */
const worktreeDir = (sessionId: string, stepId: string): string =>
    path.join(worktreeRootDir(), sessionId, stepId);

/** 判定「非 git 仓库」错误（与 git.ts 同源）。 */
const isNotARepoError = (e: any): boolean => {
    const text = `${e?.message || ""} ${e?.stderr || ""}`.toLowerCase();
    return text.includes("not a git repository");
};

/**
 * 创建一个从主仓当前 HEAD 检出的独立 worktree（新临时分支）。
 * @throws 非 git 仓库 / worktree add 失败时抛错（run_workflow 捕获后该步骤标失败）
 */
export const createWorktree = async (sessionId: string, stepId: string): Promise<WorktreeHandle> => {
    // 主仓 HEAD 作为 worktree 基座与 diff 基准
    const { stdout: shaOut } = await runMainGit(["rev-parse", "HEAD"]);
    const baseSha = shaOut.trim();

    const wtPath = worktreeDir(sessionId, stepId);
    // 分支名：dsc-wt-<sessionId 前 8>-<stepId>（合法 git ref，可读、可溯源）
    const shortId = sessionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) || "x";
    const branch = `dsc-wt-${shortId}-${stepId}`;

    await fs.promises.mkdir(path.dirname(wtPath), { recursive: true });
    // -b：新建分支；HEAD：从主仓当前 HEAD 检出。worktree 路径须不存在（mkdir 只建到父级）。
    try {
        await runMainGit(["worktree", "add", "-b", branch, wtPath, "HEAD"]);
    } catch (e: any) {
        // 残留目录兜底：若上次崩溃留了空目录，清后重试一次
        if (e?.code === "ENOENT" || /already exists|not a working tree/i.test(`${e?.stderr || ""} ${e?.message || ""}`)) {
            await fs.promises.rm(wtPath, { recursive: true, force: true }).catch(() => { });
            await runMainGit(["worktree", "add", "-b", branch, wtPath, "HEAD"]);
        } else {
            throw e;
        }
    }
    console.log(`🌿 [worktree] 创建 ${branch} → ${wtPath}（base=${baseSha.slice(0, 8)}）`);
    return { path: wtPath, branch, baseSha };
};

/**
 * 收割 worktree 相对 baseSha 的全部改动（已提交 + 暂存 + 未暂存 + 新文件）。
 * 先 git add -A（worktree 独立 index，不影响主仓）再 diff --cached <baseSha>，确保新文件也被纳入。
 * 带头尾截断（与 get_git_diff 同口径），防巨 diff 撑爆上下文。
 */
export const harvestDiff = async (wt: WorktreeHandle): Promise<string> => {
    try {
        await runInWorktree(wt.path, ["add", "-A"]);
        let stdout: string;
        try {
            ({ stdout } = await runInWorktree(wt.path, ["diff", "--cached", wt.baseSha, "--no-color"]));
        } catch (e: any) {
            if (e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && typeof e.stdout === "string") stdout = e.stdout;
            else throw e;
        }
        if (!stdout.trim()) return "（该 worktree 相对基座无改动）";
        const HEAD = 60, TAIL = 60;
        const lines = stdout.split("\n");
        if (lines.length > HEAD + TAIL) {
            const omitted = lines.length - HEAD - TAIL;
            return [
                `[Worktree Diff | 省略中间约 ${omitted} 行，保留首 ${HEAD} + 末 ${TAIL} 行]`,
                lines.slice(0, HEAD).join("\n"),
                `\n[... ⚠️ 中间 ${omitted} 行已隐藏 ...]`,
                lines.slice(-TAIL).join("\n"),
            ].join("\n");
        }
        return stdout;
    } catch (error: any) {
        return `（收割 diff 失败: ${error?.message || error}）`;
    }
};

/** 在 worktree 内执行 git（git -C <wt>）。 */
const runInWorktree = (wtPath: string, args: string[], maxBuffer = 1024 * 1024 * 5) =>
    execFileAsync("git", ["-C", wtPath, ...args], { maxBuffer });

/**
 * 移除 worktree：先杀其下常驻后台进程，再 git worktree remove + prune + 删临时分支。
 * 全程 best-effort（每步 catch），不抛错——清理失败不能击垮主流程，残留由下次启动期 sweep 兜底。
 */
export const removeWorktree = async (wt: WorktreeHandle): Promise<void> => {
    try { await killBackgroundTasksUnder(wt.path); } catch (e: any) { console.warn(`⚠️ [worktree] kill 后台任务失败: ${e?.message || e}`); }
    try {
        await runMainGit(["worktree", "remove", "--force", wt.path]);
    } catch (e: any) {
        // remove 失败（目录已被外部动过等）：直接 fs.rm 兜底 + prune
        await fs.promises.rm(wt.path, { recursive: true, force: true }).catch(() => { });
    }
    try { await runMainGit(["worktree", "prune"]); } catch { /* ignore */ }
    try { await runMainGit(["branch", "-D", wt.branch]); } catch { /* 分支可能已被删或被占用，忽略 */ }
    console.log(`🧹 [worktree] 移除 ${wt.branch} (${wt.path})`);
};

/**
 * 启动期孤儿清扫：进程重启意味着上次未清理的 worktree 全是孤儿。
 * 扫 <dataDir>/worktrees/<userWorkspaceDir>/ 下所有 worktree 目录，强制移除 + prune。
 * 在 initEngine 中调用。非 git 仓库静默跳过。
 */
export const sweepOrphanedWorktrees = async (): Promise<void> => {
    const root = worktreeRootDir();
    let entries: string[];
    try { entries = await fs.promises.readdir(root); } catch { return; /* 目录不存在，无事可扫 */ }
    let swept = 0;
    for (const sessionIdDir of entries) {
        const sessionPath = path.join(root, sessionIdDir);
        let stepDirs: string[];
        try { stepDirs = await fs.promises.readdir(sessionPath); } catch { continue; }
        for (const stepDir of stepDirs) {
            const wtPath = path.join(sessionPath, stepDir);
            try {
                await runMainGit(["worktree", "remove", "--force", wtPath]);
            } catch {
                await fs.promises.rm(wtPath, { recursive: true, force: true }).catch(() => { });
            }
            swept++;
        }
        // 该 session 的 worktree 目录已空，清掉壳
        await fs.promises.rm(sessionPath, { recursive: true, force: true }).catch(() => { });
    }
    if (swept > 0) {
        try { await runMainGit(["worktree", "prune"]); } catch { /* ignore */ }
        console.log(`🧹 [worktree] 启动期清扫 ${swept} 个孤儿 worktree`);
    }
};

export { isNotARepoError };
