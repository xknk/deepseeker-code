/**
 * @file batch/sync/sync.ts
 * @description 多入口工单流水线：`batch sync` 编排器（§5.2 + P2 续修 §6.2）——拉候选 → 三态去重
 *  （指纹变化 → 迁移/续修）→ 规则闸 → 验收解析 → 组装工单（引用块边界）→ enqueueTicketFile 入队
 *  （复用全部既有校验，不绕过 accept 必填）。
 *
 *  ★ 轻模块红线：零 LLM 调用，不 import agent/LLM 链；gh/HTTP 全部可注入（exec.ts / M3 fetch）。
 *  ★ --dry-run：只打印不落盘——不取锁、不记 state、不建票文件（预演也是零副作用）。
 *  ★ 一切失败 fail-closed：配置错/拉取错/锁被占 → 拒绝继续；候选级失败只跳过该候选并记录。
 *  ★ P2 续修（§6.2）：指纹变化且前票 verdict=work 且前票已入 done → 生成续修票（continues），
 *    继承前票 setup/accept/budget/timeout；前票未跑完 → 保留旧指纹下轮重试；P1 存量指纹（无 v2
 *    前缀）→ 只迁移不续修（防升级首跑续修洪水）。
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { batchQueueRoot, enqueueTicketFile, readReport } from "../queue.ts";
import { generateBatchId, parseBatchTicket } from "../ticket.ts";
import { buildContinuationTicketSource, doneTicketPath, extractPrevReportSummary, findDoneTicketIdBySourceId } from "../continuation.ts";
import { loadSyncConfig, type SyncConfig, type SyncLocale } from "./config.ts";
import { acquireSyncLock, releaseSyncLock } from "./lock.ts";
import { loadSyncState, appendSyncState, syncFingerprint, deduceVerdict, needsFingerprintMigration, todayTicketCount, type SyncStateEntry } from "./state.ts";
import { fetchGithubIssues, SyncPullError, type SyncCandidate } from "./github.ts";
import { fetchGitlabIssues, fetchGitlabProject, extractGitlabUploads, makeGitlabDownloadFile, defaultSyncFetch, type SyncFetch } from "./gitlab.ts";
import { applyRuleGate, normalizeTitle } from "./rulegate.ts";
import { resolveAccept, missingAcceptShort, externalAcceptNote, type AcceptResolution } from "./accept.ts";
import { buildQuotedExternalBody, QUOTE_PREAMBLE } from "./boundary.ts";
import { processAttachmentList, extractUserAttachments, defaultDownloadFile, type DownloadFile, type SyncAttachmentResult } from "./attachments.ts";
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
    /** GitLab 附件下载注入（P2；缺省 PRIVATE-TOKEN fetch 二进制下载）。 */
    gitlabDownload?: DownloadFile;
    /** 输出通道（缺省 process.stdout.write；测试捕获断言）。 */
    out?: (line: string) => void;
}

export interface SyncSummary {
    /** 新增建票数（含续修票）。 */
    added: number;
    /** 跳过数（已见未变 / 已见且变 / 迁移）。 */
    skipped: number;
    /** 规则闸拒绝数。 */
    rejected: number;
    /** 缺验收拒绝数。 */
    missingAccept: number;
    /** 因 maxTicketsPerDay 未建票的候选数（M6：超限不建票，摘要写明）。 */
    capped: number;
    /** 续修票数（P2；added 的子集，摘要单独一列）。 */
    continued: number;
}

const sanitizeTitle = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, 120);

// ============ 仓库一致性标注（DS 评审第四条，2026-11-04 拍板：不阻断 + 显式标注 + 强制 needs-review） ============

/** `git remote -v` 输出行形态：`<name>\t<url> (fetch|push)`。 */
const REMOTE_LINE_RE = /^\S+\t(\S+) \((?:fetch|push)\)$/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 从 remote URL 提取 `<host>/<repo-path>`（统一键形状；github 与 gitlab 自建 host 通用）。
 *  https://h/p 、ssh://git@h/p 、git@h:p 三形态，.git 后缀可无。 */
const parseRemoteRepo = (url: string, host: string): string | null => {
    const h = escapeRe(host);
    let m = new RegExp(`^(?:https?://|ssh://git@)${h}[/:](.+?)(?:\\.git)?/?$`, "i").exec(url);
    if (!m) m = new RegExp(`^git@${h}:(.+?)(?:\\.git)?/?$`, "i").exec(url);
    return m ? `${host}/${m[1]}`.toLowerCase() : null;
};

/**
 * 本地仓库在指定 host 上的 remote 集合（小写 `<host>/<path>`）。比对【所有】 remote 而非仅 origin——
 * fork 工作流（origin=fork、upstream=源仓库）任一匹配即视为一致，不误报。
 * - git 不可用 / 非仓库 / 输出无一行合法 remote 形态 → null（无法判定，不标注；假 exec 的
 *   全链路测试对任何调用都回 issue JSON，此规则让它们天然免疫，无需感知本探测）；
 * - 有合法 remote 行但没有任何该 host 远端 → 空集（有效判定：全不一致，标注）。
 */
export const collectLocalHostRepos = async (exec: SyncExec, projectRoot: string, host: string): Promise<Set<string> | null> => {
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
        const u = parseRemoteRepo(m[1], host);
        if (u) repos.add(u);
    }
    return sawRemoteLine ? repos : null;
};

/** P1 兼容包装：github.com remote 集合（小写 owner/repo，无 host 前缀——既有测试钉此形状）。 */
export const collectLocalGithubRepos = async (exec: SyncExec, projectRoot: string): Promise<Set<string> | null> => {
    const all = await collectLocalHostRepos(exec, projectRoot, "github.com");
    if (all === null) return null;
    return new Set([...all].map((e) => e.slice("github.com/".length)));
};

/** 仓库不一致警示块（票内注记；首票与续修票共用同一文案事实）。expected = `<host>/<path>` 键。 */
export const repoMismatchBlock = (locale: SyncLocale, expected: string): string => {
    const head = locale === "zh" ? "仓库不一致警示" : "Repo mismatch warning";
    const note = locale === "zh"
        ? `issue 来自 ${expected}，但本地工作区的 git remote 不含该仓库——agent 将在本地代码库上改动并验收，可能答非所问。fork 工作流（本地是 fork、issue 来自上游）属有意为之可忽略；否则请核对 sync.json 对应源配置。本票已强制 needs-review。`
        : `The issue is from ${expected}, but no local git remote points at that repo — the agent will modify and verify against the LOCAL codebase, which may not match. A fork workflow (local fork, issue from upstream) is intentional and fine; otherwise check the matching source config in sync.json. needs-review is forced for this ticket.`;
    return `---\n${head}：${note}\n`;
};

/** 组装 sync 工单源文本（frontmatter + 引用块正文 + 验收来源注记 + 仓库不一致警示 + 附件段）。frontmatter 只给人与策略，agent 只见 body。 */
export const buildSyncTicketSource = (candidate: SyncCandidate, acc: AcceptResolution & { ok: true }, config: SyncConfig, locale: SyncLocale, att?: SyncAttachmentResult, repoMismatch?: string, preId?: string): string => {
    const lines = [
        "---",
        `title: ${sanitizeTitle(candidate.title)}`,
        `accept: ${acc.accept}`,
        `source: ${candidate.sourceId.split(":")[0]}`,
        candidate.url ? `source-url: ${candidate.url}` : null,
        `source-id: ${candidate.sourceId}`,
        acc.needsReview || att?.needsReview || repoMismatch ? "needs-review: true" : null,
        config.defaultBudgetYuan !== undefined ? `budget-yuan: ${config.defaultBudgetYuan}` : null,
        att?.dir && preId ? `attachments: batch/attachments/${preId}` : null,
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
    if (repoMismatch) text += repoMismatchBlock(locale, repoMismatch);
    // 附件段（M5/P2 双平台）：内联文本在引用块内、落盘给绝对路径、不可读标「未读取 + 原因」——绝不静默。
    if (att?.section) text += `\n${att.section}\n`;
    return text;
};

/** 单候选的完整处理：返回其计入的摘要桶（续修票计 added，续修张数经 summary.contained 另列）。 */
type SummaryKey = keyof SyncSummary;
type CandidateBucket = Exclude<SummaryKey, "continued"> | "changed";

const fileExists = async (p: string): Promise<boolean> => (await fs.stat(p).catch(() => null)) !== null;

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
    /** 附件下载注入（GitHub 链；缺省 gh api）。 */
    download: DownloadFile;
    /** GitLab 附件下载注入（P2；缺省 PRIVATE-TOKEN fetch 二进制，token 缺设逐附件标未读取）。 */
    gitlabDownload: DownloadFile;
    /** 期望的本地仓库键 `<host>/<path>`（""=无法判定不标注：github 从 sourceId 推导，gitlab 从项目详情）。 */
    expectedRepo: string;
    /** 本地 remote 集合（键 `<host>/<path>`；null=无法判定不标注）。 */
    localRepos: Set<string> | null;
    /** 续修张数经 summary.contained 直增（dry-run 也计——预演报的是「将会发生什么」）。 */
    summary: SyncSummary;
    /** M6 每日建票上限（缺省不限）；createdToday 共享计数（本 run 建票即增），capAnnounced 保证上限文案只打一次。 */
    maxPerDay?: number;
    createdToday?: { n: number };
    capAnnounced?: { v: boolean };
}): Promise<CandidateBucket> => {
    const { candidate, config, locale, dryRun, now, out } = args;
    const M = (k: string, ...a: any[]) => syncMsg(locale, k, ...a);
    const pre = dryRun ? M("dryRunPrefix") : "";
    const fingerprint = syncFingerprint(candidate.title, candidate.body, candidate.comments);
    const existing = args.state.get(candidate.sourceId);
    const deduce = deduceVerdict(existing, fingerprint);
    // fresh 兜底（存档缺失走全新管线）时给规则闸的标题集（摘本候选与前票标题）；null=用原集合
    let freshGateTitles: Set<string> | null = null;

    const isGithub = candidate.sourceId.startsWith("github:");
    const extractAttUrls = (): string[] => (isGithub ? extractUserAttachments(candidate.body) : extractGitlabUploads(candidate.body, candidate.url));
    const dryAttHint = (): void => {
        const n = extractAttUrls().length;
        if (n > 0) out(`${pre}${M("dryRunAttachments", n)}`);
    };
    // state 记录统一入口（dry-run 零写盘；extra 后展开——transient 可用旧指纹覆盖默认新指纹）
    const stateTouch = async (extra: Partial<SyncStateEntry>): Promise<void> => {
        if (dryRun) return;
        const base: SyncStateEntry = { sourceId: candidate.sourceId, seenAt: now().toISOString(), fingerprint, verdict: "work", title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined };
        await appendSyncState({ ...base, ...extra } as SyncStateEntry); // 调用方总是带 verdict/reason 覆盖默认
    };
    const capOk = (): boolean => {
        if (dryRun || args.maxPerDay === undefined || (args.createdToday?.n ?? 0) < args.maxPerDay) return true;
        if (args.capAnnounced && !args.capAnnounced.v) {
            out(M("capReached", args.maxPerDay));
            args.capAnnounced.v = true;
        }
        return false;
    };
    // 附件链（M5 GitHub / P2 GitLab 对齐三态）：先占票 id（附件目录按票命名），下载失败只标
    // 「未读取 + 原因」不阻塞建票；整体意外失败兜底成一条未读取段——宁可让它知道缺信息，不能让它猜。
    // 票 id 对所有源统一按注入时钟预生成：队列按文件名字典序当 FIFO，若非 github 源落到队列默认的
    // 真实墙钟，同 run 多源建票的排序就随现实时刻漂移——2026-11-04 CI 实锤（UTC 上午跑时区翻车）。
    const handleAttachments = async (ticketId: string): Promise<SyncAttachmentResult | undefined> => {
        const items = extractAttUrls().map((url) => ({ url, rawName: url.split("?")[0].split("/").pop() ?? "" }));
        if (items.length === 0) return undefined;
        try {
            return await processAttachmentList({ items, ticketId, locale, download: isGithub ? args.download : args.gitlabDownload });
        } catch (e: any) {
            const why = String(e?.message ?? e).slice(0, 120);
            return {
                section: locale === "zh" ? `### 附件——未读取：附件处理异常（${why}）` : `### Attachments — not read: processing error (${why})`,
                needsReview: false,
                anyAttachment: true,
            };
        }
    };
    // 临时文件写入 + 入队（续修/全新两路共用；入队失败回收附件目录防孤儿）
    const writeAndEnqueue = async (source: string, preId: string, attDir?: string): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> => {
        const tmp = path.join(os.tmpdir(), `dsc-sync-ticket-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
        try {
            await fs.writeFile(tmp, source, "utf-8");
            const enq = await enqueueTicketFile(tmp, locale, preId);
            if (!enq.ok && attDir) await fs.rm(attDir, { recursive: true, force: true }).catch(() => { });
            return enq;
        } finally {
            await fs.rm(tmp, { force: true }).catch(() => { });
        }
    };

    // 仓库一致性标注（DS 评审第四条，P2 泛化双平台）：多 repo 配置下改动与验收都发生在本地代码库
    // ——来源对不上时不阻断（fork 工作流合法），但控制台 + 票内显式标注并强制 needs-review。
    const repoMismatch = args.expectedRepo !== "" && args.localRepos !== null && !args.localRepos.has(args.expectedRepo) ? args.expectedRepo : undefined;

    // —— P2 续修（§6.2）：指纹变化 + 前票 verdict=work + 前票已入 done → 继承式续修票。
    // 返回：continued=已建（dry-run 则「将建」）；fresh=前票档缺失走全新票管线；
    // skipped/transient/capped=本轮不建（state 均已妥善落笔或按 dry-run 跳过）。
    const tryContinuation = async (): Promise<"continued" | "fresh" | "skipped" | "transient" | "capped" | "rejected"> => {
        const prev = existing as SyncStateEntry;
        if (prev.verdict !== "work") {
            // 上轮就没建票（被拒/缺验收）：无从「续修」，维持原结论——被拒票不因改文自动重放（防灌水循环）。
            out(`${pre}${M("changedNoBase", candidate.sourceId)}`);
            await stateTouch({ verdict: prev.verdict, reason: prev.reason });
            return "skipped";
        }
        const prevId = prev.ticketId ?? await findDoneTicketIdBySourceId(candidate.sourceId);
        if (!prevId) { out(`${pre}${M("changedNoPrev", candidate.sourceId)}`); return "fresh"; }
        const prevRaw = await fs.readFile(doneTicketPath(prevId), "utf-8").catch(() => null);
        const prevParsed = prevRaw !== null ? parseBatchTicket(prevRaw, locale) : null;
        if (!prevParsed?.ok) {
            // done/ 里没有：还在 pending/running → 本轮不建、保【旧】指纹（票跑完后的下轮以新指纹再进本分支）；
            // 哪都找不到 → 存档被 clean 清掉，无法继承验收/环境，走全新票管线。
            const queued = await fileExists(path.join(batchQueueRoot(), "pending", `${prevId}.md`))
                || await fileExists(path.join(batchQueueRoot(), "running", `${prevId}.md`));
            if (queued) {
                out(`${pre}${M("changedWaitRun", candidate.sourceId, prevId)}`);
                await stateTouch({ fingerprint: prev.fingerprint, verdict: "changed", ticketId: prevId });
                return "transient";
            }
            out(`${pre}${M("changedNoPrev", candidate.sourceId)}`);
            return "fresh";
        }
        const prevTicket = prevParsed.ticket;
        if (!capOk()) return "capped";
        // 规则闸：标题集去掉本候选与前票标题——标题未变的续修不该被 dupTitle 自拒
        const gateTitles = new Set(args.knownTitles);
        gateTitles.delete(normalizeTitle(candidate.title));
        if (prevTicket.title) gateTitles.delete(normalizeTitle(prevTicket.title));
        const gate = applyRuleGate(candidate, config, gateTitles, locale);
        if (!gate.work) {
            out(`${pre}${M("rejected", candidate.sourceId, gate.reason)}`);
            await stateTouch({ verdict: "reject", reason: gate.reason });
            return "rejected"; // 闸拒绝计 rejected 桶（与全新管线同口径；enqueue 失败才计 skipped）
        }
        if (repoMismatch) out(`${pre}${M("repoMismatch", repoMismatch)}`);
        if (dryRun) {
            dryAttHint();
            out(`${pre}${M("wouldContinue", prevId, sanitizeTitle(candidate.title))}`);
            return "continued";
        }
        const preId = generateBatchId(now());
        const att = await handleAttachments(preId);
        const prevSummary = extractPrevReportSummary(await readReport(prevId), locale);
        let source = buildContinuationTicketSource({ candidate, prevTicket, prevId, prevSummary, locale, extraNeedsReview: att?.needsReview, attachments: att?.dir ? `batch/attachments/${preId}` : undefined });
        if (repoMismatch) source += repoMismatchBlock(locale, repoMismatch);
        if (att?.section) source += `\n${att.section}\n`;
        const enq = await writeAndEnqueue(source, preId, att?.dir);
        if (!enq.ok) {
            out(M("continuationFail", candidate.sourceId, enq.error));
            await stateTouch({ verdict: "reject", reason: enq.error });
            return "skipped";
        }
        out(M("continued", enq.id, prevId, sanitizeTitle(candidate.title), candidate.sourceId));
        await stateTouch({ verdict: "work", ticketId: enq.id });
        args.knownTitles.add(normalizeTitle(candidate.title));
        if (args.createdToday) args.createdToday.n++;
        args.summary.continued++;
        return "continued";
    };

    // —— 已收录：skip / 迁移 / 续修（§6.2）——
    if (deduce !== "new") {
        if (deduce === "skip") {
            out(`${pre}${M("skipUnchanged", candidate.sourceId)}`);
            return "skipped";
        }
        // P2 迁移：P1 存量指纹（无 v2 前缀）缺评论轨迹——只刷新不续修（防升级首跑洪水）；
        // 原 verdict/ticketId 随新指纹保留，下轮起的指纹变化走正常续修判定。
        if (existing && needsFingerprintMigration(existing)) {
            out(`${pre}${M("migrated", candidate.sourceId)}`);
            await stateTouch({ verdict: existing.verdict, reason: existing.reason, ticketId: existing.ticketId });
            return "skipped";
        }
        out(`${pre}${M("changedNote", candidate.sourceId)}`);
        const r = await tryContinuation();
        if (r === "fresh") {
            // 前票档缺失：落到下方全新票管线（state 由该管线闭环）。标题集须摘掉本候选与前票标题
            // ——state 里还留着上轮标题，不摘会被 dupTitle 自拒（存档清理后的合法重做不该自拒）。
            freshGateTitles = new Set(args.knownTitles);
            freshGateTitles.delete(normalizeTitle(candidate.title));
            const prevTitle = (existing as SyncStateEntry | undefined)?.title;
            if (prevTitle) freshGateTitles.delete(normalizeTitle(prevTitle));
        }
        else if (r === "continued") return "added";
        else return r === "transient" ? "skipped" : r; // transient 计跳过（本轮确实没建票，下轮自动重试）
    }

    // —— 全新票管线（未见候选 / 续修兜底 changedNoPrev）——
    // M6 每日建票上限（§5.2.3）：超限不建票（state 不记——明日上限重置后这些候选自然重进管线）
    if (!capOk()) return "capped";

    // 规则闸（纯规则，无 LLM；续修 fresh 兜底时用摘过标题的集合）
    const gate = applyRuleGate(candidate, config, freshGateTitles ?? args.knownTitles, locale);
    if (!gate.work) {
        out(`${pre}${M("rejected", candidate.sourceId, gate.reason)}`);
        await stateTouch({ verdict: "reject", reason: gate.reason });
        return "rejected";
    }

    // 验收解析（M4 四档：配置 > 外部块[gated] > 自动探测 > 拒绝）
    const acc = await resolveAccept(candidate.title, candidate.body, config, locale, args.projectRoot);
    if (!acc.ok) {
        out(`${pre}${M("missingAccept", candidate.sourceId, missingAcceptShort(locale))}`);
        out(`${pre}   └ ${acc.reason.replace(/\n/g, "\n   ")}`);
        await stateTouch({ verdict: "missing-accept", reason: missingAcceptShort(locale) });
        return "missingAccept";
    }

    if (repoMismatch) out(`${pre}${M("repoMismatch", repoMismatch)}`);

    // 组装 + 入队（复用全部既有校验：accept 必填 / 字段白名单 fail-closed）
    if (dryRun) {
        out(`${pre}${M("wouldEnqueue", sanitizeTitle(candidate.title), candidate.sourceId, acc.origin)}`);
        dryAttHint(); // dry-run 零落盘——附件不下载，只盘点提示
        return "added";
    }
    const preId = generateBatchId(now());
    const att = await handleAttachments(preId);
    const source = buildSyncTicketSource(candidate, acc, config, locale, att, repoMismatch, preId);
    const enq = await writeAndEnqueue(source, preId, att?.dir);
    if (!enq.ok) {
        out(M("enqueueFail", candidate.sourceId, enq.error));
        await stateTouch({ verdict: "reject", reason: enq.error });
        return "rejected";
    }
    out(M("added", enq.id, sanitizeTitle(candidate.title), candidate.sourceId, acc.origin));
    await stateTouch({ verdict: "work", ticketId: enq.id });
    args.knownTitles.add(normalizeTitle(candidate.title));
    if (args.createdToday) args.createdToday.n++; // M6：本 run 建票计入当日上限
    return "added";
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

    const summary: SyncSummary = { added: 0, skipped: 0, rejected: 0, missingAccept: 0, capped: 0, continued: 0 };
    // M6 每日建票上限（§5.2.3）：createdToday 是共享计数（state 今日数起步、本 run 建票即增），
    // capAnnounced 保证「已达上限」文案只打一次；dry-run 不查上限（也不落盘）。
    const maxPerDay = config.maxTicketsPerDay;
    const createdToday = { n: !opts?.dryRun && maxPerDay !== undefined ? await todayTicketCount(now()) : 0 };
    const capAnnounced = { v: false };
    const projectRoot = opts?.projectRoot ?? process.cwd();
    // 仓库一致性标注（P2 泛化双平台）的惰性探测：按 host 缓存（键 `<host>/<path>`）；
    // --source gitlab 时只对 gitlab host 探测（「不发起 gh 调用」的测试口径对 git 同样成立）。
    const hostReposCache = new Map<string, Promise<Set<string> | null>>();
    const localReposFor = (host: string): Promise<Set<string> | null> => {
        if (!hostReposCache.has(host)) hostReposCache.set(host, collectLocalHostRepos(exec, projectRoot, host));
        return hostReposCache.get(host)!;
    };
    try {
        const state = await loadSyncState();
        const knownTitles = new Set<string>();
        for (const e of state.values()) {
            if (e.verdict === "work" && e.title) knownTitles.add(normalizeTitle(e.title));
        }

        // 3. 逐源拉取 + 逐候选处理（一个源挂掉不影响另一个——适配器互相独立，§2 原则 2）
        const runCandidates = async (candidates: SyncCandidate[], host: string | null, expectedRepo: string, gitlabDownload?: DownloadFile): Promise<void> => {
            const localRepos = host ? await localReposFor(host) : null;
            for (const candidate of candidates) {
                const bucket = await processCandidate({ candidate, config, state, knownTitles, locale, dryRun: opts?.dryRun === true, now, out, projectRoot, download: opts?.download ?? defaultDownloadFile, gitlabDownload: gitlabDownload ?? defaultDownloadFile, expectedRepo, localRepos, summary, maxPerDay, createdToday, capAnnounced });
                if (bucket === "changed") summary.skipped++;
                else summary[bucket]++;
            }
        };
        const wantGithub = config.github !== undefined && (opts?.source === undefined || opts.source === "github");
        if (wantGithub && config.github) {
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
                await runCandidates(candidates, "github.com", `github.com/${repo}`.toLowerCase());
            }
        }
        const wantGitlab = config.gitlab !== undefined && (opts?.source === undefined || opts.source === "gitlab");
        if (wantGitlab && config.gitlab) {
            const gl = config.gitlab;
            const fetchImpl: SyncFetch = opts?.fetchImpl ?? defaultSyncFetch;
            const glDownload = opts?.gitlabDownload ?? makeGitlabDownloadFile(gl);
            let glHost = "";
            try { glHost = new URL(gl.baseUrl).host; } catch { /* baseUrl 由配置校验兜底；再防御一层 */ }
            for (const projectId of gl.projects) {
                out(M("pulling", "gitlab", `project ${projectId}（label: ${gl.label}）`));
                // 增量游标：该项目已见候选的最大 updatedAt（省配额；重复候选由指纹去重兜底）
                let updatedAfter: string | undefined;
                for (const e of state.values()) {
                    if (e.sourceId.startsWith(`gitlab:${projectId}#`) && e.updatedAt && (!updatedAfter || e.updatedAt > updatedAfter)) {
                        updatedAfter = e.updatedAt;
                    }
                }
                let candidates: SyncCandidate[];
                try {
                    candidates = await fetchGitlabIssues(gl, projectId, { fetchImpl, updatedAfter, locale });
                } catch (e: any) {
                    out(M("pullFail", "gitlab", `project ${projectId}`, String(e?.message ?? e)));
                    continue;
                }
                // P2：项目详情（一致性标注的期望键 = <host>/<path_with_namespace>）。失败降级为不标注，不阻断拉票。
                let expectedRepo = "";
                if (glHost) {
                    try {
                        const info = await fetchGitlabProject(gl, projectId, { fetchImpl, locale });
                        expectedRepo = `${glHost}/${info.pathWithNamespace}`.toLowerCase();
                    } catch (e: any) {
                        out(M("glProjInfoFail", projectId, String(e?.message ?? e).slice(0, 120)));
                    }
                }
                await runCandidates(candidates, glHost || null, expectedRepo, glDownload);
            }
        }

        // 4. 摘要一行（§5.2 第 6 步）；续修张数与超限提示按需追加
        out(M("summary", summary.added, summary.skipped, summary.rejected, summary.missingAccept)
            + (summary.continued > 0 ? M("continuedSuffix", summary.continued) : "")
            + (summary.capped > 0 && maxPerDay !== undefined ? M("capSuffix", summary.capped, maxPerDay) : "")
            + (opts?.dryRun ? M("dryRunNote") : ""));
        return { ok: true, summary };
    } finally {
        if (locked) await releaseSyncLock();
    }
};
