/**
 * @file batch/sync/github.ts
 * @description 多入口工单流水线 P1：GitHub 拉模式适配器（§5.2 第 1 步）——gh issue list 经可注入 exec。
 *
 *  - 凭据零配置（L0）：gh 自认 GH_TOKEN 环境变量或已登录态，本模块不做任何 token 处理。
 *  - 拉取即过滤：`--label <label> --state open`——label 是人类显式意图，准入已在源头（§3.3）。
 *  - 输出 JSON 解析失败/gh 非零退出 → SyncPullError（人话 + gh stderr 尾部），fail-closed 不建票。
 */
import type { SyncExec } from "./exec.ts";

/** 统一候选（两平台适配器输出同一形状，下游去重/闸门/建票不分支）。 */
export interface SyncCandidate {
    /** 身份键：github:<owner/repo>#<number> / gitlab:<projectId>#<iid>。 */
    sourceId: string;
    /** 外部系统原文链接（frontmatter source-url，审计/回执用）。 */
    url: string;
    title: string;
    body: string;
    /** 作者（规则闸白名单比对）。 */
    author: string;
    /** 候选端最后更新时刻（ISO）。 */
    updatedAt: string;
}

/** 拉取失败（人话原因进 CLI 控制台；state 不记录——拉取失败不是候选级结论）。 */
export class SyncPullError extends Error {}

/** gh issue list 的输出行（--json 字段子集）。 */
interface GhIssue {
    number: number;
    title: string;
    body: string | null;
    url: string;
    updatedAt: string;
    author?: { login?: string } | null;
}

/**
 * 拉取一个仓库的准入 issue（open + label）。
 * @param ghVersion 见 gh --version 输出与否不影响；exec 由调用方注入（缺省真 gh）。
 */
export const fetchGithubIssues = async (repo: string, label: string, exec: SyncExec): Promise<SyncCandidate[]> => {
    const r = await exec("gh", [
        "issue", "list",
        "-R", repo,
        "--label", label,
        "--state", "open",
        "--json", "number,title,body,url,updatedAt,author",
    ]);
    if (r.code !== 0) {
        throw new SyncPullError(`gh issue list 失败（repo ${repo}，exit ${r.code}）：${r.stderr.trim().split("\n").slice(-3).join(" | ") || "（无 stderr）"}`);
    }
    let issues: GhIssue[];
    try {
        issues = JSON.parse(r.stdout) as GhIssue[];
    } catch (e: any) {
        throw new SyncPullError(`gh 输出不是合法 JSON（repo ${repo}）：${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (!Array.isArray(issues)) throw new SyncPullError(`gh 输出形态异常（repo ${repo}）：期望数组`);
    return issues.map((i) => ({
        sourceId: `github:${repo}#${i.number}`,
        url: i.url ?? "",
        title: i.title ?? "",
        body: i.body ?? "",
        author: i.author?.login ?? "",
        updatedAt: i.updatedAt ?? "",
    }));
};
