/**
 * @file batch/continuation.ts
 * @description 多入口工单流水线 P2：同 issue 续修链（§6.2）——sync 侧建票与 runner 侧基座解析的共享层。
 *
 *  身份键落地（§2 原则 4）：sync 发现已收录 source-id 的指纹变化（新评论/重开）→ 生成续修票
 *  （frontmatter `continues: <前票id>`）。三个硬约定：
 *  1. 继承前票 setup/accept/budget-yuan/timeout-min——验收与环境是「这个 issue 怎么算修好」的
 *     本地事实，不随外部正文变化重猜（也不重走 accept 解析序，防外部内容借续修换验收命令）。
 *  2. body = 前次报告摘要 + 新外部正文（引用块包裹）——frontmatter 不进模型上下文（§4.1 红线），
 *     agent 需要的续修语境必须显式写进 body；新外部内容与首票同等走 §4.3 边界（数据非指令）。
 *  3. 代码基座 = 前票产物分支（runner 侧 createWorktree 以 continuationBaseBranch 为 baseRef 检出），
 *     不从 main 重做——「不续接旧对话」说的是会话，不是代码。
 *
 *  ★ 轻模块红线：只有 fs/path 级依赖，零 LLM（与 sync/pr 同级）。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot, reportPath } from "./queue.ts";
import { parseBatchTicket, type BatchTicket } from "./ticket.ts";
import { buildQuotedExternalBody, QUOTE_PREAMBLE } from "./sync/boundary.ts";
import type { SyncCandidate } from "./sync/github.ts";
import type { SyncLocale } from "./sync/config.ts";

/** done/ 目录工单路径（queue 只导出 reportPath，这里补工单侧）。 */
export const doneTicketPath = (id: string): string => path.join(batchQueueRoot(), "done", `${id}.md`);

/**
 * 按 source-id 扫 done/ 工单找最近一张票（state 里 ticketId 缺失时的兜底——P1 时代的 changed
 * 条目不落 ticketId）。文件名字典序 = 时间序（票 id 由注入时钟预生成），取最大即最近。
 */
export const findDoneTicketIdBySourceId = async (sourceId: string): Promise<string | null> => {
    let files: string[];
    try {
        files = (await fs.readdir(path.join(batchQueueRoot(), "done")))
            .filter((f) => f.endsWith(".md") && !f.endsWith(".report.md"))
            .sort();
    } catch {
        return null;
    }
    for (const f of [...files].reverse()) {
        const id = f.replace(/\.md$/, "");
        const parsed = parseBatchTicket(await fs.readFile(path.join(batchQueueRoot(), "done", f), "utf-8").catch(() => ""));
        if (parsed.ok && parsed.ticket.sourceId === sourceId) return id;
    }
    return null;
};

/** 前票产物分支名（runner 侧续修基座）：读 done 报告 frontmatter `branch:`。无报告/无分支 → null。 */
export const continuationBaseBranch = async (prevId: string): Promise<string | null> => {
    const report = await fs.readFile(reportPath(prevId), "utf-8").catch(() => null);
    if (!report) return null;
    const m = /^branch:\s*(\S+)\s*$/m.exec(report);
    const branch = m?.[1];
    // 报告里 worktree 未创建时 branch 是「（未创建）」/占位串——用合法 ref 名形状把关，防拿占位串当分支
    return branch && /^[\w][\w./-]*$/.test(branch) ? branch : null;
};

/**
 * 前票跨仓路由结果（runner 侧续修继承，2026-11-10）：读 done 报告 frontmatter `repo:`。
 * 前票被路由到外部仓（如 lg-pms）时，续修票必须仍在该仓检出——分支只存在于那个仓库，
 * 落回基座仓 rev-parse 必失败、基座退化为 HEAD，前次修复成果就丢了。无报告/无 repo/目录已不存在 → null
 * （null = 基座仓，即不路由，现行为）。目录存在性校验：报告可能比磁盘活得久（外部删仓）。
 */
export const continuationRepoRoot = async (prevId: string): Promise<string | null> => {
    const report = await fs.readFile(reportPath(prevId), "utf-8").catch(() => null);
    if (!report) return null;
    const m = /^repo:\s*(\S+)\s*$/m.exec(report);
    const dir = m?.[1];
    if (!dir || !path.isAbsolute(dir)) return null;
    const stat = await fs.stat(dir).catch(() => null);
    return stat?.isDirectory() ? dir : null;
};

/** 前次改动文件清单封顶（与 batchRunner 生成端同口径；超出末尾补省略行带余量）。 */
const CHANGED_FILE_CAP = 30;
const CHANGED_MORE_NOTE = (n: number): string => `…（其余 ${n} 个略）`;

/**
 * 前次报告摘要（进续修票 body 的「前次结果摘要」段）：状态 + 花费 + 分支 + 改动文件清单 + 模型收尾汇报（截断）。
 * 改动清单收报告 frontmatter 全部 `changed-file:` 行（batchRunner 固化的 git numstat 事实）——续修票
 * 不用重新探索上票改了什么；与 1200 字截断分开计（那是对模型收尾汇报段的限制）。报告头尾与验收
 * 输出/diff 都不进——续修票 body 要小（撑爆上下文与引用块边界都无益）。
 */
export const extractPrevReportSummary = (report: string | null, locale: SyncLocale = "zh", maxChars = 1200): string => {
    if (!report) return locale === "zh" ? "（前次报告已不存在——存档可能被 clean 清理）" : "(previous report unavailable — archive may have been cleaned)";
    const fm = (key: string): string => {
        const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(report);
        return m ? m[1].trim() : "";
    };
    const lines = [
        `- 状态 / status: ${fm("status") || "?"}`,
        `- 花费 / cost: ${fm("cost-yuan") || "?"} 元`,
        `- 产物分支 / branch: ${fm("branch") || "?"}`,
    ];
    // 前次改动文件段（2026-11-05 打磨第一批）：旧报告没有 changed-file 行时整段不加（不炸）。
    const changedAll = [...report.matchAll(/^changed-file:\s*(.+)$/gm)].map((m) => m[1].trim());
    if (changedAll.length > 0) {
        const shown = changedAll.slice(0, CHANGED_FILE_CAP);
        if (changedAll.length > CHANGED_FILE_CAP) shown.push(CHANGED_MORE_NOTE(changedAll.length - CHANGED_FILE_CAP));
        lines.push("", "【前次改动文件 / previous changed files】", "", ...shown.map((f) => `- ${f}`));
    }
    // 模型收尾汇报段（zh/en 两种报告头都认；取到下一个 ## 为止）
    const sec = /^## (?:模型收尾汇报|Model final report)\s*$/m.exec(report);
    if (sec) {
        const rest = report.slice(sec.index + sec[0].length);
        const end = rest.search(/^## /m);
        const finalText = (end >= 0 ? rest.slice(0, end) : rest).trim();
        if (finalText) {
            const clipped = finalText.length > maxChars ? `${finalText.slice(0, maxChars)}…（截断）` : finalText;
            lines.push("", "【前次模型收尾汇报 / previous model final report】", "", clipped);
        }
    }
    return lines.join("\n");
};

export interface ContinuationBuildArgs {
    candidate: SyncCandidate;
    /** 前票解析结果（继承源）。 */
    prevTicket: BatchTicket;
    /** 前票 id（continues 字段 + body 引用）。 */
    prevId: string;
    /** 前次报告摘要文本（extractPrevReportSummary 所得）。 */
    prevSummary: string;
    locale?: SyncLocale;
    /** 本票新附件里有图（视觉注入新攻击面，与前票 needs-review 取或）。 */
    extraNeedsReview?: boolean;
    /** 附件落盘目录（相对 .deepseeker-code，如 batch/attachments/<id>；有落盘才写 fm）。 */
    attachments?: string;
}

/**
 * 组装续修票源文本。frontmatter 继承前票 setup/accept/budget-yuan/timeout-min/needs-review，
 * 新增 continues；body = 续修说明（含「基座已含前次改动、勿重做」）+ 前次摘要 + 引用块新外部正文。
 * ★ 新外部内容与首票同等走 §4.3 边界（引用块 + QUOTE_PREAMBLE）；batch 会话 system 段由
 * appendBatchBoundary 注入（session 前缀判定，续修票会话同为 batch-* 前缀，天然生效）。
 */
export const buildContinuationTicketSource = (args: ContinuationBuildArgs): string => {
    const locale = args.locale ?? "zh";
    const zh = locale === "zh";
    const t = args.prevTicket;
    const num = args.candidate.sourceId.split("#")[1] ?? "?";
    const head = zh
        ? `【续修票】本票续修前票 ${args.prevId}（同 issue 有新动态触发）。代码基座为前票产物分支：前次修复已包含在待检出的代码里，勿重做；只处理下方新动态。本次为全新会话，前次对话上下文不可见。`
        : `[Continuation] This ticket continues ${args.prevId} (new activity on the same issue). The code base is the previous ticket's artifact branch: the previous fix is already in the checked-out tree — do NOT redo it; only handle the new activity below. This is a fresh session; previous conversation context is not visible.`;
    const quoteLabel = zh ? `issue #${num} 新动态` : `issue #${num} new activity`;
    const lines = [
        "---",
        `title: ${args.candidate.title.replace(/\s+/g, " ").trim().slice(0, 120)}`,
        `accept: ${t.accept}`,
        t.setup ? `setup: ${t.setup}` : null,
        t.budgetYuan !== undefined ? `budget-yuan: ${t.budgetYuan}` : null,
        t.timeoutMin !== undefined ? `timeout-min: ${t.timeoutMin}` : null,
        `source: ${args.candidate.sourceId.split(":")[0]}`,
        args.candidate.url ? `source-url: ${args.candidate.url}` : null,
        `source-id: ${args.candidate.sourceId}`,
        `continues: ${args.prevId}`,
        t.needsReview || args.extraNeedsReview ? "needs-review: true" : null,
        args.attachments ? `attachments: ${args.attachments}` : null,
        "---",
        "",
        head,
        "",
        "## " + (zh ? "前次结果摘要" : "Previous result summary"),
        "",
        args.prevSummary,
        "",
        buildQuotedExternalBody(QUOTE_PREAMBLE[locale], quoteLabel, args.candidate.title, args.candidate.body),
    ];
    return lines.filter((l) => l !== null).join("\n") + "\n";
};
