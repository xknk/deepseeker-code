/**
 * @file tests/batch-ticket.test.ts
 * @description 挂机批处理工单解析（batch/ticket.ts）与队列操作（batch/queue.ts，成本信任链第四环 F1）守门测试：
 *  frontmatter 解析 / accept 必填（缺验收拒绝入队红线）/ 数字字段校验 / tools 清单归一 / title 回退 /
 *  三态目录流转（pending→running→done）/ 崩溃残留重排队 / 运行锁互斥与死锁接管 /
 *  clean 清 done 时回收附件目录（pending/running 保留、真孤儿按宽限期清）。
 *  队列目录经 DEEPSEEKER_CODE_BATCH_DIR 重定向到临时目录（batchQueueRoot 调用时实时读 env，非冻结）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { parseBatchTicket, generateBatchId } = await import("@/batch/ticket.ts");
const queue = await import("@/batch/queue.ts");

// ============ 工单解析 ============

test("合法工单：全字段解析 + title 缺省回退正文首行", () => {
    const r = parseBatchTicket(
        "---\ntitle: 修复日期解析\naccept: npm test\nbudget-yuan: 0.5\ntimeout-min: 45\ntools: run_command, web_search\n---\n把 utils/date.ts 的 parseDate 修好。",
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.title, "修复日期解析");
    assert.equal(r.ticket.accept, "npm test");
    assert.equal(r.ticket.budgetYuan, 0.5);
    assert.equal(r.ticket.timeoutMin, 45);
    assert.deepEqual(r.ticket.tools, ["run_command", "web_search"]);
    assert.equal(r.ticket.body, "把 utils/date.ts 的 parseDate 修好。");
});

test("合法工单：tools 数组形态 + 可选字段全省 + title 回退", () => {
    const r = parseBatchTicket("---\naccept: make check\n---\n第一行标题就是它\n\n正文其余");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.title, "第一行标题就是它");
    assert.equal(r.ticket.setup, undefined);
    assert.equal(r.ticket.budgetYuan, undefined);
    assert.equal(r.ticket.timeoutMin, undefined);
    assert.equal(r.ticket.tools, undefined);
});

test("setup 字段：agent 前环境准备命令解析（空白归一，空串=未设）", () => {
    const r = parseBatchTicket("---\naccept: npm test\nsetup:   pnpm install --frozen-lockfile  \n---\n正文");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.setup, "pnpm install --frozen-lockfile");
    // setup 留空 = 未设置（不进 ticket）
    const blank = parseBatchTicket("---\naccept: npm test\nsetup:   \n---\n正文");
    assert.equal(blank.ok, true);
    if (!blank.ok) return;
    assert.equal(blank.ticket.setup, undefined);
});

test("红线：缺 accept 拒绝（挂机任务必须带可执行验收）", () => {
    const r = parseBatchTicket("---\ntitle: x\n---\n正文");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /accept/);
});

test("数字字段校验：budget-yuan / timeout-min 非正数拒绝", () => {
    assert.equal(parseBatchTicket("---\naccept: t\nbudget-yuan: abc\n---\n正文").ok, false);
    assert.equal(parseBatchTicket("---\naccept: t\nbudget-yuan: -1\n---\n正文").ok, false);
    assert.equal(parseBatchTicket("---\naccept: t\ntimeout-min: 0\n---\n正文").ok, false);
});

test("retry 字段（看门狗带证据重试）：缺省 undefined；0-3 合法；越界/非整数拒绝（双倍烧钱口子须封顶）", () => {
    assert.equal(parseBatchTicket("---\naccept: t\n---\n正文").ok && (parseBatchTicket("---\naccept: t\n---\n正文") as any).ticket.retry, undefined);
    const r1 = parseBatchTicket("---\naccept: t\nretry: 1\n---\n正文");
    assert.equal(r1.ok && (r1 as any).ticket.retry, 1);
    const r0 = parseBatchTicket("---\naccept: t\nretry: 0\n---\n正文");
    assert.equal(r0.ok && (r0 as any).ticket.retry, 0);
    for (const bad of ["4", "-1", "1.5", "abc"]) {
        const r = parseBatchTicket(`---\naccept: t\nretry: ${bad}\n---\n正文`);
        assert.equal(r.ok, false, `retry: ${bad} 应拒绝`);
        if (!r.ok) assert.match(r.error, /retry/);
    }
});

test("tools 为空拒绝（要么删行要么列名）；无 frontmatter / 空正文拒绝", () => {
    assert.equal(parseBatchTicket("---\naccept: t\ntools: , ,\n---\n正文").ok, false);
    assert.equal(parseBatchTicket("没有 frontmatter 的工单").ok, false);
    assert.equal(parseBatchTicket("---\naccept: t\n---\n   \n").ok, false);
});

test("generateBatchId：格式（日期-时间-随机4）与同秒唯一性", () => {
    const a = generateBatchId();
    assert.match(a, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
    const seen = new Set([a]);
    for (let i = 0; i < 50; i++) seen.add(generateBatchId(new Date(2026, 0, 1, 0, 0, 0)));
    assert.equal(seen.size, 51); // 同一秒生成 50 个不撞名
});

// ============ 队列操作（临时目录） ============

test("队列三态流转：入队→取走→收尾；崩溃残留 running 重排队", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-batch-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        const src = path.join(dir, "src.md");
        await fs.writeFile(src, "---\ntitle: 任务A\naccept: npm test\n---\n正文", "utf-8");
        const enq = await queue.enqueueTicketFile(src);
        assert.equal(enq.ok, true);
        if (!enq.ok) return;

        let snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 1);
        assert.equal(snap.running.length, 0);

        // 入队保留原文（不做二次序列化）
        const pendingFile = path.join(dir, "pending", `${enq.id}.md`);
        assert.equal(await fs.readFile(pendingFile, "utf-8"), await fs.readFile(src, "utf-8"));

        const taken = await queue.takeNextTicket();
        assert.ok(taken);
        assert.equal(taken!.id, enq.id);
        snap = await queue.snapshotQueue();
        assert.equal(snap.pending.length, 0);
        assert.equal(snap.running.length, 1);

        // 崩溃残留重排队：不收尾直接再 take → running 被搬回 pending 再取走
        const again = await queue.takeNextTicket();
        assert.equal(again!.id, enq.id);
        assert.equal((await queue.snapshotQueue()).running.length, 1);

        // 收尾：报告落 done + 工单随迁
        await queue.finishTicket(enq.id, `---\nid: ${enq.id}\nstatus: passed\n---\n报告正文`);
        snap = await queue.snapshotQueue();
        assert.equal(snap.running.length, 0);
        assert.deepEqual(snap.done, [enq.id]);
        assert.equal(await queue.readReport(enq.id), `---\nid: ${enq.id}\nstatus: passed\n---\n报告正文`);

        // clean：清 done
        const cleaned = await queue.cleanDone();
        assert.equal(cleaned.tasks, 1);
        assert.equal(cleaned.attachments, 0);
        assert.equal((await queue.snapshotQueue()).done.length, 0);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("clean：清 done 时回收附件目录（pending/running 保留；真孤儿按宽限期清）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-batch-clean-att-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        // 三态各一张票（queue 只按文件名认票，直接落文件即可）
        const doneId = "20260101-000000-aaaa";
        const pendingId = "20260101-000000-bbbb";
        const runningId = "20260101-000000-cccc";
        for (const [state, id] of [["done", doneId], ["pending", pendingId], ["running", runningId]] as const) {
            await fs.mkdir(path.join(dir, state), { recursive: true });
            await fs.writeFile(path.join(dir, state, `${id}.md`), "---\naccept: t\n---\n正文", "utf-8");
        }
        await fs.writeFile(path.join(dir, "done", `${doneId}.report.md`), "报告", "utf-8");

        // 附件目录：done 票 / pending 票 / running 票 / 老孤儿 / 新孤儿（可能是在途 sync 刚建的）
        const mkAtt = async (id: string, ageMs = 0): Promise<string> => {
            const d = path.join(dir, "attachments", id);
            await fs.mkdir(d, { recursive: true });
            await fs.writeFile(path.join(d, "a.txt"), "x", "utf-8");
            if (ageMs > 0) {
                const t = new Date(Date.now() - ageMs);
                await fs.utimes(d, t, t); // 目录 mtime 回拨（写文件会把 mtime 顶成现在）
            }
            return d;
        };
        const exists = async (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);
        const dDone = await mkAtt(doneId);
        const dPending = await mkAtt(pendingId);
        const dRunning = await mkAtt(runningId);
        const dOldOrphan = await mkAtt("20260101-000000-dddd", 2 * 60 * 60 * 1000);
        const dFreshOrphan = await mkAtt("20260101-000000-eeee");

        const r = await queue.cleanDone();
        assert.equal(r.tasks, 1, "done/ 的工单存档被清掉");
        assert.equal(r.attachments, 2, "done 票的附件 + 老孤儿被清掉");
        assert.equal(await exists(dDone), false, "刚清掉的 done 票附件应删除");
        assert.equal(await exists(dOldOrphan), false, "超宽限期的无票孤儿应删除");
        assert.equal(await exists(dPending), true, "pending 票附件不得动");
        assert.equal(await exists(dRunning), true, "running 票附件不得动");
        assert.equal(await exists(dFreshOrphan), true, "新目录可能是 inflight sync 的，宽限期内保留");
        assert.equal((await queue.snapshotQueue()).pending.length, 1);
        assert.equal((await queue.snapshotQueue()).running.length, 1);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("运行锁：互斥持有 + 持有者死亡可接管 + 释放", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-batch-lock-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        const first = await queue.acquireRunLock();
        assert.equal(first.ok, true);
        // 活锁互斥：第二 runner 被拒（拿自己 pid 当持有者=活着）
        const second = await queue.acquireRunLock();
        assert.equal(second.ok, false);
        if (!second.ok) assert.match(second.error, /串行/);
        // 死锁接管：锁里写一个必然不存在的 pid → 接管成功
        await fs.writeFile(path.join(dir, ".lock"), "999999999 2099-01-01T00:00:00.000Z", "utf-8");
        const takeover = await queue.acquireRunLock();
        assert.equal(takeover.ok, true);
        // 释放后可再持
        await queue.releaseRunLock();
        assert.equal((await queue.acquireRunLock()).ok, true);
        await queue.releaseRunLock();
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

// ============ P4 反馈闭环字段（feishu-chat/msg/sender：回执路由与完成推送） ============

test("feishu 回执字段：合法单行 id 解析往返；含空白 = fail-closed 拒整票；缺省向后兼容", () => {
    const ok = parseBatchTicket("---\ntitle: t\naccept: npm test\nsource: feishu\nfeishu-chat: oc_chat1\nfeishu-msg: om_9\nfeishu-sender: ou_alice\n---\n正文");
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.ticket.feishuChat, "oc_chat1");
    assert.equal(ok.ticket.feishuMsg, "om_9");
    assert.equal(ok.ticket.feishuSender, "ou_alice");

    // 含空白 = frontmatter 夹带自由文本（可被当第二个正文注入），拒收。
    // 注：frontmatter 按行解析，值里出现换行结构上不可能（换行即断行、余下行当裸键忽略），只测同行空白。
    for (const bad of ["feishu-chat: oc_x aaa", "feishu-msg: om_x\tfake", "feishu-sender: ou_x y"]) {
        const r = parseBatchTicket(`---\ntitle: t\naccept: npm test\n${bad}\n---\n正文`);
        assert.equal(r.ok, false, `非法值必须拒收：${JSON.stringify(bad)}`);
        if (!r.ok) assert.match(r.error, /feishu-(chat|msg|sender)/, "错误文案指明字段");
    }

    // 缺省：老工单/其他来源工单零影响
    const plain = parseBatchTicket("---\naccept: npm test\n---\n正文");
    assert.equal(plain.ok, true);
    if (plain.ok) {
        assert.equal(plain.ticket.feishuChat, undefined);
        assert.equal(plain.ticket.feishuMsg, undefined);
        assert.equal(plain.ticket.feishuSender, undefined);
    }
});
