/**
 * @file tests/batch-pr.test.ts
 * @description 多入口工单流水线 P2：`batch pr` 交付命令（§6.1）守门测试。
 *
 *  沙盒真 git（bare 假远端 + work 仓）+ 假 gh/fetchImpl 注入，全流程不发真网、不碰真仓：
 *  GitHub happy path（幂等标记/PR 正文四要素/无代理旗标红线/worktree 用完即弃）、
 *  behind 拒绝（手工 rebase 提示 + 标 needs-review + 冲突文件清单 + 零外发）、
 *  needs-review / 未过验收 / 无报告 / 已交付 四类预检拒绝、push 失败、fetch 失败（fail-closed）、
 *  GitLab MR 路径（Draft: 前缀 + Closes #iid）、buildPrBody 单元（封顶 20 / 空清单 / fixes #N）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { runBatchPr, buildPrBody, nameStatusToPaths } = await import("@/batch/pr.ts");
const { defaultSyncExec } = await import("@/batch/sync/exec.ts");
const { SYNC_CONFIG_PATH } = await import("@/batch/sync/config.ts");
type PrFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string; headers: Record<string, string> }>;
type SyncExec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-pr-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

const TICKET_ID = "20261105-120000-aaa";
const BRANCH = "dsc-wt-x-1";

/** 落一张已完成票：done 工单 + passed 报告（含产物分支）。 */
const seedDoneTicket = async (dir: string, opts?: { status?: string; needsReviewInReport?: boolean; needsReviewInTicket?: boolean; sourceId?: string }): Promise<void> => {
    await fs.mkdir(path.join(dir, "done"), { recursive: true });
    const sourceId = opts?.sourceId ?? "github:acme/widget#42";
    const ticket = [
        "---",
        `title: sandbox ticket`,
        "accept: npm test",
        opts?.needsReviewInTicket ? "needs-review: true" : null,
        "source: " + sourceId.split(":")[0],
        `source-id: ${sourceId}`,
        "---",
        "",
        "正文（含验收说明）",
    ].filter((l) => l !== null).join("\n");
    const report = [
        "---",
        `id: ${TICKET_ID}`,
        `status: ${opts?.status ?? "passed"}`,
        "cost-yuan: 0.42",
        `branch: ${BRANCH}`,
        opts?.needsReviewInReport ? "needs-review: true" : null,
        "---",
        "",
        "## 验收",
        "",
        "```",
        "npm test 全部通过（验收输出——断言它绝不进 PR 正文）",
        "```",
    ].filter((l) => l !== null).join("\n");
    await fs.writeFile(path.join(dir, "done", `${TICKET_ID}.md`), ticket, "utf-8");
    await fs.writeFile(path.join(dir, "done", `${TICKET_ID}.report.md`), report, "utf-8");
};

/** 沙盒仓库：bare 假远端 + work 仓（main 已推送）。 */
const setupSandbox = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-pr-sandbox-"));
    const remotePath = path.join(root, "remote.git");
    const workPath = path.join(root, "work");
    const git = async (dir: string, args: string[]): Promise<string> => {
        const r = await defaultSyncExec("git", ["-C", dir, ...args]);
        assert.equal(r.code, 0, `git ${args.join(" ")} 失败: ${r.stderr}`);
        return r.stdout;
    };
    const init = await defaultSyncExec("git", ["init", "--bare", "-b", "main", remotePath]);
    assert.equal(init.code, 0, init.stderr);
    const initWork = await defaultSyncExec("git", ["init", "-b", "main", workPath]);
    assert.equal(initWork.code, 0, initWork.stderr);
    await git(workPath, ["config", "user.email", "test@example.invalid"]);
    await git(workPath, ["config", "user.name", "tester"]);
    await git(workPath, ["remote", "add", "origin", remotePath]);
    await fs.writeFile(path.join(workPath, "README.md"), "# sandbox\n", "utf-8");
    await fs.writeFile(path.join(workPath, "shared.txt"), "base\n", "utf-8");
    await git(workPath, ["add", "README.md", "shared.txt"]);
    await git(workPath, ["commit", "-m", "init"]);
    await git(workPath, ["push", "-u", "origin", "main"]);
    return { root, remotePath, workPath, git };
};

/** 产物分支：从 main 分叉并提交两文件（含 shared.txt 供冲突场景改写）。 */
const makeArtifactBranch = async (workPath: string, git: (dir: string, args: string[]) => Promise<string>): Promise<void> => {
    await git(workPath, ["checkout", "-b", BRANCH]);
    await fs.writeFile(path.join(workPath, "src-feature.ts"), "export const x = 1;\n", "utf-8");
    await fs.writeFile(path.join(workPath, "shared.txt"), "from branch\n", "utf-8");
    await git(workPath, ["add", "src-feature.ts", "shared.txt"]);
    await git(workPath, ["commit", "-m", "fix: feature"]);
    await git(workPath, ["checkout", "main"]);
};

interface FakeState { calls: string[][]; ghBody: string; pushFail: boolean; fetchFail: boolean; ghPrFail: boolean; }

const makeFakeExec = (st: FakeState): SyncExec => async (file, args) => {
    st.calls.push([file, ...args]);
    if (file === "gh") {
        if (args[0] === "repo") return { code: 0, stdout: "main\n", stderr: "" }; // repo view → default branch
        if (args[0] === "pr") {
            if (st.ghPrFail) return { code: 1, stdout: "", stderr: "boom" };
            const i = args.indexOf("--body-file");
            st.ghBody = i >= 0 ? await fs.readFile(args[i + 1], "utf-8").catch(() => "") : "";
            return { code: 0, stdout: "https://fake.invalid/acme/widget/pull/7\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unexpected gh call" };
    }
    if (st.fetchFail && args.includes("fetch")) return { code: 1, stdout: "", stderr: "could not resolve host" };
    if (st.pushFail && args.includes("push")) return { code: 1, stdout: "", stderr: "pre-receive hook declined" };
    return defaultSyncExec(file, args);
};

test("batch pr happy path：全流程交付（幂等标记 + PR 正文四要素 + fixes #42 + 零代理旗标 + worktree 用完即弃）", async () => {
    await withTempBatchDir(async (dir) => {
        await seedDoneTicket(dir);
        const sb = await setupSandbox();
        await makeArtifactBranch(sb.workPath, sb.git);
        const wtRoot = path.join(sb.root, "wt");
        const st: FakeState = { calls: [], ghBody: "", pushFail: false, fetchFail: false, ghPrFail: false };
        const lines: string[] = [];
        const r = await runBatchPr(TICKET_ID, { exec: makeFakeExec(st), out: (s) => lines.push(s), worktreeRoot: wtRoot, cwd: sb.workPath });
        assert.equal(r.ok, true, r.ok ? "" : r.error);
        if (r.ok) {
            assert.equal(r.url, "https://fake.invalid/acme/widget/pull/7");
            assert.equal(r.branch, `agent/${TICKET_ID}`);
            assert.equal(r.base, "main");
        }
        // 幂等标记
        const marker = JSON.parse(await fs.readFile(path.join(dir, "done", `${TICKET_ID}.pr.json`), "utf-8"));
        assert.equal(marker.platform, "github");
        assert.equal(marker.branch, `agent/${TICKET_ID}`);
        assert.equal(marker.base, "main");
        // PR 正文四要素：标题 / 状态与成本 / 变更文件清单 / fixes；验收输出与 diff 不外发
        assert.match(st.ghBody, /^## sandbox ticket$/m);
        assert.match(st.ghBody, /acceptance \*\*passed\*\*/);
        assert.match(st.ghBody, /Cost: 0\.42 CNY/);
        assert.match(st.ghBody, /- `src-feature\.ts`/, "正文清单是纯路径（状态列已剥）");
        assert.match(st.ghBody, /- `shared\.txt`/);
        assert.doesNotMatch(st.ghBody, /`[MAD]\t|^[A-D]\t/m, "状态字母不进正文（试点 PR #4 实证 M\\t 漏进正文，已剥）");
        assert.match(st.ghBody, /fixes #42\s*$/);
        assert.doesNotMatch(st.ghBody, /验收输出|npm test 全部通过/, "验收输出永不外发");
        assert.doesNotMatch(st.ghBody, /from branch|base\\n|\+\+\+/, "diff 内容永不外发");
        // gh pr create 参数
        const createCall = st.calls.find((c) => c[0] === "gh" && c[1] === "pr");
        assert.ok(createCall);
        assert.ok(createCall.includes("--draft"), "草稿态 PR");
        assert.ok(createCall.includes("--repo") && createCall.includes("acme/widget"));
        // 红线：命令里无代理旗标（代理需求只进文案提示）
        assert.equal(st.calls.some((c) => c.join(" ").toLowerCase().includes("proxy")), false);
        // worktree 用完即弃
        await assert.rejects(fs.stat(path.join(wtRoot, TICKET_ID)));
        assert.equal(await fs.readFile(path.join(dir, "done", `${TICKET_ID}.md`), "utf-8").then((t) => t.includes("needs-review")), false, "成功交付不标 needs-review");
        // 控制台预览保留 name-status 状态列（人看有用）——与外发正文剥前缀相反
        const preview = lines.filter((l) => l.includes("src-feature.ts") || l.includes("shared.txt"));
        assert.ok(preview.some((l) => /^\s+A\tsrc-feature\.ts$/.test(l)), `预览带 A\\t 状态列：${preview.join(" | ")}`);
        await fs.rm(sb.root, { recursive: true, force: true });
    });
});

test("batch pr behind 拒绝：手工 rebase 提示 + 冲突文件清单 + 标 needs-review + 零外发（2026-11-05 拍板：不自动 rebase）", async () => {
    await withTempBatchDir(async (dir) => {
        await seedDoneTicket(dir);
        const sb = await setupSandbox();
        await makeArtifactBranch(sb.workPath, sb.git);
        // 主干前进（同文件改法不同 → merge-tree 出冲突行）：第二个克隆推 main
        const clone2 = path.join(sb.root, "clone2");
        const c2 = await defaultSyncExec("git", ["clone", sb.remotePath, clone2]);
        assert.equal(c2.code, 0, c2.stderr);
        await sb.git(clone2, ["config", "user.email", "test@example.invalid"]);
        await sb.git(clone2, ["config", "user.name", "tester"]);
        await fs.writeFile(path.join(clone2, "shared.txt"), "from main\n", "utf-8");
        await sb.git(clone2, ["add", "shared.txt"]);
        await sb.git(clone2, ["commit", "-m", "main advances"]);
        await sb.git(clone2, ["push", "origin", "main"]);
        const st: FakeState = { calls: [], ghBody: "", pushFail: false, fetchFail: false, ghPrFail: false };
        const lines: string[] = [];
        const r = await runBatchPr(TICKET_ID, { exec: makeFakeExec(st), out: (s) => lines.push(s), worktreeRoot: path.join(sb.root, "wt"), cwd: sb.workPath });
        assert.equal(r.ok, false);
        const all = lines.join("\n") + "\n" + r.error;
        assert.match(all, /落后 origin\/main/);
        assert.match(all, /手工命令|manual rebase/i);
        assert.match(all, /git rebase origin\/main/, "手工 rebase 命令可照抄");
        assert.match(all, /CONFLICT/, "merge-tree 冲突文件清单随拒绝一并给出");
        // 工单已标 needs-review（人工复核入口）
        const t = await fs.readFile(path.join(dir, "done", `${TICKET_ID}.md`), "utf-8");
        assert.match(t, /^needs-review:\s*true$/m);
        // 零外发：无 push、无 gh pr create、无幂等标记
        assert.equal(st.calls.some((c) => c.includes("push")), false);
        assert.equal(st.calls.some((c) => c[0] === "gh" && c[1] === "pr"), false);
        await assert.rejects(fs.readFile(path.join(dir, "done", `${TICKET_ID}.pr.json`)));
        await fs.rm(sb.root, { recursive: true, force: true });
    });
});

test("batch pr 预检拒绝：needs-review（报告 ∨ 票档，无豁免）/ 未过验收 / 无报告 / 已交付幂等", async () => {
    await withTempBatchDir(async (dir) => {
        // 报告侧 needs-review → 拒绝且零 git/gh 调用
        await seedDoneTicket(dir, { needsReviewInReport: true });
        let r = await runBatchPr(TICKET_ID, { exec: makeFakeExec({ calls: [], ghBody: "", pushFail: false, fetchFail: false, ghPrFail: false }), out: () => { } });
        assert.equal(r.ok, false);
        assert.match(r.ok ? "" : r.error, /needs-review 标记.*拒绝交付|carries a needs-review flag/s);
        // 票档侧 needs-review 同拒
        await seedDoneTicket(dir, { needsReviewInTicket: true });
        const calls: string[][] = [];
        r = await runBatchPr(TICKET_ID, { exec: makeFakeExec({ calls, ghBody: "", pushFail: false, fetchFail: false, ghPrFail: false }), out: () => { } });
        assert.equal(r.ok, false);
        assert.equal(calls.length, 0, "预检拒绝不碰 git/gh");
        // 未过验收
        await seedDoneTicket(dir, { status: "failed" });
        r = await runBatchPr(TICKET_ID, { out: () => { } });
        assert.match(r.ok ? "" : r.error, /验收未通过.*failed|did not pass acceptance/s);
        // 无报告
        await fs.rm(path.join(dir, "done"), { recursive: true, force: true });
        r = await runBatchPr(TICKET_ID, { out: () => { } });
        assert.match(r.ok ? "" : r.error, /未找到.*完成报告|No done report found/s);
        // 已交付幂等
        await seedDoneTicket(dir);
        await fs.writeFile(path.join(dir, "done", `${TICKET_ID}.pr.json`), '{"at":"2026-11-05T00:00:00Z"}\n', "utf-8");
        r = await runBatchPr(TICKET_ID, { out: () => { } });
        assert.match(r.ok ? "" : r.error, /已交付过|Already delivered/s);
    });
});

test("batch pr 失败路径：push 失败（分支未丢文案 + 无标记无 PR）；fetch 失败 fail-closed（代理提示进文案不进命令）", async () => {
    await withTempBatchDir(async (dir) => {
        await seedDoneTicket(dir);
        const sb = await setupSandbox();
        await makeArtifactBranch(sb.workPath, sb.git);
        const wtRoot = path.join(sb.root, "wt");
        // push 失败
        const st1: FakeState = { calls: [], ghBody: "", pushFail: true, fetchFail: false, ghPrFail: false };
        let r = await runBatchPr(TICKET_ID, { exec: makeFakeExec(st1), out: () => { }, worktreeRoot: wtRoot, cwd: sb.workPath });
        assert.equal(r.ok, false);
        assert.match(r.ok ? "" : r.error, /push 失败.*未丢|push failed.*no code is lost/s);
        await assert.rejects(fs.readFile(path.join(dir, "done", `${TICKET_ID}.pr.json`)));
        assert.equal(st1.calls.some((c) => c[0] === "gh" && c[1] === "pr"), false, "push 失败不建 PR");
        await assert.rejects(fs.stat(path.join(wtRoot, TICKET_ID)), "失败也回收审查 worktree");
        // fetch 失败（fail-closed：核对不了主干就不外发）
        const st2: FakeState = { calls: [], ghBody: "", pushFail: false, fetchFail: true, ghPrFail: false };
        const calls2: string[][] = [];
        st2.calls = calls2;
        r = await runBatchPr(TICKET_ID, { exec: makeFakeExec(st2), out: () => { }, worktreeRoot: wtRoot, cwd: sb.workPath });
        assert.equal(r.ok, false);
        assert.match(r.ok ? "" : r.error, /fetch origin 失败.*代理|fetch origin failed.*proxy/s);
        assert.equal(calls2.some((c) => c.includes("push")), false);
        await assert.rejects(fs.readFile(path.join(dir, "done", `${TICKET_ID}.pr.json`)));
        await fs.rm(sb.root, { recursive: true, force: true });
    });
});

test("batch pr GitLab：Draft: 前缀 MR + Closes #iid（fixes 不外发）+ token 只走环境变量", async () => {
    await withTempBatchDir(async (dir) => {
        await seedDoneTicket(dir, { sourceId: "gitlab:77#12" });
        await fs.mkdir(path.dirname(SYNC_CONFIG_PATH()), { recursive: true });
        await fs.writeFile(SYNC_CONFIG_PATH(), JSON.stringify({ gitlab: { baseUrl: "https://gitlab.example.invalid", projects: [77], label: "agent", tokenEnv: "GL_T" }, defaultAccept: "npm test" }), "utf-8");
        const sb = await setupSandbox();
        await makeArtifactBranch(sb.workPath, sb.git);
        process.env.GL_T = "tok-test";
        const posts: { url: string; body: string }[] = [];
        const glFetch: PrFetch = async (url, init) => {
            if (init?.method === "POST") {
                posts.push({ url, body: init.body ?? "" });
                return { status: 201, body: JSON.stringify({ web_url: "https://gitlab.example.invalid/g/p/-/merge_requests/9" }), headers: {} };
            }
            if (url.includes("/projects/77")) return { status: 200, body: JSON.stringify({ default_branch: "main", path_with_namespace: "group/proj" }), headers: {} };
            return { status: 404, body: "{}", headers: {} };
        };
        try {
            const r = await runBatchPr(TICKET_ID, { fetchImpl: glFetch, out: () => { }, worktreeRoot: path.join(sb.root, "wt"), cwd: sb.workPath });
            assert.equal(r.ok, true, r.ok ? "" : r.error);
            if (r.ok) assert.equal(r.url, "https://gitlab.example.invalid/g/p/-/merge_requests/9");
            assert.equal(posts.length, 1);
            const sent = JSON.parse(posts[0].body);
            assert.equal(sent.source_branch, `agent/${TICKET_ID}`);
            assert.equal(sent.target_branch, "main");
            assert.ok(String(sent.title).startsWith("Draft: "), "MR 草稿态前缀");
            assert.equal(sent.draft, true);
            assert.match(String(sent.description), /Closes #12/);
            assert.doesNotMatch(String(sent.description), /fixes #/, "GitLab 正文不残留 GitHub 关闭语法");
            const marker = JSON.parse(await fs.readFile(path.join(dir, "done", `${TICKET_ID}.pr.json`), "utf-8"));
            assert.equal(marker.platform, "gitlab");
        } finally {
            delete process.env.GL_T;
            await fs.rm(sb.root, { recursive: true, force: true });
        }
    });
});

test("buildPrBody：四要素 + 封顶 20 文件 + 空清单兜底 + fixes 仅 github", () => {
    const base = { ticketId: "t1", title: "T", status: "passed", costYuan: "0.1" };
    const b1 = buildPrBody({ ...base, files: ["a.ts"], issueNumber: 42 });
    assert.match(b1, /^## T$/m);
    assert.match(b1, /fixes #42/);
    const many = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const b2 = buildPrBody({ ...base, files: many });
    assert.equal((b2.match(/^- `f\d+\.ts`$/gm) ?? []).length, 20, "清单封顶 20");
    assert.match(b2, /and 5 more/);
    assert.doesNotMatch(b2, /fixes #/, "无 issue 号不写 fixes（GitLab 用 Closes 替换）");
    const b3 = buildPrBody({ ...base, files: [] });
    assert.match(b3, /\(no file changes recorded\)/);
});

test("nameStatusToPaths：剥状态列（M/A/D 单列 / R100 改名原样 / 二进制 D 列）；正文不得含状态前缀", () => {
    assert.deepEqual(
        nameStatusToPaths(["M\tREADME.md", "A\tsrc/new.ts", "D\told.ts"]),
        ["README.md", "src/new.ts", "old.ts"],
        "单列状态行 pop 取路径列",
    );
    assert.deepEqual(
        nameStatusToPaths(["R100\tsrc/{old => new}.ts"]),
        ["src/{old => new}.ts"],
        "改名行多列，pop 仍取路径列（{a => b} 按 git 原样）",
    );
    const body = buildPrBody({ ticketId: "t", title: "T", status: "passed", costYuan: "0", files: nameStatusToPaths(["M\tREADME.md", "A\ta.ts"]) });
    assert.doesNotMatch(body, /[MAD]\t/, "剥完的清单进正文不含状态前缀");
});
