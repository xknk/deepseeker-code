/**
 * @file batch/sync/gitlab.ts
 * @description 多入口工单流水线 P1-M3：GitLab 拉模式适配器（§5.2 第 1 步）——API v4 经可注入 fetch。
 *
 *  - token：从 tokenEnv 声明的环境变量读（缺设 fail-closed 报错）；变量名存 sync.json、
 *    token 本体永不入文件（§3.2）。HTTP 头 PRIVATE-TOKEN 直传，不落任何盘。
 *  - 增量：updated_after = 该项目已见候选的最大 updatedAt（省配额，§5.2 第 1 步）；
 *    重复拉到的候选由指纹去重跳过，游标只做省流量不做正确性依赖。
 *  - 分页：X-Next-Page 头驱动（上限 50 页 fail-safe，防误配死循环）。
 *  - 与 GitHub 适配器同一统一候选形状（SyncCandidate），下游去重/闸门/建票不分支。
 */
import type { SyncCandidate } from "./github.ts";
import type { GitlabSourceConfig, SyncLocale } from "./config.ts";

/** 注入面：HTTP 调用（GitLab API）。测试注入假实现，不打真网。 */
export type SyncFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; body: string; headers: Record<string, string> }>;

/** 缺省实现：global fetch + 响应体文本 + 头转小写 map。 */
export const defaultSyncFetch: SyncFetch = async (url, init) => {
    const r = await fetch(url, { headers: init?.headers });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: r.status, body: await r.text(), headers };
};

const GL_MSG: Record<SyncLocale, Record<string, (...args: any[]) => string>> = {
    zh: {
        tokenMissing: (v) => `环境变量 ${v} 未设置（gitlab.tokenEnv 指向它）：在 shell 里 export 后再 sync，token 本体不进配置文件。`,
        httpFail: (v) => `GitLab API HTTP ${v}`,
        badJson: (v) => `GitLab 返回不是合法 JSON（HTTP ${v}）`,
        badShape: () => `GitLab 返回形态异常：期望 issue 数组`,
    },
    en: {
        tokenMissing: (v) => `Environment variable ${v} is not set (gitlab.tokenEnv points to it): export it in the shell before syncing; the token itself never goes into the config file.`,
        httpFail: (v) => `GitLab API HTTP ${v}`,
        badJson: (v) => `GitLab response is not valid JSON (HTTP ${v})`,
        badShape: () => `GitLab response shape unexpected: expected an issue array`,
    },
};

interface GlIssue {
    iid: number;
    title: string | null;
    description: string | null;
    web_url: string;
    updated_at: string;
    author?: { username?: string } | null;
}

const MAX_PAGES = 50;

/**
 * 拉取一个 GitLab 项目的准入 issue（opened + label）。
 * @param opts.updatedAfter 增量游标（ISO 8601）；缺省全量拉 open 集（首跑）。
 */
export const fetchGitlabIssues = async (config: GitlabSourceConfig, projectId: number, opts: { fetchImpl: SyncFetch; updatedAfter?: string; locale?: SyncLocale }): Promise<SyncCandidate[]> => {
    const locale = opts.locale ?? "zh";
    const msg = GL_MSG[locale] ?? GL_MSG.zh;
    const token = process.env[config.tokenEnv];
    if (!token) throw new Error(msg.tokenMissing(config.tokenEnv));
    const base = `${config.baseUrl.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(String(projectId))}/issues`;
    const qs = (page: number): string => {
        const p = new URLSearchParams({ labels: config.label, state: "opened", per_page: "100", page: String(page) });
        if (opts.updatedAfter) p.set("updated_after", opts.updatedAfter);
        return p.toString();
    };
    const headers = { "PRIVATE-TOKEN": token };
    const out: SyncCandidate[] = [];
    let page = 1;
    for (;;) {
        const r = await opts.fetchImpl(`${base}?${qs(page)}`, { headers });
        if (r.status < 200 || r.status >= 300) throw new Error(msg.httpFail(String(r.status)));
        let issues: GlIssue[];
        try {
            issues = JSON.parse(r.body) as GlIssue[];
        } catch {
            throw new Error(msg.badJson(String(r.status)));
        }
        if (!Array.isArray(issues)) throw new Error(msg.badShape());
        for (const i of issues) {
            out.push({
                sourceId: `gitlab:${projectId}#${i.iid}`,
                url: i.web_url ?? "",
                title: i.title ?? "",
                body: i.description ?? "",
                author: i.author?.username ?? "",
                updatedAt: i.updated_at ?? "",
            });
        }
        const next = (r.headers["x-next-page"] ?? "").trim();
        if (!next || ++page > MAX_PAGES) break;
    }
    return out;
};
