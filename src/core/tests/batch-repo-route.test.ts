/**
 * @file tests/batch-repo-route.test.ts
 * @description 跨仓任务路由（2026-11-10 真机实锤 ij9q）守门测试。
 *
 *  覆盖：归一化与复合标识符提取（纯单词/版本号不参与）/ 规则路由三护栏（唯一外部命中 + 基座
 *  不命中 + 邻近词——「参考 lg-pms 的实现改本仓」不得误路由）/ 仓库索引扫描（.git 命中即停、
 *  node_modules 剪枝、深度上限、token 提取 package.json+pom）/ 索引缓存 TTL / 续修仓继承
 *  （repo: frontmatter 解析、目录存在性把关）/ pom.xml 探测验收（mvn 编译检查——ij9q 那类
 *  Java 仓跨仓票的 accept 适配来源）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const route = await import("@/batch/repoRoute.ts");
const cont = await import("@/batch/continuation.ts");
const { detectAccept } = await import("@/batch/sync/accept.ts");
const { reportPath } = await import("@/batch/queue.ts");

/** 临时 batch 目录（DEEPSEEKER_CODE_BATCH_DIR 重定向 batchQueueRoot）。 */
const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-reporoute-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
};

/** 临时扫描根（fn 收到根目录，自建仓库树）。 */
const withScanRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-reposcan-test-"));
    try {
        await fn(root);
    } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => { });
    }
};

/** 建一个最小 git 仓库目录（.git 目录 + 可选 package.json / pom.xml）。 */
const mkRepo = async (dir: string, files: { name: string; content: string }[] = []): Promise<void> => {
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    for (const f of files) {
        await fs.mkdir(path.dirname(path.join(dir, f.name)), { recursive: true });
        await fs.writeFile(path.join(dir, f.name), f.content, "utf-8");
    }
};

// ============ 归一化与复合标识符 ============

test("normalizeIdent：小写 + 剔分隔符（lg-pms / com.zlgx.lg.pms → lgpms / comzlgxlgpms）", () => {
    assert.equal(route.normalizeIdent("lg-pms"), "lgpms");
    assert.equal(route.normalizeIdent("com.zlgx.lg.pms"), "comzlgxlgpms");
    assert.equal(route.normalizeIdent("LG_PMS"), "lgpms", "下划线也剔");
});

test("extractCompoundIdents：只抓复合 token（带 - 或 . 多段）；纯单词/纯数字版本号不抓", () => {
    const idents = route.extractCompoundIdents("帮我在lg-pms项目中生成一个test文件，参考 com.zlgx.lg.pms 的坐标，版本 1.2.3，跑 npm install");
    assert.ok(idents.includes("lg-pms"), "lg-pms 命中");
    assert.ok(idents.includes("com.zlgx.lg.pms"), "groupId 复合段命中");
    assert.ok(!idents.includes("test"), "纯单词不抓（噪声源）");
    assert.ok(!idents.includes("1.2.3"), "纯数字段=版本号不抓");
    assert.ok(!idents.includes("install"), "npm install 单词不抓");
});

// ============ 规则路由：三护栏 ============

const BASE_DIR = "D:/code/self/deepseeker-code";
const mkIndex = (repos: { dir: string; name: string; tokens: string[] }[]) => ({ builtAt: new Date().toISOString(), repos });

test("routeRepoByRules：ij9q 形态命中——「在 lg-pms 项目中生成 test 文件」→ pms-parent（groupId 归一包含）", () => {
    const index = mkIndex([
        { dir: BASE_DIR, name: "deepseeker-code", tokens: ["deepseekercode", "dsc"] },
        { dir: "D:/code/zhonglian/pms-parent", name: "pms-parent", tokens: ["pmsparent", "comzlgxlgpms", "comzlgxlgpmspmsparent"] },
    ]);
    const r = route.routeRepoByRules("帮我在lg-pms项目中生成一个test文件\n如题", index, BASE_DIR);
    assert.ok(r.repo, "应路由");
    assert.equal(r.repo!.dir, "D:/code/zhonglian/pms-parent");
    assert.equal(r.matchedIdent, "lg-pms");
});

test("routeRepoByRules：邻近词护栏——「参考 lg-pms 的实现改本仓」不路由（防误路由到被参考仓）", () => {
    const index = mkIndex([{ dir: "D:/code/zhonglian/pms-parent", name: "pms-parent", tokens: ["pmsparent", "comzlgxlgpms"] }]);
    const r = route.routeRepoByRules("参考 lg-pms 的实现，修改本仓库的结算逻辑", index, BASE_DIR);
    assert.equal(r.repo, null, "「参考 X」无项目语境 → 落回基座（fail-safe=现行为）");
});

test("routeRepoByRules：邻近词的另一形态——前邻切换动词（切换到/去/进入）也放行", () => {
    const index = mkIndex([{ dir: "D:/code/zhonglian/pms-parent", name: "pms-parent", tokens: ["pmsparent", "comzlgxlgpms"] }]);
    const r = route.routeRepoByRules("切换到 lg-pms 后把 PunishType 加个字段", index, BASE_DIR);
    assert.ok(r.repo, "切换动词前邻 = 明确的仓库意图");
    const r2 = route.routeRepoByRules("去 lg-wms-admin 修一下登录页", index, BASE_DIR);
    assert.equal(r2.repo, null, "索引里没有的标识符不命中（唯一性护栏）");
});

test("routeRepoByRules：多仓同时命中 → 不路由（歧义宁可落基座）", () => {
    const index = mkIndex([
        { dir: "D:/a/pms-parent", name: "pms-parent", tokens: ["pmsparent", "comzlgxlgpms"] },
        { dir: "D:/b/lg-pms-mirror", name: "lg-pms-mirror", tokens: ["lgpmsmirror"] },
    ]);
    const r = route.routeRepoByRules("在 lg-pms 项目里加个测试", index, BASE_DIR);
    assert.equal(r.repo, null, "两仓都含 lgpms 归一串 → 歧义拒绝");
});

test("routeRepoByRules：命中的是基座自身 → 不路由（基座票本就该基座跑）", () => {
    const index = mkIndex([{ dir: BASE_DIR, name: "deepseeker-code", tokens: ["deepseekercode"] }]);
    const r = route.routeRepoByRules("在 deepseeker-code 项目里修个 bug", index, BASE_DIR);
    assert.equal(r.repo, null, "基座命中被排除 → 无外部命中 → null");
});

test("routeRepoByRules：无复合标识符 → null（零误报面）", () => {
    const r = route.routeRepoByRules("修复登录页崩溃", mkIndex([]), BASE_DIR);
    assert.equal(r.repo, null);
});

// ============ 索引扫描与缓存 ============

test("buildRepoIndex：.git 命中即停（嵌套仓不当独立目标）；node_modules/隐藏目录剪枝；深度上限；pom 坐标取 parent 块+自身（全文首匹配会抓成 <parent> 的坐标——pms-parent 真机实锤）", async () => {
    await withScanRoot(async (root) => {
        await mkRepo(path.join(root, "pms-parent"), [{
            name: "pom.xml",
            // 真实 pms-parent 形态：<modules> 在最前、<parent> 坐标其后、自身坐标再后、
            // dependencyManagement 里大量外来坐标（两个历史 bug：首匹配抓成 parent 坐标；头部切片被 modules 截断）
            content: `<project><modules><module>pms-api</module><module>pms-settlement</module></modules>` +
                `<parent><groupId>com.zlgx.base</groupId><artifactId>zlgx-bom</artifactId></parent>` +
                `<groupId>com.zlgx.lg.pms</groupId><artifactId>pms-parent</artifactId>` +
                `<dependencyManagement><dependencies><dependency><groupId>com.zlgx.bid.cooperative</groupId><artifactId>zhaocai-api</artifactId></dependency></dependencies></dependencyManagement></project>`,
        }]);
        await mkRepo(path.join(root, "webapp"), [{ name: "package.json", content: JSON.stringify({ name: "@org/lg-webapp" }) }]);
        // webapp 内嵌套仓：不独立收录（webapp 已是仓库，扫描到它即 return）
        await mkRepo(path.join(root, "webapp", "nested-inner-repo"));
        // node_modules 内的仓：剪枝
        await mkRepo(path.join(root, "node_modules", "hidden-pkg"));
        // 深度 4（超上限）：不扫
        await mkRepo(path.join(root, "l1", "l2", "l3", "l4", "too-deep-repo"));
        const idx = await route.buildRepoIndex([root]);
        const dirs = idx.repos.map((x) => x.name).sort();
        assert.deepEqual(dirs, ["pms-parent", "webapp"], "只收根下两层仓库；嵌套/黑名单/超深不收");
        const pms = idx.repos.find((x) => x.name === "pms-parent")!;
        assert.ok(pms.tokens.includes("comzlgxlgpms"), "自身坐标 groupId（在 parent 块之后）也进 token——lg-pms 匹配的就是它");
        assert.ok(pms.tokens.includes("comzlgxlgpmspmsparent"), "坐标按出现序配对进 token（不做笛卡尔积）");
        assert.ok(!pms.tokens.includes("comzlgxbidcooperative"), "依赖管理里的外来坐标不当身份 token（防歧义误伤）");
        assert.ok(pms.tokens.includes("pmsparent"), "目录名进 token");
        const web = idx.repos.find((x) => x.name === "webapp")!;
        assert.ok(web.tokens.includes("orglgwebapp"), "package.json name 归一进 token");
    });
});

test("loadRepoIndex：TTL 内读缓存（不重扫）；过期/缺失重建并落盘", async () => {
    await withTempBatchDir(async (batchDir) => {
        await withScanRoot(async (root) => {
            await mkRepo(path.join(root, "some-repo"));
            process.env.DEEPSEEKER_REPO_SCAN_ROOTS = root;
            try {
                // 缓存缺失 → 重建并落盘
                const idx1 = await route.loadRepoIndex();
                assert.equal(idx1.repos.length, 1);
                const cacheFile = path.join(batchDir, "repo-index.json");
                const raw = await fs.readFile(cacheFile, "utf-8");
                assert.ok(JSON.parse(raw).repos.length === 1, "索引缓存已落盘");
                // TTL 内：手改缓存内容（标记 repo 名），loadRepoIndex 必须返回缓存值而非重扫
                const patched = { ...JSON.parse(raw), repos: [{ dir: path.join(root, "some-repo"), name: "CACHED-NAME", tokens: ["somerepo"] }] };
                await fs.writeFile(cacheFile, JSON.stringify(patched), "utf-8");
                const idx2 = await route.loadRepoIndex();
                assert.equal(idx2.repos[0]?.name, "CACHED-NAME", "TTL 内吃缓存不重扫");
                // 过期：builtAt 拨回 25h 前 → 重建（名字回到磁盘事实）
                const stale = { ...patched, builtAt: new Date(Date.now() - 25 * 3600_000).toISOString() };
                await fs.writeFile(cacheFile, JSON.stringify(stale), "utf-8");
                const idx3 = await route.loadRepoIndex();
                assert.equal(idx3.repos[0]?.name, "some-repo", "过期重建");
            } finally {
                delete process.env.DEEPSEEKER_REPO_SCAN_ROOTS;
            }
        });
    });
});

test("repoScanRoots：env 分号分隔多根；单根 Windows 路径的盘符冒号不拆；POSIX 多根按 : 拆；未设回退基座上两级", async () => {
    process.env.DEEPSEEKER_REPO_SCAN_ROOTS = "D:/code;E:/work";
    try {
        assert.deepEqual(route.repoScanRoots(), ["D:/code", "E:/work"]);
        process.env.DEEPSEEKER_REPO_SCAN_ROOTS = "D:/code/中联"; // 盘符冒号：绝不按 : 拆（拆出垃圾根扫描全空）
        assert.deepEqual(route.repoScanRoots(), ["D:/code/中联"], "单根 Windows 路径原样保留");
        process.env.DEEPSEEKER_REPO_SCAN_ROOTS = "/home/u/code:/srv/repos"; // POSIX 多根：每段 / 开头才认 :
        assert.deepEqual(route.repoScanRoots(), ["/home/u/code", "/srv/repos"]);
    } finally {
        delete process.env.DEEPSEEKER_REPO_SCAN_ROOTS;
    }
    const root0 = route.repoScanRoots()[0];
    const active = process.env.WORKSPACE_ROOT || process.cwd();
    assert.ok(
        path.resolve(active).toLowerCase().startsWith(path.resolve(root0).toLowerCase() + path.sep),
        `缺省扫描根 = 基座上两级（${root0} 应是基座 ${active} 的祖先目录）`,
    );
});

// ============ 续修仓继承（repo: frontmatter） ============

test("continuationRepoRoot：repo: 行存在且目录活着 → 返回；无行/非绝对/目录已删 → null（落回基座）", async () => {
    await withTempBatchDir(async (batchDir) => {
        const alive = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-repo-alive-"));
        try {
            const id = "20261110-000000-aaaa";
            await fs.mkdir(path.dirname(reportPath(id)), { recursive: true });
            // 1) 正常：repo: 指向存在目录
            await fs.writeFile(reportPath(id), `---\nid: ${id}\nstatus: passed\nbranch: dsc-wt-x-1\nrepo: ${alive.replace(/\\/g, "/")}\n---\n正文`, "utf-8");
            assert.equal(await cont.continuationRepoRoot(id), alive.replace(/\\/g, "/"), "命中（正斜杠形态原样返回，fs 接受）");
            // 2) 无 repo: 行
            await fs.writeFile(reportPath(id), `---\nbranch: dsc-wt-x-1\n---\n正文`, "utf-8");
            assert.equal(await cont.continuationRepoRoot(id), null, "基座票报告无 repo: → null");
            // 3) 非绝对路径（占位/相对值）→ null
            await fs.writeFile(reportPath(id), `---\nrepo: pms-parent\n---\n正文`, "utf-8");
            assert.equal(await cont.continuationRepoRoot(id), null);
            // 4) 目录已不存在（外部删仓）→ null
            await fs.writeFile(reportPath(id), `---\nrepo: D:/definitely/not/there\n---\n正文`, "utf-8");
            assert.equal(await cont.continuationRepoRoot(id), null);
            // 5) 无报告 → null
            assert.equal(await cont.continuationRepoRoot("no-such-id"), null);
        } finally {
            await fs.rm(alive, { recursive: true, force: true }).catch(() => { });
        }
    });
});

// ============ pom.xml 探测验收（跨仓 accept 适配的来源） ============

test("detectAccept：根 pom.xml → mvn -q -DskipTests compile（编译检查；探测不出时 ok=false）", async () => {
    const javaRepo = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-javarepo-"));
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-empty-"));
    try {
        await fs.writeFile(path.join(javaRepo, "pom.xml"), "<project></project>", "utf-8");
        const d = await detectAccept(javaRepo);
        assert.equal(d.ok, true);
        assert.equal(d.accept, "mvn -q -DskipTests compile");
        assert.match(d.source ?? "", /pom/);
        const d2 = await detectAccept(empty);
        assert.equal(d2.ok, false, "无 package.json/Makefile/pom/go.mod → 探测失败（保留原 accept，基线校验诚实报告）");
    } finally {
        await fs.rm(javaRepo, { recursive: true, force: true }).catch(() => { });
        await fs.rm(empty, { recursive: true, force: true }).catch(() => { });
    }
});
