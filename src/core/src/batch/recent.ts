/**
 * @file batch/recent.ts
 * @description 记忆策略窄口径方案 ②：同仓近况确定性提取（2026-11-12，路线 #12）。
 *
 *  批处理时代跨票知识的第一层（零检索、零 LLM、零相关性判断）：每票 body 尾部注入「本仓最近 N 票」，
 *  数据源 = done/ 报告 frontmatter（id/title/status/branch/repo 五字段确定性提取）。价值是防重做/撞车
 *  （agent 至少知道前票改动在哪条 dsc-wt-* 分支上，未合并不代表没做过），顺带缓解队列内基线过期。
 *
 *  「本仓」判定按报告 frontmatter 的 repo 字段（batchRunner 收尾落盘，2026-11-10）：
 *   - 跨仓票（repoRoot 非空）→ 只收 `repo:` 解析相等的目标仓报告；
 *   - 基座票（repoRoot 为 null）→ 只收【无】`repo:` 行的报告（旧报告无此行 = 基座，天然兼容）。
 *  顺序 = done/ 文件名字典序 = 票 id 时间序（id 由注入时钟预生成），不排序不检索；从最近往回扫、
 *  攒满 limit 即停（done/ 大时不必全读）。
 *
 *  红线：条目只含 frontmatter 字段（id/标题/状态/分支）——报告正文、diff、文件清单一律不进
 *  （注入面是模型上下文，近况是小体积事实清单不是摘要）；注入落点在 batchRunner（body 尾部），
 *  本模块只产出数据。fail-safe：done/ 不存在 / 单报告读失败 / frontmatter 残缺 → 跳过该条或返回空
 *  （零注入 = 成本回到现状，不会更糟）。
 *
 *  ★ 轻模块红线：只有 fs/path 级依赖，零 LLM（与 continuation.ts/pr.ts 同级）。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot } from "./queue.ts";

/** 缺省注入条数（方案 ②：默认 3）。 */
export const RECENT_TICKETS_LIMIT = 3;

/** 单条近况（渲染为 `- #id 标题 [状态] [分支]`，分支缺省省略段）。 */
export interface RecentTicketEntry {
    id: string;
    title: string;
    status: string;
    /** 产物分支；报告无 branch 行或值为占位串（worktree 未创建）→ null（渲染侧省略该段）。 */
    branch: string | null;
}

/** 报告 frontmatter 块提取（首个 `---...---` 段；无块 = 残缺报告）。只在该块内找字段——
 *  报告正文/diff 段里同名行（如任务正文引用工单 frontmatter）不会被误当字段值。 */
const frontmatterBlock = (report: string): string =>
    /^---\r?\n([\s\S]*?)\r?\n---/.exec(report)?.[1] ?? "";

/** 分支名形状闸（与 continuation.ts continuationBaseBranch 同款）：占位串（「（未创建）」等）不当分支。 */
const BRANCH_RE = /^[\w][\w./-]*$/;

/** 块内单行字段值（frontmatter 值必单行，first match 即字段值）。 */
const fmValue = (block: string, key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block);
    return m ? m[1].trim() : "";
};

/**
 * 单份报告文本 → 近况条目；frontmatter 残缺（无块/无 status）→ null（调用方跳过，不炸整批）。
 * 导出供守门测试直接验证（占位分支剔除、字段提取、残缺隔离）。
 */
export const parseRecentEntry = (report: string, id: string): RecentTicketEntry | null => {
    const block = frontmatterBlock(report);
    if (!block) return null;
    const status = fmValue(block, "status");
    if (!status) return null; // 无 status = 不完整的报告头（半截文件），不当近况条目
    const branchRaw = fmValue(block, "branch");
    return {
        id,
        title: fmValue(block, "title") || id, // 标题缺失回退 id（不渲染空标题行）
        status,
        branch: branchRaw && BRANCH_RE.test(branchRaw) ? branchRaw : null,
    };
};

/**
 * 「本仓」匹配：repoRoot=null（基座票）→ 只收无 `repo:` 行的报告；跨仓 → `repo:` 与目标仓根
 * resolve 相等（报告侧写盘时已归一正斜杠，resolve 抹平两斜写法；解析失败 fail-closed 不匹配）。
 */
export const matchesRepo = (report: string, repoRoot: string | null): boolean => {
    const repo = fmValue(frontmatterBlock(report), "repo");
    if (repoRoot === null) return repo === "";
    if (!repo) return false;
    try {
        return path.resolve(repo) === path.resolve(repoRoot);
    } catch {
        return false;
    }
};

/**
 * 读 done/ 报告提取本仓最近 N 票（时间序，旧→新）。任何失败路径都回落为更少条目或空数组——
 * 近况是增益不是关键路径，绝不因它拦票。
 */
export const readRecentTickets = async (args: { repoRoot: string | null; limit?: number }): Promise<RecentTicketEntry[]> => {
    const limit = Math.max(1, Math.floor(args.limit ?? RECENT_TICKETS_LIMIT));
    const doneDir = path.join(batchQueueRoot(), "done");
    let files: string[];
    try {
        files = (await fs.readdir(doneDir)).filter((f) => f.endsWith(".report.md")).sort();
    } catch {
        return []; // done/ 不存在 = 无历史票（正常态，零注入）
    }
    const out: RecentTicketEntry[] = [];
    for (const f of [...files].reverse()) { // 从最近往回扫，攒满 limit 即停
        const raw = await fs.readFile(path.join(doneDir, f), "utf-8").catch(() => null);
        if (raw === null) continue; // 单报告读失败：跳过不炸
        const id = f.replace(/\.report\.md$/, "");
        const entry = parseRecentEntry(raw, id);
        if (!entry || !matchesRepo(raw, args.repoRoot)) continue;
        out.push(entry);
        if (out.length >= limit) break;
    }
    return out.reverse(); // 回时间序（旧→新）：注入按时间线读，最新一票在最末
};
