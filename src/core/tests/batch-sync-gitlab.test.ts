/**
 * @file tests/batch-sync-gitlab.test.ts
 * @description 多入口工单流水线 P1-M3：GitLab 适配器（batch/sync/gitlab.ts，可注入 fetch）与双源编排守门测试。
 *
 *  覆盖：假 fetch 全链路（不打真网）/ URL 参数（labels/state/per_page/增量 updated_after）/
 *  PRIVATE-TOKEN 取自 tokenEnv 环境变量（缺设 fail-closed）/ X-Next-Page 分页 / 双源独立
 *  （一源挂掉另一源照常建票）/ --source 过滤。零 LLM 红线同 M2（import 面由 core 轻模块保证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const gl = await import("@/batch/sync/gitlab.ts");
const state = await import("@/batch/sync/state.ts");
const { runSync } = await import("@/batch/sync/sync.ts");
const queue = await import("@/batch/queue.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-sync-gl-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const GL_ISSUE = (iid: number, over: Partial<{ title: string; description: string; updated_at: string; username: string }> = {}) => ({
    iid,
    title: over.title ?? `gl bug ${iid}`,
    description: over.description ?? `修 ${iid}`,
    web_url: `https://gitlab.example.com/g/p/-/issues/${iid}`,
    updated_at: over.updated_at ?? "2026-11-04T10:00:00Z",
    author: { username: over.username ?? "alice" },
});

/** 假 fetch：记录全部请求，按 URL 匹配响应。 */
const fakeFetchFactory = () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const respond = (body: any, headers: Record<string, string> = {}, status = 200) => async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: init?.headers ?? {} });
        return { status, body: typeof body === "string" ? body : JSON.stringify(body), headers };
    };
    return { calls, respond };
};

test("gitlab：假 fetch 全链路映射 + URL 参数 + token 头 + 统一候选形状", async () => {
    const { calls, respond } = fakeFetchFactory();
    process.env.TEST_GL_TOKEN = "tok-123";
    try {
        const r = await gl.fetchGitlabIssues(
            { baseUrl: "https://gitlab.example.com/", projects: [123], label: "agent", tokenEnv: "TEST_GL_TOKEN" },
            123,
            { fetchImpl: respond([GL_ISSUE(7)]) },
        );
        assert.equal(r[0].sourceId, "gitlab:123#7");
        assert.equal(r[0].url, "https://gitlab.example.com/g/p/-/issues/7");
        assert.equal(r[0].author, "alice");
        const u = new URL(calls[0].url);
        assert.equal(u.pathname, "/api/v4/projects/123/issues");
        assert.equal(u.searchParams.get("labels"), "agent");
        assert.equal(u.searchParams.get("state"), "opened");
        assert.equal(u.searchParams.get("per_page"), "100");
        assert.equal(u.searchParams.get("page"), "1");
        assert.equal(u.searchParams.has("updated_after"), false, "无游标不带 updated_after");
        assert.equal(calls[0].headers["PRIVATE-TOKEN"], "tok-123");
    } finally {
        delete process.env.TEST_GL_TOKEN;
    }
});

test("gitlab：增量 updated_after 透传；X-Next-Page 翻页；上限护栏", async () => {
    const { calls, respond } = fakeFetchFactory();
    process.env.TEST_GL_TOKEN = "t";
    try {
        // 两页：第一页带 X-Next-Page=2，第二页空（结束）
        const cfg = { baseUrl: "https://gitlab.example.com", projects: [9], label: "agent", tokenEnv: "TEST_GL_TOKEN" };
        const fetch2 = async (url: string, init?: { headers?: Record<string, string> }) => {
            const page = new URL(url).searchParams.get("page");
            if (page === "1") return respond([GL_ISSUE(1)], { "x-next-page": "2" })(url, init);
            return respond([GL_ISSUE(2)])(url, init);
        };
        const r = await gl.fetchGitlabIssues(cfg, 9, { fetchImpl: fetch2, updatedAfter: "2026-11-01T00:00:00Z" });
        assert.equal(r.length, 2);
        assert.equal(r[1].sourceId, "gitlab:9#2");
        const u1 = new URL(calls[0].url);
        assert.equal(u1.searchParams.get("updated_after"), "2026-11-01T00:00:00Z");
        assert.equal(new URL(calls[1].url).searchParams.get("page"), "2");
        assert.equal(calls.length, 2, "第二页无 next 停止");
    } finally {
        delete process.env.TEST_GL_TOKEN;
    }
});

test("gitlab：tokenEnv 缺设 fail-closed（点名环境变量）；HTTP 非 2xx 报状态码", async () => {
    delete process.env.TEST_GL_MISSING;
    await assert.rejects(
        () => gl.fetchGitlabIssues({ baseUrl: "https://g.com", projects: [1], label: "agent", tokenEnv: "TEST_GL_MISSING" }, 1, { fetchImpl: async () => ({ status: 200, body: "[]", headers: {} }) }),
        /TEST_GL_MISSING/,
    );
    const { respond } = fakeFetchFactory();
    process.env.TEST_GL_TOKEN = "t";
    try {
        await assert.rejects(
            () => gl.fetchGitlabIssues({ baseUrl: "https://g.com", projects: [1], label: "agent", tokenEnv: "TEST_GL_TOKEN" }, 1, { fetchImpl: respond({ message: "401 Unauthorized" }, {}, 401) }),
            /401/,
        );
    } finally {
        delete process.env.TEST_GL_TOKEN;
    }
});

test("双源编排：github+gitlab 同配，两源各建一票；一源挂掉另一源照常", async () => {
    await withTempBatchDir(async () => {
        await fs.mkdir(path.dirname(state.syncStatePath()), { recursive: true });
        await fs.writeFile(
            path.join(path.dirname(state.syncStatePath()), "sync.json"),
            JSON.stringify({
                github: { repos: ["o/r"], label: "agent" },
                gitlab: { baseUrl: "https://gitlab.example.com", projects: [55], label: "agent", tokenEnv: "TEST_GL_TOKEN" },
                defaultAccept: "pnpm test",
            }),
            "utf-8",
        );
        process.env.TEST_GL_TOKEN = "t";
        try {
            const exec = async () => ({ code: 0, stdout: JSON.stringify([{ number: 42, title: "gh bug", body: "b", url: "https://github.com/o/r/issues/42", updatedAt: "2026-11-04T10:00:00Z", author: { login: "a" } }]), stderr: "" });
            const fetch = async () => ({ status: 500, body: "boom", headers: {} }); // gitlab 挂
            const lines: string[] = [];
            const r = await runSync({ exec, fetchImpl: fetch, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00") });
            assert.equal(r.ok, true, "一源挂掉不算整体失败");
            if (r.ok) assert.equal(r.summary.added, 1, "github 正常建票");
            assert.match(lines.join("\n"), /500/);

            // gitlab 恢复后再跑：建 gitlab 票（github 同票被指纹去重跳过）
            const fetchOk = async () => ({ status: 200, body: JSON.stringify([GL_ISSUE(8)]), headers: {} });
            const lines2: string[] = [];
            const r2 = await runSync({ exec, fetchImpl: fetchOk, out: (s) => lines2.push(s), now: () => new Date("2026-11-04T12:10:00") });
            assert.equal(r2.ok, true);
            if (r2.ok) assert.deepEqual([r2.summary.added, r2.summary.skipped], [1, 1]);
            const ids = await queue.snapshotQueue();
            assert.equal(ids.pending.length, 2);
            // 「最后一张 = gitlab 票」是确定性断言：两票 id 都由注入时钟预生成（12:00/12:10），
            // 文件名字典序即 FIFO——此行同时钉住「非 github 源不得落到队列默认真实墙钟」
            // （2026-11-04 CI 时区翻车回归锚：UTC 上午跑曾把 gitlab 票排到 github 票之前）。
            const glTicket = await fs.readFile(path.join(path.dirname(state.syncStatePath()), "pending", ids.pending[ids.pending.length - 1]), "utf-8");
            assert.match(glTicket, /^source: gitlab$/m);
            assert.match(glTicket, /^source-id: gitlab:55#8$/m);
            assert.match(glTicket, /^source-url: https:\/\/gitlab\.example\.com\/g\/p\/-\/issues\/8$/m);
        } finally {
            delete process.env.TEST_GL_TOKEN;
        }
    });
});

test("--source gitlab 过滤：只拉 gitlab（github 不发起 exec 调用）", async () => {
    await withTempBatchDir(async () => {
        await fs.mkdir(path.dirname(state.syncStatePath()), { recursive: true });
        await fs.writeFile(
            path.join(path.dirname(state.syncStatePath()), "sync.json"),
            JSON.stringify({
                github: { repos: ["o/r"], label: "agent" },
                gitlab: { baseUrl: "https://gitlab.example.com", projects: [55], label: "agent", tokenEnv: "TEST_GL_TOKEN" },
                defaultAccept: "pnpm test",
            }),
            "utf-8",
        );
        process.env.TEST_GL_TOKEN = "t";
        try {
            let ghCalls = 0;
            const exec = async () => { ghCalls++; return { code: 0, stdout: "[]", stderr: "" }; };
            const fetch = async () => ({ status: 200, body: JSON.stringify([GL_ISSUE(3)]), headers: {} });
            const r = await runSync({ source: "gitlab", exec, fetchImpl: fetch, out: () => { }, now: () => new Date("2026-11-04T12:00:00") });
            assert.equal(r.ok, true);
            if (r.ok) assert.equal(r.summary.added, 1);
            assert.equal(ghCalls, 0, "--source gitlab 不发起 gh 调用");
            // 增量游标：第二次跑 updated_after 来自 state 的 updatedAt
            const calls: string[] = [];
            const fetchCap = async (url: string) => { calls.push(url); return { status: 200, body: "[]", headers: {} }; };
            await runSync({ source: "gitlab", exec, fetchImpl: fetchCap, out: () => { }, now: () => new Date("2026-11-04T12:20:00") });
            assert.equal(new URL(calls[0]).searchParams.get("updated_after"), "2026-11-04T10:00:00Z");
        } finally {
            delete process.env.TEST_GL_TOKEN;
        }
    });
});
