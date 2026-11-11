/**
 * @file batch/repoRoute.ts
 * @description 跨仓任务路由（2026-11-10 真机实锤 ij9q 引发）：飞书/工单说「在 lg-pms 项目生成 test 文件」
 *  时，目标仓库不是监听基座——旧 runner 只会从基座仓库开 worktree，agent 在自己工作区里找不到 lg-pms、
 *  写外部绝对路径又被工作区围栏熔断，只能诚实报告「写不进去」。本模块回答：这张工单该在哪个本机仓库执行。
 *
 *  两层判定（规则先行、宁窄勿宽）：
 *  1. 仓库索引：扫本机代码根目录（env DEEPSEEKER_REPO_SCAN_ROOTS 覆盖，缺省 = 基座上两级，如 D:/code）
 *     找 .git 仓库，提取辨识 token（目录名 / package.json name / 根 pom groupId+artifactId / origin 远端名），
 *     落 <queueRoot>/repo-index.json 缓存（TTL 24h，手动删即强制重建）。
 *  2. 规则匹配：从工单文本抓「复合标识符」（lg-pms / lg-wms-admin 这类带 - 或 . 的多段 token，纯单词
 *     如 test/npm 不参与，防误报），归一化后与各仓库 token 归一串做包含匹配（「lg-pms」→ lgpms ⊂
 *     com.zlgx.lg.pms 归一串——ij9q 里 agent 靠 groupId 认出的正是这条路）。命中需同时满足：
 *     唯一外部仓库 + 基座自身不命中 + 邻近词护栏（标识符后紧跟 项目/仓库/工程/repo/project，或前邻
 *     在/去/到/进入——「参考 lg-pms 的实现改本仓」不得误路由）。任一不满足 → null（落回基座，现行为）。
 *
 *  ★ 轻模块红线：零 LLM、零 SDK（与 continuation.ts 同级）；路由失败永远回基座（fail-safe = 现行为）。
 */
import fs from "fs/promises";
import path from "path";
import { getActiveWorkspaceRoot } from "@/tool/guard.ts";
import { batchQueueRoot } from "./queue.ts";

/** 索引里的一个本机仓库。tokens 为归一化辨识串（唯一即可溯源，含目录名/包名/坐标/远端名）。 */
export interface RepoRecord {
    /** 仓库根绝对路径（路由命中后作为 worktree 的 admin cwd）。 */
    dir: string;
    /** 目录名（人读；emit/报告用）。 */
    name: string;
    /** 归一化辨识串集合（小写、仅字母数字与 CJK；长度 ≥4）。 */
    tokens: string[];
}

export interface RepoIndex {
    /** ISO 构建时刻（TTL 判定）。 */
    builtAt: string;
    repos: RepoRecord[];
}

/** 归一化：小写、剔除非字母数字非 CJK——`lg-pms` / `com.zlgx.lg.pms` → `lgpms` / `comzlgxlgpms`。 */
export const normalizeIdent = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");

/**
 * 扫描根：env 覆盖（分隔符 `;`；POSIX 多根形态 `/a:/b` 额外接受 `:` 拆）；缺省 = 基座上两级。
 * ★ Windows 盘符冒号红线：`C:\x` 绝不能按 `:` 拆（拆出 ["C","\x"] 垃圾根）——只有「每段都是
 *   POSIX 绝对路径」时 `:` 才当分隔符；Windows 多根一律走 `;`（PATH 同款约定）。
 */
export const repoScanRoots = (): string[] => {
    const env = process.env.DEEPSEEKER_REPO_SCAN_ROOTS;
    if (env && env.trim()) {
        let parts = env.split(";");
        if (parts.length === 1 && env.includes(":")) {
            const colonParts = env.split(":");
            if (colonParts.length > 1 && colonParts.every((p) => p.trim().startsWith("/"))) parts = colonParts;
        }
        const roots = parts.map((p) => p.trim()).filter(Boolean);
        if (roots.length) return roots;
    }
    const base = getActiveWorkspaceRoot();
    return [path.dirname(path.dirname(base))];
};

/** 目录名黑名单（扫描下降剪枝——node_modules 内的嵌套仓不是「任务目标」级别的仓库）。 */
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".turbo", ".cache", "coverage", ".pnpm-store"]);
/** 最大扫描深度（相对每个扫描根）。 */
const MAX_SCAN_DEPTH = 3;
/** 归一 token 最小长度（lg/pms 这类两三字母碎片不参与，防海量误报）。 */
const MIN_TOKEN_LEN = 4;
/** 索引 TTL（毫秒，24h）。 */
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

/** 单仓库 token 提取：目录名 + package.json name + 根 pom groupId/artifactId + origin 远端名。读失败静默跳过。 */
const collectRepoTokens = async (repoDir: string): Promise<string[]> => {
    const raw = new Set<string>();
    raw.add(path.basename(repoDir));
    const pkgRaw = await fs.readFile(path.join(repoDir, "package.json"), "utf-8").catch(() => null);
    if (pkgRaw) {
        try { const pkg = JSON.parse(pkgRaw); if (typeof pkg?.name === "string") raw.add(pkg.name); } catch { /* 非法 package.json 忽略 */ }
    }
    const pomRaw = await fs.readFile(path.join(repoDir, "pom.xml"), "utf-8").catch(() => null);
    if (pomRaw) {
        // 剥掉依赖/构建/插件/仓库/profile 子树后再抓坐标：只留 parent 块 + 项目自身坐标——
        // ①全文首匹配会抓到 <parent> 的坐标（pms-parent 真机实锤：真坐标 com.zlgx.lg.pms 在 parent 之后）；
        // ②头部切片也不行（同 pom 的 <modules> 排在 parent 之前，真机实锤二连）；③全文全抓会把
        // 依赖管理的几十个外来坐标当噪声 token。非贪婪 + 反向引用配对闭合标签，嵌套同族块安全。
        const noise = /<(dependencyManagement|dependencies|build|pluginManagement|plugins|repositories|profiles|reporting)\b[^>]*>[\s\S]*?<\/\1>/g;
        const body = pomRaw.replace(noise, " ");
        const gs = [...body.matchAll(/<groupId>\s*([^<]+?)\s*<\/groupId>/g)].map((m) => m[1]);
        const as = [...body.matchAll(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/g)].map((m) => m[1]);
        for (const g of gs) raw.add(g);
        for (const a of as) raw.add(a);
        // 坐标按出现序配对（parent 对、自身对）——只加真实存在的组合，不做笛卡尔积
        const n = Math.min(gs.length, as.length);
        for (let i = 0; i < n; i++) raw.add(`${gs[i]}.${as[i]}`);
    }
    const cfgRaw = await fs.readFile(path.join(repoDir, ".git", "config"), "utf-8").catch(() => null);
    if (cfgRaw) {
        const url = /url\s*=\s*(\S+)/.exec(cfgRaw)?.[1];
        if (url) raw.add(path.basename(url.replace(/\.git$/, "")));
    }
    const tokens = new Set<string>();
    for (const r of raw) {
        const n = normalizeIdent(r);
        if (n.length >= MIN_TOKEN_LEN) tokens.add(n);
    }
    return [...tokens];
};

/** 递归扫描根目录找 git 仓库（含 .git 文件/目录均算——worktree/submodule 风格的 .git 文件也是仓库）。 */
const scanReposUnder = async (root: string, depth: number, out: RepoRecord[]): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: import("fs").Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
    // 本层是否是仓库：是则记录且不再向下扫（嵌套仓按子模块处理，不当独立目标）
    if (entries.some((e) => e.name === ".git")) {
        const tokens = await collectRepoTokens(root);
        if (tokens.length) out.push({ dir: root, name: path.basename(root), tokens });
        return;
    }
    for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || SCAN_SKIP_DIRS.has(e.name)) continue;
        await scanReposUnder(path.join(root, e.name), depth + 1, out);
    }
};

/** 构建仓库索引（扫全部根，去重跨根重复仓库）。 */
export const buildRepoIndex = async (roots: string[]): Promise<RepoIndex> => {
    const repos: RepoRecord[] = [];
    for (const r of roots) await scanReposUnder(path.resolve(r), 0, repos);
    const seen = new Set<string>();
    const deduped = repos.filter((x) => (seen.has(x.dir) ? false : (seen.add(x.dir), true)));
    return { builtAt: new Date().toISOString(), repos: deduped };
};

const indexCachePath = (): string => path.join(batchQueueRoot(), "repo-index.json");

/** 取索引（TTL 内读缓存；过期/缺失/损坏重建）。baseRoot 的仓库也进索引（护栏判定要用「基座是否也命中」）。 */
export const loadRepoIndex = async (): Promise<RepoIndex> => {
    const p = indexCachePath();
    try {
        const raw = await fs.readFile(p, "utf-8");
        const idx = JSON.parse(raw) as RepoIndex;
        if (Array.isArray(idx?.repos) && Date.now() - Date.parse(idx.builtAt) < INDEX_TTL_MS) return idx;
    } catch { /* 无缓存/损坏 → 重建 */ }
    const idx = await buildRepoIndex(repoScanRoots());
    await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => { });
    await fs.writeFile(p, JSON.stringify(idx, null, 2), "utf-8").catch(() => { });
    return idx;
};

/** 从文本抓复合标识符（至少一个 - 或 . 连接段；纯单词不抓——test/npm/go 这类噪声源）。 */
export const extractCompoundIdents = (text: string): string[] => {
    const out = new Set<string>();
    for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9]*(?:[-.][a-zA-Z0-9]+)+/g)) {
        const raw = m[0];
        // 归一后仍需 ≥4 且含字母（纯数字段如 1.2.3 是版本号，不是仓库标识）
        const n = normalizeIdent(raw);
        if (n.length >= MIN_TOKEN_LEN && /[a-z]/.test(n)) out.add(raw);
    }
    return [...out];
};

/** 邻近词护栏：标识符后紧跟 项目/仓库/工程/repo/project，或前邻 在/去/到/进入/open。「参考 X 的实现」不命中。 */
const hasProjectContext = (text: string, ident: string): boolean => {
    const esc = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${esc}\\s{0,4}(项目|仓库|工程|repo|project)`, "i").test(text)
        || new RegExp(`(?:在|去|到|进入|切换到|open|switch\\s+to)\\s{0,4}${esc}\\b`, "i").test(text);
};

/** 规则路由结果。repo=null 表示落回基座（不路由）。 */
export interface RepoRouteResult {
    repo: RepoRecord | null;
    /** 命中的标识符原文（emit/报告溯源）。 */
    matchedIdent?: string;
}

/**
 * 规则路由：唯一外部仓库命中 + 基座不命中 + 邻近词护栏，三条全过才路由；否则 null（现行为 fail-safe）。
 * @param text 工单标题+正文
 * @param index 仓库索引
 * @param baseRoot 监听/执行基座仓库根
 */
export const routeRepoByRules = (text: string, index: RepoIndex, baseRoot: string): RepoRouteResult => {
    const idents = extractCompoundIdents(text);
    if (!idents.length) return { repo: null };
    const baseNorm = normalizeIdent(path.basename(path.resolve(baseRoot)));
    let hit: { repo: RepoRecord; ident: string } | null = null;
    let ambiguous = false;
    for (const ident of idents) {
        if (!hasProjectContext(text, ident)) continue;
        const n = normalizeIdent(ident);
        for (const repo of index.repos) {
            const isBase = normalizeIdent(path.basename(path.resolve(repo.dir))) === baseNorm && path.resolve(repo.dir) === path.resolve(baseRoot);
            if (isBase) continue;
            if (repo.tokens.some((t) => t.includes(n) || n.includes(t))) {
                if (hit && hit.repo.dir !== repo.dir) { ambiguous = true; }
                else if (!hit) hit = { repo, ident };
            }
        }
    }
    if (ambiguous || !hit) return { repo: null };
    return { repo: hit.repo, matchedIdent: hit.ident };
};
