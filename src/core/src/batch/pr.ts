/**
 * @file batch/pr.ts
 * @description 多入口工单流水线 P2：`batch pr <id>` 交付命令（§6.1）——显式命令 = 天然审批，永不自动外发。
 *
 *  流程：前置预检（报告存在 + 验收 passed + needs-review 闸 + 幂等标记）→ 产物分支核对 →
 *  基分支探测（gitlab default_branch → gh repo view → origin/HEAD → main/master）→ worktree 重建/复用
 *  （审查现场，绝不直接动主工作区）→ 强制 `git fetch origin <base>`（fail-closed）→ behind 检查 +
 *  merge-tree 冲突预检（老 git 软降级）→ diff 预览 → push `agent/<票id>` → gh pr create --draft /
 *  GitLab MR（Draft: 前缀）→ 落 done/<id>.pr.json 幂等标记。
 *
 *  红线落地：
 *  - 零 LLM（不 import agent 链；exec/HTTP 全部可注入）；外发动作只在显式命令路径发生。
 *  - needs-review（改测试降级/含图/仓库不一致，任一来源）→ 一律拒绝交付，无豁免旗标。
 *  - 落后主干的票不自动 rebase（2026-11-05 评审拍板：首版人工）——拒交 + 打印手工命令 + 标 needs-review。
 *  - 代理需求只进文案提示，绝不默认拼进命令（README 说明）。
 *  - PR 正文四要素：标题 / 状态与成本 / 变更文件清单（封顶 20）/ 成本；diff 与验收输出永不外发。
 *  ★ 轻模块红线：config/index（轻）+ fs/path/os 级依赖，零 LLM。
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { appConfig } from "@/config/index.ts";
import { readReport, reportPath, markTicketNeedsReview } from "./queue.ts";
import { doneTicketPath } from "./continuation.ts";
import { parseBatchTicket } from "./ticket.ts";
import { defaultSyncExec, type SyncExec } from "./sync/exec.ts";
import { loadSyncConfig, type GitlabSourceConfig, type SyncLocale } from "./sync/config.ts";
import { fetchGitlabProject } from "./sync/gitlab.ts";

/** 注入面：HTTP（GitLab 项目详情 GET / MR POST）。比 sync 的 SyncFetch 多 method/body，测试注入假实现。 */
export type PrFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string; headers: Record<string, string> }>;

/** 缺省实现：global fetch + 响应体文本 + 头转小写 map（与 sync/gitlab 同构，多了 method/body）。 */
export const defaultPrFetch: PrFetch = async (url, init) => {
    const r = await fetch(url, { method: init?.method, headers: init?.headers, body: init?.body });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: r.status, body: await r.text(), headers };
};

const PR_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        noReport: (id: string) => `未找到 ${id} 的完成报告（batch/done/${id}.report.md）——票还没跑完或存档已被 clean 清理，无法交付。`,
        notPassed: (id: string, status: string) => `${id} 验收未通过（status: ${status}）——只有验收通过的票才能交付。`,
        needsReviewBlock: (id: string) => `${id} 带 needs-review 标记（改过测试 / 含图片附件 / 仓库不一致等）——这类票一律拒绝交付，请人工复核后手工处理（无豁免旗标）。`,
        alreadyDelivered: (marker: string) => `该票已交付过（done/<id>.pr.json 标记）：\n${marker}`,
        noBranch: (id: string, branch: string) => `${id} 报告里没有可用的产物分支（branch: ${branch}）——worktree 未创建或已丢失，无法交付。`,
        noSourceId: (id: string) => `${id} 的工单缺 source-id——不是多入口流水线建出的票，无法回指来源仓库。`,
        unsupportedSource: (sourceId: string) => `暂不支持的来源：${sourceId}（当前支持 github:owner/repo#N 与 gitlab:projectId#N）。`,
        noGitlabConfig: () => `sync.json 未配置 gitlab 源——GitLab 票交付需要 baseUrl/tokenEnv 配置。`,
        glBaseFail: (why: string) => `GitLab 项目信息获取失败（${why}）——拿不到默认分支，无法确定 MR 目标。`,
        noBase: () => `无法确定基分支（探测顺序 gitlab default_branch → gh repo view → origin/HEAD → main/master 全部落空）。`,
        wtFail: (why: string) => `审查 worktree 重建失败：${why}`,
        fetchFail: (why: string) => `git fetch origin 失败（${why}）——交付前必须核对最新主干（fail-closed）。网络不通时检查代理（README「交付与 PR」节）。`,
        baseMissing: (b: string) => `远端分支 ${b} 不存在——先确认仓库名与基分支。`,
        behindShort: (branch: string, base: string) => `${branch} 落后 origin/${base}（首版不自动 rebase，已标 needs-review）。`,
        behindBlock: (branch: string, base: string) => `该分支落后主干，需要人工 rebase 后重新 batch pr。手工命令（在本仓库根目录执行）：`,
        rebaseHint: (branch: string, base: string) => `  git fetch origin\n  git worktree add ../rebase-${branch} ${branch}\n  cd ../rebase-${branch} && git rebase origin/${base}\n  # 冲突解决后：git rebase --continue && cd - && git worktree remove ../rebase-${branch}`,
        conflictShort: () => `与主干存在合并冲突（已标 needs-review）——先人工 rebase 解决冲突再交付。`,
        conflictBlock: (files: string) => `merge-tree 预检发现冲突文件：\n${files}`,
        mergeTreeOld: () => `（本机 git 版本较老，merge-tree 预检不可用——冲突将靠 GitHub/GitLab 侧检测；落后检查仍然强制）`,
        pushFail: (why: string) => `git push 失败：${why}\n（若为网络/代理问题：push 走本地 git 配置，代理设置见 README「交付与 PR」节；分支代码未丢，可修好网络后重跑 batch pr）`,
        prCreateFail: (why: string) => `分支已推送，但 gh pr create 失败：${why}\n可手工建 PR：分支 agent/<票id> 已在远端。`,
        mrCreateFail: (why: string) => `分支已推送，但 GitLab MR 创建失败：${why}\n可手工在网页上建 MR：分支 agent/<票id> 已在远端。`,
        glTokenMissing: (env: string) => `环境变量 ${env} 未设置：GitLab MR 创建需要 token（只走环境变量，不进配置文件）。`,
        reviewHeader: (n: number) => `交付前请人工过目（改动 ${n} 个文件）：`,
        moreFiles: (n: number) => `（其余 ${n} 个文件略）`,
        done: (url: string) => `✅ 已交付：${url}\n（草稿态 PR/MR——人工复核后手动 Ready；幂等标记 done/<id>.pr.json 已落盘，重复 batch pr 会被拒绝）`,
    },
    en: {
        noReport: (id: string) => `No done report found for ${id} (batch/done/${id}.report.md) — the ticket has not finished or the archive was cleaned; cannot deliver.`,
        notPassed: (id: string, status: string) => `${id} did not pass acceptance (status: ${status}) — only accepted tickets can be delivered.`,
        needsReviewBlock: (id: string) => `${id} carries a needs-review flag (test files touched / image attachments / repo mismatch) — delivery is always refused for such tickets; review manually (no override flag).`,
        alreadyDelivered: (marker: string) => `Already delivered (done/<id>.pr.json marker):\n${marker}`,
        noBranch: (id: string, branch: string) => `No usable artifact branch in the ${id} report (branch: ${branch}) — worktree was never created or is lost; cannot deliver.`,
        noSourceId: (id: string) => `Ticket ${id} has no source-id — not created via the multi-entry pipeline; cannot map back to a source repo.`,
        unsupportedSource: (sourceId: string) => `Unsupported source: ${sourceId} (currently github:owner/repo#N and gitlab:projectId#N).`,
        noGitlabConfig: () => `sync.json has no gitlab source — GitLab delivery needs baseUrl/tokenEnv configured.`,
        glBaseFail: (why: string) => `Failed to fetch GitLab project info (${why}) — cannot determine the MR target branch.`,
        noBase: () => `Cannot determine the base branch (gitlab default_branch → gh repo view → origin/HEAD → main/master all failed).`,
        wtFail: (why: string) => `Failed to rebuild the review worktree: ${why}`,
        fetchFail: (why: string) => `git fetch origin failed (${why}) — the latest mainline must be verified before delivery (fail-closed). If the network is down, check proxy settings (README "Delivery & PR" section).`,
        baseMissing: (b: string) => `Remote branch ${b} does not exist — verify the repo name and base branch first.`,
        behindShort: (branch: string, base: string) => `${branch} is behind origin/${base} (no auto-rebase in v1; marked needs-review).`,
        behindBlock: (branch: string, base: string) => `The branch is behind mainline; manual rebase required before delivery. Manual commands (run at the repo root):`,
        rebaseHint: (branch: string, base: string) => `  git fetch origin\n  git worktree add ../rebase-${branch} ${branch}\n  cd ../rebase-${branch} && git rebase origin/${base}\n  # after resolving conflicts: git rebase --continue && cd - && git worktree remove ../rebase-${branch}`,
        conflictShort: () => `Merge conflicts against mainline detected (marked needs-review) — resolve them via a manual rebase before delivering.`,
        conflictBlock: (files: string) => `merge-tree precheck found conflicting files:\n${files}`,
        mergeTreeOld: () => `(local git is too old for the merge-tree precheck — conflicts will surface on the GitHub/GitLab side; the behind check is still enforced)`,
        pushFail: (why: string) => `git push failed: ${why}\n(if network/proxy related: push uses your local git config; proxy setup in README "Delivery & PR" — no code is lost, rerun batch pr once fixed)`,
        prCreateFail: (why: string) => `Branch pushed, but gh pr create failed: ${why}\nYou can open the PR manually: branch agent/<ticket-id> is on the remote.`,
        mrCreateFail: (why: string) => `Branch pushed, but GitLab MR creation failed: ${why}\nYou can open the MR on the web: branch agent/<ticket-id> is on the remote.`,
        glTokenMissing: (env: string) => `Environment variable ${env} is not set: creating a GitLab MR needs a token (env vars only, never config files).`,
        reviewHeader: (n: number) => `Please review before delivering (${n} changed files):`,
        moreFiles: (n: number) => `(and ${n} more files)`,
        done: (url: string) => `✅ Delivered: ${url}\n(draft PR/MR — mark Ready manually after review; the done/<id>.pr.json marker is written, so a repeat batch pr is refused)`,
    },
};
const msg = (locale: SyncLocale, key: string, ...args: any[]): string => {
    const v = (PR_MSG[locale] ?? PR_MSG.zh)[key] ?? PR_MSG.zh[key] ?? key;
    return typeof v === "function" ? v(...args) : v;
};

export interface BatchPrOptions {
    locale?: SyncLocale;
    /** 注入外部命令（git/gh；测试假实现，不碰真仓）。 */
    exec?: SyncExec;
    /** 注入 HTTP（GitLab；缺省 global fetch）。 */
    fetchImpl?: PrFetch;
    /** 输出通道（缺省 stdout）。 */
    out?: (line: string) => void;
    /** 审查 worktree 根（测试注入临时目录；缺省 appConfig 分桶 + batch-pr 段）。 */
    worktreeRoot?: string;
    /** git 命令锚定目录（缺省 process.cwd()；测试注入沙盒仓库，不碰真仓）。 */
    cwd?: string;
}

export type BatchPrResult =
    | { ok: true; url: string; branch: string; base: string }
    | { ok: false; error: string };

/** 合法 git ref 名形状（把报告里的「（未创建）」等占位串挡在外面）。 */
const BRANCH_RE = /^[\w][\w./-]*$/;

/** 变更文件清单封顶（PR 正文四要素之一；超出部分计数字提示）。 */
const FILE_LIST_CAP = 20;

/**
 * name-status 行 → 纯路径（剥状态列）：`M\ta.ts` → `a.ts`；改名 `R100\t{a => b}` 路径按 git 原样。
 * name-status 行至少两列（状态 + 路径），pop 恒取路径列。导出供守门测试钉形态；控制台预览不走
 * 此处（状态列人看有用），只有外发正文剥（试点 PR #4 实证 `M\tREADME.md` 漏进正文）。
 */
export const nameStatusToPaths = (rows: string[]): string[] =>
    rows.map((line) => line.split(/\t/).pop() ?? line).filter(Boolean);

/** PR 正文（四要素：标题 / 状态与成本 / 变更文件清单 / 成本；外发红线：diff 与验收输出永不进正文）。 */
export const buildPrBody = (args: { ticketId: string; title: string; status: string; costYuan: string; files: string[]; issueNumber?: number; locale?: SyncLocale }): string => {
    const lines = [
        `## ${args.title}`,
        "",
        `Delivered by batch ticket \`${args.ticketId}\` — acceptance **${args.status}**.`,
        `Cost: ${args.costYuan} CNY (LLM usage, self-reported by the local runner).`,
        "",
        `### Changed files (${args.files.length})`,
        "",
    ];
    const shown = args.files.slice(0, FILE_LIST_CAP);
    lines.push(...shown.map((f) => `- \`${f}\``));
    if (args.files.length > FILE_LIST_CAP) lines.push(`- ... and ${args.files.length - FILE_LIST_CAP} more`);
    if (args.files.length === 0) lines.push("- (no file changes recorded)");
    if (args.issueNumber !== undefined) lines.push("", `fixes #${args.issueNumber}`);
    return lines.join("\n") + "\n";
};

/**
 * 执行一次交付（§6.1 全流程）。任何一步失败都返回 {ok:false, error}（人话原因，CLI 直接展示）；
 * 外发动作（push/建 PR）只有走到最后两步才会发生——之前任何拒绝都不碰远端。
 */
export const runBatchPr = async (ticketId: string, opts: BatchPrOptions = {}): Promise<BatchPrResult> => {
    const locale = opts.locale ?? "zh";
    const M = (k: string, ...a: any[]) => msg(locale, k, ...a);
    const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const exec = opts.exec ?? defaultSyncExec;
    const fetchImpl = opts.fetchImpl ?? defaultPrFetch;

    // git 命令统一入口：锚定目录（缺省 process.cwd()；测试注入沙盒仓库）。
    const g = async (args: string[]) => exec("git", opts.cwd ? ["-C", opts.cwd, ...args] : args);

    const fail = (error: string): BatchPrResult => {
        out(`🚫 [batch pr] ${error}`);
        return { ok: false, error };
    };

    // 1. 前置预检：报告存在 + 验收通过
    const report = await readReport(ticketId);
    if (!report) return fail(M("noReport", ticketId));
    const fm = (key: string): string => {
        const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(report);
        return m ? m[1].trim() : "";
    };
    const status = fm("status");
    if (status !== "passed") return fail(M("notPassed", ticketId, status || "?"));

    // 2. needs-review 闸（报告 ∨ 票档，任一为真即拒；无豁免旗标——人工复核走手工流程）
    const reportNeedsReview = /^needs-review:\s*true\s*$/m.test(report);
    const ticketRaw = await fs.readFile(doneTicketPath(ticketId), "utf-8").catch(() => null);
    const parsed = ticketRaw !== null ? parseBatchTicket(ticketRaw, locale) : null;
    if (!parsed?.ok) return fail(M("noReport", ticketId)); // 票档没了与报告没了同因（clean），文案同源
    const ticket = parsed.ticket;
    if (reportNeedsReview || ticket.needsReview) return fail(M("needsReviewBlock", ticketId));

    // 3. 幂等标记（done/<id>.pr.json）：重复交付拒绝
    const markerPath = path.join(path.dirname(reportPath(ticketId)), `${ticketId}.pr.json`);
    const marker = await fs.readFile(markerPath, "utf-8").catch(() => null);
    if (marker !== null) return fail(M("alreadyDelivered", marker.trim()));

    // 4. 产物分支
    const branch = fm("branch");
    if (!branch || !BRANCH_RE.test(branch)) return fail(M("noBranch", ticketId, branch || "-"));

    // 5. 平台与仓库回指
    const sourceId = ticket.sourceId ?? "";
    const gh = /^github:([^#\s]+)#(\d+)$/.exec(sourceId);
    const gl = /^gitlab:(\d+)#(\d+)$/.exec(sourceId);
    if (!gh && !gl) {
        if (!sourceId) return fail(M("noSourceId", ticketId));
        return fail(M("unsupportedSource", sourceId));
    }

    // 6. 基分支探测 + GitLab 配置（仅 GitLab 票需要）
    let glCfg: GitlabSourceConfig | undefined;
    let base = "";
    if (gl) {
        const cfg = await loadSyncConfig({ locale });
        if (!cfg.ok || !cfg.config.gitlab) return fail(M("noGitlabConfig"));
        glCfg = cfg.config.gitlab;
        try {
            const info = await fetchGitlabProject(glCfg, Number(gl[1]), { fetchImpl, locale });
            base = info.defaultBranch;
        } catch (e: any) {
            return fail(M("glBaseFail", String(e?.message ?? e).slice(0, 160)));
        }
    } else {
        const v = await exec("gh", ["repo", "view", gh![1], "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
        if (v.code === 0 && v.stdout.trim()) base = v.stdout.trim();
        else {
            const sym = await g(["symbolic-ref", "refs/remotes/origin/HEAD"]);
            if (sym.code === 0 && sym.stdout.trim()) base = sym.stdout.trim().replace(/^refs\/remotes\/origin\//, "");
            else {
                for (const cand of ["main", "master"]) {
                    const chk = await g(["rev-parse", "--verify", `refs/remotes/origin/${cand}`]);
                    if (chk.code === 0) { base = cand; break; }
                }
            }
        }
    }
    if (!base || !BRANCH_RE.test(base)) return fail(M("noBase"));

    // 7. 审查 worktree 重建/复用（绝不直接动主工作区；分支被别的 worktree 占着时复用它）
    const wtRoot = opts.worktreeRoot ?? path.join(os.tmpdir(), "deepseeker-code-worktrees", appConfig.userWorkspaceDir, "batch-pr");
    const wtPath = path.join(wtRoot, ticketId);
    let actualWt = wtPath;
    const list = await g(["worktree", "list", "--porcelain"]);
    if (list.code === 0) {
        for (const block of list.stdout.split(/\r?\n\r?\n/)) {
            const lines = block.split(/\r?\n/).filter((l) => l.trim());
            const p = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length).trim();
            const b = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length).trim();
            if (p && b === `refs/heads/${branch}`) { actualWt = p; break; }
        }
    } else {
        return fail(M("wtFail", list.stderr.trim().slice(0, 160)));
    }
    let worktreeReused = actualWt !== wtPath;
    if (!worktreeReused) {
        const add = await g(["worktree", "add", actualWt, branch]);
        if (add.code !== 0) return fail(M("wtFail", add.stderr.trim().slice(0, 160) || add.stdout.trim().slice(0, 160)));
    }

    try {
        // 8. 强制 fetch（fail-closed：交付前必须核对最新主干）
        const fetchR = await g(["fetch", "origin", base]);
        if (fetchR.code !== 0) {
            return fail(M("fetchFail", (fetchR.stderr || fetchR.stdout).trim().slice(0, 200)));
        }

        // 9. behind 检查：merge-base(branch, origin/base) ≠ origin/base tip 即落后
        const mb = await g(["merge-base", branch, `origin/${base}`]);
        const tip = await g(["rev-parse", `origin/${base}`]);
        if (mb.code !== 0 || tip.code !== 0) return fail(M("baseMissing", `origin/${base}`));
        const mergeBase = mb.stdout.trim();
        const behind = mergeBase !== tip.stdout.trim();

        // 10. merge-tree 冲突预检（git 2.38+；老 git 软降级为提示，落后检查不受影响）
        const mt = await g(["merge-tree", "--write-tree", branch, `origin/${base}`]);
        let conflicts: string[] = [];
        if (mt.code === 1) {
            conflicts = `${mt.stdout}\n${mt.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("CONFLICT")).slice(0, 10);
        } else if (mt.code !== 0 && /unknown option|invalid option|usage:/i.test(mt.stderr)) {
            out(M("mergeTreeOld"));
        }

        if (behind) {
            await markTicketNeedsReview(doneTicketPath(ticketId));
            out(M("behindBlock", branch, base));
            out(M("rebaseHint", branch, base));
            if (conflicts.length > 0) out(M("conflictBlock", conflicts.join("\n")));
            return fail(M("behindShort", branch, base));
        }
        if (conflicts.length > 0) {
            await markTicketNeedsReview(doneTicketPath(ticketId));
            out(M("conflictBlock", conflicts.join("\n")));
            return fail(M("conflictShort"));
        }

        // 11. diff 预览（人过目的清单：文件级 + 规模行；diff 内容只进报告存档，不外发）
        //     core.quotepath=false：中文等非 ASCII 路径保持原样，不转 \344\270\255 八进制串进 PR 正文。
        const nst = await g(["-c", "core.quotepath=false", "diff", "--name-status", `${mergeBase}..${branch}`]);
        const shortstat = await g(["diff", "--shortstat", `${mergeBase}..${branch}`]);
        const files = nst.code === 0 ? nst.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
        out(M("reviewHeader", files.length));
        for (const f of files.slice(0, FILE_LIST_CAP)) out(`  ${f}`);
        if (files.length > FILE_LIST_CAP) out(`  ${M("moreFiles", files.length - FILE_LIST_CAP)}`);
        if (shortstat.code === 0 && shortstat.stdout.trim()) out(`  ${shortstat.stdout.trim()}`);

        // 12. PR 正文（四要素；github 附 fixes #N）。外发清单剥掉 name-status 的状态列（试点 PR #4
        //     实证 `M\tREADME.md` 漏进正文——观感差且泄露命令细节）；控制台预览保留状态列（人看有用）。
        const filePaths = nameStatusToPaths(files);
        const bodyTmp = path.join(os.tmpdir(), `dsc-pr-body-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
        try {
            await fs.writeFile(bodyTmp, buildPrBody({
                ticketId,
                title: ticket.title,
                status,
                costYuan: fm("cost-yuan") || "0",
                files: filePaths,
                issueNumber: gh ? Number(gh[2]) : undefined,
            }), "utf-8");

            // 13. push（代理走本地 git 配置——README 提示，绝不默认拼进命令）
            const pushBranch = `agent/${ticketId}`;
            const push = await g(["push", "origin", `${branch}:refs/heads/${pushBranch}`]);
            if (push.code !== 0) return fail(M("pushFail", (push.stderr || push.stdout).trim().slice(0, 300)));

            // 14. 建 PR / MR（草稿态；人复核后手动 Ready）
            let url = "";
            if (gh) {
                const create = await exec("gh", ["pr", "create", "--draft", "--base", base, "--head", pushBranch, "--title", ticket.title.replace(/\s+/g, " ").trim(), "--body-file", bodyTmp, "--repo", gh[1]]);
                if (create.code !== 0) return fail(M("prCreateFail", (create.stderr || create.stdout).trim().slice(0, 200)));
                url = create.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
            } else {
                const token = process.env[glCfg!.tokenEnv];
                if (!token) return fail(M("glTokenMissing", glCfg!.tokenEnv));
                // description = PR 正文（剥离 GitHub 修复语法——buildPrBody 只给 github 票写 fixes，这里防御性再剥）
                //   + GitLab 侧关闭语法（Closes #iid 显式追加）。
                const desc = (await fs.readFile(bodyTmp, "utf-8")).replace(/fixes #\d+\s*$/, "").trim();
                const resp = await fetchImpl(`${glCfg!.baseUrl.replace(/\/+$/, "")}/api/v4/projects/${gl![1]}/merge_requests`, {
                    method: "POST",
                    headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
                    body: JSON.stringify({
                        source_branch: pushBranch,
                        target_branch: base,
                        title: `Draft: ${ticket.title.replace(/\s+/g, " ").trim()}`,
                        description: `${desc}\n\nCloses #${gl![2]}`,
                        draft: true,
                    }),
                });
                if (resp.status < 200 || resp.status >= 300) return fail(M("mrCreateFail", `HTTP ${resp.status} ${resp.body.slice(0, 160)}`));
                try { url = (JSON.parse(resp.body) as { web_url?: string }).web_url ?? ""; } catch { url = ""; }
            }
            if (!url) return fail(M(gh ? "prCreateFail" : "mrCreateFail", "no URL in response"));

            // 15. 幂等标记 + 收尾（审查 worktree 用完即弃；失败时保留供排查，启动 sweep 兜底）
            await fs.writeFile(markerPath, `${JSON.stringify({ at: new Date().toISOString(), platform: gh ? "github" : "gitlab", url, branch: pushBranch, base }, null, 2)}\n`, "utf-8");
            out(M("done", url));
            return { ok: true, url, branch: pushBranch, base };
        } finally {
            await fs.rm(bodyTmp, { force: true }).catch(() => { });
        }
    } finally {
        if (!worktreeReused) await g(["worktree", "remove", actualWt, "--force"]).catch(() => undefined);
    }
};
