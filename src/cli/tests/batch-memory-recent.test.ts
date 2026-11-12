/**
 * @file cli/tests/batch-memory-recent.test.ts
 * @description 记忆策略窄口径 ①+②（2026-11-12，路线 #12）runner 侧守门测试。
 *
 *  覆盖：② 同仓近况注入——done/ 报告 frontmatter 确定性提取（repo 匹配：基座=无 repo: 行、
 *  跨仓=repo: resolve 相等；最近 N 条时间序；残缺报告隔离；占位分支剔除；无历史零注入）/
 *  附录渲染只含 frontmatter 四字段 + 尾部位置 / ① 蒸馏引导为纯提示词（每票必有、无强制机制）/
 *  装配面源码扫描钉死接线（注入在路由定型【后】——近况标题不得参与路由；repoBodyNote 之后——
 *  附录恒为 body 最末段；content 仍 = t.body；runner 全程不碰 system/message[0]）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const { buildBodyAppendix } = await import("../src/batchRunner.ts");
const { readRecentTickets, parseRecentEntry, matchesRepo, RECENT_TICKETS_LIMIT } = await import("@/batch/recent.ts");
const { batchT } = await import("../src/batchStrings.ts");

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_SRC = fsSync.readFileSync(path.join(CLI_ROOT, "src", "batchRunner.ts"), "utf-8");

const T = batchT("zh");

/** 最小报告文本（frontmatter 四字段 + 正文；正文段故意可带 `status:`/`repo:` 同名行——frontmatter 块提取必须不被污染）。 */
const report = (o: { id: string; title: string; status: string; branch?: string; repo?: string; body?: string }): string =>
    `---\nid: ${o.id}\ntitle: ${o.title}\nstatus: ${o.status}${o.branch ? `\nbranch: ${o.branch}` : ""}${o.repo ? `\nrepo: ${o.repo}` : ""}\n---\n\n正文\n${o.body ?? ""}`;

/** 临时 batch 目录（DEEPSEEKER_CODE_BATCH_DIR 重定向 batchQueueRoot，queue.ts 实时读 env）。 */
const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-batch-recent-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
};

const writeReport = async (dir: string, o: { id: string; title: string; status: string; branch?: string; repo?: string }): Promise<void> => {
    await fs.mkdir(path.join(dir, "done"), { recursive: true });
    await fs.writeFile(path.join(dir, "done", `${o.id}.report.md`), report(o), "utf-8");
};

// ============ ② readRecentTickets：确定性提取 ============

test("readRecentTickets：基座票（repoRoot=null）只收无 repo: 行的报告；跨仓票只收 repo: resolve 相等的报告", async () => {
    await withTempBatchDir(async (dir) => {
        const target = "D:/code/zhonglian/pms-parent";
        await writeReport(dir, { id: "20261111-000001-a", title: "基座票甲", status: "passed", branch: "dsc-wt-x-1" });
        await writeReport(dir, { id: "20261111-000002-b", title: "跨仓票乙", status: "accept-failed", branch: "dsc-wt-y-2", repo: target });
        await writeReport(dir, { id: "20261111-000003-c", title: "基座票丙", status: "timeout", branch: "dsc-wt-x-3" });
        await writeReport(dir, { id: "20261111-000004-d", title: "跨仓票丁", status: "passed", repo: "D:\\code\\zhonglian\\pms-parent" });
        // 基座视角：只收无 repo: 的两张，时间序（旧→新）
        assert.deepEqual(await readRecentTickets({ repoRoot: null }), [
            { id: "20261111-000001-a", title: "基座票甲", status: "passed", branch: "dsc-wt-x-1" },
            { id: "20261111-000003-c", title: "基座票丙", status: "timeout", branch: "dsc-wt-x-3" },
        ]);
        // 跨仓视角：只收目标仓两张（正/反斜杠 resolve 等价）
        const routed = await readRecentTickets({ repoRoot: target });
        assert.deepEqual(routed.map((e) => e.id), ["20261111-000002-b", "20261111-000004-d"]);
        // 其余仓根：零命中
        assert.deepEqual(await readRecentTickets({ repoRoot: "D:/code/other/repo" }), []);
    });
});

test("readRecentTickets：缺省 3 条上限、从最近往回取、输出回时间序（旧→新）", async () => {
    await withTempBatchDir(async (dir) => {
        for (let i = 1; i <= 5; i++) {
            await writeReport(dir, { id: `20261111-00000${i}-x`, title: `票${i}`, status: "passed", branch: `dsc-wt-x-${i}` });
        }
        assert.equal(RECENT_TICKETS_LIMIT, 3, "缺省上限=3（方案 ②）");
        const got = await readRecentTickets({ repoRoot: null });
        assert.deepEqual(got.map((e) => e.id), ["20261111-000003-x", "20261111-000004-x", "20261111-000005-x"], "最近 3 条");
        const got2 = await readRecentTickets({ repoRoot: null, limit: 2 });
        assert.deepEqual(got2.map((e) => e.id), ["20261111-000004-x", "20261111-000005-x"], "limit 生效且仍时间序");
    });
});

test("readRecentTickets：done/ 不存在 → 空数组（零注入幂等）；残缺报告（无 frontmatter/无 status）跳过不炸", async () => {
    await withTempBatchDir(async (dir) => {
        assert.deepEqual(await readRecentTickets({ repoRoot: null }), [], "done/ 缺失 = 无历史（正常态）");
        await fs.mkdir(path.join(dir, "done"), { recursive: true });
        await fs.writeFile(path.join(dir, "done", "20261111-000001-e.report.md"), "没有 frontmatter 的半截文件\nstatus: passed\n", "utf-8");
        await fs.writeFile(path.join(dir, "done", "20261111-000002-f.report.md"), "---\nid: x\ntitle: 缺状态\n---\n", "utf-8");
        await writeReport(dir, { id: "20261111-000003-g", title: "好蛋", status: "passed" });
        const got = await readRecentTickets({ repoRoot: null });
        assert.deepEqual(got.map((e) => e.id), ["20261111-000003-g"], "残缺条目隔离，好蛋保留");
    });
});

test("parseRecentEntry：占位分支（worktree 未创建）剔除 → branch null；标题缺失回退 id", () => {
    const noWt = parseRecentEntry("---\nid: t1\ntitle: 甲\nstatus: baseline-broken\nbranch: （未创建）\n---\n正文", "t1");
    assert.deepEqual(noWt, { id: "t1", title: "甲", status: "baseline-broken", branch: null }, "占位串不当分支渲染");
    const noTitle = parseRecentEntry("---\nstatus: rejected\n---\n", "t2");
    assert.equal(noTitle!.title, "t2", "标题缺失回退 id");
    assert.equal(parseRecentEntry("完全无块", "t3"), null);
});

test("matchesRepo：正文里的 repo:/status: 同名行不参与判定（frontmatter 块隔离）", () => {
    const tricky = report({ id: "t", title: "x", status: "passed", body: "\nrepo: D:/some/other\nstatus: fake\n" });
    assert.equal(matchesRepo(tricky, null), true, "正文同名行不污染基座匹配");
    assert.equal(matchesRepo(tricky, "D:/some/other"), false, "正文 repo: 不当跨仓命中");
});

// ============ ①+② buildBodyAppendix：渲染形态与红线 ============

test("附录：近况段含标题计数与 #id 标题 [状态] [分支] 行（时间序原样）；分支缺省省略该段", () => {
    const out = buildBodyAppendix([
        { id: "20261111-000001-a", title: "基座票甲", status: "passed", branch: "dsc-wt-x-1" },
        { id: "20261111-000003-c", title: "基座票丙", status: "timeout", branch: null },
    ]);
    assert.ok(out.includes(T.recentNoteH(2)), "标题带条数");
    assert.ok(out.includes("- #20261111-000001-a 基座票甲 [passed] [dsc-wt-x-1]"), "行形态 #id 标题 [状态] [分支]");
    assert.ok(out.includes("- #20261111-000003-c 基座票丙 [timeout]"), "分支 null 省略段");
    assert.ok(!out.includes(" []"), "不渲染空分支括号");
});

test("附录红线：内容只含 frontmatter 四字段——近况行只能是 `#id 标题 [状态] [分支]` 形态", () => {
    const out = buildBodyAppendix([
        { id: "t9", title: "标题含空格也行", status: "watchdog-killed", branch: "dsc-wt-z-9" },
        { id: "t8", title: "无分支票", status: "accept-failed", branch: null },
    ]);
    const recentPart = out.slice(0, out.indexOf(T.distillNote));
    for (const line of recentPart.split("\n")) {
        if (!line.startsWith("- #")) continue;
        assert.match(line, /^- #\S+ .+ \[[\w-]+\]( \[[\w./-]+\])?$/, `近况行只能是 frontmatter 字段形态：${line}`);
    }
    assert.ok(!recentPart.includes("changed-file") && !recentPart.includes(".report.md"), "无报告清单/报告路径字样");
});

test("附录：无历史票 → 近况段整段省略（零注入），只剩蒸馏引导；有历史 → 近况在前、引导收尾", () => {
    const empty = buildBodyAppendix([]);
    assert.equal(empty, T.distillNote, "零历史 = 无近况段（幂等：注入物只有引导）");
    const withRecent = buildBodyAppendix([{ id: "t1", title: "甲", status: "passed", branch: "b" }]);
    assert.ok(withRecent.indexOf(T.recentNoteH(1)) < withRecent.indexOf(T.distillNote), "近况在前、引导收尾");
});

test("附录：追加在票 body 尾部（原正文在前、跨仓注记之后、附录恒最末）", () => {
    const body = "原始任务正文";
    const repoNote = T.repoBodyNote("pms-parent");
    const full = body + repoNote + buildBodyAppendix([{ id: "t1", title: "甲", status: "passed", branch: "b" }]);
    assert.ok(full.startsWith(body), "原正文在前");
    assert.ok(full.indexOf(repoNote) < full.indexOf(T.recentNoteH(1)), "跨仓注记在前、近况在后");
    assert.ok(full.trimEnd().endsWith("不写不算失败。"), "蒸馏引导恒为最末段（收尾前最后读到的指令）");
});

test("双语：EN 词表同键、行形态与 zh 一致（typeof ZH 编译约束之外运行时再钉一手）", () => {
    const TE = batchT("en");
    const enRecent = [TE.recentNoteH(1), TE.recentLine("t1", "x", "passed", "b")].join("\n");
    assert.ok(enRecent.includes("- #t1 x [passed] [b]"), "EN 行形态一致");
    assert.ok(TE.recentLine("t1", "x", "passed", null) === "- #t1 x [passed]", "EN 分支缺省同样省略段");
    assert.ok(TE.distillNote.includes("memory_save"), "EN 引导同样点名 memory_save");
});

// ============ 装配面：接线钉死（红线：注入只在 body 尾部，永不进 system） ============

test("装配：近况注入在路由定型【后】——历史票标题不得参与路由判定", () => {
    const rulesIdx = RUNNER_SRC.indexOf("routeRepoByRules(`${t.title}\\n${t.body}`");
    const contIdx = RUNNER_SRC.indexOf("await continuationRepoRoot(t.continues)");
    const injectIdx = RUNNER_SRC.indexOf("recentTickets = await readRecentTickets({ repoRoot })");
    assert.ok(rulesIdx > 0 && contIdx > 0 && injectIdx > 0, "三个锚点都在");
    assert.ok(injectIdx > rulesIdx, "规则路由在注入之前（近况标题若在路由前拼进 body 会被标识符匹配误扫）");
    assert.ok(injectIdx > contIdx, "续修继承也在注入之前");
});

test("装配：附录追加在 repoBodyNote 之后（附录恒为 body 最末段）；content 仍 = t.body（user 消息通道）", () => {
    const noteIdx = RUNNER_SRC.indexOf("t.body = t.body + T.repoBodyNote(routedRepoName)");
    // ③ 仓库地图并单（2026-11-12）：附录签名追加第二参 map（缺省 null 零改动幂等），调用点带 repoMap
    const injectIdx = RUNNER_SRC.indexOf("t.body = t.body + buildBodyAppendix(recentTickets, repoMap)");
    assert.ok(noteIdx > 0 && injectIdx > noteIdx, "附录在跨仓注记之后");
    assert.match(RUNNER_SRC, /let content = t\.body;/, "工单正文仍整体走 user 消息（body 是注入唯一通道）");
    assert.match(RUNNER_SRC, /buildRetryTaskContent\(t\.body,/, "重试轮内容同样从 t.body 派生（不改注入通道）");
});

test("装配红线：batchRunner 全程不碰 system/message[0]/parentSystemPrompt（注入永不进前缀缓存段）", () => {
    assert.ok(!RUNNER_SRC.includes("parentSystemPrompt"), "runner 不注入 system 模板");
    assert.ok(!RUNNER_SRC.includes("message[0]"), "runner 不改 message[0]");
    assert.ok(!RUNNER_SRC.includes("sysPrompt"), "runner 不拼 system prompt");
    assert.ok(!RUNNER_SRC.includes("injectMemory"), "记忆索引注入与 runner 无关（body 附录是唯一注入面）");
});

test("装配：近况读取 fail-safe（try/catch 回落零注入不拦票）；有近况时控制台有一行可见性输出", () => {
    assert.match(RUNNER_SRC, /recentTickets = await readRecentTickets\(\{ repoRoot \}\);?[^\n]*\n\s*\} catch/, "读取包在 try/catch（fail-safe：近况缺失回落现状）");
    assert.match(RUNNER_SRC, /T\.recentInjected\(recentTickets\.length\)/, "注入条数控制台可见");
});
