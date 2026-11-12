/**
 * @file batch/repoMap.ts
 * @description 记忆策略窄口径方案 ③：仓库地图（2026-11-12，路线 #12）——按「仓库根 + HEAD SHA」
 *  键控的确定性结构速览缓存（基线缓存同款失效机制：代码一提交 SHA 即变，旧图自然作废，天然防 stale）。
 *
 *  ★ 口径修订（2026-11-12 定案，覆盖方案原文「某 SHA 首张票跑完时收尾生成」）：地图在【取票开工时】
 *  生成或读缓存（body 装配前）。算术问题：地图按 SHA 键控而仓库提交频繁，绝大多数票都是「该 SHA 的
 *  第一张」，收尾生成等于绝大多数票享受不到；开工时生成则首票即受益。确定性提取是纯 fs/git 读
 *  （毫秒级），不拖慢开工。
 *
 *  提取内容（宁缺毋滥——只报确定性结构事实，「目录职责」这类提炼不出来的宁可不上）：
 *   - package.json：name / scripts 里 test·build·typecheck·lint 族（≤8）/ workspaces globs；
 *   - 根 pom.xml：artifactId + <module> 清单（★ <parent> 块先剥——repoRoute 实锤：首匹配会抓到
 *     parent 坐标）；
 *   - 顶层目录名（2 层深度，黑名单与 repoRoute.SCAN_SKIP_DIRS 同款——刻意复制不导入：轻模块红线，
 *     不把 repoRoute 经 guard.ts 的依赖拖进本模块 import 图）；
 *   - 关键构建文件存在性（tsconfig.json / Makefile / go.mod / .github/workflows——只报名字）。
 *
 *  缓存：<queueRoot>/repo-map/<仓库键>-<SHA8>.md（仓库键 = sha256(resolve(仓库根)) 前 12 位）。
 *  命中即注入不重读源；SHA 变更自然 miss 重建；写入时修剪——每仓只留最近 5 份（SHA 键控文件不
 *  修剪，几个月就是几百个孤儿）。地图正文是数据行（pkg:/scripts:/… 白名单单行形态，无自由文本段），
 *  总量 ≤2KB——注入面是模型上下文，地图是小体积事实清单不是摘要；散文包装（这是什么/怎么用）
 *  在 batchStrings.repoMapNoteH（zh/en），不落缓存文件。
 *
 *  ★ 轻模块红线：只有 fs/path/crypto 与 childProcess 级 git 调用，零 LLM 零检索零 agent。
 *  fail-safe：非 git 仓 / HEAD 取不到 / 读文件失败 → null（零注入 = 成本回到现状，不会更糟），
 *  绝不因地图拦票。
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { batchQueueRoot } from "./queue.ts";

/** 每仓保留地图份数（写入时修剪，mtime 最新的前 N 份）。 */
export const REPO_MAP_KEEP = 5;
/** 各条目封顶（方案 ③：目录 ~15、scripts ~8；modules/workspaces 同量级随手钉死）。 */
export const REPO_MAP_CAPS = { dirs: 15, scripts: 8, modules: 8, workspaces: 6 } as const;
/** 地图正文总量红线（字节）——注入面是小体积事实清单，超预算整行丢弃加省略标记。 */
export const REPO_MAP_MAX_BYTES = 2048;

/** 目录黑名单（与 repoRoute.SCAN_SKIP_DIRS 同款；同上：复制不导入，守轻模块红线）。 */
const MAP_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next", ".turbo", ".cache", "coverage", ".pnpm-store"]);

/** 地图缓存目录：<queueRoot>/repo-map/。 */
export const repoMapDir = (): string => path.join(batchQueueRoot(), "repo-map");

/** 仓库键：sha256(resolve(仓库根)) 前 12 位（正反斜杠/尾斜杠写法差异归一）。 */
export const repoKeyOf = (repoRoot: string): string =>
    crypto.createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);

/** 单仓单 SHA 的缓存文件路径。 */
export const repoMapCachePath = (repoKey: string, sha8: string): string =>
    path.join(repoMapDir(), `${repoKey}-${sha8}.md`);

/** 单行化：注入面卫生——提取值一律压成无换行无控制字符的单行（白名单形态的前提），限长防单行爆量。 */
const oneLine = (s: string, max = 160): string =>
    s.replace(/[\r\n\t\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();

/** 提取产物（全字段可选——有什么报什么，宁缺毋滥）。 */
export interface RepoMapFacts {
    pkgName?: string;
    /** 已格式化的 `脚本名=命令` 对（只含 test·build·typecheck·lint 族）。 */
    scripts?: [string, string][];
    workspaces?: string[];
    pomArtifactId?: string;
    pomModules?: string[];
    /** `dir/`、`dir/sub/` 形态（2 层深度，黑名单外）。 */
    dirs?: string[];
    /** 存在的关键构建文件名（只报名字，不读内容）。 */
    buildFiles?: string[];
}

/** package.json → 结构事实；非法 JSON / 空壳 → null。scripts 只取 test·build·typecheck·lint 族
 *  （dev/start/prepare 这类与「怎么验这个仓」无关的噪音不上图）。 */
export const extractPkgFacts = (raw: string): RepoMapFacts | null => {
    let pkg: any;
    try { pkg = JSON.parse(raw); } catch { return null; }
    if (!pkg || typeof pkg !== "object") return null;
    const out: RepoMapFacts = {};
    if (typeof pkg.name === "string" && pkg.name.trim()) out.pkgName = oneLine(pkg.name, 120);
    if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
        const picked: [string, string][] = [];
        for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) {
            if (typeof v !== "string" || !/(test|build|typecheck|lint)/i.test(k)) continue;
            picked.push([oneLine(k, 60), oneLine(v)]);
        }
        if (picked.length) out.scripts = picked;
    }
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : null;
    if (ws) {
        const globs = (ws as unknown[]).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => oneLine(x, 80));
        if (globs.length) out.workspaces = globs;
    }
    return Object.keys(out).length ? out : null; // 零事实 = 无段可渲染 → null（宁缺毋滥）
};

/** 根 pom.xml → artifactId + modules；<parent> 块先剥（首个 artifactId 必须是项目自身坐标，
 *  repoRoute 在 pms-parent 上实锤过 parent 坐标排前面）。无 artifactId → null（不当 pom 仓）。 */
export const extractPomFacts = (raw: string): { artifactId: string; modules: string[] } | null => {
    const body = raw.replace(/<parent\b[^>]*>[\s\S]*?<\/parent>\s*/g, " ");
    const aid = /<artifactId>\s*([^<]+?)\s*<\/artifactId>/.exec(body)?.[1];
    if (!aid) return null;
    const modules = [...body.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => oneLine(m[1], 120)).filter(Boolean);
    return { artifactId: oneLine(aid, 120), modules };
};

/** 顶层目录名（2 层深度）：点目录与黑名单剔除；每层显式排序（确定性，不依赖 readdir 顺序）。 */
export const listTopDirs = async (repoRoot: string): Promise<string[]> => {
    const out: string[] = [];
    let top: import("fs").Dirent[];
    try { top = await fs.readdir(repoRoot, { withFileTypes: true }); } catch { return out; }
    const level1 = top.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !MAP_SKIP_DIRS.has(e.name)).map((e) => e.name).sort();
    for (const d of level1) {
        out.push(`${d}/`);
        let sub: import("fs").Dirent[];
        try { sub = await fs.readdir(path.join(repoRoot, d), { withFileTypes: true }); } catch { continue; }
        for (const s of sub.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !MAP_SKIP_DIRS.has(e.name)).map((e) => e.name).sort()) {
            out.push(`${d}/${s}/`);
        }
    }
    return out;
};

/** 关键构建文件存在性（只报名字，不读内容；不存在不报——宁缺毋滥）。 */
export const listBuildFiles = async (repoRoot: string): Promise<string[]> => {
    const out: string[] = [];
    for (const [label, rel] of [
        ["tsconfig.json", "tsconfig.json"],
        ["Makefile", "Makefile"],
        ["go.mod", "go.mod"],
        [".github/workflows", path.join(".github", "workflows")], // 目录：存在即报
    ] as const) {
        try { await fs.stat(path.join(repoRoot, rel)); out.push(label); } catch { /* 不存在 = 不上图 */ }
    }
    return out;
};

const omitMore = (n: number): string => `... (+${n} more)`;
const TRUNCATED_LINE = "... (truncated)";

/**
 * 渲染（纯函数，守门测试直接验证）：白名单行形态 `pkg:/scripts:/workspaces:/pom:/modules:/build:/dirs:`
 * + 省略行。段序即优先级序（pkg/脚本/工作区/坐标/模块/构建文件/目录）；总量超 2KB 时从末尾整行丢弃
 * （目录清单在最后、也最可由 agent 现场 ls 得到，最先丢），丢后加省略标记行。零事实 → 空串。
 */
export const renderRepoMap = (f: RepoMapFacts): string => {
    const lines: string[] = [];
    if (f.pkgName) lines.push(`pkg: ${f.pkgName}`);
    if (f.scripts?.length) {
        const picked = f.scripts.slice(0, REPO_MAP_CAPS.scripts);
        lines.push(`scripts: ${picked.map(([k, v]) => `${k}=${v}`).join(" | ")}`);
        if (f.scripts.length > picked.length) lines.push(omitMore(f.scripts.length - picked.length));
    }
    if (f.workspaces?.length) {
        const picked = f.workspaces.slice(0, REPO_MAP_CAPS.workspaces);
        lines.push(`workspaces: ${picked.join(", ")}`);
        if (f.workspaces.length > picked.length) lines.push(omitMore(f.workspaces.length - picked.length));
    }
    if (f.pomArtifactId) {
        lines.push(`pom: ${f.pomArtifactId}`);
        if (f.pomModules?.length) {
            const picked = f.pomModules.slice(0, REPO_MAP_CAPS.modules);
            lines.push(`modules: ${picked.join(", ")}`);
            if (f.pomModules.length > picked.length) lines.push(omitMore(f.pomModules.length - picked.length));
        }
    }
    if (f.buildFiles?.length) lines.push(`build: ${f.buildFiles.join(", ")}`);
    if (f.dirs?.length) {
        const picked = f.dirs.slice(0, REPO_MAP_CAPS.dirs).map((d) => oneLine(d, 120));
        lines.push(`dirs: ${picked.join(" ")}`);
        if (f.dirs.length > picked.length) lines.push(omitMore(f.dirs.length - picked.length));
    }
    if (lines.length === 0) return "";
    if (Buffer.byteLength(lines.join("\n"), "utf-8") <= REPO_MAP_MAX_BYTES) return lines.join("\n");
    while (lines.length > 1 && Buffer.byteLength([...lines, TRUNCATED_LINE].join("\n"), "utf-8") > REPO_MAP_MAX_BYTES) lines.pop();
    return [...lines, TRUNCATED_LINE].join("\n");
};

/** 注入段（batchRunner 装配 buildBodyAppendix 的第二参）。body = 缓存正文（纯数据行）。 */
export interface RepoMapSection {
    repoName: string;
    sha8: string;
    body: string;
    fromCache: boolean;
}

/** HEAD SHA（git 只跑短命令 shell:false 无注入面；非 git 仓/裸仓失败 → null）。 */
const gitHeadSha = (cwd: string): Promise<string | null> =>
    new Promise((resolve) => {
        const child = spawn("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true, shell: false });
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => chunks.push(d));
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
            if (code !== 0) { resolve(null); return; }
            const out = Buffer.concat(chunks).toString("utf-8").trim();
            resolve(/^[0-9a-f]{40}$/i.test(out) ? out : null);
        });
    });

/** 修剪：每仓只留最近 REPO_MAP_KEEP 份（mtime 降序）。返回删除数；目录缺失/读失败 = 0（不抛）。 */
export const pruneRepoMaps = async (repoKey: string, keep: number = REPO_MAP_KEEP): Promise<number> => {
    const dir = repoMapDir();
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(`${repoKey}-`) && f.endsWith(".md"));
    if (files.length <= keep) return 0;
    const statd = await Promise.all(files.map(async (f) => {
        const st = await fs.stat(path.join(dir, f)).catch(() => null);
        return { f, m: st?.mtimeMs ?? 0 };
    }));
    statd.sort((a, b) => b.m - a.m);
    let removed = 0;
    for (const x of statd.slice(keep)) {
        if (await fs.rm(path.join(dir, x.f), { force: true }).then(() => true, () => false)) removed++;
    }
    return removed;
};

/**
 * 取票开工时入口（③ 定案口径）：生成或读缓存，首票即受益。
 *  - 命中：直接注入缓存正文，不重读源（提取零执行）；
 *  - 未命中：确定性提取（纯 fs 读）→ 渲染 → 落缓存 → 修剪旧份；
 *  - 任何失败（非 git 仓 / HEAD 取不到 / 读失败 / 零事实）→ null：零注入 = 成本回到现状，绝不拦票。
 */
export const loadRepoMap = async (args: { repoRoot: string }): Promise<RepoMapSection | null> => {
    const repoRoot = path.resolve(args.repoRoot);
    const sha = await gitHeadSha(repoRoot);
    if (!sha) return null; // 非 git 仓 / HEAD 取不到 → 零注入
    const sha8 = sha.slice(0, 8);
    const key = repoKeyOf(repoRoot);
    const cached = await fs.readFile(repoMapCachePath(key, sha8), "utf-8").catch(() => null);
    if (cached && cached.trim()) {
        return { repoName: path.basename(repoRoot), sha8, body: cached.trim(), fromCache: true };
    }
    const [pkgRaw, pomRaw, dirs, buildFiles] = await Promise.all([
        fs.readFile(path.join(repoRoot, "package.json"), "utf-8").catch(() => null),
        fs.readFile(path.join(repoRoot, "pom.xml"), "utf-8").catch(() => null),
        listTopDirs(repoRoot),
        listBuildFiles(repoRoot),
    ]);
    const facts: RepoMapFacts = { ...(pkgRaw ? extractPkgFacts(pkgRaw) ?? {} : {}), dirs, buildFiles };
    if (pomRaw) {
        const pom = extractPomFacts(pomRaw);
        if (pom) { facts.pomArtifactId = pom.artifactId; facts.pomModules = pom.modules; }
    }
    const body = renderRepoMap(facts);
    if (!body) return null; // 一个事实都提不出来（空目录且无包/构建文件）→ 零注入
    await fs.mkdir(repoMapDir(), { recursive: true }).catch(() => { });
    await fs.writeFile(repoMapCachePath(key, sha8), body, "utf-8").catch(() => { }); // 写缓存失败 = 本次仍注入，只是下次重生成
    await pruneRepoMaps(key).catch(() => { });
    return { repoName: path.basename(repoRoot), sha8, body, fromCache: false };
};
