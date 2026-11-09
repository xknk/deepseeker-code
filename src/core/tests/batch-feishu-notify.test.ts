/**
 * @file tests/batch-feishu-notify.test.ts
 * @description 多入口工单流水线 P4 反馈闭环：notify.ts + finishTicket 钩子守门测试。
 *
 *  覆盖：消息映射表（往返/封顶丢最旧/损坏=空表可重建）/ 完成通知文件（落盘字段提取→扫描→
 *  清除；损坏清走）/ 重试上限放弃 / 文案构造器（完成推送含状态映射与回复指引）/
 *  finishTicket 单一咽喉（feishu 票落通知、非 feishu 票零行为）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const {
    recordMsgMap, lookupMsgMap, MSG_MAP_CAP,
    writeFinishNotification, listPendingNotifications, clearNotification, bumpNotificationRetries, notifyText, NOTIFY_MAX_RETRIES,
} = await import("@/batch/feishu/notify.ts");
const queue = await import("@/batch/queue.ts");

const withTempBatchDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-notify-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        await fn(dir);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

test("消息映射表：登记/查询往返；封顶丢最旧；损坏=空表（可重建不炸）", async () => {
    await withTempBatchDir(async (dir) => {
        assert.equal(await lookupMsgMap("om_x"), null, "空表查无");
        await recordMsgMap("om_a", "t-1");
        await recordMsgMap("om_b", "t-2");
        assert.equal(await lookupMsgMap("om_a"), "t-1");
        assert.equal(await lookupMsgMap("om_b"), "t-2");
        // 幂等：同键同值再登记不炸
        await recordMsgMap("om_a", "t-1");

        // 封顶：灌满 cap+10，最旧的必须被丢、最新的保留（续修窗口近因语义）
        for (let i = 0; i < MSG_MAP_CAP + 10; i++) await recordMsgMap(`om_bulk_${i}`, `t-${i}`);
        assert.equal(await lookupMsgMap("om_bulk_0"), null, "最旧被丢");
        assert.equal(await lookupMsgMap(`om_bulk_${MSG_MAP_CAP + 9}`), "t-" + (MSG_MAP_CAP + 9), "最新保留");
        assert.equal(await lookupMsgMap("om_a"), null, "封顶后早期条目也被挤掉");

        // 损坏 → 空表（重新登记可恢复）
        await fs.writeFile(path.join(dir, "feishu-msg-map.json"), "{broken", "utf-8");
        assert.equal(await lookupMsgMap(`om_bulk_${MSG_MAP_CAP + 9}`), null, "损坏=空表");
        await recordMsgMap("om_new", "t-new");
        assert.equal(await lookupMsgMap("om_new"), "t-new");
    });
});

const SAMPLE_REPORT = `---
id: 20261106-160000-abcd
title: 修复日期解析 bug
status: passed
cost-yuan: 0.42
branch: dsc-batch/20261106-160000-abcd
changed-file: src/a.ts (+12/-3)
changed-file: src/b.ts (+4/-1)
---

## 模型收尾汇报

修好了。
`;

test("完成通知：落盘字段提取 → 扫描 → 清除；损坏文件清走", async () => {
    await withTempBatchDir(async () => {
        await writeFinishNotification({
            ticketId: "20261106-160000-abcd", reportMd: SAMPLE_REPORT,
            chatId: "oc_chat1", senderOpenId: "ou_alice", title: "修复日期解析 bug",
        });
        let pend = await listPendingNotifications();
        assert.equal(pend.length, 1);
        const n = pend[0];
        assert.equal(n.status, "passed");
        assert.equal(n.cost, "0.42");
        assert.equal(n.branch, "dsc-batch/20261106-160000-abcd");
        assert.equal(n.changedFiles, 2, "changed-file 行计数");
        assert.equal(n.chatId, "oc_chat1");
        assert.match(n.reportPath, /done\/20261106-160000-abcd\.report\.md$/);

        await clearNotification("20261106-160000-abcd");
        assert.equal((await listPendingNotifications()).length, 0, "发送后清除");

        // 损坏文件：扫描时清走（tmp+rename 下不该出现，防御）
        await fs.mkdir(path.join(process.env.DEEPSEEKER_CODE_BATCH_DIR!, "notifications"), { recursive: true });
        await fs.writeFile(path.join(process.env.DEEPSEEKER_CODE_BATCH_DIR!, "notifications", "bad.json"), "{broken", "utf-8");
        pend = await listPendingNotifications();
        assert.equal(pend.length, 0, "损坏被清走");
    });
});

test("完成通知重试：未达上限保留重发计数；达上限放弃并删文件", async () => {
    await withTempBatchDir(async () => {
        await writeFinishNotification({ ticketId: "t-retry", reportMd: SAMPLE_REPORT, chatId: "oc_c", title: "x" });
        let pend = await listPendingNotifications();
        let n = pend[0];
        for (let i = 1; i < NOTIFY_MAX_RETRIES; i++) {
            const giveUp = await bumpNotificationRetries(n);
            assert.equal(giveUp, false, `第 ${i} 次失败不放弃`);
            n = (await listPendingNotifications())[0];
            assert.equal(n.retries, i, "重试计数落盘");
        }
        const giveUp = await bumpNotificationRetries(n);
        assert.equal(giveUp, true, "达上限放弃");
        assert.equal((await listPendingNotifications()).length, 0, "放弃后文件删除");
    });
});

test("文案：完成推送含状态中文映射/文件数/花费/回复指引；建票回执带排队位", () => {
    const n = {
        ticketId: "t-1", chatId: "oc_c", title: "修复 bug", status: "accept-failed", cost: "0.3", branch: "dsc-batch/x",
        changedFiles: 3, reportPath: ".deepseeker-code/batch/done/t-1.report.md", retries: 0, createdAt: "",
    };
    const text = notifyText.finish("zh", n as any);
    assert.match(text, /验收未通过/);
    assert.match(text, /改动 3 个文件/);
    assert.match(text, /¥0\.3/);
    assert.match(text, /回复本条消息/, "回复即续修指引");
    assert.ok(!text.includes("diff"), "外发红线：不含 diff");

    const ack = notifyText.ackCreated("zh", "t-9", "标题", 2);
    assert.match(ack, /已建票 t-9/);
    assert.match(ack, /前面还有 2 张/);
    assert.match(notifyText.ackSkipped("zh", "今日建票已达上限 100"), /未建票：今日建票已达上限/);
});

test("finishTicket 咽喉：feishu 票（带 feishu-chat）落完成通知；普通票零行为", async () => {
    await withTempBatchDir(async (dir) => {
        const mkTicket = async (name: string, extra: string): Promise<string> => {
            const src = `---\ntitle: ${name}\naccept: npm test\nsource: feishu\n${extra}---\n\n正文\n`;
            const tmp = path.join(dir, `${name}.md`);
            await fs.writeFile(tmp, src, "utf-8");
            const enq = await queue.enqueueTicketFile(tmp);
            if (!enq.ok) throw new Error(enq.error);
            await fs.rm(tmp, { force: true });
            return enq.id;
        };
        const feishuId = await mkTicket("飞书票", "feishu-chat: oc_target\nfeishu-msg: om_orig\nfeishu-sender: ou_alice\n");
        const plainId = await mkTicket("普通票", "");
        // 串行取跑（与生产 runner 同构）：take→finish→take→finish。不能连取两张再一起 finish——
        // takeNextTicket 开头的崩溃残留回收会把 running 搬回 pending，第二 take 会把第一张退回去再取
        // 同一张（随机 id 排序决定谁被退，「单跑绿全量红」实为 50% 硬币，2026-11-09 取证实锤）。
        const t1 = await queue.takeNextTicket();
        assert.ok(t1, "第一张进入 running");
        await queue.finishTicket(t1.id, SAMPLE_REPORT);
        const t2 = await queue.takeNextTicket();
        assert.ok(t2, "第二张进入 running");
        await queue.finishTicket(t2.id, SAMPLE_REPORT);

        // rename 后的目录可见性在 Windows 高负载下可能短暂滞后，短轮询兜底（不影响确定性）
        let pend: Awaited<ReturnType<typeof listPendingNotifications>> = [];
        for (let i = 0; i < 20 && pend.length === 0; i++) {
            pend = await listPendingNotifications();
            if (pend.length === 0) await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(pend.length, 1, "只有 feishu 票落通知");
        assert.equal(pend[0].ticketId, feishuId);
        assert.equal(pend[0].chatId, "oc_target");
        assert.equal(pend[0].senderOpenId, "ou_alice");
        assert.match(pend[0].title, /飞书票/);
    });
});
