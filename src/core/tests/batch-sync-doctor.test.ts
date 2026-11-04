/**
 * @file tests/batch-sync-doctor.test.ts
 * @description 多入口工单流水线 P1-M7：`batch sync --check` doctor（§5.3 清单）守门测试。
 *
 *  覆盖：配置坏 fail-closed（只报配置、不查源）/ gh 鉴权失败（后续仓库检查不刷屏）/
 *  仓库不可达 / label 缺失（带可照抄创建命令）/ label 查询失败 / GitLab token 未设（不发起
 *  请求）/ 项目 401（token 权限指引）/ 404（baseUrl 指引）/ 网络异常 / label 缺失 / 全绿 /
 *  渲染面（✗ 必带「怎么修」行 + 汇总一行）/ 双语。gh 走注入 exec、GitLab 走注入 fetch，零真网。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const state = await import("@/batch/sync/state.ts");
const { runSyncCheck } = await import("@/batch/sync/doctor.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-doctor-test-"));
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

/** 假 gh：按 argv 分发应答，记录全部调用。 */
const fakeGh = (over: { authCode?: number; repoCode?: number; labelCode?: number; labelNames?: string[] } = {}) => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "auth") return { code: over.authCode ?? 0, stdout: "", stderr: "" };
        if (args[0] === "repo") {
            if ((over.repoCode ?? 0) !== 0) return { code: over.repoCode!, stdout: "", stderr: "gh: repo not found" };
            return { code: 0, stdout: '{"nameWithOwner":"o/r"}', stderr: "" };
        }
        if (args[0] === "label") {
            if ((over.labelCode ?? 0) !== 0) return { code: over.labelCode!, stdout: "", stderr: "gh: HTTP 502" };
            return { code: 0, stdout: JSON.stringify((over.labelNames ?? ["agent"]).map((n) => ({ name: n }))), stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected call" };
    };
    return { exec, calls };
};

/** 假 GitLab fetch：按 url 分发应答，记录全部调用。 */
const fakeGl = (over: { projStatus?: number; labelNames?: string[]; netFail?: boolean } = {}) => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
        calls.push(url);
        if (over.netFail) throw new Error("getaddrinfo ENOTFOUND");
        if (url.endsWith("/labels?per_page=100")) {
            return { status: 200, body: JSON.stringify((over.labelNames ?? ["agent"]).map((n) => ({ name: n }))), headers: {} };
        }
        return { status: over.projStatus ?? 200, body: '{"id":55}', headers: {} };
    };
    return { fetchImpl, calls };
};

const GITHUB_CFG = { github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test" };
const GL_CFG = { gitlab: { baseUrl: "https://gitlab.example.com", projects: [55], label: "agent", tokenEnv: "TEST_GL_TOKEN" }, defaultAccept: "pnpm test" };

// ============ 配置（fail-closed 第一关） ============

test("doctor：配置缺失只报配置这一项（不查源）；✗ 必带修复指引；汇总行退出面", async () => {
    await withTempBatchDir(async (dir) => {
        const { exec, calls } = fakeGh();
        const lines: string[] = [];
        const r = await runSyncCheck({ exec, out: (s) => lines.push(s) });
        assert.equal(r.ok, false);
        assert.equal(r.items.length, 1, "配置坏 → 只报配置（补好才有资格谈源）");
        assert.equal(r.items[0].ok, false);
        assert.match(r.items[0].text, /配置非法/);
        assert.match(r.items[0].fix ?? "", /sync\.json\.example/);
        assert.equal(calls.length, 0, "配置坏不发起 gh 调用");
        const text = lines.join("\n");
        assert.match(text, /✗ 配置非法/);
        assert.match(text, /└ 修复：/);
        assert.match(text, /--check 未过：1\/1/);
    });
});

// ============ GitHub 链 ============

test("doctor：GitHub 全绿（auth → repo → label 各 ✓；argv 形态精确）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), GITHUB_CFG);
        const { exec, calls } = fakeGh();
        const r = await runSyncCheck({ exec });
        assert.equal(r.ok, true);
        assert.equal(r.items.filter((i) => i.ok).length, r.items.length);
        assert.deepEqual(calls, [
            ["auth", "status"],
            ["repo", "view", "o/r", "--json", "nameWithOwner"],
            ["label", "list", "-R", "o/r", "--json", "name"],
        ]);
    });
});

test("doctor：gh 鉴权失败 → ✗ + 修复指引，且不再发起仓库/label 调用（不刷屏）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), GITHUB_CFG);
        const { exec, calls } = fakeGh({ authCode: 1 });
        const lines: string[] = [];
        const r = await runSyncCheck({ exec, out: (s) => lines.push(s) });
        assert.equal(r.ok, false);
        assert.equal(calls.length, 1, "auth 失败后无后续 gh 调用");
        const auth = r.items.find((i) => i.text.includes("gh"));
        assert.ok(auth && !auth.ok);
        assert.match(auth.fix ?? "", /gh auth login/);
        assert.equal(r.items.length, 2, "配置 + gh 两项（仓库检查跳过）");
    });
});

test("doctor：仓库不可达 → ✗ + fixRepo；该仓库 label 不再查", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), GITHUB_CFG);
        const { exec, calls } = fakeGh({ repoCode: 1 });
        const r = await runSyncCheck({ exec });
        assert.equal(r.ok, false);
        const repo = r.items.find((i) => i.text.includes("仓库不可达") || i.text.includes("unreachable"));
        assert.ok(repo && !repo.ok);
        assert.match(repo.fix ?? "", /gh repo view o\/r/);
        assert.equal(calls.filter((a) => a[0] === "label").length, 0, "仓库不可达不查 label");
    });
});

test("doctor：label 缺失 → ✗ + 可照抄创建命令；label 查询失败 → ✗ + 原因", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), GITHUB_CFG);
        const missing = fakeGh({ labelNames: ["other"] });
        const r1 = await runSyncCheck({ exec: missing.exec });
        assert.equal(r1.ok, false);
        const m = r1.items.find((i) => i.text.includes("label 不存在") || i.text.includes("Label missing"));
        assert.ok(m && !m.ok);
        assert.equal(m.fix, "gh label create agent -R o/r", "修复命令必须可照抄");

        await writeConfig(path.dirname(state.syncStatePath()), GITHUB_CFG);
        const fail = fakeGh({ labelCode: 1 });
        const r2 = await runSyncCheck({ exec: fail.exec });
        assert.equal(r2.ok, false);
        const f = r2.items[r2.items.length - 1];
        assert.ok(!f.ok);
        assert.match(f.text, /502/, "查询失败带 gh 原因（与「不存在」分开报）");
        assert.equal(f.fix, "gh label create agent -R o/r");
    });
});

// ============ GitLab 链 ============

test("doctor：GitLab token 未设 → 单项 ✗ + 修复指引，零网络请求", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), GL_CFG);
        const gl = fakeGl();
        const r = await runSyncCheck({ fetchImpl: gl.fetchImpl });
        assert.equal(r.ok, false);
        const tok = r.items.find((i) => !i.ok);
        assert.ok(tok);
        assert.match(tok.text, /TEST_GL_TOKEN/);
        assert.match(tok.fix ?? "", /export TEST_GL_TOKEN/);
        assert.equal(gl.calls.length, 0, "token 未设不发起任何请求");
    });
});

test("doctor：GitLab 401/404/网络异常/label 缺失 四个失败分支分开报", async () => {
    await withTempBatchDir(async (dir) => {
        const setTok = async () => { process.env.TEST_GL_TOKEN = "t"; };
        const unsetTok = async () => { delete process.env.TEST_GL_TOKEN; };

        await setTok();
        try {
            await writeConfig(path.dirname(state.syncStatePath()), GL_CFG);
            const p401 = fakeGl({ projStatus: 401 });
            const r1 = await runSyncCheck({ fetchImpl: p401.fetchImpl });
            const f1 = r1.items.find((i) => !i.ok);
            assert.ok(f1);
            assert.match(f1.text, /401/);
            assert.match(f1.fix ?? "", /权限|permission/i, "401 → token 权限指引");

            await writeConfig(path.dirname(state.syncStatePath()), GL_CFG);
            const p404 = fakeGl({ projStatus: 404 });
            const r2 = await runSyncCheck({ fetchImpl: p404.fetchImpl });
            const f2 = r2.items.find((i) => !i.ok);
            assert.ok(f2);
            assert.match(f2.text, /404/);
            assert.match(f2.fix ?? "", /baseUrl/);

            await writeConfig(path.dirname(state.syncStatePath()), GL_CFG);
            const net = fakeGl({ netFail: true });
            const r3 = await runSyncCheck({ fetchImpl: net.fetchImpl });
            const f3 = r3.items.find((i) => !i.ok);
            assert.ok(f3);
            assert.match(f3.text, /ENOTFOUND/);
            assert.match(f3.fix ?? "", /baseUrl/);

            await writeConfig(path.dirname(state.syncStatePath()), GL_CFG);
            const noLabel = fakeGl({ labelNames: ["other"] });
            const r4 = await runSyncCheck({ fetchImpl: noLabel.fetchImpl });
            assert.equal(r4.ok, false);
            const f4 = r4.items.find((i) => !i.ok);
            assert.ok(f4);
            assert.match(f4.text, /label 不存在|Label missing/);
            assert.match(f4.fix ?? "", /Settings → Labels/);

            await writeConfig(path.dirname(state.syncStatePath()), GL_CFG);
            const ok = fakeGl();
            const r5 = await runSyncCheck({ fetchImpl: ok.fetchImpl });
            assert.equal(r5.ok, true, "token + 项目 + label 全绿");
            assert.equal(ok.calls.filter((u) => u.includes("/labels")).length, 1);
        } finally {
            await unsetTok();
        }
    });
});

// ============ 渲染与双语 ============

test("sync.json.example 本身必须通过 loadSyncConfig 校验（防示例与实现漂移）", async () => {
    const { loadSyncConfig } = await import("@/batch/sync/config.ts");
    const fsSync = await import("fs");
    const p = await import("path");
    const { fileURLToPath } = await import("url");
    const repoRoot = p.resolve(p.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const raw = fsSync.readFileSync(p.join(repoRoot, "sync.json.example"), "utf-8");
    const r = await loadSyncConfig({ raw });
    assert.equal(r.ok, true, `示例配置必须能直接通过校验（照抄即用）：${r.ok ? "" : r.error}`);
});

test("doctor：渲染面——✗ 后跟「怎么修」行、汇总一行；en locale 走英文词表", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(state.syncStatePath()), GITHUB_CFG);
        const zh = fakeGh({ labelNames: ["other"] });
        const lines: string[] = [];
        await runSyncCheck({ exec: zh.exec, out: (s) => lines.push(s) });
        const text = lines.join("\n");
        assert.match(text, /✓ 配置合法/);
        assert.match(text, /✓ gh 已安装/);
        assert.match(text, /✓ 仓库可达：o\/r/);
        assert.match(text, /✗ label 不存在：agent/);
        assert.match(text, /└ 修复：gh label create agent -R o\/r/);
        assert.match(text, /--check 未过：1\/4/);

        const en = fakeGh({ labelNames: ["other"] });
        const enLines: string[] = [];
        await runSyncCheck({ exec: en.exec, locale: "en", out: (s) => enLines.push(s) });
        const enText = enLines.join("\n");
        assert.match(enText, /✓ Config valid/);
        assert.match(enText, /└ fix: gh label create/);
        assert.match(enText, /--check failed: 1\/4/);
    });
});
