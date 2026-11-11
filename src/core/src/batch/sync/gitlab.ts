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
import { writeFile as fsWriteFile } from "fs/promises";
import type { SyncCandidate } from "./github.ts";
import type { GitlabSourceConfig, SyncLocale } from "./config.ts";
import { COMMENTS_IN_FINGERPRINT, type SyncCommentRef } from "./state.ts";
import type { DownloadFile } from "./attachments.ts";

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

/** 项目详情（P2 仓库一致性标注 + MR 目标分支）：GET /projects/:id。 */
export interface GitlabProjectInfo {
    pathWithNamespace: string;
    defaultBranch: string;
}

/**
 * 取项目详情（path_with_namespace / default_branch）。非 2xx 或解析失败抛错（调用方降级处理）。
 */
export const fetchGitlabProject = async (config: GitlabSourceConfig, projectId: number, opts: { fetchImpl: SyncFetch; locale?: SyncLocale }): Promise<GitlabProjectInfo> => {
    const locale = opts.locale ?? "zh";
    const msg = GL_MSG[locale] ?? GL_MSG.zh;
    const token = process.env[config.tokenEnv];
    if (!token) throw new Error(msg.tokenMissing(config.tokenEnv));
    const url = `${config.baseUrl.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(String(projectId))}`;
    const r = await opts.fetchImpl(url, { headers: { "PRIVATE-TOKEN": token } });
    if (r.status < 200 || r.status >= 300) throw new Error(msg.httpFail(String(r.status)));
    const p = JSON.parse(r.body) as { path_with_namespace?: string; default_branch?: string };
    if (!p || typeof p.path_with_namespace !== "string" || !p.path_with_namespace) throw new Error(msg.badShape());
    return { pathWithNamespace: p.path_with_namespace, defaultBranch: typeof p.default_branch === "string" && p.default_branch ? p.default_branch : "main" };
};

/**
 * 取一个 issue 最近 N 条 note 的 (id, updated_at) 轨迹（P2 续修指纹；GitLab 无 issue list 级
 * comments 字段，只能逐 issue 拉 notes——N+1 可接受：候选已被 label 过滤，量小）。
 * 系统 note（重开/关单等状态事件）一并计入——重开即轨迹变化，天然的 reopen 信号。
 * 失败返回 undefined（评论轨迹缺席不阻塞建票；标题/正文指纹仍有效）。
 */
export const fetchGitlabNotes = async (config: GitlabSourceConfig, projectId: number, iid: number, opts: { fetchImpl: SyncFetch }): Promise<SyncCommentRef[] | undefined> => {
    const token = process.env[config.tokenEnv];
    if (!token) return undefined;
    const url = `${config.baseUrl.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(String(projectId))}/issues/${iid}/notes?sort=desc&per_page=${COMMENTS_IN_FINGERPRINT}`;
    try {
        const r = await opts.fetchImpl(url, { headers: { "PRIVATE-TOKEN": token } });
        if (r.status < 200 || r.status >= 300) return undefined;
        const notes = JSON.parse(r.body) as { id?: number | string; updated_at?: string }[];
        if (!Array.isArray(notes)) return undefined;
        return notes.slice(0, COMMENTS_IN_FINGERPRINT).map((n) => ({ id: String(n?.id ?? ""), updatedAt: n?.updated_at ?? "" }));
    } catch {
        return undefined;
    }
};

/**
 * 从 issue 正文提取 GitLab 上传附件链接（图片/文件 markdown 与裸链接通吃），去重保序，上限 10 个。
 * 三种形态归一为绝对 URL：
 *  - 相对 `/uploads/<hash>/<file>`（旧版 markdown，相对项目根）→ origin + 项目路径 + 该段；
 *  - 全路径 `/<ns>/<p>/uploads/<hash>/<file>` → origin + 该段；
 *  - 绝对 `https://host/<ns>/<p>/uploads/...`（含 `/-/uploads/`）→ 原样。
 * @param issueWebUrl issue web_url（推断 origin 与项目路径；非法/缺省时相对链接跳过、绝对链接照收）。
 */
export const extractGitlabUploads = (body: string, issueWebUrl: string): string[] => {
    const out: string[] = [];
    let origin = "";
    let projectPath = "";
    try {
        const u = new URL(issueWebUrl);
        origin = u.origin;
        // web_url 形如 https://host/<ns>/<p>/-/issues/7 → 项目路径 = /- 之前的全部段
        projectPath = (u.pathname.split("/-/")[0] ?? "").replace(/\/+$/, "");
    } catch { /* web_url 非法：相对链接无法解析，仅收绝对链接 */ }
    // 匹配：绝对 URL（含 /uploads/ 段）或以边界起的 /...uploads/ 相对路径；字符集限 URL 安全 ASCII
    for (const m of body.matchAll(/https?:\/\/[^\s)"'<>]*\/(?:[\w.-]+\/)*uploads\/[^\s)"'<>]+|(?<=[>\s"'(=])\/(?:[\w.-]+\/)*uploads\/[^\s)"'<>]+/g)) {
        let url = m[0].replace(/[.,;:!?]+$/, "");
        if (!/^https?:\/\//i.test(url)) {
            if (!origin) continue;
            url = url.startsWith("/uploads/") ? `${origin}${projectPath}${url}` : `${origin}${url}`;
        }
        if (!out.includes(url)) out.push(url);
    }
    return out.slice(0, 10);
};

/**
 * GitLab 附件二进制下载（缺省实现：global fetch + arrayBuffer → Buffer；PRIVATE-TOKEN 头）。
 * 与 SyncFetch（文本）分开：附件是二进制，文本通道会坏。测试注入假实现。
 */
export type GitlabDownloadBinary = (url: string, headers: Record<string, string>) => Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }>;

export const defaultGitlabDownloadBinary: GitlabDownloadBinary = async (url, headers) => {
    try {
        const r = await fetch(url, { headers });
        if (r.status < 200 || r.status >= 300) return { ok: false, reason: `HTTP ${r.status}` };
        const buf = Buffer.from(await r.arrayBuffer());
        return { ok: true, bytes: buf };
    } catch (e: any) {
        return { ok: false, reason: String(e?.message ?? e) };
    }
};

/** token 缺设时逐附件的未读取原因（fail-closed：不静默装作下载成功）。 */
const glDlTokenMissing = (tokenEnv: string): string =>
    `GitLab 附件下载不可用：环境变量 ${tokenEnv} 未设置（token 只走环境变量，sync.json 只存变量名）`;

/**
 * 造一个 GitLab 附件下载器（DownloadFile 形状，与 GitHub 侧同一签名——processAttachmentList 不分支）。
 * PRIVATE-TOKEN 从 tokenEnv 环境变量读；token 缺设时返回的下载器对每个附件都回未读取（原因写明缺 token），
 * 不抛错——附件不可读只降级标注，不阻塞建票。
 */
export const makeGitlabDownloadFile = (config: GitlabSourceConfig, opts?: { binary?: GitlabDownloadBinary }): DownloadFile => {
    const binary = opts?.binary ?? defaultGitlabDownloadBinary;
    return async (url, destAbs) => {
        const token = process.env[config.tokenEnv];
        if (!token) return { ok: false, reason: glDlTokenMissing(config.tokenEnv) };
        const r = await binary(url, { "PRIVATE-TOKEN": token });
        if (!r.ok) return r;
        try {
            await fsWriteFile(destAbs, r.bytes);
            return { ok: true, sizeBytes: r.bytes.length };
        } catch (e: any) {
            return { ok: false, reason: String(e?.message ?? e) };
        }
    };
};

/**
 * 拉取一个 GitLab 项目的准入 issue（opened + label），逐 issue 附带 notes 指纹轨迹。
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
                comments: await fetchGitlabNotes(config, projectId, i.iid, { fetchImpl: opts.fetchImpl }),
            });
        }
        const next = (r.headers["x-next-page"] ?? "").trim();
        if (!next || ++page > MAX_PAGES) break;
    }
    return out;
};
