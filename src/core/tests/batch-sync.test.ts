/**
 * @file tests/batch-sync.test.ts
 * @description 多入口工单流水线 P1-M2：`batch sync` 骨架（GitHub，§5.1/§5.2）守门测试。
 *
 *  覆盖：sync.json fail-closed 校验 / sync-state 三态去重与指纹 / .sync.lock 单飞 / 假 gh 全链路
 *  （可注入 exec，不打真网，§3.9 评审修订）/ --dry-run 零落盘 / 规则闸四规则 / 引用块注入边界 /
 *  system 追加段「仅 batch-* 会话」条件（§4.3，源码扫描钉死 chatProcessing 调用点）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const { loadSyncConfig, SYNC_CONFIG_PATH } = await import("@/batch/sync/config.ts");
const state = await import("@/batch/sync/state.ts");
const lock = await import("@/batch/sync/lock.ts");
const gh = await import("@/batch/sync/github.ts");
const gate = await import("@/batch/sync/rulegate.ts");
const { resolveAccept } = await import("@/batch/sync/accept.ts");
const boundary = await import("@/batch/sync/boundary.ts");
const { runSync, buildSyncTicketSource } = await import("@/batch/sync/sync.ts");
const queue = await import("@/batch/queue.ts");

// 源码扫描：chatProcessing 必须经 appendBatchBoundary 注入（位置与条件由单测钉死）
const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAT_SRC = fsSync.readFileSync(path.join(CORE_ROOT, "src", "serve", "chatProcessing.ts"), "utf-8");

/** 临时 batch 目录（DEEPSEEKER_CODE_BATCH_DIR 重定向，batchQueueRoot 实时读 env）。 */
const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-sync-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const writeConfig = async (dir: string, obj: any): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "sync.json"), JSON.stringify(obj), "utf-8");
};

const GH_CALL_ARGS = ["issue", "list", "-R", "o/r", "--label", "agent", "--state", "open", "--json", "number,title,body,url,updatedAt,author,comments"];
const mkIssue = (n: number, over: Partial<{ title: string; body: string }> = {}) => ({
    number: n, title: over.title ?? `bug ${n}`, body: over.body ?? `修复它 ${n}`, url: `https://github.com/o/r/issues/${n}`,
    updatedAt: "2026-11-04T10:00:00Z", author: { login: "alice" },
});

// ============ 配置校验（fail-closed） ============

test("config：合法配置解析；未配置任何源拒绝", async () => {
    const ok = await loadSyncConfig({ raw: JSON.stringify({ github: { repos: ["o/r"], label: "agent" } }) });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.deepEqual(ok.config.github, { repos: ["o/r"], label: "agent" });

    const empty = await loadSyncConfig({ raw: "{}" });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.error, /未配置任何源|no source/);
});

test("config：未知键拒绝（拼写错静默失效防护）；坏 JSON / 非对象拒绝", async () => {
    const typo = await loadSyncConfig({ raw: JSON.stringify({ github: { repos: ["o/r"], label: "agent" }, lable: "x" }) });
    assert.equal(typo.ok, false);
    if (!typo.ok) assert.match(typo.error, /未知配置键/);
    assert.equal((await loadSyncConfig({ raw: "{broken" })).ok, false);
    assert.equal((await loadSyncConfig({ raw: "[]" })).ok, false);
});

test("config：repos 形态 / baseUrl / projects / tokenEnv 逐项 fail-closed", async () => {
    const bad = [
        { github: { repos: [], label: "agent" } },
        { github: { repos: ["owner only"], label: "agent" } },
        { github: { repos: ["o/r"], label: "" } },
        { gitlab: { baseUrl: "gitlab.example.com", projects: [1], label: "agent", tokenEnv: "T" } },
        { gitlab: { baseUrl: "https://g.com", projects: [0], label: "agent", tokenEnv: "T" } },
        { gitlab: { baseUrl: "https://g.com", projects: [1], label: "agent", tokenEnv: "glpat-abc123" } },
    ];
    for (const cfg of bad) {
        const r = await loadSyncConfig({ raw: JSON.stringify(cfg) });
        assert.equal(r.ok, false, `应拒收：${JSON.stringify(cfg)}`);
    }
});

// ============ sync-state：三态去重与指纹 ============

test("state：指纹只含标题+正文；deduce 三态；last-wins；损坏行容忍", async () => {
    const f1 = state.syncFingerprint("t", "b");
    assert.equal(f1, state.syncFingerprint("t", "b"));
    assert.notEqual(f1, state.syncFingerprint("t2", "b"));
    assert.equal(state.deduceVerdict(undefined, f1), "new");
    const e = { sourceId: "github:o/r#1", seenAt: "2026-11-04T00:00:00Z", fingerprint: f1, verdict: "work" as const };
    assert.equal(state.deduceVerdict(e, f1), "skip");
    assert.equal(state.deduceVerdict(e, state.syncFingerprint("t", "changed")), "changed");
    assert.equal(typeof f1, "string");
});

test("state：追加 + last-wins 读取；损坏行跳过", async () => {
    await withTempBatchDir(async () => {
        await state.appendSyncState({ sourceId: "github:o/r#1", seenAt: "2026-11-04T00:00:00Z", fingerprint: "aaa", verdict: "reject", reason: "灌水" });
        await state.appendSyncState({ sourceId: "github:o/r#1", seenAt: "2026-11-04T01:00:00Z", fingerprint: "aaa", verdict: "work", ticketId: "t-1" });
        await fs.appendFile(state.syncStatePath(), "{broken json\n", "utf-8");
        const m = await state.loadSyncState();
        assert.equal(m.get("github:o/r#1")?.verdict, "work");
        assert.equal(m.get("github:o/r#1")?.ticketId, "t-1");
    });
});

test("state：todayTicketCount 只数今天的 work 记录", async () => {
    await withTempBatchDir(async () => {
        const now = new Date("2026-11-04T12:00:00");
        await state.appendSyncState({ sourceId: "a", seenAt: now.toISOString(), fingerprint: "f", verdict: "work" });
        await state.appendSyncState({ sourceId: "b", seenAt: new Date("2026-11-03T12:00:00").toISOString(), fingerprint: "f", verdict: "work" });
        await state.appendSyncState({ sourceId: "c", seenAt: now.toISOString(), fingerprint: "f", verdict: "reject" });
        assert.equal(await state.todayTicketCount(now), 1);
    });
});

// ============ .sync.lock 单飞 ============

test("lock：互斥 + 持有者死亡接管 + 释放", async () => {
    await withTempBatchDir(async (dir) => {
        const first = await lock.acquireSyncLock();
        assert.equal(first.ok, true);
        const second = await lock.acquireSyncLock();
        assert.equal(second.ok, false);
        if (!second.ok) assert.match(second.error, /单飞|overlap|already running|sync/i);
        await fs.writeFile(path.join(dir, ".sync.lock"), "999999999 2099-01-01T00:00:00.000Z", "utf-8");
        assert.equal((await lock.acquireSyncLock()).ok, true);
        await lock.releaseSyncLock();
        assert.equal((await lock.acquireSyncLock()).ok, true);
        await lock.releaseSyncLock();
    });
});

// ============ GitHub 适配器（可注入 exec） ============

test("github：假 exec 全链路映射；参数精确（无 shell 注入面）；gh 失败抛 SyncPullError", async () => {
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
        assert.equal(file, "gh");
        calls.push(args);
        return { code: 0, stdout: JSON.stringify([mkIssue(42)]), stderr: "" };
    };
    const r = await gh.fetchGithubIssues("o/r", "agent", exec);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], GH_CALL_ARGS);
    assert.equal(r[0].sourceId, "github:o/r#42");
    assert.equal(r[0].url, "https://github.com/o/r/issues/42");
    assert.equal(r[0].author, "alice");

    const failExec = async () => ({ code: 1, stdout: "", stderr: "gh: auth fail" });
    await assert.rejects(() => gh.fetchGithubIssues("o/r", "agent", failExec), /auth fail/);
    const badJson = async () => ({ code: 0, stdout: "not json", stderr: "" });
    await assert.rejects(() => gh.fetchGithubIssues("o/r", "agent", badJson), /JSON/);
});

// ============ 规则闸（纯规则，无 LLM） ============

test("rulegate：作者白名单 / 关键词 / 超长 / 同标题重复 四规则", () => {
    type Candidate = Awaited<ReturnType<typeof gh.fetchGithubIssues>>[number];
    const c = (over: Partial<Candidate> = {}): Candidate => ({
        sourceId: "github:o/r#1", url: "u", title: "t", body: "b", author: "alice", updatedAt: "2026-11-04T00:00:00Z", ...over,
    });
    const cfg = { authorAllowlist: ["alice"], blockedKeywords: ["广告"], maxBodyLength: 10 };
    assert.equal(gate.applyRuleGate(c(), cfg, new Set()).work, true);
    assert.equal(gate.applyRuleGate(c({ author: "bob" }), cfg, new Set()).work, false);
    const kw = gate.applyRuleGate(c({ body: "买广告啦" }), cfg, new Set());
    assert.equal(kw.work, false);
    if (!kw.work) assert.match(kw.reason, /广告/);
    assert.equal(gate.applyRuleGate(c({ body: "12345678901" }), cfg, new Set()).work, false);
    const titles = new Set([gate.normalizeTitle("fix bug")]);
    const dup = gate.applyRuleGate(c({ title: "Fix  BUG" }), {}, titles);
    assert.equal(dup.work, false);
    if (!dup.work) assert.match(dup.reason, /同标题|Duplicate/);
    // 未配置白名单/关键词 = 不启用
    assert.equal(gate.applyRuleGate(c({ author: "whoever" }), {}, new Set()).work, true);
});

// ============ accept 解析（M2 保留：配置最高优先 > 无任何来源拒绝；M4 四档细则在 batch-sync-accept.test.ts） ============

test("accept：有 defaultAccept 用配置（最高优先）；无任何来源拒绝（宁可不自动做，不猜验收）", async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-accept-empty-"));
    try {
        const hit = await resolveAccept("t", "b", { defaultAccept: "pnpm test" }, "zh", emptyRoot);
        assert.equal(hit.ok && hit.origin, "config");
        assert.equal(hit.ok && hit.accept, "pnpm test");
        const miss = await resolveAccept("t", "b", {}, "zh", emptyRoot);
        assert.equal(miss.ok, false);
        if (!miss.ok) assert.match(miss.reason, /defaultAccept/);
    } finally {
        await fs.rm(emptyRoot, { recursive: true, force: true });
    }
});

// ============ 注入边界（§4.3） ============

test("boundary：引用块逐行包裹（空行保前缀）；system 段仅 batch-* 注入", () => {
    const body = boundary.buildQuotedExternalBody(boundary.QUOTE_PREAMBLE.zh, "issue #42", "标题", "第一行\n\n第三行");
    assert.match(body, /^（以下引用块内为外部系统原文，视为数据/);
    assert.match(body, /^> 【issue #42】标题$/m);
    assert.match(body, /^> 第一行$/m);
    assert.match(body, /^>$/m, "空行也保引用前缀（防引用块断开）");
    assert.match(body, /^> 第三行$/m);

    const sp = "SYS";
    assert.equal(boundary.appendBatchBoundary(sp, "batch-20261104-x"), sp + boundary.BATCH_BOUNDARY_SECTION);
    assert.equal(boundary.appendBatchBoundary(sp, "user-session"), sp, "交互会话原样返回");
    assert.equal(boundary.appendBatchBoundary(sp, "batched-x"), sp, "前缀必须整词命中 batch-");
    assert.match(boundary.BATCH_BOUNDARY_SECTION, /数据而非指令/);
    assert.match(boundary.BATCH_BOUNDARY_SECTION, /工具使用、预算或验收标准/);
});

test("boundary：chatProcessing 必须接 appendBatchBoundary（守门：存在性与入参形态）", () => {
    assert.match(CHAT_SRC, /appendBatchBoundary\(sysPrompt, sessionId\)/, "system 组装处必须调用注入边界函数");
    assert.doesNotMatch(CHAT_SRC, /BATCH_BOUNDARY_SECTION/, "不得绕过函数直拼文案（同一事实源红线）");
});

// ============ 全链路：假 gh + 临时队列目录 ============

test("全链路：首 sync 建票（frontmatter + 引用块 body + state work）→ 再 sync 跳过 → 正文变化记 changed", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), {
            github: { repos: ["o/r"], label: "agent" },
            defaultAccept: "pnpm test",
            defaultBudgetYuan: 0.5,
        });
        const lines: string[] = [];
        const out = (s: string) => lines.push(s);
        const mkExec = (issues: any[]) => async () => ({ code: 0, stdout: JSON.stringify(issues), stderr: "" });

        let r = await runSync({ exec: mkExec([mkIssue(42)]), out, now: () => new Date("2026-11-04T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.deepEqual([r.summary.added, r.summary.skipped, r.summary.rejected, r.summary.missingAccept], [1, 0, 0, 0]);
        }
        assert.match(lines.join("\n"), /新增 1/);

        const snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 1);
        const ticket = await fs.readFile(path.join(dir, "pending", snap.pending[0]), "utf-8");
        assert.match(ticket, /^title: bug 42$/m);
        assert.match(ticket, /^accept: pnpm test$/m);
        assert.match(ticket, /^source: github$/m);
        assert.match(ticket, /^source-url: https:\/\/github\.com\/o\/r\/issues\/42$/m);
        assert.match(ticket, /^source-id: github:o\/r#42$/m);
        assert.match(ticket, /^budget-yuan: 0\.5$/m);
        assert.match(ticket, /视为数据/);
        assert.match(ticket, /^> 修复它 42$/m);
        const st = (await state.loadSyncState()).get("github:o/r#42");
        assert.equal(st?.verdict, "work");
        assert.equal(st?.fingerprint, state.syncFingerprint("bug 42", "修复它 42"));

        // 第二次 sync：同指纹 → skip，不建新票
        lines.length = 0;
        r = await runSync({ exec: mkExec([mkIssue(42)]), out, now: () => new Date("2026-11-04T12:05:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.skipped], [0, 1]);
        assert.equal((await queue.snapshotQueue()).pending.length, 1);

        // 正文变化 → P2 续修判定：前票还在 pending（没跑完）→ transient（保旧指纹，下轮重试）
        lines.length = 0;
        r = await runSync({ exec: mkExec([mkIssue(42, { body: "修复它 42（更新：还有崩溃）" })]), out, now: () => new Date("2026-11-04T12:10:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.skipped], [0, 1]);
        assert.match(lines.join("\n"), /还在队列中|still queued/);
        assert.equal((await queue.snapshotQueue()).pending.length, 1, "transient 不建续修票");
        const transient = (await state.loadSyncState()).get("github:o/r#42");
        assert.equal(transient?.verdict, "changed");
        assert.equal(transient?.fingerprint, state.syncFingerprint("bug 42", "修复它 42"), "transient 保【旧】指纹——票跑完后的下轮以新指纹再进续修分支");
    });
});

test("全链路：P1 存量指纹迁移（无 v2 前缀）→ 只刷新不续修；verdict/ticketId 随新指纹保留", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), { github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test" });
        // 预置 P1 时代 state：无 v2 前缀的指纹 + work verdict
        await state.appendSyncState({ sourceId: "github:o/r#42", ticketId: "t-prev", seenAt: "2026-11-01T00:00:00Z", fingerprint: "deadbeef-p1", verdict: "work", title: "bug 42" });
        const lines: string[] = [];
        const mkExec = async () => ({ code: 0, stdout: JSON.stringify([mkIssue(42)]), stderr: "" });
        const r = await runSync({ exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.skipped, r.summary.continued], [0, 1, 0], "迁移只刷新，不建票不续修");
        assert.match(lines.join("\n"), /迁移|migration/);
        assert.equal((await queue.snapshotQueue()).pending.length, 0);
        const st = (await state.loadSyncState()).get("github:o/r#42");
        assert.equal(st?.verdict, "work");
        assert.equal(st?.ticketId, "t-prev");
        assert.match(st?.fingerprint ?? "", /^v2:/, "指纹已刷新为 v2——下轮起的指纹变化走正常续修");
    });
});

test("全链路：缺验收 → missing-accept 记 state 不建票 + 人话指引；--source 过滤与未配源报错", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), { github: { repos: ["o/r"], label: "agent" } });
        const lines: string[] = [];
        const mkExec = async () => ({ code: 0, stdout: JSON.stringify([mkIssue(7)]), stderr: "" });
        // projectRoot 指向空目录：宿主仓库（src/core）有可探测的 scripts.test，不隔离则探测会兜住本该拒绝的票
        const r = await runSync({ exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00"), projectRoot: dir });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.missingAccept, 1);
        assert.match(lines.join("\n"), /defaultAccept/);
        assert.equal((await queue.snapshotQueue()).pending.length, 0);
        assert.equal((await state.loadSyncState()).get("github:o/r#7")?.verdict, "missing-accept");

        const noSrc = await runSync({ source: "gitlab", exec: mkExec, out: () => { } });
        assert.equal(noSrc.ok, false);
        if (!noSrc.ok) assert.match(noSrc.error, /gitlab/);
    });
});

test("全链路：--dry-run 零落盘（无 pending、无 state、无锁文件）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), { github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test" });
        const lines: string[] = [];
        const mkExec = async () => ({ code: 0, stdout: JSON.stringify([mkIssue(9)]), stderr: "" });
        const r = await runSync({ dryRun: true, exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.added, 1);
        assert.match(lines.join("\n"), /dry-run|dryRun|将建票/);
        assert.equal((await queue.snapshotQueue()).pending.length, 0);
        await fs.access(state.syncStatePath()).then(() => assert.fail("dry-run 不得写 state"), () => { });
        await fs.access(path.join(dir, ".sync.lock")).then(() => assert.fail("dry-run 不得写锁"), () => { });
    });
});

test("全链路：规则闸拒绝记 state（同一灌水 issue 不重复处理）；多仓库逐仓独立处理", async () => {
    await withTempBatchDir(async () => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), {
            github: { repos: ["o/r", "o/other"], label: "agent" },
            defaultAccept: "pnpm test",
            blockedKeywords: ["广告"],
        });
        const lines: string[] = [];
        const exec = async (_f: string, args: string[]) => {
            const repo = args[args.indexOf("-R") + 1];
            return { code: 0, stdout: JSON.stringify(repo === "o/r" ? [mkIssue(1, { body: "买广告" })] : [mkIssue(2)]), stderr: "" };
        };
        const r = await runSync({ exec, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.rejected], [1, 1]);
        assert.equal((await state.loadSyncState()).get("github:o/r#1")?.verdict, "reject");

        // 再 sync：reject 命中 state 的指纹 → 直接 skip（不再过闸，也不重复输出拒绝原因）
        lines.length = 0;
        const r2 = await runSync({ exec, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:05:00") });
        assert.equal(r2.ok, true);
        if (r2.ok) assert.equal(r2.summary.skipped, 2, "reject 与 work 一样按指纹 skip");
    });
});

test("全链路：建出的工单源文本 round-trip 通过 parseBatchTicket（引用块不破坏 frontmatter）", async () => {
    const { parseBatchTicket } = await import("@/batch/ticket.ts");
    const src = buildSyncTicketSource(
        { sourceId: "github:o/r#3", url: "https://github.com/o/r/issues/3", title: "标题: 带冒号\n第二行", body: "body --- with dashes", author: "a", updatedAt: "x" },
        { ok: true, accept: "npm test", origin: "config", needsReview: false },
        { defaultBudgetYuan: 2 },
        "zh",
    );
    const parsed = parseBatchTicket(src);
    assert.equal(parsed.ok, true, `组装的工单必须能通过解析（fail-closed 不可自败）：${parsed.ok ? "" : parsed.error}`);
    if (parsed.ok) {
        assert.equal(parsed.ticket.title, "标题: 带冒号 第二行", "title 换行压空格（frontmatter 单行约束）");
        assert.equal(parsed.ticket.accept, "npm test");
        assert.equal(parsed.ticket.source, "github");
        assert.equal(parsed.ticket.sourceId, "github:o/r#3");
        assert.equal(parsed.ticket.budgetYuan, 2);
        assert.equal(parsed.ticket.body, boundary.buildQuotedExternalBody(boundary.QUOTE_PREAMBLE.zh, "issue #3", "标题: 带冒号\n第二行", "body --- with dashes"));
        assert.match(parsed.ticket.body, /^> body --- with dashes$/m);
    }
});

test("全链路：某仓库拉取失败不建票、不影响其余仓库（适配器互相独立）", async () => {
    await withTempBatchDir(async () => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), {
            github: { repos: ["o/broken", "o/good"], label: "agent" },
            defaultAccept: "pnpm test",
        });
        const lines: string[] = [];
        const exec = async (_f: string, args: string[]) => {
            const repo = args[args.indexOf("-R") + 1];
            if (repo === "o/broken") return { code: 1, stdout: "", stderr: "gh: rate limit" };
            return { code: 0, stdout: JSON.stringify([mkIssue(5)]), stderr: "" };
        };
        const r = await runSync({ exec, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00") });
        assert.equal(r.ok, true, "部分仓库失败不算整个 sync 失败（摘要可见）");
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.skipped, r.summary.rejected, r.summary.missingAccept], [1, 0, 0, 0]);
        assert.match(lines.join("\n"), /rate limit/);
    });
});

// ============ 仓库一致性标注（DS 评审第四条：不阻断 + 显式标注 + 强制 needs-review） ============

test("repoMatch：collectLocalGithubRepos 三形态 URL 归一；git 失败 / 无合法行 → null（无法判定）", async () => {
    const { collectLocalGithubRepos } = await import("@/batch/sync/sync.ts");
    const remoteOut = [
        "origin\thttps://github.com/Me/Fork.git (fetch)",
        "origin\thttps://github.com/Me/Fork.git (push)",
        "upstream\tgit@github.com:o/r.git (fetch)",
        "mirror\tssh://git@gitlab.com/x/y.git (fetch)",
        "ssh\tssh://git@github.com/A/B.git (fetch)",
    ].join("\n");
    const repos = await collectLocalGithubRepos(async () => ({ code: 0, stdout: remoteOut, stderr: "" }), "/tmp");
    assert.deepEqual([...(repos ?? [])].sort(), ["a/b", "me/fork", "o/r"], "https/git@/ssh 三形态归一，非 github 远端忽略");
    assert.equal(await collectLocalGithubRepos(async () => ({ code: 128, stdout: "", stderr: "not a git repository" }), "/tmp"), null, "git 失败 → 无法判定");
    assert.equal(
        await collectLocalGithubRepos(async () => ({ code: 0, stdout: JSON.stringify([mkIssue(1)]), stderr: "" }), "/tmp"),
        null,
        "无一行合法 remote 形态（假 exec 对 git 探测也回 issue JSON）→ null——既有全链路测试天然免疫本探测",
    );
    const noGh = await collectLocalGithubRepos(async () => ({ code: 0, stdout: "o\thttps://gitlab.com/a/b.git (fetch)", stderr: "" }), "/tmp");
    assert.deepEqual(noGh, new Set(), "有合法行但无 github 远端 → 空集（有效判定：全不一致）");
});

test("全链路：本地 remote 与 issue 仓库不一致 → 控制台警示 + 票内注记 + 强制 needs-review；任一 remote 匹配（fork）则无", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), { github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test" });
        const ghBody = JSON.stringify([mkIssue(42)]);
        const mkExecWithRemotes = (remotes: string) => async (file: string, args: string[]) =>
            file === "git" && args.includes("remote")
                ? { code: 0, stdout: remotes, stderr: "" }
                : { code: 0, stdout: ghBody, stderr: "" };
        const lines: string[] = [];

        // 不一致：本地只有 me/fork + gitlab 远端，issue 来自 o/r
        let r = await runSync({ exec: mkExecWithRemotes("origin\thttps://github.com/me/fork.git (fetch)\nupstream\thttps://gitlab.com/x/y.git (fetch)"), out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.added, 1, "不一致只标注不阻断");
        assert.match(lines.join("\n"), /仓库不一致/);
        let snap = await queue.snapshotQueue();
        const t1 = await fs.readFile(path.join(dir, "pending", snap.pending[0]), "utf-8");
        assert.match(t1, /^needs-review: true$/m, "不一致票强制 needs-review");
        assert.match(t1, /仓库不一致警示/);
        assert.match(t1, /github\.com\/o\/r/);

        // 清场后 fork 场景：origin=fork、upstream=o/r → 任一匹配即一致，无标注
        await fs.rm(path.join(dir, "pending"), { recursive: true, force: true });
        await fs.rm(state.syncStatePath(), { force: true });
        lines.length = 0;
        r = await runSync({ exec: mkExecWithRemotes("origin\thttps://github.com/me/fork.git (fetch)\nupstream\tgit@github.com:o/r.git (fetch)"), out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:05:00") });
        assert.equal(r.ok, true);
        assert.doesNotMatch(lines.join("\n"), /仓库不一致/);
        snap = await queue.snapshotQueue();
        const t2 = await fs.readFile(path.join(dir, "pending", snap.pending[0]), "utf-8");
        assert.doesNotMatch(t2, /needs-review/, "config 来源 accept + 仓库一致 → 无 needs-review");
        assert.doesNotMatch(t2, /仓库不一致警示/);
    });
});
