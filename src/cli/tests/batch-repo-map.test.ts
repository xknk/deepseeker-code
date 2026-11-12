/**
 * @file cli/tests/batch-repo-map.test.ts
 * @description 记忆策略窄口径 ③：仓库地图 runner 侧守门测试（2026-11-12，路线 #12）。
 *
 *  覆盖：开工时生成或读缓存（定案口径修订——SHA 键控下「首票收尾生成」等于绝大多数票享受不到）——
 *  同 SHA 二票注入同一份且不重复生成（mtime/文件数）/ 命中不重读源 / SHA 变更重建新文件 /
 *  修剪每仓 ≤5 / 内容形态白名单（pkg:/scripts:/… 数据行 + 省略行，条目封顶、≤2KB、无自由文本段）/
 *  提取纯函数（scripts 族过滤、parent 块剥离、单行化）/ 零地图幂等（fail-safe：非 git 仓 → null）/
 *  附录段序钉死 repoBodyNote → ③地图 → ②近况 → ①蒸馏 / 双语 / 装配面源码扫描（地图读在路由定型
 *  【后】、repoBodyNote 后、body 装配前；runner 仍零 system 字面）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const { buildBodyAppendix } = await import("../src/batchRunner.ts");
const {
    loadRepoMap, pruneRepoMaps, repoKeyOf, renderRepoMap, extractPkgFacts, extractPomFacts,
    REPO_MAP_KEEP, REPO_MAP_CAPS, REPO_MAP_MAX_BYTES,
} = await import("@/batch/repoMap.ts");
const { batchT } = await import("../src/batchStrings.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fsSync.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");

const T = batchT("zh");

/** 地图正文行白名单：段行 + 省略行 + 截断标记，无第四种形态。 */
const MAP_LINE_RE = /^(pkg|scripts|workspaces|pom|modules|build|dirs): .+$/;
const OMIT_LINE_RE = /^\.\.\. \(\+\d+ more\)$/;
const TRUNCATED_LINE = "... (truncated)";
const isMapLine = (l: string): boolean => MAP_LINE_RE.test(l) || OMIT_LINE_RE.test(l) || l === TRUNCATED_LINE;

/** git 短命令（shell:false 无注入面；失败带 stderr 摘要拒绝，测试直接红）。 */
const gitRun = (cwd: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        const c = spawn("git", args, { cwd, windowsHide: true, shell: false });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        c.stdout?.on("data", (d: Buffer) => out.push(d));
        c.stderr?.on("data", (d: Buffer) => err.push(d));
        c.on("error", reject);
        c.on("close", (code) => (code === 0
            ? resolve(Buffer.concat(out).toString("utf-8"))
            : reject(new Error(`git ${args.join(" ")} -> exit ${code}: ${Buffer.concat(err).toString("utf-8").slice(0, 200)}`))));
    });

/** 临时 batch 目录（env 实时重定向）+ 临时 git 仓（一个空 commit 定 HEAD）。 */
const withTempEnv = async (fn: (env: { batchDir: string; repoDir: string; git: (args: string[]) => Promise<string> }) => Promise<void>): Promise<void> => {
    const batchDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-batch-map-"));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-map-repo-"));
    const prev = process.env.DEEPSEEKER_CODE_BATCH_DIR;
    process.env.DEEPSEEKER_CODE_BATCH_DIR = batchDir;
    try {
        await gitRun(repoDir, ["init"]);
        // 仓库级身份：CI runner 无全局 git 身份（Author identity unknown exit 128 本机不可复现——
        // 本机有全局配置，白板环境首跑即红）。写进 .git/config 让本仓后续任意 commit 都成立。
        // 与 worktree-commit.test.ts 惯例对齐（含 gpgsign false 防 contributor 机器全局签名配置）。
        await gitRun(repoDir, ["config", "user.email", "t@t.local"]);
        await gitRun(repoDir, ["config", "user.name", "t"]);
        await gitRun(repoDir, ["config", "commit.gpgsign", "false"]);
        await gitRun(repoDir, ["commit", "--allow-empty", "-m", "init"]);
        await fn({ batchDir, repoDir, git: (args) => gitRun(repoDir, args) });
    } finally {
        if (prev === undefined) delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        else process.env.DEEPSEEKER_CODE_BATCH_DIR = prev;
        await fs.rm(batchDir, { recursive: true, force: true }).catch(() => { });
        await fs.rm(repoDir, { recursive: true, force: true }).catch(() => { });
    }
};

const mapFiles = async (batchDir: string): Promise<string[]> => {
    try { return (await fs.readdir(path.join(batchDir, "repo-map"))).filter((f) => f.endsWith(".md")); }
    catch { return []; }
};

// ============ 缓存生命周期：同 SHA 命中 / SHA 变更重建 / 修剪 / fail-safe ============

test("同 SHA 二票：注入同一份、不重复生成（文件数 1、mtime 不变）、命中不重读源", async () => {
    await withTempEnv(async ({ batchDir, repoDir }) => {
        await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "alpha", scripts: { test: "node --test", dev: "vite" } }), "utf-8");
        const r1 = await loadRepoMap({ repoRoot: repoDir });
        assert.ok(r1 && !r1.fromCache, "首票：现场生成");
        assert.equal(r1.repoName, path.basename(repoDir), "仓库名 = 目录名");
        assert.match(r1.sha8, /^[0-9a-f]{8}$/, "SHA8 标识");
        assert.match(r1.body, /^pkg: alpha$/m);
        assert.match(r1.body, /^scripts: test=node --test$/m, "test 族脚本上图");
        assert.ok(!r1.body.includes("dev"), "非 test/build/typecheck/lint 族脚本不上图");
        const files1 = await mapFiles(batchDir);
        assert.equal(files1.length, 1, "同 SHA 只落一份缓存");
        const p = path.join(batchDir, "repo-map", files1[0]);
        assert.ok(files1[0].startsWith(repoKeyOf(repoDir)), "文件名带仓库键前缀");
        assert.ok(files1[0].includes(r1.sha8), "文件名带 SHA8");
        const mt1 = (await fs.stat(p)).mtimeMs;

        // 第二票：改源（package.json 换名）后取图——必须命中缓存，不重读源
        await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "beta-renamed", scripts: {} }), "utf-8");
        const r2 = await loadRepoMap({ repoRoot: repoDir });
        assert.ok(r2?.fromCache, "同 SHA 第二票命中缓存（fromCache）");
        assert.equal(r2.body, r1.body, "注入同一份");
        assert.ok(r2.body.includes("alpha") && !r2.body.includes("beta-renamed"), "命中不重读源（源已改名仍注入旧图内容）");
        assert.equal(r2.sha8, r1.sha8);
        assert.equal((await fs.stat(p)).mtimeMs, mt1, "命中不重复生成（mtime 不变）");
        assert.equal((await mapFiles(batchDir)).length, 1, "同 SHA 不新增缓存文件");
    });
});

test("SHA 变更：重建新文件（fromCache=false、新 SHA8），旧文件保留；两份共存 ≤ 保留上限", async () => {
    await withTempEnv(async ({ batchDir, repoDir, git }) => {
        await fs.writeFile(path.join(repoDir, "package.json"), JSON.stringify({ name: "alpha", scripts: { build: "tsc" } }), "utf-8");
        const r1 = await loadRepoMap({ repoRoot: repoDir });
        assert.ok(r1);
        await git(["commit", "--allow-empty", "-m", "second"]); // 代码一提交 → SHA 变 → 旧图自然作废
        const head = (await git(["rev-parse", "HEAD"])).trim();
        const r2 = await loadRepoMap({ repoRoot: repoDir });
        assert.ok(r2 && !r2.fromCache, "SHA 变更 = 缓存 miss，重建");
        assert.equal(r2.sha8, head.slice(0, 8), "新图锚定新 SHA");
        assert.notEqual(r2.sha8, r1.sha8);
        assert.match(r2.body, /^scripts: build=tsc$/m, "重建内容来自当前源");
        const files = await mapFiles(batchDir);
        assert.equal(files.length, 2, "新旧两份共存");
        assert.ok(files.some((f) => f.includes(r1.sha8)) && files.some((f) => f.includes(r2.sha8)));
    });
});

test("修剪：每仓只留最近 5 份（mtime 降序），最旧被剪、最新保留", async () => {
    await withTempEnv(async ({ batchDir, repoDir }) => {
        assert.equal(REPO_MAP_KEEP, 5, "保留上限 = 5（方案 ③ ★修剪）");
        const key = repoKeyOf(repoDir);
        const dir = path.join(batchDir, "repo-map");
        await fs.mkdir(dir, { recursive: true });
        const base = 1_700_000_000_000;
        for (let i = 0; i < 7; i++) {
            const p = path.join(dir, `${key}-aaaa000${i}.md`);
            await fs.writeFile(p, `pkg: x${i}`, "utf-8");
            const t = new Date(base + i * 60_000);
            await fs.utimes(p, t, t); // mtime 递增：0 最旧 … 6 最新
        }
        await pruneRepoMaps(key);
        const rest = (await mapFiles(batchDir)).sort();
        assert.equal(rest.length, REPO_MAP_KEEP, "剪完 ≤5");
        assert.ok(rest.includes(`${key}-aaaa0006.md`), "最新保留");
        assert.ok(rest.includes(`${key}-aaaa0002.md`), "次新保留");
        assert.ok(!rest.includes(`${key}-aaaa0000.md`) && !rest.includes(`${key}-aaaa0001.md`), "最旧两张被剪");
        assert.equal(await pruneRepoMaps(key), 0, "已 ≤5 时零删除（幂等）");
    });
});

test("fail-safe：非 git 仓 / 路径不存在 → null（零注入不拦票）；空图不落缓存", async () => {
    await withTempEnv(async ({ repoDir }) => {
        const plain = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-map-nogit-"));
        try {
            assert.equal(await loadRepoMap({ repoRoot: plain }), null, "非 git 仓 → null");
            assert.equal(await loadRepoMap({ repoRoot: path.join(repoDir, "no-such-dir") }), null, "路径不存在 → null");
        } finally {
            await fs.rm(plain, { recursive: true, force: true }).catch(() => { });
        }
    });
});

// ============ 提取纯函数：宁缺毋滥、单行化、parent 块剥离 ============

test("extractPkgFacts：scripts 只取 test/build/typecheck/lint 族；workspaces 两种形态；非法 JSON → null；值单行化", () => {
    const f = extractPkgFacts(JSON.stringify({
        name: "alpha",
        scripts: { test: "node --test", dev: "vite", build: "tsc -b", typecheck: "tsc --noEmit", lint: "eslint .", start: "node ." },
        workspaces: ["packages/*", "apps/*"],
    }));
    assert.deepEqual(f, {
        pkgName: "alpha",
        scripts: [["test", "node --test"], ["build", "tsc -b"], ["typecheck", "tsc --noEmit"], ["lint", "eslint ."]],
        workspaces: ["packages/*", "apps/*"],
    }, "start/dev 不上图（宁缺毋滥）");
    const g = extractPkgFacts(JSON.stringify({ workspaces: { packages: ["pkg/*"] } }));
    assert.deepEqual(g?.workspaces, ["pkg/*"], "workspaces {packages:[…]} 形态等价");
    const h = extractPkgFacts(JSON.stringify({ name: "a\nb", scripts: { test: "x\ny" } }));
    assert.equal(h?.pkgName, "a b", "name 单行化");
    assert.deepEqual(h?.scripts, [["test", "x y"]], "脚本值单行化");
    assert.equal(extractPkgFacts("not json{"), null, "非法 JSON → null");
    assert.equal(extractPkgFacts(JSON.stringify({ noName: 1 })), null, "零事实 → null（无段可渲染）");
});

test("extractPomFacts：<parent> 块先剥（artifactId 取项目自身坐标），modules 清单；无 artifactId → null", () => {
    const pom = `<project><parent><groupId>com.z</groupId><artifactId>pms-parent</artifactId><version>1</version></parent>`
        + `<artifactId>lg-pms</artifactId><modules><module>core</module><module>web</module></modules></project>`;
    assert.deepEqual(extractPomFacts(pom), { artifactId: "lg-pms", modules: ["core", "web"] }, "首匹配不得抓到 parent 坐标（repoRoute 实锤）");
    assert.equal(extractPomFacts("<project><parent><artifactId>x</artifactId></parent></project>"), null, "剥完 parent 无自身坐标 → null");
});

// ============ 渲染形态：白名单行 / 条目封顶 / 2KB 红线 ============

test("renderRepoMap：白名单行形态（段行+省略行），零自由文本段", () => {
    const out = renderRepoMap({
        pkgName: "alpha",
        scripts: [["test", "npm test"], ["build", "tsc -b"]],
        workspaces: ["packages/*"],
        pomArtifactId: "lg-app",
        pomModules: ["core", "web"],
        buildFiles: ["tsconfig.json", ".github/workflows"],
        dirs: ["src/", "src/core/", "tests/"],
    });
    const lines = out.split("\n");
    assert.deepEqual(lines, [
        "pkg: alpha",
        "scripts: test=npm test | build=tsc -b",
        "workspaces: packages/*",
        "pom: lg-app",
        "modules: core, web",
        "build: tsconfig.json, .github/workflows",
        "dirs: src/ src/core/ tests/",
    ], "段序钉死：pkg→scripts→workspaces→pom→modules→build→dirs");
    for (const l of lines) assert.ok(isMapLine(l), `白名单形态：${l}`);
    assert.equal(renderRepoMap({}), "", "零事实 → 空串（调用方零注入）");
});

test("renderRepoMap：条目封顶（目录 15 / scripts 8），超出加省略行", () => {
    assert.equal(REPO_MAP_CAPS.dirs, 15);
    assert.equal(REPO_MAP_CAPS.scripts, 8);
    const dirsOut = renderRepoMap({ pkgName: "x", dirs: Array.from({ length: 20 }, (_, i) => `d${i}/`) });
    assert.match(dirsOut, /^dirs: (d\d+\/ ){14}d14\/$/m, "目录行恰好 15 项");
    assert.ok(dirsOut.includes("... (+5 more)"), "余量省略行");
    const scripts = Array.from({ length: 10 }, (_, i) => [`t${i}`, `cmd${i}`] as [string, string]);
    const sOut = renderRepoMap({ pkgName: "x", scripts });
    assert.match(sOut, /^scripts: t0=cmd0( \| t\d+=cmd\d+){7}$/m, "脚本行恰好 8 对");
    assert.ok(sOut.includes("... (+2 more)"), "余量省略行");
});

test("renderRepoMap：总量 ≤2KB 红线——超预算从末尾整行丢弃 + 截断标记，行形态仍白名单", () => {
    const big = renderRepoMap({
        pkgName: "m",
        scripts: Array.from({ length: 8 }, (_, i) => [`s${i}`, "v".repeat(150)] as [string, string]),
        workspaces: Array.from({ length: 6 }, (_, i) => `w${i}-${"o".repeat(76)}`),
        pomArtifactId: "p",
        pomModules: Array.from({ length: 8 }, (_, i) => `m${i}-${"x".repeat(96)}`),
        buildFiles: ["tsconfig.json", "Makefile", "go.mod", ".github/workflows"],
        dirs: Array.from({ length: 15 }, (_, i) => `d${i}-${"y".repeat(96)}/`),
    });
    assert.ok(Buffer.byteLength(big, "utf-8") <= REPO_MAP_MAX_BYTES, `≤2KB（实得 ${Buffer.byteLength(big, "utf-8")}）`);
    assert.ok(big.endsWith(TRUNCATED_LINE), "截断标记收尾");
    for (const l of big.split("\n")) assert.ok(isMapLine(l), `截断后仍是白名单形态：${l}`);
});

// ============ 附录装配：段序钉死 + 零地图幂等 + 双语 ============

test("附录段序：repoBodyNote → ③地图 → ②近况 → ①蒸馏引导（恒最末）；地图段行全白名单", () => {
    const map = { repoName: "demo", sha8: "abcd1234", body: renderRepoMap({ pkgName: "alpha", dirs: ["src/"] }), fromCache: true };
    const recent = [{ id: "t1", title: "甲", status: "passed", branch: "dsc-wt-x-1" }];
    const body = "原始任务正文";
    const repoNote = T.repoBodyNote("pms-parent");
    const full = body + repoNote + buildBodyAppendix(recent, map);
    assert.ok(full.startsWith(body), "原正文在前");
    const iNote = full.indexOf(repoNote);
    const iMap = full.indexOf(T.repoMapNoteH(map.repoName, map.sha8));
    const iRecent = full.indexOf(T.recentNoteH(1));
    const iDistill = full.indexOf(T.distillNote);
    assert.ok(iNote > 0 && iNote < iMap, "跨仓注记在前");
    assert.ok(iMap < iRecent, "③地图（稳定事实）在 ②近况（近期事件）之前");
    assert.ok(iRecent < iDistill, "①蒸馏引导收尾");
    assert.ok(full.trimEnd().endsWith("不写不算失败。"), "蒸馏引导恒为最末段");
    const mapSection = full.slice(iMap + T.repoMapNoteH(map.repoName, map.sha8).length, iRecent);
    for (const l of mapSection.split("\n")) {
        if (!l.trim()) continue;
        assert.ok(isMapLine(l), `地图段只含白名单数据行：${l}`);
    }
});

test("零地图幂等：map 缺省/null 时附录与 ①② 现状完全一致（现有票零行为变化）", () => {
    const recent = [{ id: "t1", title: "甲", status: "passed", branch: "b" }];
    assert.equal(buildBodyAppendix(recent), buildBodyAppendix(recent, null), "缺省参数 = null");
    assert.equal(buildBodyAppendix([]), T.distillNote, "零地图 + 零历史 = 只有蒸馏引导");
});

test("双语：zh/en repoMapNoteH 同键带仓名与 SHA8；mapInjected 两态文案", () => {
    const TE = batchT("en");
    for (const t of [T, TE]) {
        const h = t.repoMapNoteH("demo", "abcd1234");
        assert.ok(h.includes("demo") && h.includes("abcd1234"), "头带仓名与 SHA8");
        assert.match(t.mapInjected("abcd1234", true), /abcd1234/);
        assert.match(t.mapInjected("abcd1234", false), /abcd1234/);
    }
    assert.ok(T.repoMapNoteH("demo", "abcd1234").includes("仓库地图"), "zh 主题词");
    assert.ok(TE.repoMapNoteH("demo", "abcd1234").includes("Repo map"), "en 主题词");
    assert.match(TE.mapInjected("abcd1234", true), /cache hit/);
    assert.match(TE.mapInjected("abcd1234", false), /generated/);
});

// ============ 装配面源码扫描：接线钉死（同 batch-memory-recent 惯例） ============

test("装配：地图读取在路由定型【后】、repoBodyNote 之后、body 装配【前】（定案口径：开工时生成）", () => {
    const rulesIdx = RUNNER_SRC.indexOf("routeRepoByRules(`${t.title}\\n${t.body}`");
    const contIdx = RUNNER_SRC.indexOf("await continuationRepoRoot(t.continues)");
    const noteIdx = RUNNER_SRC.indexOf("t.body = t.body + T.repoBodyNote(routedRepoName)");
    const mapIdx = RUNNER_SRC.indexOf("repoMap = await loadRepoMap({ repoRoot: repoRoot ?? process.cwd() })");
    const recentIdx = RUNNER_SRC.indexOf("recentTickets = await readRecentTickets({ repoRoot })");
    const appendixIdx = RUNNER_SRC.indexOf("t.body = t.body + buildBodyAppendix(recentTickets, repoMap)");
    assert.ok(rulesIdx > 0 && contIdx > 0 && noteIdx > 0 && mapIdx > 0 && recentIdx > 0 && appendixIdx > 0, "六个锚点都在");
    assert.ok(mapIdx > rulesIdx, "地图读在规则路由之后（repoRoot 决定读哪个仓）");
    assert.ok(mapIdx > contIdx, "续修继承也在地图读之前");
    assert.ok(mapIdx > noteIdx, "地图读在跨仓注记之后（附录段序的前置）");
    assert.ok(mapIdx < recentIdx && mapIdx < appendixIdx, "开工时生成（body 装配前；地图读先于近况读）");
    assert.ok(appendixIdx > recentIdx, "附录装配在近况读取之后");
});

test("装配：地图读取 fail-safe（try/catch 回落零注入）；注入时控制台有一行可见性输出", () => {
    assert.match(RUNNER_SRC, /repoMap = await loadRepoMap\(\{ repoRoot: repoRoot \?\? process\.cwd\(\) \}\);?\s*\n\s*\} catch/, "读取包在 try/catch（fail-safe：地图缺失回落现状）");
    assert.match(RUNNER_SRC, /T\.mapInjected\(repoMap\.sha8, repoMap\.fromCache\)/, "注入可见（缓存命中/本次生成）");
});

test("装配红线：batchRunner 全程不碰 system/message[0]/parentSystemPrompt（注入永不进前缀缓存段）", () => {
    assert.ok(!RUNNER_SRC.includes("parentSystemPrompt"), "runner 不注入 system 模板");
    assert.ok(!RUNNER_SRC.includes("message[0]"), "runner 不改 message[0]");
    assert.ok(!RUNNER_SRC.includes("sysPrompt"), "runner 不拼 system prompt");
    assert.ok(!RUNNER_SRC.includes("injectMemory"), "记忆索引注入与 runner 无关（body 附录是唯一注入面）");
});
