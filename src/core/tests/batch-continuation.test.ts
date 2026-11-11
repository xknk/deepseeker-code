/**
 * @file tests/batch-continuation.test.ts
 * @description 多入口工单流水线 P2：同 issue 续修链（§6.2）守门测试。
 *
 *  覆盖：续修票组装（frontmatter 继承验收/环境 + continues + 引用块边界 + round-trip 可解析）/
 *  前次报告摘要提取（验收输出不进续修 body）/ done 档检索与分支解析（占位串拒绝）/ sync 全链路
 *  （指纹变化 + 前票 done → 续修票，state 闭环）。transient（前票未跑完保旧指纹）与迁移在
 *  batch-sync.test.ts；续修基座检出的 runner 侧在 worktree-base-ref.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const state = await import("@/batch/sync/state.ts");
const cont = await import("@/batch/continuation.ts");
const boundary = await import("@/batch/sync/boundary.ts");
const { runSync } = await import("@/batch/sync/sync.ts");
const { parseBatchTicket } = await import("@/batch/ticket.ts");
const { SYNC_CONFIG_PATH } = await import("@/batch/sync/config.ts");
const queue = await import("@/batch/queue.ts");

/** 临时 batch 目录（DEEPSEEKER_CODE_BATCH_DIR 重定向，batchQueueRoot 实时读 env）。 */
const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-cont-test-"));
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

const mkPrevTicket = () => parseBatchTicket([
    "---",
    "title: bug 42",
    "accept: pnpm test",
    "setup: pnpm install",
    "budget-yuan: 0.5",
    "timeout-min: 45",
    "source: github",
    "source-id: github:o/r#42",
    "---",
    "",
    "正文",
].join("\n"));

// ============ 续修票组装 ============

test("continuation：buildContinuationTicketSource 继承验收/环境 + continues fm + 引用块边界；round-trip 可解析", () => {
    const candidate = { sourceId: "github:o/r#42", url: "https://github.com/o/r/issues/42", title: "bug 42", body: "新动态正文\n第二行", author: "alice", updatedAt: "2026-11-05T00:00:00Z" };
    const prev = mkPrevTicket();
    assert.equal(prev.ok, true);
    if (!prev.ok) return;
    const src = cont.buildContinuationTicketSource({
        candidate, prevTicket: prev.ticket, prevId: "t-prev", prevSummary: "- 状态 / status: passed", locale: "zh", extraNeedsReview: true, attachments: "batch/attachments/t-new",
    });
    assert.match(src, /^continues: t-prev$/m);
    assert.match(src, /^accept: pnpm test$/m, "验收继承前票（不重走解析序，防外部内容借续修换验收命令）");
    assert.match(src, /^setup: pnpm install$/m);
    assert.match(src, /^budget-yuan: 0\.5$/m);
    assert.match(src, /^timeout-min: 45$/m);
    assert.match(src, /^needs-review: true$/m, "前票标记 ∨ 新附件含图 → 保留/置位");
    assert.match(src, /^attachments: batch\/attachments\/t-new$/m);
    assert.match(src, /勿重做/, "「基座已含前次改动」指令必须显式在 body");
    assert.match(src, /全新会话|上下文不可见/);
    assert.match(src, /- 状态 \/ status: passed/, "前次摘要进 body（frontmatter 不进模型上下文）");
    assert.match(src, /^> 新动态正文$/m, "新外部内容进引用块（§4.3 数据非指令）");
    assert.match(src, /视为数据/, "QUOTE_PREAMBLE 边界前置");
    const parsed = parseBatchTicket(src);
    assert.equal(parsed.ok, true, `续修票必须能过解析（fail-closed 不可自败）：${parsed.ok ? "" : parsed.error}`);
    if (parsed.ok) {
        assert.equal(parsed.ticket.continues, "t-prev");
        assert.equal(parsed.ticket.accept, "pnpm test");
        assert.equal(parsed.ticket.needsReview, true);
        assert.match(parsed.ticket.body, /【issue #42 新动态】bug 42/, "引用块来源标签 + 标题同源（buildQuotedExternalBody）");
        assert.equal(
            parsed.ticket.body.includes(boundary.buildQuotedExternalBody(boundary.QUOTE_PREAMBLE.zh, "issue #42 新动态", "bug 42", "新动态正文\n第二行")),
            true,
            "票 body 尾部引用块与 boundary 事实源逐字节同源",
        );
    }
});

test("continuation：extractPrevReportSummary 取状态/花费/分支 + 收尾汇报截断；报告缺失给占位", () => {
    const report = [
        "---", "id: t1", "status: passed", "cost-yuan: 0.1234", "branch: dsc-wt-x-1", "---", "",
        "## 报告", "", "正文", "",
        "## 模型收尾汇报", "", "修好了 X", "", "## 验收", "", "```", "npm test output", "```",
    ].join("\n");
    const s = cont.extractPrevReportSummary(report, "zh", 2000);
    assert.match(s, /status: passed/);
    assert.match(s, /0\.1234/);
    assert.match(s, /dsc-wt-x-1/);
    assert.match(s, /修好了 X/);
    assert.doesNotMatch(s, /npm test output/, "验收输出不进续修票 body（body 要小）");
    const clipped = cont.extractPrevReportSummary(report.replace("修好了 X", "很长的汇报".repeat(60)), "zh", 50);
    assert.match(clipped, /截断|truncated/i);
    assert.match(cont.extractPrevReportSummary(null, "zh"), /已不存在|unavailable/);
    const en = cont.extractPrevReportSummary(report, "en", 2000);
    assert.match(en, /previous model final report/i);
});

// ============ 前次改动文件清单注入（2026-11-05 打磨第一批） ============

test("continuation：报告含 changed-file 清单 → 摘要含清单段；超 30 条截断标注；旧报告无清单不加段", () => {
    // 有清单：全量收集 + 独立段（与状态/花费/分支分开，不挤 1200 字截断）
    const withList = [
        "---", "id: t1", "status: passed", "cost-yuan: 0.5", "branch: b1",
        "changed-file: src/a.ts (+42/-3)", "changed-file: src/b.ts (+1/-0)", "changed-file: bin.dat (binary)", "---", "",
        "## 模型收尾汇报", "", "修好了。", "",
    ].join("\n");
    const s1 = cont.extractPrevReportSummary(withList, "zh");
    assert.match(s1, /【前次改动文件 \/ previous changed files】/);
    assert.match(s1, /- src\/a\.ts \(\+42\/-3\)/);
    assert.match(s1, /- src\/b\.ts \(\+1\/-0\)/);
    assert.match(s1, /- bin\.dat \(binary\)/, "二进制行按生成端渲染原样收进");

    // 超 30 条：显示前 30 + 末尾截断标注
    const many = Array.from({ length: 35 }, (_, i) => `changed-file: f${i}.ts (+1/-0)`).join("\n");
    const report35 = `---\nid: t2\nstatus: passed\nbranch: b2\n${many}\n---\n`;
    const s2 = cont.extractPrevReportSummary(report35, "zh");
    const seg = s2.slice(s2.indexOf("【前次改动文件"));
    assert.equal((seg.match(/^- f\d+\.ts/gm) ?? []).length, 30, "清单封顶 30 条");
    assert.match(seg, /其余 5 个略/, "截断标注带余量");
    assert.doesNotMatch(seg, /- f30\.ts/);

    // 旧报告无 changed-file 行：整段不加、不报错（1200 字收尾段照常）
    const legacy = "---\nid: t3\nstatus: passed\ncost-yuan: 0.1\nbranch: b3\n---\n\n## 模型收尾汇报\n\n旧格式汇报。\n";
    const s3 = cont.extractPrevReportSummary(legacy, "zh");
    assert.doesNotMatch(s3, /前次改动文件/);
    assert.match(s3, /旧格式汇报/);
});

// ============ done 档检索与分支解析 ============

test("continuation：findDoneTicketIdBySourceId 取最近一张；continuationBaseBranch 拒绝占位串", async () => {
    await withTempBatchDir(async (dir) => {
        const done = path.join(dir, "done");
        await fs.mkdir(done, { recursive: true });
        const mk = (id: string, sourceId: string): string => ["---", `title: ${id}`, "accept: npm test", "source: github", `source-id: ${sourceId}`, "---", "", "正文"].join("\n");
        await fs.writeFile(path.join(done, "20261104-100000-a.md"), mk("20261104-100000-a", "github:o/r#42"), "utf-8");
        await fs.writeFile(path.join(done, "20261104-120000-b.md"), mk("20261104-120000-b", "github:o/r#42"), "utf-8");
        await fs.writeFile(path.join(done, "20261104-130000-c.md"), mk("20261104-130000-c", "github:o/r#99"), "utf-8");
        await fs.writeFile(path.join(done, "20261104-140000-d.report.md"), "（报告不是票）", "utf-8");
        assert.equal(await cont.findDoneTicketIdBySourceId("github:o/r#42"), "20261104-120000-b", "文件名字典序最大 = 最近；.report.md 不算票");
        assert.equal(await cont.findDoneTicketIdBySourceId("github:o/r#none"), null);

        await fs.writeFile(path.join(done, "20261104-100000-a.report.md"), "---\nid: x\nstatus: passed\nbranch: dsc-wt-x-1\n---\n", "utf-8");
        assert.equal(await cont.continuationBaseBranch("20261104-100000-a"), "dsc-wt-x-1");
        await fs.writeFile(path.join(done, "20261104-120000-b.report.md"), "---\nbranch: （未创建）\n---\n", "utf-8");
        assert.equal(await cont.continuationBaseBranch("20261104-120000-b"), null, "报告占位串（未创建）不是分支名");
        assert.equal(await cont.continuationBaseBranch("nope"), null, "无报告 → null");
    });
});

// ============ sync 全链路：指纹变化 + 前票 done → 续修票 ============

test("全链路：指纹变化 + 前票 done（verdict=work）→ 续修票（continues/继承验收/摘要进 body），state 闭环", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), { github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test" });
        const lines: string[] = [];
        let issueBody = "修复它 42";
        const mkExec = async () => ({ code: 0, stdout: JSON.stringify([{ number: 42, title: "bug 42", body: issueBody, url: "https://github.com/o/r/issues/42", updatedAt: "2026-11-05T10:00:00Z", author: { login: "alice" } }]), stderr: "" });
        let r = await runSync({ exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-05T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.added, 1);
        const snap = await queue.snapshotQueue();
        const firstId = snap.pending[0].replace(/\.md$/, "");
        // 模拟 runner 跑完：票搬 done/ + 报告落盘（含产物分支）
        await fs.mkdir(path.join(dir, "done"), { recursive: true });
        await fs.rename(path.join(dir, "pending", snap.pending[0]), path.join(dir, "done", snap.pending[0]));
        await fs.writeFile(queue.reportPath(firstId), ["---", `id: ${firstId}`, "status: passed", "cost-yuan: 0.2", "branch: dsc-wt-batch-1", "---", "", "## 模型收尾汇报", "", "前次修好了。", ""].join("\n"), "utf-8");
        assert.equal((await state.loadSyncState()).get("github:o/r#42")?.ticketId, firstId);

        // issue 有新动态（正文更新）→ 续修票
        issueBody = "修复它 42（更新：还有边界情况）";
        lines.length = 0;
        r = await runSync({ exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-05T12:30:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.skipped, r.summary.continued], [1, 0, 1], "续修票计 added，张数另列 continued");
        assert.match(lines.join("\n"), /续修票|Continuation ticket/);
        const snap2 = await queue.snapshotQueue();
        assert.equal(snap2.pending.length, 1);
        const t = await fs.readFile(path.join(dir, "pending", snap2.pending[0]), "utf-8");
        assert.match(t, new RegExp(`^continues: ${firstId}$`, "m"));
        assert.match(t, /^accept: pnpm test$/m);
        assert.match(t, /前次修好了/, "前次报告摘要进续修 body");
        assert.match(t, /勿重做/);
        assert.match(t, /^> 修复它 42（更新：还有边界情况）$/m, "新动态正文逐行进引用块");
        const st = (await state.loadSyncState()).get("github:o/r#42");
        assert.equal(st?.verdict, "work");
        assert.match(st?.fingerprint ?? "", /^v2:/, "state 以新指纹闭环（下轮同内容 → skip）");
        assert.equal(st?.ticketId !== firstId, true, "state 指向续修票");

        // 再 sync：同内容 → skip（续修幂等，不重复建）
        lines.length = 0;
        r = await runSync({ exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-05T12:35:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.skipped], [0, 1]);
    });
});

test("全链路：续修 + 规则闸 dupTitle 不自拒（标题集去掉本候选与前票标题）；闸拒绝记 reject", async () => {
    await withTempBatchDir(async (dir) => {
        // dupTitle 场景：knownTitles 含前票标题（同题），若续修前不清空必被自拒
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), { github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test", blockedKeywords: ["广告"] });
        let issueBody = "正常正文";
        const mkExec = async () => ({ code: 0, stdout: JSON.stringify([{ number: 7, title: "dup 标题票", body: issueBody, url: "https://github.com/o/r/issues/7", updatedAt: "2026-11-05T10:00:00Z", author: { login: "alice" } }]), stderr: "" });
        let r = await runSync({ exec: mkExec, out: () => { }, now: () => new Date("2026-11-05T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.added, 1);
        const snap = await queue.snapshotQueue();
        const firstId = snap.pending[0].replace(/\.md$/, "");
        await fs.mkdir(path.join(dir, "done"), { recursive: true });
        await fs.rename(path.join(dir, "pending", snap.pending[0]), path.join(dir, "done", snap.pending[0]));
        await fs.writeFile(queue.reportPath(firstId), ["---", `id: ${firstId}`, "status: passed", "branch: b1", "---", ""].join("\n"), "utf-8");

        issueBody = "买广告啦（关键词触发续修闸拒绝）";
        r = await runSync({ exec: mkExec, out: () => { }, now: () => new Date("2026-11-05T12:30:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.rejected, 1, "续修路径同样过规则闸");
        assert.equal((await state.loadSyncState()).get("github:o/r#7")?.verdict, "reject");
        assert.equal((await queue.snapshotQueue()).pending.length, 0);
    });
});

test("全链路：前票档被 clean 清理 → changedNoPrev 走全新票管线（继承无从谈起，验收重新解析）", async () => {
    await withTempBatchDir(async (dir) => {
        await writeConfig(path.dirname(SYNC_CONFIG_PATH()), { github: { repos: ["o/r"], label: "agent" }, defaultAccept: "pnpm test" });
        let issueBody = "第一版正文";
        const mkExec = async () => ({ code: 0, stdout: JSON.stringify([{ number: 8, title: "bug 8", body: issueBody, url: "https://github.com/o/r/issues/8", updatedAt: "2026-11-05T10:00:00Z", author: { login: "alice" } }]), stderr: "" });
        let r = await runSync({ exec: mkExec, out: () => { }, now: () => new Date("2026-11-05T12:00:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.equal(r.summary.added, 1);
        const snap = await queue.snapshotQueue();
        const firstId = snap.pending[0].replace(/\.md$/, "");
        // 模拟 batch clean：done 工单与报告都没了，state 的 work 条目还在
        await fs.mkdir(path.join(dir, "done"), { recursive: true });
        await fs.rename(path.join(dir, "pending", snap.pending[0]), path.join(dir, "done", snap.pending[0]));
        await fs.rm(path.join(dir, "done", snap.pending[0]), { force: true });

        issueBody = "第二版正文";
        const lines: string[] = [];
        r = await runSync({ exec: mkExec, out: (s) => lines.push(s), now: () => new Date("2026-11-05T12:30:00") });
        assert.equal(r.ok, true);
        if (r.ok) assert.deepEqual([r.summary.added, r.summary.continued], [1, 0], "档缺失 → 全新票而非续修票");
        assert.match(lines.join("\n"), /存档缺失|archive missing/);
        const t = await fs.readFile(path.join(dir, "pending", (await queue.snapshotQueue()).pending[0]), "utf-8");
        assert.doesNotMatch(t, /^continues:/m, "全新票无 continues");
        assert.match(t, /^source-id: github:o\/r#8$/m);
        void firstId;
    });
});
