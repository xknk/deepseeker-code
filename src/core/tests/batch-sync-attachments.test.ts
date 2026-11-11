/**
 * @file tests/batch-sync-attachments.test.ts
 * @description 多入口工单流水线 P1-M5：附件链（§5.2.2，GitHub 单平台）守门测试。
 *
 *  覆盖：user-attachments 链接提取（markdown/裸链/去重/上限）/ 文件名安全化（路径注入全拒）/
 *  魔数判型 / 三态端到端（假下载器，零真网）：文本内联保留尾部+落盘绝对路径、图片落盘+强制
 *  needs-review、不可读类型与下载失败标「未读取 + 原因」、大小上限、dry-run 零下载、
 *  GitLab 候选不触发下载链、入队失败清理孤儿附件目录、enqueueTicketFile 预生成 id。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const att = await import("@/batch/sync/attachments.ts");
const state = await import("@/batch/sync/state.ts");
const { runSync } = await import("@/batch/sync/sync.ts");
const queue = await import("@/batch/queue.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-att-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

// ============ 提取与安全化 ============

test("extract：markdown/裸链/去重/尾部标点剥离/上限 10/非 user-attachments 不收", () => {
    const a = "https://github.com/user-attachments/assets/abc-123";
    const b = "https://github.com/user-attachments/files/9/error.log";
    const body = `![截图](${a})\n看这个 ${b}，还有 ${a}. 和 https://example.com/not-mine.png`;
    const urls = att.extractUserAttachments(body);
    assert.deepEqual(urls, [a, b], "去重保序 + 尾部句点剥离 + 外域链接不收");
    const many = Array.from({ length: 12 }, (_, i) => `https://github.com/user-attachments/files/${i}/f.txt`).join("\n");
    assert.equal(att.extractUserAttachments(many).length, 10, "上限 10 个（fail-safe）");
    assert.equal(att.extractUserAttachments("没有附件").length, 0);
});

test("sanitize：路径注入全拒（../、绝对路径、反斜杠、控制字符、.开头）；畸形百分号不抛", () => {
    assert.equal(att.sanitizeAttachmentName("../../etc/passwd", "fb"), "passwd");
    assert.equal(att.sanitizeAttachmentName("C:\\evil\\x.txt", "fb"), "x.txt");
    assert.equal(att.sanitizeAttachmentName("..%2F..%2Fevil", "fb"), "evil", "URL 解码后再取 basename（../ 被剥掉）");
    assert.equal(att.sanitizeAttachmentName("....hidden", "fb"), "hidden");
    assert.equal(att.sanitizeAttachmentName("", "fb"), "fb");
    assert.equal(att.sanitizeAttachmentName("100%", "fb"), "100%", "畸形百分号原样处理（decode 不抛）");
    const cleaned = att.sanitizeAttachmentName("a\x00b.txt", "fb");
    assert.doesNotMatch(cleaned, /[\x00-\x1f]/);
});

test("sniff：五族图片魔数 + pdf + 文本 + NUL 二进制判 unknown", () => {
    assert.equal(att.sniffKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])), "png");
    assert.equal(att.sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "jpg");
    assert.equal(att.sniffKind(Buffer.from("GIF89a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00", "latin1")), "gif");
    assert.equal(att.sniffKind(Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1")), "webp");
    assert.equal(att.sniffKind(Buffer.from("BM\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00", "latin1")), "bmp");
    assert.equal(att.sniffKind(Buffer.from("%PDF-1.7\n...", "utf-8")), "pdf");
    assert.equal(att.sniffKind(Buffer.from("hello log line\n".repeat(10), "utf-8")), "text");
    assert.equal(att.sniffKind(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(12, 0)])), "unknown", "zip 含 NUL = 不可读");
});

// ============ 三态端到端（假下载器） ============

const U_LOG = "https://github.com/user-attachments/files/1/error.log";
const U_PNG_ASSET = "https://github.com/user-attachments/assets/abcd-1234";
const U_ZIP = "https://github.com/user-attachments/files/2/trace.zip";
const U_FAKE_PNG = "https://github.com/user-attachments/files/3/fake.png";
const U_BIG = "https://github.com/user-attachments/files/4/big.log";
const U_DEAD = "https://github.com/user-attachments/files/5/gone.txt";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 假下载器：按 url 写确定性内容；未登记 = 下载失败。 */
const fakeDownload = (files: Record<string, Buffer>, calls: string[]): ((url: string, dest: string) => Promise<{ ok: true; sizeBytes: number } | { ok: false; reason: string }>) => async (url: string, dest: string) => {
    calls.push(url);
    const buf = files[url];
    if (!buf) return { ok: false, reason: "HTTP 404" };
    await fs.writeFile(dest, buf);
    return { ok: true, sizeBytes: buf.length };
};

test("三态端到端：文本内联保留尾部+落盘绝对路径；图片落盘+needsReview；zip 不下载标未读取", async () => {
    await withTempBatchDir(async (dir) => {
        const logBody = `HEAD-MARK ${"a".repeat(20 * 1024)}\nError: boom\n    at fn (src/x.ts:1)\nTAIL-MARK exit 1`;
        const calls: string[] = [];
        const dl = fakeDownload({
            [U_LOG]: Buffer.from(logBody, "utf-8"),
            [U_PNG_ASSET]: PNG_MAGIC,
        }, calls);
        const body = `看日志 ${U_LOG}\n![截图](${U_PNG_ASSET})\n${U_ZIP}`;
        const r = await att.processAttachments({ issueBody: body, ticketId: "t-att-1", locale: "zh", download: dl });
        assert.equal(r.needsReview, true, "含图票强制 needs-review");
        assert.ok(r.dir, "有落盘才有目录");
        assert.match(r.section, /### 附件（sync 侧已处理，共 3 个/);
        assert.doesNotMatch(r.section, /张图：请按需/, "单图票不触发多图提示");
        assert.match(r.section, /附件 1：error\.log（文本/);
        assert.match(r.section, /已内联尾部/);
        assert.match(r.section, /TAIL-MARK exit 1/, "内联保留尾部");
        assert.doesNotMatch(r.section, /HEAD-MARK/, "头部被截掉（8KB 预算）");
        assert.match(r.section, /绝对路径 `.*attachments.*t-att-1.*error\.log`/);
        assert.match(r.section, /附件 2：abcd-1234\.png（图片/, "assets 无扩展名按魔数补 .png");
        assert.match(r.section, /read_image/);
        assert.match(r.section, /附件 3：trace\.zip——未读取：无工具可读/);
        assert.deepEqual(calls, [U_LOG, U_PNG_ASSET], "zip 根本不发起下载（不花字节）");
        // 落盘真实存在 + 内联文本带引用前缀
        const saved = await fs.readFile(path.join(r.dir!, "error.log"), "utf-8");
        assert.match(saved, /TAIL-MARK/);
        assert.match(r.section, /^> .*TAIL-MARK/m, "内联文本逐行引用包裹（§4.3 附件同属外部数据）");
    });
});

test("多图票：正文提示按需读取（避免逐张全读）", async () => {
    await withTempBatchDir(async () => {
        const calls: string[] = [];
        const a1 = "https://github.com/user-attachments/assets/img-1";
        const a2 = "https://github.com/user-attachments/assets/img-2";
        const dl = fakeDownload({ [a1]: PNG_MAGIC, [a2]: PNG_MAGIC }, calls);
        const r = await att.processAttachments({ issueBody: `图1 ${a1}\n图2 ${a2}`, ticketId: "t-att-multi", locale: "zh", download: dl });
        assert.match(r.section, /本票含 2 张图：请按需选择性读取/);
        assert.equal(r.needsReview, true);
    });
});

test("失败面：下载失败/超单文件限/扩展名与内容不符 → 逐条「未读取 + 原因」，不阻塞其余附件", async () => {
    await withTempBatchDir(async () => {
        const calls: string[] = [];
        const dl = fakeDownload({
            [U_DEAD]: undefined as unknown as Buffer,
            [U_BIG]: Buffer.alloc(10 * 1024 * 1024 + 1),
            [U_FAKE_PNG]: Buffer.from("其实我是文本", "utf-8"),
            [U_LOG]: Buffer.from("ok log", "utf-8"),
        }, calls);
        const body = [U_DEAD, U_BIG, U_FAKE_PNG, U_LOG].join("\n");
        const r = await att.processAttachments({ issueBody: body, ticketId: "t-att-2", locale: "zh", download: dl });
        assert.match(r.section, /附件 1：gone\.txt——未读取：下载失败（HTTP 404）/);
        assert.match(r.section, /附件 2：big\.log——未读取：超过单文件上限/);
        assert.match(r.section, /附件 3：fake\.png——未读取：实际内容与扩展名不符/);
        assert.match(r.section, /附件 4：error\.log（文本/);
        assert.equal(r.needsReview, false, "假 png 判型失败不算图（不误触发 needs-review）");
        assert.ok(r.dir);
        const leftover = await fs.readdir(r.dir!);
        assert.deepEqual(leftover, ["error.log"], "被拒附件不留残盘");
    });
});

test("dry-run 零下载 + 盘点提示；GitLab 候选不走 github 下载面（uploads 提取与 user-attachments 链接互不相认）；入队失败清孤儿目录；preId 生效", async () => {
    await withTempBatchDir(async (dir) => {
        await fs.mkdir(path.dirname(state.syncStatePath()), { recursive: true });
        await fs.writeFile(
            path.join(path.dirname(state.syncStatePath()), "sync.json"),
            JSON.stringify({ github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test" }),
            "utf-8",
        );
        const body = `修复崩溃\n![截图](${U_PNG_ASSET})\n${U_LOG}`;
        const mkIssue = (n: number, b: string) => JSON.stringify([{ number: n, title: `票 ${n}`, body: b, url: `https://github.com/o/r/issues/${n}`, updatedAt: "2026-11-04T10:00:00Z", author: { login: "a" } }]);
        const calls: string[] = [];
        const dl = fakeDownload({ [U_PNG_ASSET]: PNG_MAGIC, [U_LOG]: Buffer.from("log", "utf-8") }, calls);
        const lines: string[] = [];
        // dry-run：不下载、不落盘，只提示
        const dry = await runSync({ dryRun: true, exec: async () => ({ code: 0, stdout: mkIssue(1, body), stderr: "" }), download: dl, out: (s) => lines.push(s), now: () => new Date("2026-11-04T12:00:00") });
        assert.equal(dry.ok, true);
        assert.equal(calls.length, 0, "dry-run 零下载");
        assert.match(lines.join("\n"), /附件 2 个：dry-run 不下载/);
        assert.equal(await fs.readdir(dir).then((xs) => xs.filter((x) => x === "attachments").length), 0, "不建附件目录");

        // 正式建票：附件落盘 + 工单正文带绝对路径
        const r = await runSync({ exec: async () => ({ code: 0, stdout: mkIssue(1, body), stderr: "" }), download: dl, out: () => { }, now: () => new Date("2026-11-04T12:01:00") });
        assert.equal(r.ok, true);
        assert.equal(calls.length, 2, "正式跑发起下载");
        const snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 1);
        const ticketSrc = await fs.readFile(path.join(dir, "pending", snap.pending[0]), "utf-8");
        assert.match(ticketSrc, /^needs-review: true$/m, "含图票 needs-review 落 frontmatter");
        assert.match(ticketSrc, /### 附件（sync 侧已处理/);
        assert.match(ticketSrc, new RegExp(`attachments[\\\\/]${snap.pending[0].replace(/\.md$/, "")}`), "正文绝对路径指向按票 id 命名的附件目录");
        const attDir = await fs.readdir(path.join(dir, "attachments", snap.pending[0].replace(/\.md$/, "")));
        assert.deepEqual(attDir.sort(), ["abcd-1234.png", "error.log"]);

        // GitLab 候选带同样的 user-attachments 链接：P2 附件链走 uploads 提取 + gitlabDownload 面，
        // user-attachments（无 /uploads/ 段）不被误收 → 票内无附件段；fetchImpl 只承载 notes/项目详情（P2 新增）
        const glCalls: string[] = [];
        process.env.TEST_GL_TOKEN = "t";
        try {
            const fetchImpl = async (url: string) => {
                if (url.includes("/notes")) return { status: 200, body: "[]", headers: {} };
                if (url.includes("/issues?")) {
                    return { status: 200, body: JSON.stringify([{ iid: 7, title: "gl 票", description: `看图 ${U_PNG_ASSET}`, web_url: "https://gitlab.example.com/g/p/-/issues/7", updated_at: "2026-11-04T10:00:00Z", author: { username: "a" } }]), headers: {} };
                }
                glCalls.push(url);
                return { status: 200, body: JSON.stringify({ path_with_namespace: "g/p", default_branch: "main" }), headers: {} };
            };
            await fs.writeFile(
                path.join(path.dirname(state.syncStatePath()), "sync.json"),
                JSON.stringify({ gitlab: { baseUrl: "https://gitlab.example.com", projects: [55], label: "agent", tokenEnv: "TEST_GL_TOKEN" }, defaultAccept: "pnpm test" }),
                "utf-8",
            );
            const gl = await runSync({ source: "gitlab", fetchImpl, download: dl, out: () => { }, now: () => new Date("2026-11-04T12:02:00") });
            assert.equal(gl.ok, true);
            if (gl.ok) assert.equal(gl.summary.added, 1);
            assert.equal(calls.length, 2, "github 下载面计数不变（gitlab 候选不借用）");
            assert.ok(glCalls.length >= 1, "P2：项目详情（一致性标注期望键）经 fetchImpl 发起");
            const snap2 = await queue.snapshotQueue();
            const glTicket = (await Promise.all(snap2.pending.map(async (f) => ({ f, t: await fs.readFile(path.join(dir, "pending", f), "utf-8") }))))
                .find((x) => x.t.includes("source-id: gitlab:55#7"));
            assert.ok(glTicket, "gitlab 票已建");
            assert.doesNotMatch(glTicket?.t ?? "", /^attachments:/m, "user-attachments 链接不算 gitlab uploads → 无 attachments fm");
            assert.doesNotMatch(glTicket?.t ?? "", /### 附件/, "无附件段（不误走 github 资产链）");
        } finally {
            delete process.env.TEST_GL_TOKEN;
        }
    });
});

test("enqueueTicketFile 预生成 id：pending 文件按 preId 命名", async () => {
    await withTempBatchDir(async (dir) => {
        const src = path.join(dir, "src.md");
        await fs.writeFile(src, "---\ntitle: 预id票\naccept: npm test\nsource: github\nsource-id: github:o/r#1\n---\n正文\n", "utf-8");
        const r = await queue.enqueueTicketFile(src, "zh", "20261104-120000-pre1");
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.id, "20261104-120000-pre1");
        const snap = await queue.snapshotQueue();
        assert.deepEqual(snap.pending, ["20261104-120000-pre1.md"]);
    });
});
