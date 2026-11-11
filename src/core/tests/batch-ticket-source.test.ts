/**
 * @file tests/batch-ticket-source.test.ts
 * @description 多入口工单流水线 P1-M1：工单协议扩展（batch/ticket.ts §4.1 新 frontmatter 字段）守门测试。
 *
 *  三态覆盖：合法（全字段/部分字段）/ 缺省（老工单无新字段向后兼容，source 回退 manual）/
 *  非法（枚举外来源、非 http 链接、无冒号 source-id、needs-review 非 true/false、空白 continues、
 *  绝对路径与 .. 上跳的 attachments）——非法值一律 fail-closed 拒收。
 *  红线锚点：新字段只进 BatchTicket 结构（给人/给策略），永不进模型上下文（batchRunner 只传 body）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { parseBatchTicket } = await import("@/batch/ticket.ts");
const queue = await import("@/batch/queue.ts");

// ============ 合法：全字段 / 部分字段 ============

test("合法：全字段解析（source/source-url/source-id/needs-review/continues/attachments）", () => {
    const r = parseBatchTicket(
        "---\ntitle: 修复日期解析\naccept: npm test\nsource: github\nsource-url: https://github.com/o/r/issues/42\nsource-id: github:o/r#42\nneeds-review: true\ncontinues: 20261104-101010-ab12\nattachments: batch/attachments/x\n---\n正文",
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.source, "github");
    assert.equal(r.ticket.sourceUrl, "https://github.com/o/r/issues/42");
    assert.equal(r.ticket.sourceId, "github:o/r#42");
    assert.equal(r.ticket.needsReview, true);
    assert.equal(r.ticket.continues, "20261104-101010-ab12");
    assert.equal(r.ticket.attachments, "batch/attachments/x");
});

test("合法：source 六个枚举值全部通过；needs-review: false 解析为 false", () => {
    for (const s of ["github", "gitlab", "feishu", "webhook", "ci", "manual"]) {
        const r = parseBatchTicket(`---\naccept: t\nsource: ${s}\n---\n正文`);
        assert.equal(r.ok, true, `source: ${s} 应合法`);
        if (r.ok) assert.equal(r.ticket.source, s);
    }
    const r = parseBatchTicket("---\naccept: t\nneeds-review: false\n---\n正文");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.ticket.needsReview, false);
});

test("source-url 含 http 与含冒号的 URL 完整保留（行式解析取首个冒号做键值分隔）", () => {
    const r = parseBatchTicket("---\naccept: t\nsource-url: https://gitlab.example.com/g/p/-/issues/7?x=1#note\n---\n正文");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.ticket.sourceUrl, "https://gitlab.example.com/g/p/-/issues/7?x=1#note");
});

// ============ 缺省：老工单向后兼容 ============

test("缺省：老工单无新字段 → source 回退 manual，其余字段 undefined（向后兼容不炸）", () => {
    const r = parseBatchTicket("---\ntitle: 老工单\naccept: npm test\n---\n正文");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.source, "manual");
    assert.equal(r.ticket.sourceUrl, undefined);
    assert.equal(r.ticket.sourceId, undefined);
    assert.equal(r.ticket.needsReview, undefined);
    assert.equal(r.ticket.continues, undefined);
    assert.equal(r.ticket.attachments, undefined);
});

test("缺省：新字段留空（键后无值）等同未设置，不拒收", () => {
    const r = parseBatchTicket("---\naccept: t\nsource:\nsource-url:\nsource-id:\nneeds-review:\nattachments:\n---\n正文");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.source, "manual");
    assert.equal(r.ticket.sourceUrl, undefined);
    assert.equal(r.ticket.sourceId, undefined);
    assert.equal(r.ticket.needsReview, undefined);
    assert.equal(r.ticket.attachments, undefined);
});

// ============ 非法：fail-closed 拒收 ============

test("非法 source（枚举外/含空白/大小写变体）拒收", () => {
    for (const bad of ["gITHUB", "slack", "hello world", "github extra"]) {
        const r = parseBatchTicket(`---\naccept: t\nsource: ${bad}\n---\n正文`);
        assert.equal(r.ok, false, `source: ${bad} 应拒收`);
        if (!r.ok) assert.match(r.error, /source/);
    }
});

test("非法 source-url（非 http(s) 前缀）拒收", () => {
    for (const bad of ["ftp://x/y", "javascript:alert(1)", "/local/path", "github.com/o/r/issues/1"]) {
        const r = parseBatchTicket(`---\naccept: t\nsource-url: ${bad}\n---\n正文`);
        assert.equal(r.ok, false, `source-url: ${bad} 应拒收`);
        if (!r.ok) assert.match(r.error, /source-url/);
    }
});

test("非法 source-id（缺冒号/含空白/空平台名）拒收", () => {
    for (const bad of ["owner/repo#42", "github:owner repo#42", "github:", ":42", "github:o r#1"]) {
        const r = parseBatchTicket(`---\naccept: t\nsource-id: ${bad}\n---\n正文`);
        assert.equal(r.ok, false, `source-id: ${bad} 应拒收`);
        if (!r.ok) assert.match(r.error, /source-id/);
    }
});

test("非法 needs-review（true/false 之外）拒收", () => {
    for (const bad of ["yes", "1", "TRUE", "on"]) {
        const r = parseBatchTicket(`---\naccept: t\nneeds-review: ${bad}\n---\n正文`);
        assert.equal(r.ok, false, `needs-review: ${bad} 应拒收`);
        if (!r.ok) assert.match(r.error, /needs-review/);
    }
});

test("非法 continues（空白/特殊字符）拒收", () => {
    for (const bad of ["a b", "../x", "x/y", "a;b"]) {
        const r = parseBatchTicket(`---\naccept: t\ncontinues: ${bad}\n---\n正文`);
        assert.equal(r.ok, false, `continues: ${bad} 应拒收`);
        if (!r.ok) assert.match(r.error, /continues/);
    }
});

test("非法 attachments（绝对路径/盘符/.. 上跳）拒收——防把 agent 可读入口指到仓外", () => {
    for (const bad of ["/etc/passwd", "C:\\tmp\\x", "c:/tmp", "\\\\srv\\share", "../outside", "a/../../b", "..\\win"]) {
        const r = parseBatchTicket(`---\naccept: t\nattachments: ${bad}\n---\n正文`);
        assert.equal(r.ok, false, `attachments: ${bad} 应拒收`);
        if (!r.ok) assert.match(r.error, /attachments/);
    }
    // 正常相对路径放行
    const ok = parseBatchTicket("---\naccept: t\nattachments: batch/attachments/20261104-101010-ab12\n---\n正文");
    assert.equal(ok.ok, true);
});

// ============ 队列端到端：新字段经入队落盘后仍保真 ============

test("端到端：带新字段的工单经 enqueueTicketFile → takeNextTicket 全程保真", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-batch-src-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        const src = path.join(dir, "src.md");
        await fs.writeFile(
            src,
            "---\ntitle: 同步票\naccept: pnpm test\nsource: github\nsource-id: github:o/r#7\nneeds-review: true\n---\n外部正文",
            "utf-8",
        );
        const enq = await queue.enqueueTicketFile(src);
        assert.equal(enq.ok, true);
        if (!enq.ok) return;
        const taken = await queue.takeNextTicket();
        assert.ok(taken);
        const source = await fs.readFile(taken!.path, "utf-8");
        const parsed = parseBatchTicket(source);
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.equal(parsed.ticket.source, "github");
        assert.equal(parsed.ticket.sourceId, "github:o/r#7");
        assert.equal(parsed.ticket.needsReview, true);
        assert.equal(parsed.ticket.body, "外部正文");
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
});
