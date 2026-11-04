/**
 * @file batch/sync/sync.ts
 * @description 多入口工单流水线 P1：`batch sync` 编排器（§5.2）——拉候选 → 三态去重 → 规则闸 →
 *  验收解析 → 组装工单（引用块边界）→ enqueueTicketFile 入队（复用全部既有校验，不绕过 accept 必填）。
 *
 *  ★ 轻模块红线：零 LLM 调用，不 import agent/LLM 链；gh/HTTP 全部可注入（exec.ts / M3 fetch）。
 *  ★ --dry-run：只打印不落盘——不取锁、不记 state、不建票文件（预演也是零副作用）。
 *  ★ 一切失败 fail-closed：配置错/拉取错/锁被占 → 拒绝继续；候选级失败只跳过该候选并记录。
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { enqueueTicketFile } from "../queue.ts";
import { generateBatchId } from "../ticket.ts";
import { loadSyncConfig, type SyncConfig, type SyncLocale } from "./config.ts";
import { acquireSyncLock, releaseSyncLock } from "./lock.ts";
import { loadSyncState, appendSyncState, syncFingerprint, deduceVerdict, todayTicketCount, type SyncStateEntry } from "./state.ts";
import { fetchGithubIssues, SyncPullError, type SyncCandidate } from "./github.ts";
import { fetchGitlabIssues, defaultSyncFetch, type SyncFetch } from "./gitlab.ts";
import { applyRuleGate, normalizeTitle } from "./rulegate.ts";
import { resolveAccept, missingAcceptShort, externalAcceptNote, type AcceptResolution } from "./accept.ts";
import { buildQuotedExternalBody, QUOTE_PREAMBLE } from "./boundary.ts";
import { processAttachments, extractUserAttachments, defaultDownloadFile, type DownloadFile, type SyncAttachmentResult } from "./attachments.ts";
import { defaultSyncExec, type SyncExec } from "./exec.ts";
import { syncMsg } from "./strings.ts";

export interface SyncOptions {
    /** 只同步指定源（--source github|gitlab）；缺省全部已配置源。 */
    source?: "github" | "gitlab";
    /** 预演：只打印将建/将跳过，不落任何盘。 */
    dryRun?: boolean;
    locale?: SyncLocale;
    /** 注入外部命令执行（测试用假 gh；缺省真 spawn）。 */
    exec?: SyncExec;
    /** 注入 HTTP（M3 GitLab；缺省 defaultSyncFetch 包装 global fetch）。 */
    fetchImpl?: SyncFetch;
    /** 测试时钟（state seenAt / 每日上限）。 */
    now?: () => Date;
    /** 自动探测的本地项目根（缺省 process.cwd()；测试传临时目录隔离宿主仓库形态）。 */
    projectRoot?: string;
    /** 附件下载注入（M5，测试用假下载器；缺省 gh api + fd 重定向）。 */
    download?: DownloadFile;
    /** 输出通道（缺省 process.stdout.write；测试捕获断言）。 */
    out?: (line: string) => void;
}

export interface SyncSummary {
    /** 新增建票数。 */
    added: number;
    /** 跳过数（已见未变 / 已见且变）。 */
    skipped: number;
    /** 规则闸拒绝数。 */
    rejected: number;
    /** 缺验收拒绝数。 */
    missingAccept: number;
    /** 因 maxTicketsPerDay 未建票的候选数（M6：超限不建票，摘要写明）。 */
    capped: number;
}

const sanitizeTitle = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, 120);

// ============ 仓库一致性标注（DS 评审第四条，2026-11-04 拍板：不阻断 + 显式标注 + 强制 needs-review） ============

/** `git remote -v` 输出行形态：`<name>\t<url> (fetch|push)`。 */
const REMOTE_LINE_RE = /^\S+\t(\S+) \((?:fetch|push)\)$/;
/** github.com remote URL（https / ssh://git@ / git@ 三形态，可带 .git 后缀），捕获 owner/repo。 */
const GH_REMOTE_RE = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;

/**
 * 本地仓库的 github remote 集合（小写 owner/repo）。比对【所有】 remote 而非仅 origin——
 * fork 工作流（origin=fork、upstream=源仓库）任一匹配即视为一致，不误报。
 * - git 不可用 / 非仓库 / 输出无一行合法 remote 形态 → null（无法判定，不标注；假 exec 的
 *   全链路测试对任何调用都回 issue JSON，此规则让它们天然免疫，无需感知本探测）；
 * - 有合法 remote 行但没有任何 github.com 远端 → 空集（有效判定：全不一致，标注）。
 */
export const collectLocalGithubRepos = async (exec: SyncExec, projectRoot: string): Promise<Set<string> | null> => {
    let r: { code: number; stdout: string; stderr: string };
    try {
        r = await exec("git", ["-C", projectRoot, "remote", "-v"]);
    } catch {
        return null;
    }
    if (r.code !== 0) return null;
    const repos = new Set<string>();
    let sawRemoteLine = false;
    for (const line of r.stdout.split("\n")) {
        const m = REMOTE_LINE_RE.exec(line.trim());
        if (!m) continue;
        sawRemoteLine = true;
        const u = GH_REMOTE_RE.exec(m[1]);
        if (u) repos.add(u[1].toLowerCase());
    }
    return sawRemoteLine ? repos : null;
};

/** 组装 sync 工单源文本（frontmatter + 引用块正文 + 验收来源注记 + 仓库不一致警示 + 附件段）。frontmatter 只给人与策略，agent 只见 body。 */
export const buildSyncTicketSource = (candidate: SyncCandidate, acc: AcceptResolution & { ok: true }, config: SyncConfig, locale: SyncLocale, att?: SyncAttachmentResult, repoMismatch?: string): string => {
    const lines = [
        "---",
        `title: ${sanitizeTitle(candidate.title)}`,
        `accept: ${acc.accept}`,
        `source: ${candidate.sourceId.split(":")[0]}`,
        candidate.url ? `source-url: ${candidate.url}` : null,
        `source-id: ${candidate.sourceId}`,
        acc.needsReview || att?.needsReview || repoMismatch ? "needs-review: true" : null,
        config.defaultBudgetYuan !== undefined ? `budget-yuan: ${config.defaultBudgetYuan}` : null,
        "---",
        "",
        buildQuotedExternalBody(QUOTE_PREAMBLE[locale], `issue #${candidate.sourceId.split("#")[1] ?? "?"}`, candidate.title, candidate.body),
    ];
    let text = lines.filter((l) => l !== null).join("\n") + "\n";
    // 验收来源注记（§3.5「探测到即注明」）：外部/探测来源必须让看票的人一眼知道 accept 哪来的。
    if (acc.origin !== "config") {
        const sourceDesc = acc.origin === "detect" ? (acc.detectSource ?? "") : externalAcceptNote(locale);
        const head = locale === "zh" ? "验收命令说明" : "Accept command note";
        text += `---\n${head}：accept 来自 ${sourceDesc}。\n`;
    }
    // 仓库不一致警示：多 repo 配置下改动与验收都发生在本地代码库——来源对不上时人必须在烧钱前看见。
    if (repoMismatch) {
        const head = locale === "zh" ? "仓库不一致警示" : "Repo mismatch warning";
        const note = locale === "zh"
            ? `issue 来自 github.com/${repoMismatch}，但本地工作区的 git remote 不含该仓库——agent 将在本地代码库上改动并验收，可能答非所问。fork 工作流（本地是 fork、issue 来自上游）属有意为之可忽略；否则请核对 sync.json 的 github.repos。本票已强制 needs-review。`
            : `The issue is from github.com/${repoMismatch}, but no local git remote points at that repo — the agent will modify and verify against the LOCAL codebase, which may not match. A fork workflow (local fork, issue from upstream) is intentional and fine; otherwise check github.repos in sync.json. needs-review is forced for this ticket.`;
        text += `---\n${head}：${note}\n`;
    }
    // 附件段（M5）：内联文本在引用块内、落盘给绝对路径、不可读标「未读取 + 原因」——绝不静默。
    if (att?.section) text += `\n${att.section}\n`;
    return text;
};

/** 单候选的完整处理：返回其计入的摘要桶。 */
type SummaryKey = keyof SyncSummary;
const processCandidate = async (args: {
    candidate: SyncCandidate;
    config: SyncConfig;
    state: Map<string, SyncStateEntry>;
    knownTitles: Set<string>;
    locale: SyncLocale;
    dryRun: boolean;
    now: () => Date;
    out: (line: string) => void;
    /** 自动探测的本地项目根（§3.5 探测的是本地仓库形态，不是远端）。 */
    projectRoot: string;
    /** 附件下载注入（M5；缺省 gh api）。 */
    download: DownloadFile;
    /** 本地 github remote 集合（仓库一致性标注；null=无法判定不标注，gitlab-only sync 传 null）。 */
    localRepos: Set<string> | null;
    /** M6 每日建票上限（缺省不限）；createdToday 共享计数（本 run 建票即增），capAnnounced 保证上限文案只打一次。 */
    maxPerDay?: number;
    createdToday?: { n: number };
    capAnnounced?: { v: boolean };
}): Promise<SummaryKey | "changed"> => {
    const { candidate, config, locale, dryRun, now, out } = args;
    const M = (k: string, ...a: any[]) => syncMsg(locale, k, ...a);
    const pre = dryRun ? M("dryRunPrefix") : "";
    const fingerprint = syncFingerprint(candidate.title, candidate.body);
    const existing = args.state.get(candidate.sourceId);
    const deduce = deduceVerdict(existing, fingerprint);

    if (deduce !== "new") {
        if (deduce === "changed") {
            out(`${pre}${M("changedNote", candidate.sourceId)}`);
            if (!dryRun) {
                await appendSyncState({ sourceId: candidate.sourceId, seenAt: now().toISOString(), fingerprint, verdict: "changed", title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined });
            }
            return "changed";
        }
        out(`${pre}${M("skipUnchanged", candidate.sourceId)}`);
        return "skipped";
    }

    // M6 每日建票上限（§5.2.3）：超限不建票（state 不记——明日上限重置后这些候选自然重进管线）
    if (!dryRun && args.maxPerDay !== undefined && (args.createdToday?.n ?? 0) >= args.maxPerDay) {
        if (args.capAnnounced && !args.capAnnounced.v) {
            out(M("capReached", args.maxPerDay));
            args.capAnnounced.v = true;
        }
        return "capped";
    }

    // 规则闸（纯规则，无 LLM）
    const gate = applyRuleGate(candidate, config, args.knownTitles, locale);
    if (!gate.work) {
        out(`${pre}${M("rejected", candidate.sourceId, gate.reason)}`);
        if (!dryRun) {
            await appendSyncState({ sourceId: candidate.sourceId, seenAt: now().toISOString(), fingerprint, verdict: "reject", reason: gate.reason, title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined });
        }
        return "rejected";
    }

    // 验收解析（M4 四档：配置 > 外部块[gated] > 自动探测 > 拒绝）
    const acc = await resolveAccept(candidate.title, candidate.body, config, locale, args.projectRoot);
    if (!acc.ok) {
        out(`${pre}${M("missingAccept", candidate.sourceId, missingAcceptShort(locale))}`);
        out(`${pre}   └ ${acc.reason.replace(/\n/g, "\n   ")}`);
        if (!dryRun) {
            await appendSyncState({ sourceId: candidate.sourceId, seenAt: now().toISOString(), fingerprint, verdict: "missing-accept", reason: missingAcceptShort(locale), title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined });
        }
        return "missingAccept";
    }

    // 仓库一致性标注（DS 评审第四条）：多 repo 配置下改动与验收都发生在本地代码库——来源对不上
    // 时不阻断（fork 工作流合法），但控制台 + 票内显式标注并强制 needs-review。GitLab 候选是
    // 项目 ID、对不齐 remote 路径，随 P2/P4 的 GitLab 附件链一起做。
    const issueRepo = candidate.sourceId.startsWith("github:") ? candidate.sourceId.slice("github:".length).split("#")[0].toLowerCase() : "";
    const repoMismatch = issueRepo !== "" && args.localRepos !== null && !args.localRepos.has(issueRepo) ? issueRepo : undefined;
    if (repoMismatch) out(`${pre}${M("repoMismatch", repoMismatch)}`);

    // 组装 + 入队（复用全部既有校验：accept 必填 / 字段白名单 fail-closed）
    if (dryRun) {
        out(`${pre}${M("wouldEnqueue", sanitizeTitle(candidate.title), candidate.sourceId, acc.origin)}`);
        // M5：dry-run 零落盘——附件不下载，只盘点提示（仅 GitHub 有下载链）
        if (candidate.sourceId.startsWith("github:")) {
            const found = extractUserAttachments(candidate.body).length;
            if (found > 0) out(`${pre}${M("dryRunAttachments", found)}`);
        }
        return "added";
    }
    // M5 附件链（仅 GitHub；GitLab/飞书随 P2/P4）：先占票 id（附件目录按票命名），下载失败只标
    // 「未读取 + 原因」不阻塞建票；整体意外失败兜底成一条未读取段——宁可让它知道缺信息，不能让它猜。
    // 票 id 对所有源统一按注入时钟预生成（github 先占只是附件目录要按票命名的起因）：队列按文件名
    // 字典序当 FIFO，若非 github 源落到队列默认的真实墙钟，同 run 多源建票的排序就随现实时刻漂移
    // ——2026-11-04 CI 实锤：UTC 上午跑，gitlab 票（08:29 生成）排到 github 票（注入 12:00）之前，
    // 双源测试时区性翻车；本地 UTC+8 下午跑则恒绿，典型「我机器上没问题」。
    const preId = generateBatchId(now());
    let att: SyncAttachmentResult | undefined;
    if (candidate.sourceId.startsWith("github:")) {
        try {
            att = await processAttachments({ issueBody: candidate.body, ticketId: preId, locale, download: args.download });
        } catch (e: any) {
            const why = String(e?.message ?? e).slice(0, 120);
            att = {
                section: locale === "zh" ? `### 附件——未读取：附件处理异常（${why}）` : `### Attachments — not read: processing error (${why})`,
                needsReview: false,
                anyAttachment: true,
            };
        }
    }
    const source = buildSyncTicketSource(candidate, acc, config, locale, att, repoMismatch);
    const tmp = path.join(os.tmpdir(), `dsc-sync-ticket-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
    try {
        await fs.writeFile(tmp, source, "utf-8");
        const enq = await enqueueTicketFile(tmp, locale, preId);
        if (!enq.ok) {
            if (att?.dir) await fs.rm(att.dir, { recursive: true, force: true }).catch(() => { }); // 防孤儿附件目录
            out(M("enqueueFail", candidate.sourceId, enq.error));
            await appendSyncState({ sourceId: candidate.sourceId, seenAt: now().toISOString(), fingerprint, verdict: "reject", reason: enq.error, title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined });
            return "rejected";
        }
        out(M("added", enq.id, sanitizeTitle(candidate.title), candidate.sourceId, acc.origin));
        await appendSyncState({ sourceId: candidate.sourceId, ticketId: enq.id, seenAt: now().toISOString(), fingerprint, verdict: "work", title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined });
        args.knownTitles.add(normalizeTitle(candidate.title));
        if (args.createdToday) args.createdToday.n++; // M6：本 run 建票计入当日上限
        return "added";
    } finally {
        await fs.rm(tmp, { force: true }).catch(() => { });
    }
};

/**
 * 执行一次 sync（§5.2 流程）。成功返回摘要；配置/锁/源级失败返回 {ok:false, error}（CLI 据此设退出码）。
 */
export const runSync = async (opts?: SyncOptions): Promise<{ ok: true; summary: SyncSummary } | { ok: false; error: string }> => {
    const locale = opts?.locale ?? "zh";
    const out = opts?.out ?? ((line: string) => process.stdout.write(line + "\n"));
    const now = opts?.now ?? (() => new Date());
    const exec = opts?.exec ?? defaultSyncExec;
    const M = (k: string, ...a: any[]) => syncMsg(locale, k, ...a);

    // 1. 配置（fail-closed：错配置绝不建票）
    const cfg = await loadSyncConfig({ locale });
    if (!cfg.ok) return { ok: false, error: cfg.error };
    const config = cfg.config;
    if (config.github === undefined && config.gitlab === undefined) {
        return { ok: false, error: M("sourceUnavailable") };
    }
    if (opts?.source === "github" && config.github === undefined) return { ok: false, error: M("noSource", "github") };
    if (opts?.source === "gitlab" && config.gitlab === undefined) return { ok: false, error: M("noSource", "gitlab") };

    // 2. 单飞锁（dry-run 不落盘 = 不取锁；定时器重叠时第二个直接退出）
    let locked = false;
    if (!opts?.dryRun) {
        const lock = await acquireSyncLock(locale);
        if (!lock.ok) return { ok: false, error: lock.error };
        locked = true;
    }

    const summary: SyncSummary = { added: 0, skipped: 0, rejected: 0, missingAccept: 0, capped: 0 };
    // M6 每日建票上限（§5.2.3）：createdToday 是共享计数（state 今日数起步、本 run 建票即增），
    // capAnnounced 保证「已达上限」文案只打一次；dry-run 不查上限（也不落盘）。
    const maxPerDay = config.maxTicketsPerDay;
    const createdToday = { n: !opts?.dryRun && maxPerDay !== undefined ? await todayTicketCount(now()) : 0 };
    const capAnnounced = { v: false };
    const projectRoot = opts?.projectRoot ?? process.cwd();
    // 仓库一致性标注的惰性探测：仅 github 源会比对（gitlab 候选是项目 ID 对不齐 remote 路径）；
    // --source gitlab 时一次 git 调用也不发（「不发起 gh 调用」的测试口径对 git 同样成立）。
    let localReposCache: { v: Set<string> | null } | undefined;
    const githubLocalRepos = async (): Promise<Set<string> | null> => {
        if (!localReposCache) localReposCache = { v: await collectLocalGithubRepos(exec, projectRoot) };
        return localReposCache.v;
    };
    try {
        const state = await loadSyncState();
        const knownTitles = new Set<string>();
        for (const e of state.values()) {
            if (e.verdict === "work" && e.title) knownTitles.add(normalizeTitle(e.title));
        }

        // 3. 逐源拉取 + 逐候选处理（一个源挂掉不影响另一个——适配器互相独立，§2 原则 2）
        const runCandidates = async (candidates: SyncCandidate[], localRepos: Set<string> | null): Promise<void> => {
            for (const candidate of candidates) {
                const bucket = await processCandidate({ candidate, config, state, knownTitles, locale, dryRun: opts?.dryRun === true, now, out, projectRoot, download: opts?.download ?? defaultDownloadFile, localRepos, maxPerDay, createdToday, capAnnounced });
                if (bucket === "changed") summary.skipped++;
                else summary[bucket]++;
            }
        };
        const wantGithub = config.github !== undefined && (opts?.source === undefined || opts.source === "github");
        if (wantGithub && config.github) {
            const localRepos = await githubLocalRepos();
            for (const repo of config.github.repos) {
                out(M("pulling", "github", `${repo}（label: ${config.github.label}）`));
                let candidates: SyncCandidate[];
                try {
                    candidates = await fetchGithubIssues(repo, config.github.label, exec, locale);
                } catch (e: any) {
                    const why = e instanceof SyncPullError ? e.message : String(e?.message ?? e);
                    out(M("pullFail", "github", repo, why));
                    continue;
                }
                await runCandidates(candidates, localRepos);
            }
        }
        const wantGitlab = config.gitlab !== undefined && (opts?.source === undefined || opts.source === "gitlab");
        if (wantGitlab && config.gitlab) {
            const gl = config.gitlab;
            const fetchImpl: SyncFetch = opts?.fetchImpl ?? defaultSyncFetch;
            for (const projectId of gl.projects) {
                out(M("pulling", "gitlab", `project ${projectId}（label: ${gl.label}）`));
                // 增量游标：该项目已见候选的最大 updatedAt（省配额；重复候选由指纹去重兜底）
                let updatedAfter: string | undefined;
                for (const e of state.values()) {
                    if (e.sourceId.startsWith(`gitlab:${projectId}#`) && e.updatedAt && (!updatedAfter || e.updatedAt > updatedAfter)) {
                        updatedAfter = e.updatedAt;
                    }
                }
                try {
                    // gitlab 候选传 null：项目 ID 无法与 remote 路径对齐，一致性标注随 P2/P4 GitLab 链一起做
                    await runCandidates(await fetchGitlabIssues(gl, projectId, { fetchImpl, updatedAfter, locale }), null);
                } catch (e: any) {
                    out(M("pullFail", "gitlab", `project ${projectId}`, String(e?.message ?? e)));
                    continue;
                }
            }
        }

        // 4. 摘要一行（§5.2 第 6 步）；超限时追加「今日已达上限 N」（M6）
        out(M("summary", summary.added, summary.skipped, summary.rejected, summary.missingAccept)
            + (summary.capped > 0 && maxPerDay !== undefined ? M("capSuffix", summary.capped, maxPerDay) : "")
            + (opts?.dryRun ? M("dryRunNote") : ""));
        return { ok: true, summary };
    } finally {
        if (locked) await releaseSyncLock();
    }
};
