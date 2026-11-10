/**
 * @file tool/worktree/manager.ts
 * @description P2-13 git worktree 生命周期管理：为 run_workflow 的 worktree 隔离模式提供
 *  create / harvestDiff / commit / remove / sweep 五件套。每个并行子 agent 派生前 create 一个独立 worktree，
 *  子 agent 在其中运行（经 ALS 隔离，改动不污染主工作区），结束 harvestDiff 收割改动，最后 remove 回收。
 *  ★ commitWorktreeChanges 只为 batch 服务（worktree 目录被保留、跨重启交付）：run_workflow 的 worktree
 *    由 removeWorktree 连分支一起删，提交无意义。
 *
 *  设计要点：
 *  - worktree 工作树落在仓外 <os.tmpdir()>/deepseeker-code-worktrees/<userWorkspaceDir>/<sessionId>/<stepId>/，
 *    不污染项目目录；admin 元数据由主仓 .git/worktrees/ 管理（git 原生）。置于系统临时目录而非 .deepseeker-code，
 *    避开 isProtectedWrite 的 .deepseeker-code 路径段保护（否则写入会被误杀）。
 *  - git worktree add/remove/prune 在【主仓】执行（cwd=WORKSPACE_ROOT 常量，不走 ALS——admin 操作针对主仓）；
 *    harvestDiff 在 worktree 内执行（git -C <wt>）。
 *  - 移除前 killBackgroundTasksUnder：杀掉 cwd 落在该 worktree 的常驻进程（dev server 等），防悬空 cwd。
 *  - 崩溃孤儿由 sweepOrphanedWorktrees 在 initEngine 启动期回收（进程重启 = 上次所有 worktree 均为孤儿）。
 */
import path from "path";
import os from "os";
import fs from "fs";
import { appConfig } from "@/config/index.ts";
import { execFileSmart } from "@/common/index.ts";
import { WORKSPACE_ROOT } from "../guard.ts";
import { killBackgroundTasksUnder } from "../registry/background.ts";
import { drainAllSessionWorktrees } from "./sessionRegistry.ts";

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
    execFileSmart("git", args, { cwd: WORKSPACE_ROOT, maxBuffer });

/**
 * worktree 根目录：<os.tmpdir()/deepseeker-code-worktrees>/<userWorkspaceDir>/（按项目隔离，sweep 按此扫）。
 * ★ 必须落在 .deepseeker-code 之外：isProtectedWrite 按「路径段」禁碰 .deepseeker-code/.git/.ssh 等，
 *   若 worktree 置于 ~/.deepseeker-code/worktrees/... 其路径段含 .deepseeker-code → 所有写入被保护规则误杀。
 *   放系统临时目录既避开保护段，又契合 worktree 的临时性（OS 定期清理 + 启动期 sweep 兜底）。
 */
const worktreeRootDir = (): string =>
    path.join(os.tmpdir(), "deepseeker-code-worktrees", appConfig.userWorkspaceDir);

/** 单个 worktree 目录：<worktreeRoot>/<sessionId>/<stepId>/。 */
const worktreeDir = (sessionId: string, stepId: string): string =>
    path.join(worktreeRootDir(), sessionId, stepId);

/** 判定「非 git 仓库」错误（与 git.ts 同源）。 */
const isNotARepoError = (e: any): boolean => {
    const text = `${e?.message || ""} ${e?.stderr || ""}`.toLowerCase();
    return text.includes("not a git repository");
};

/**
 * 创建一个从主仓检出（缺省当前 HEAD）的独立 worktree（新临时分支）。
 * @param baseRef 检出基座（P2 续修链：传前票产物分支名，代码基座=前次修复成果；缺省 HEAD 不变）。
 * @param repoRoot 跨仓路由（2026-11-10）：worktree admin 锚定的仓库根，缺省主仓（WORKSPACE_ROOT）。
 *   跨仓票（如「在 lg-pms 项目…」）传目标仓库根——分支/worktree 元数据落目标仓；harvest/commit
 *   本就按 wt.path（git -C）操作、不依赖锚定仓，天然跨仓。
 * @throws 非 git 仓库 / worktree add 失败时抛错（run_workflow 捕获后该步骤标失败）
 */
export const createWorktree = async (sessionId: string, stepId: string, baseRef = "HEAD", repoRoot?: string): Promise<WorktreeHandle> => {
    // admin git 锚定仓（跨仓路由时为目标仓库；缺省主仓）
    const adminCwd = repoRoot ?? WORKSPACE_ROOT;
    const runAdminGit = (args: string[], maxBuffer = 1024 * 1024 * 5) =>
        execFileSmart("git", args, { cwd: adminCwd, maxBuffer });
    // 检出基座作为 worktree 基座与 diff 基准（先解析成 SHA：baseRef 可能是分支名）
    const { stdout: shaOut } = await runAdminGit(["rev-parse", baseRef]);
    const baseSha = shaOut.trim();

    const wtPath = worktreeDir(sessionId, stepId);
    // 分支名：dsc-wt-<sessionId 前 8>-<stepId>（合法 git ref，可读、可溯源）
    const shortId = sessionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) || "x";
    const branch = `dsc-wt-${shortId}-${stepId}`;

    await fs.promises.mkdir(path.dirname(wtPath), { recursive: true });
    // -b：新建分支；baseRef：从指定基座检出（缺省 HEAD）。worktree 路径须不存在（mkdir 只建到父级）。
    try {
        await runAdminGit(["worktree", "add", "-b", branch, wtPath, baseSha]);
    } catch (e: any) {
        // 残留兜底：上次失败尝试可能留下旧目录、陈旧 worktree 元数据或同名残分支——
        // 只清目录不够（分支还在时 -b 撞 "branch already exists"，该票永远跑不起来，重跑场景必须自愈）。
        // 同名分支（dsc-wt-<session>-<step>）只可能是本槽位上一次尝试的尸体，删之安全。
        if (e?.code === "ENOENT" || /already exists|not a working tree/i.test(`${e?.stderr || ""} ${e?.message || ""}`)) {
            await fs.promises.rm(wtPath, { recursive: true, force: true }).catch(() => { });
            await runAdminGit(["worktree", "prune"]).catch(() => { });
            await runAdminGit(["branch", "-D", branch]).catch(() => { });
            await runAdminGit(["worktree", "add", "-b", branch, wtPath, baseSha]);
        } else {
            throw e;
        }
    }
    console.log(`🌿 [worktree] 创建 ${branch} → ${wtPath}（base=${baseSha.slice(0, 8)}${baseRef === "HEAD" ? "" : ` ← ${baseRef}`}@${path.basename(adminCwd)}）`);
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
    execFileSmart("git", ["-C", wtPath, ...args], { maxBuffer });

/** 收尾快照提交的结果（供 batch 报告落字）。 */
export interface WorktreeCommit {
    /** true=本次调用产生了新 commit（worktree 内未提交改动已固化）。 */
    committed: boolean;
    /** 分支当前 HEAD SHA（成功时；失败为空串）。 */
    sha: string;
    /** true=相对基座 baseSha 完全没有改动（无未提交改动、也没有 agent 自己 commit）。 */
    noChanges: boolean;
    /** 提交失败原因（git 报错原文截断，单行）；成功或无改动时缺省。 */
    error?: string;
    /** true=agent 自 commit 被补打了 Batch-Trace 尾注（amend 改写）；快照自提的 commit 尾注随消息自带，不置位。 */
    trailerAdded?: boolean;
}

/**
 * 收尾快照提交（**仅 batch 调用**）：把 worktree 内全部改动固化成一个 commit。
 *
 * ★ 为什么必须提交：worktree 工作树落在 os.tmpdir()，进程重启时 sweepOrphanedWorktrees 会
 *   `worktree remove --force` 清掉目录——未提交的改动随之消失。只有 commit 到分支
 *   （dsc-wt-* ref 留在主仓）才能跨重启存活，次日 `batch pr` 才有东西可交付。
 * ★ 三处刻意关闭项（无人值守场景）:
 *   - `--no-verify`：跳过 pre-commit/commit-msg 钩子——仓库钩子可能交互、联网或挂死；
 *   - `-c commit.gpgsign=false`：开着签名会在无 tty 时等口令直至超时；
 *   - 显式 `user.name/email`：干净机器 / CI 常无 git 身份，缺省直接 commit 失败。
 * ★ 失败不抛错：改动还在 worktree 里（当下能看），只是重启会丢——由调用方写进报告。
 *
 * @param trailer 溯源尾注（P2：`Batch-Trace: <票id>`）——快照自提时直接拼进提交消息；agent 已
 *   自己 commit 过时（committed=false 且有改动）对 HEAD 补打尾注（amend，同样关闭钩子/签名，
 *   只动消息不动内容）。补打失败不影响交付（分支与内容都在），只是溯源降级为票报告。
 */
export const commitWorktreeChanges = async (wt: WorktreeHandle, message: string, trailer?: string): Promise<WorktreeCommit> => {
    const readHead = async (): Promise<string> => {
        const { stdout } = await runInWorktree(wt.path, ["rev-parse", "HEAD"]);
        return stdout.trim();
    };
    const identityFlags = [
        "-c", "commit.gpgsign=false",
        "-c", "user.name=deepseeker-code",
        "-c", "user.email=deepseeker-code@localhost",
    ];
    try {
        await runInWorktree(wt.path, ["add", "-A"]);
        const { stdout: status } = await runInWorktree(wt.path, ["status", "--porcelain"]);
        if (!status.trim()) {
            // 无未提交改动：agent 可能自己 commit 过（HEAD 已前移），也可能全程没动文件
            let head = await readHead();
            const noChanges = head === wt.baseSha;
            let trailerAdded = false;
            if (!noChanges && trailer) {
                // agent 自 commit：补打溯源尾注（amend 只改消息；失败不致命，降级为票报告溯源）
                try {
                    const { stdout: logMsg } = await runInWorktree(wt.path, ["log", "-1", "--format=%B"]);
                    if (!logMsg.includes(trailer)) {
                        const merged = `${logMsg.replace(/\s+$/, "")}\n\n${trailer}\n`;
                        await runInWorktree(wt.path, [...identityFlags, "commit", "--no-verify", "--amend", "-m", merged]);
                        trailerAdded = true;
                        head = await readHead();
                    }
                } catch (e: any) {
                    console.warn(`⚠️ [worktree] Batch-Trace 尾注补打失败（不影响交付）: ${`${e?.stderr || e?.message || e}`.trim().slice(0, 160)}`);
                }
            }
            return { committed: false, sha: head, noChanges, trailerAdded: trailerAdded || undefined };
        }
        const finalMessage = trailer ? `${message.replace(/\s+$/, "")}\n\n${trailer}\n` : message;
        await runInWorktree(wt.path, [...identityFlags, "commit", "--no-verify", "-m", finalMessage]);
        return { committed: true, sha: await readHead(), noChanges: false };
    } catch (e: any) {
        const text = `${e?.stderr || ""} ${e?.message || e}`.trim().replace(/\s+/g, " ");
        console.warn(`⚠️ [worktree] 收尾提交失败（改动仍在该 worktree 内，重启即丢）: ${text}`);
        return { committed: false, sha: "", noChanges: false, error: text.slice(0, 300) };
    }
};

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

/**
 * 进程退出 dispose：取出全部 session 活动 worktree 并逐个清理（防长跑进程的 worktree 泄漏）。
 * best-effort（逐个 catch）；进程退出时可能来不及完成，残留由下次启动期 sweepOrphanedWorktrees 兜底。
 */
export const disposeAllSessionWorktrees = async (): Promise<void> => {
    const all = drainAllSessionWorktrees();
    for (const wt of all) {
        try { await removeWorktree(wt); } catch { /* ignore */ }
    }
};

export { isNotARepoError };
