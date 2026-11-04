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
import { loadSyncConfig, type SyncConfig, type SyncLocale } from "./config.ts";
import { acquireSyncLock, releaseSyncLock } from "./lock.ts";
import { loadSyncState, appendSyncState, syncFingerprint, deduceVerdict, type SyncStateEntry } from "./state.ts";
import { fetchGithubIssues, SyncPullError, type SyncCandidate } from "./github.ts";
import { fetchGitlabIssues, defaultSyncFetch, type SyncFetch } from "./gitlab.ts";
import { applyRuleGate, normalizeTitle } from "./rulegate.ts";
import { resolveAccept, missingAcceptShort, externalAcceptNote, type AcceptResolution } from "./accept.ts";
import { buildQuotedExternalBody, QUOTE_PREAMBLE } from "./boundary.ts";
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
}

const sanitizeTitle = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, 120);

/** 组装 sync 工单源文本（frontmatter + 引用块正文 + 验收来源注记）。frontmatter 只给人与策略，agent 只见 body。 */
export const buildSyncTicketSource = (candidate: SyncCandidate, acc: AcceptResolution & { ok: true }, config: SyncConfig, locale: SyncLocale): string => {
    const lines = [
        "---",
        `title: ${sanitizeTitle(candidate.title)}`,
        `accept: ${acc.accept}`,
        `source: ${candidate.sourceId.split(":")[0]}`,
        candidate.url ? `source-url: ${candidate.url}` : null,
        `source-id: ${candidate.sourceId}`,
        acc.needsReview ? "needs-review: true" : null,
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

    // 组装 + 入队（复用全部既有校验：accept 必填 / 字段白名单 fail-closed）
    if (dryRun) {
        out(`${pre}${M("wouldEnqueue", sanitizeTitle(candidate.title), candidate.sourceId, acc.origin)}`);
        return "added";
    }
    const source = buildSyncTicketSource(candidate, acc, config, locale);
    const tmp = path.join(os.tmpdir(), `dsc-sync-ticket-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
    try {
        await fs.writeFile(tmp, source, "utf-8");
        const enq = await enqueueTicketFile(tmp, locale);
        if (!enq.ok) {
            out(M("enqueueFail", candidate.sourceId, enq.error));
            await appendSyncState({ sourceId: candidate.sourceId, seenAt: now().toISOString(), fingerprint, verdict: "reject", reason: enq.error, title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined });
            return "rejected";
        }
        out(M("added", enq.id, sanitizeTitle(candidate.title), candidate.sourceId, acc.origin));
        await appendSyncState({ sourceId: candidate.sourceId, ticketId: enq.id, seenAt: now().toISOString(), fingerprint, verdict: "work", title: sanitizeTitle(candidate.title), updatedAt: candidate.updatedAt || undefined });
        args.knownTitles.add(normalizeTitle(candidate.title));
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

    const summary: SyncSummary = { added: 0, skipped: 0, rejected: 0, missingAccept: 0 };
    try {
        const state = await loadSyncState();
        const knownTitles = new Set<string>();
        for (const e of state.values()) {
            if (e.verdict === "work" && e.title) knownTitles.add(normalizeTitle(e.title));
        }

        // 3. 逐源拉取 + 逐候选处理（一个源挂掉不影响另一个——适配器互相独立，§2 原则 2）
        const runCandidates = async (candidates: SyncCandidate[]): Promise<void> => {
            for (const candidate of candidates) {
                const bucket = await processCandidate({ candidate, config, state, knownTitles, locale, dryRun: opts?.dryRun === true, now, out, projectRoot: opts?.projectRoot ?? process.cwd() });
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
                await runCandidates(candidates);
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
                    await runCandidates(await fetchGitlabIssues(gl, projectId, { fetchImpl, updatedAfter, locale }));
                } catch (e: any) {
                    out(M("pullFail", "gitlab", `project ${projectId}`, String(e?.message ?? e)));
                    continue;
                }
            }
        }

        // 4. 摘要一行（§5.2 第 6 步）
        out(M("summary", summary.added, summary.skipped, summary.rejected, summary.missingAccept) + (opts?.dryRun ? M("dryRunNote") : ""));
        return { ok: true, summary };
    } finally {
        if (locked) await releaseSyncLock();
    }
};
