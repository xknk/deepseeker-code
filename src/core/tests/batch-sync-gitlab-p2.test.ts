/**
 * @file tests/batch-sync-gitlab-p2.test.ts
 * @description 多入口工单流水线 P2：GitLab 侧补齐项守门测试。
 *
 *  覆盖：uploads 链接三形态归一（extractGitlabUploads）/ 附件下载器（makeGitlabDownloadFile：
 *  token 只走环境变量 + 二进制落盘 + 失败降级）/ notes 指纹轨迹（fetchGitlabNotes：失败缺席不阻塞）/
 *  项目详情（fetchGitlabProject：default_branch 缺省 main）/ sync 全链路（附件落盘 + attachments fm +
 *  图片 → needs-review；仓库一致性标注：匹配不标注、不一致标注并降级）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const gl = await import("@/batch/sync/gitlab.ts");
const { runSync } = await import("@/batch/sync/sync.ts");
const { SYNC_CONFIG_PATH } = await import("@/batch/sync/config.ts");
const { defaultSyncExec } = await import("@/batch/sync/exec.ts");
const queue = await import("@/batch/queue.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-glp2-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const GL_CFG = { baseUrl: "https://gitlab.example.test", projects: [77], label: "agent", tokenEnv: "GL_T_P2" };

// ============ extractGitlabUploads：三形态归一 ============

test("uploads 三形态归一：相对补全项目路径 / 全路径拼 origin / 绝对原样；去重 + 尾标点剥离 + 上限 10", () => {
    const webUrl = "https://gl.example.test/grp/prj/-/issues/7";
    const out = gl.extractGitlabUploads(
        ["看 /uploads/abc/pic.png", "/grp/prj/uploads/def/doc.txt", "https://gl.example.test/grp/prj/uploads/abc/pic.png", "https://other.host/x/uploads/q.bin.",
            "https://abs.host/g/-/uploads/z.png)", "plain text /notupload/x", "/uploads/abc/pic.png"].join("\n"),
        webUrl,
    );
    assert.deepEqual(out, [
        "https://gl.example.test/grp/prj/uploads/abc/pic.png", // 相对 → origin+项目路径（与全路径绝对形态去重合一）
        "https://gl.example.test/grp/prj/uploads/def/doc.txt", // 全路径 → origin + 该段
        "https://other.host/x/uploads/q.bin",                   // 绝对原样；尾句点剥离
        "https://abs.host/g/-/uploads/z.png",                   // /-/uploads/ 变体；）不进匹配（字符集排除）
    ]);
    // 非法 web_url：相对链接跳过、绝对照收
    const only = gl.extractGitlabUploads("/uploads/abc/a.png https://k.host/g/uploads/b.png", "not-a-url");
    assert.deepEqual(only, ["https://k.host/g/uploads/b.png"]);
    // 上限 10
    const many = gl.extractGitlabUploads(Array.from({ length: 13 }, (_, i) => `/uploads/h/f${i}.bin`).join(" "), webUrl);
    assert.equal(many.length, 10);
    assert.equal(gl.extractGitlabUploads("no uploads here", webUrl).length, 0);
});

// ============ makeGitlabDownloadFile：token 只走环境变量 ============

test("download：token 缺设逐附件未读取（原因点名环境变量）；有 token 经 binary 落盘；binary 失败透传", async () => {
    await withTempBatchDir(async (dir) => {
        delete process.env.GL_T_P2;
        const dl = gl.makeGitlabDownloadFile(GL_CFG);
        const r1 = await dl("https://gitlab.example.test/grp/prj/uploads/abc/f.png", path.join(dir, "a.png"));
        assert.equal(r1.ok, false);
        if (!r1.ok) assert.match(r1.reason, /GL_T_P2/, "原因点名缺失的环境变量");
        // 有 token + 假 binary
        process.env.GL_T_P2 = "tok";
        let seenHeaders: Record<string, string> = {};
        const dl2 = gl.makeGitlabDownloadFile(GL_CFG, {
            binary: async (url, headers) => {
                seenHeaders = headers;
                return { ok: true, bytes: Buffer.from("PNGDATA") };
            },
        });
        const dest = path.join(dir, "b.png");
        const r2 = await dl2("https://x/f.png", dest);
        assert.equal(r2.ok, true);
        if (r2.ok) assert.equal(r2.sizeBytes, 7);
        assert.equal(await fs.readFile(dest, "utf-8"), "PNGDATA");
        assert.equal(seenHeaders["PRIVATE-TOKEN"], "tok", "token 从环境变量读、经 PRIVATE-TOKEN 头");
        // binary 失败透传
        const dl3 = gl.makeGitlabDownloadFile(GL_CFG, { binary: async () => ({ ok: false, reason: "HTTP 500" }) });
        const r3 = await dl3("https://x/f.png", path.join(dir, "c.png"));
        assert.equal(r3.ok, false);
        if (!r3.ok) assert.equal(r3.reason, "HTTP 500");
        delete process.env.GL_T_P2;
    });
});

// ============ notes 轨迹 / 项目详情 ============

test("notes：正常映射 (id,updatedAt) 轨迹；HTTP 失败 / token 缺设 → undefined（缺席不阻塞建票）", async () => {
    process.env.GL_T_P2 = "tok";
    let calls = 0;
    const okFetch = async () => { calls++; return { status: 200, body: JSON.stringify([{ id: 3, updated_at: "2026-11-05T08:00:00Z" }, { id: "s4", updated_at: "2026-11-05T09:00:00Z" }]), headers: {} }; };
    const refs = await gl.fetchGitlabNotes(GL_CFG, 77, 7, { fetchImpl: okFetch });
    assert.deepEqual(refs, [{ id: "3", updatedAt: "2026-11-05T08:00:00Z" }, { id: "s4", updatedAt: "2026-11-05T09:00:00Z" }], "数字 id 归一为字符串");
    const badFetch = async () => ({ status: 500, body: "boom", headers: {} });
    assert.equal(await gl.fetchGitlabNotes(GL_CFG, 77, 7, { fetchImpl: badFetch }), undefined);
    delete process.env.GL_T_P2;
    const before = calls;
    assert.equal(await gl.fetchGitlabNotes(GL_CFG, 77, 7, { fetchImpl: okFetch }), undefined, "token 缺设不发请求");
    assert.equal(calls, before);
});

test("project：default_branch 缺省 main；非 2xx 抛错；path_with_namespace 必须有", async () => {
    process.env.GL_T_P2 = "tok";
    const info = await gl.fetchGitlabProject(GL_CFG, 77, { fetchImpl: async () => ({ status: 200, body: JSON.stringify({ path_with_namespace: "Group/Proj" }), headers: {} }) });
    assert.deepEqual(info, { pathWithNamespace: "Group/Proj", defaultBranch: "main" });
    const info2 = await gl.fetchGitlabProject(GL_CFG, 77, { fetchImpl: async () => ({ status: 200, body: JSON.stringify({ path_with_namespace: "g/p", default_branch: "trunk" }), headers: {} }) });
    assert.equal(info2.defaultBranch, "trunk");
    await assert.rejects(gl.fetchGitlabProject(GL_CFG, 77, { fetchImpl: async () => ({ status: 404, body: "{}", headers: {} }) }));
    await assert.rejects(gl.fetchGitlabProject(GL_CFG, 77, { fetchImpl: async () => ({ status: 200, body: JSON.stringify({ default_branch: "x" }), headers: {} }) }), "缺 path_with_namespace 抛错");
    delete process.env.GL_T_P2;
});

// ============ sync 全链路：附件 + 一致性标注 ============

const gitlabFetchFake = (issueDescription: string) => async (url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> => {
    if (url.includes("/notes")) return { status: 200, body: JSON.stringify([{ id: 1, updated_at: "2026-11-05T09:30:00Z" }]), headers: {} };
    if (url.includes("/issues?")) {
        return {
            status: 200,
            body: JSON.stringify([{ iid: 7, title: "gl ticket", description: issueDescription, web_url: "https://gitlab.example.test/group/proj/-/issues/7", updated_at: "2026-11-05T09:00:00Z", author: { username: "bob" } }]),
            headers: {},
        };
    }
    if (url.includes("/projects/77")) return { status: 200, body: JSON.stringify({ path_with_namespace: "group/proj", default_branch: "main" }), headers: {} };
    return { status: 404, body: "{}", headers: {} };
};

/** 假下载器：png 链接落 PNG 魔数（判成图片 → needs-review），其余落文本。 */
const glDownloadFake = async (url: string, destAbs: string): Promise<{ ok: true; sizeBytes: number } | { ok: false; reason: string }> => {
    const bytes = url.endsWith(".png") ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]) : Buffer.from("hello attachment");
    await fs.writeFile(destAbs, bytes);
    return { ok: true, sizeBytes: bytes.length };
};

/** 沙盒本地仓（remote 指向 GitLab host/path —— 一致性标注的判定输入）。 */
const sandboxRepo = async (remoteUrl: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-glp2-repo-"));
    const init = await defaultSyncExec("git", ["init", "-b", "main", dir]);
    assert.equal(init.code, 0, init.stderr);
    const rem = await defaultSyncExec("git", ["-C", dir, "remote", "add", "origin", remoteUrl]);
    assert.equal(rem.code, 0, rem.stderr);
    return dir;
};

test("gitlab sync 附件链：图片+文本落盘（attachments fm + 图片 → needs-review）；远端一致 → 不标注", async () => {
    await withTempBatchDir(async (dir) => {
        await fs.mkdir(path.dirname(SYNC_CONFIG_PATH()), { recursive: true });
        await fs.writeFile(SYNC_CONFIG_PATH(), JSON.stringify({ gitlab: GL_CFG, defaultAccept: "npm test" }), "utf-8");
        process.env.GL_T_P2 = "tok";
        const repo = await sandboxRepo("https://gitlab.example.test/group/proj.git");
        try {
            const lines: string[] = [];
            const r = await runSync({
                exec: defaultSyncExec,
                fetchImpl: gitlabFetchFake("看截图 /uploads/abc/bug.png 与日志 /uploads/def/err.txt"),
                gitlabDownload: glDownloadFake,
                projectRoot: repo,
                out: (s) => lines.push(s),
                now: () => new Date("2026-11-05T12:00:00"),
            });
            assert.equal(r.ok, true, r.ok ? "" : r.error);
            if (r.ok) assert.equal(r.summary.added, 1);
            const snap = await queue.snapshotQueue();
            const id = snap.pending[0].replace(/\.md$/, "");
            const t = await fs.readFile(path.join(dir, "pending", snap.pending[0]), "utf-8");
            assert.match(t, /^source-id: gitlab:77#7$/m);
            assert.match(t, new RegExp(`^attachments: batch/attachments/${id}$`, "m"), "有落盘才写 attachments fm");
            assert.match(t, /^needs-review:\s*true$/m, "图片附件 → needs-review（视觉注入新攻击面）");
            assert.match(t, /附件/);
            assert.match(t, /bug\.png/, "附件段带文件名");
            assert.match(t, /err\.txt/, "文本附件内联进票");
            // 远端一致 → 无不一致标注
            assert.doesNotMatch(t, /与本地仓库不一致|repo mismatch/i);
            assert.doesNotMatch(lines.join("\n"), /与本地仓库不一致|repo mismatch/i);
        } finally {
            delete process.env.GL_T_P2;
            await fs.rm(repo, { recursive: true, force: true });
        }
    });
});

test("gitlab sync 仓库一致性：远端 host/path 对不上 → 控制台 + 票内标注 + 强制 needs-review（fork 合法不阻断）", async () => {
    await withTempBatchDir(async (dir) => {
        await fs.mkdir(path.dirname(SYNC_CONFIG_PATH()), { recursive: true });
        await fs.writeFile(SYNC_CONFIG_PATH(), JSON.stringify({ gitlab: GL_CFG, defaultAccept: "npm test" }), "utf-8");
        process.env.GL_T_P2 = "tok";
        const repo = await sandboxRepo("https://gitlab.example.test/other/fork-repo.git");
        try {
            const lines: string[] = [];
            const r = await runSync({
                exec: defaultSyncExec,
                fetchImpl: gitlabFetchFake("正文（无附件）"),
                projectRoot: repo,
                out: (s) => lines.push(s),
                now: () => new Date("2026-11-05T12:00:00"),
            });
            assert.equal(r.ok, true, r.ok ? "" : r.error);
            if (r.ok) assert.equal(r.summary.added, 1, "fork 工作流合法：标注不阻断建票");
            const t = await fs.readFile(path.join(dir, "pending", (await queue.snapshotQueue()).pending[0]), "utf-8");
            assert.match(lines.join("\n"), /gitlab\.example\.test\/group\/proj/, "控制台标注期望键");
            assert.match(t, /gitlab\.example\.test\/group\/proj/, "票内标注期望键（人复核时可见）");
            assert.match(t, /^needs-review:\s*true$/m, "不一致强制 needs-review");
            assert.doesNotMatch(t, /^attachments:/m, "无附件不写 attachments fm");
        } finally {
            delete process.env.GL_T_P2;
            await fs.rm(repo, { recursive: true, force: true });
        }
    });
});
