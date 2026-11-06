/**
 * @file tests/batch-feishu-approval.test.ts
 * @description 多入口工单流水线 P4：卡片审批跨进程文件协议（方案 §5）守门测试。
 *
 *  覆盖：心跳三态（新鲜可批 / 过期 / canApprove=false → runner 不进卡片等待）/
 *  requestCardApproval（不存活=deny 零输出零 pending——现状零回归红线；存活=落 pending+推卡日志；
 *  allow → "allow-once" + pending 清理；deny 同清理；approvalId 比对防错配；超时 = deny fail-closed）/
 *  writeApprovalDecision（pending 缺失拒 / 已决定拒——一个 pending 只决定一次 / 原子写成功）/
 *  listPendingApprovals 跳过过期与损坏 / sweepStaleApprovals 宽限语义（宽限内不动、过期+宽限连 decision 一起清、
 *  只剩 decision 残留也可清）/ 单实例锁（存活持有者拒绝、损坏与死 pid 自愈接管、释放删除）。
 *  全注入时钟与 sleep（零真等）；DEEPSEEKER_CODE_BATCH_DIR 重定向零碰真队列。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const {
    writeListenerHeartbeat, readListenerHeartbeat, isListenerAlive,
    requestCardApproval, writeApprovalDecision, listPendingApprovals, sweepStaleApprovals,
    acquireListenLock, releaseListenLock, pidAlive, listenLockPath,
    approvalsDir, APPROVAL_TIMEOUT_MIN, APPROVAL_SWEEP_GRACE_MIN, HEARTBEAT_MAX_AGE_MS,
} = await import("@/batch/feishu/approval.ts");

/** 临时 batch 目录 + 可拨动假时钟（now 可注入各 API；sleep 推钟）。 */
const withClock = async (fn: (args: { dir: string; now: () => Date; setT: (ms: number) => void; getT: () => number }) => Promise<void>): Promise<void> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-appr-test-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    let t = Date.parse("2026-11-05T12:00:00");
    try {
        await fn({ dir, now: () => new Date(t), setT: (ms) => { t = ms; }, getT: () => t });
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
};

/** 手工落一张合法 pending（协议文件格式是公开的；造在途场景用）。 */
const writePendingFile = async (id: string, over: Record<string, any> = {}): Promise<void> => {
    const p = {
        approvalId: id, tool: "run_command", summary: "rm -rf build",
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.parse("2026-11-05T12:30:00")).toISOString(),
        ...over,
    };
    await fs.mkdir(approvalsDir(), { recursive: true });
    await fs.writeFile(path.join(approvalsDir(), `${id}.pending.json`), JSON.stringify(p, null, 2), "utf-8");
};
const writeDecisionFile = async (id: string, decision: "allow" | "deny", decidedBy = "ou_alice"): Promise<void> => {
    const d = { approvalId: id, decision, decidedBy, decidedAt: new Date().toISOString() };
    await fs.mkdir(approvalsDir(), { recursive: true });
    await fs.writeFile(path.join(approvalsDir(), `${id}.decision.json`), JSON.stringify(d, null, 2), "utf-8");
};

// ============ 心跳三态 ============

test("心跳：写入可读；90s 内算存活；过期失效；canApprove=false 不算可批（runner 不进卡片等待）", async () => {
    await withClock(async ({ now, setT }) => {
        await writeListenerHeartbeat(true, now());
        const hb = await readListenerHeartbeat(now());
        assert.ok(hb && hb.canApprove === true);
        assert.equal(typeof hb.pid, "number");
        assert.equal(await isListenerAlive(now()), true, "新鲜 + 可批 = 存活");

        setT(Date.parse("2026-11-05T12:01:30")); // +90s：恰好边界内
        assert.equal(await isListenerAlive(now()), true);
        setT(Date.parse("2026-11-05T12:01:31")); // +91s：过期
        assert.equal(await isListenerAlive(now()), false, "心跳过期 = 不存活");
        assert.equal(await readListenerHeartbeat(now()), null);

        await writeListenerHeartbeat(false, now());
        assert.equal(await isListenerAlive(now()), false, "users 空 → canApprove=false → 不可批");
    });
});

// ============ requestCardApproval ============

test("不存活：立即 deny、零输出、不落 pending（listen 不在 = 现状自动应答路径，零回归红线）", async () => {
    await withClock(async ({ now }) => {
        const lines: string[] = [];
        const r = await requestCardApproval({ tool: "run_command", detail: "rm -rf build", locale: "zh", out: (l) => lines.push(l), now });
        assert.equal(r, "deny");
        assert.deepEqual(lines, [], "零输出");
        assert.deepEqual(await listPendingApprovals(now()), [], "不落 pending");
    });
});

test("存活：落 pending + 推卡日志；点批准 → \"allow-once\"；点拒绝 → \"deny\"；两种结局都清理 pending", async () => {
    await withClock(async ({ now }) => {
        await writeListenerHeartbeat(true, now());
        const lines: string[] = [];
        let polls = 0;
        let pendingId = "";
        let pendingSummary = "";
        const r = await requestCardApproval({
            tool: "run_command", detail: "rm -rf build\n第二行", ticketId: "bt-1", ticketTitle: "修复", locale: "zh",
            out: (l) => lines.push(l), now,
            sleep: async () => {
                polls++;
                const pendings = await listPendingApprovals(now());
                pendingId = pendings[0]?.approvalId ?? "";
                pendingSummary = pendings[0]?.summary ?? "";
                if (polls === 1) await writeDecisionFile(pendingId, "allow");
            },
        });
        assert.equal(r, "allow-once");
        assert.ok(lines.some((l) => /卡片审批请求已推送/.test(l)), "推送日志");
        assert.ok(lines.some((l) => /allow-once/.test(l)), "批准日志");
        assert.equal(pendingSummary, "rm -rf build 第二行", "摘要瘦身单行进 pending 文件（卡片内容源）");
        assert.deepEqual(await listPendingApprovals(now()), [], "结局后 pending 已清理");

        // deny 分支
        await writeListenerHeartbeat(true, now());
        const r2 = await requestCardApproval({
            tool: "delete_path", detail: "x", locale: "zh", out: () => { }, now,
            sleep: async () => {
                const pendings = await listPendingApprovals(now());
                if (pendings[0]) await writeDecisionFile(pendings[0].approvalId, "deny");
            },
        });
        assert.equal(r2, "deny");
    });
});

test("approvalId 错配的决定被忽略（防错配）；超时 = deny fail-closed + pending 清理", async () => {
    await withClock(async ({ now, setT }) => {
        await writeListenerHeartbeat(true, now());
        let t0 = now().getTime();
        const r = await requestCardApproval({
            tool: "run_command", detail: "x", timeoutMin: 1, locale: "zh", out: () => { }, now,
            sleep: async () => {
                // 第一次轮询：写一个【别的】approvalId 的决定（错配）
                const pendings = await listPendingApprovals(now());
                if (pendings[0]) await writeDecisionFile("not-this-id", "allow");
                t0 += 61_000; // 每次轮询拨 61s（pollMs 假定 1s 量级），越过 1min 期限
                setT(t0);
            },
        });
        assert.equal(r, "deny", "错配不生效 + 超时 deny");
        assert.deepEqual(await listPendingApprovals(now()), [], "超时结局也清理 pending");
        assert.equal(APPROVAL_TIMEOUT_MIN, 30, "缺省 30 分钟（方案 §5）");
    });
});

// ============ writeApprovalDecision ============

test("决定写入：pending 缺失拒；重复决定拒（一个 pending 只决定一次）；正常写盘可读", async () => {
    await withClock(async ({ now }) => {
        const miss = await writeApprovalDecision({ approvalId: "ghost", decision: "allow", decidedBy: "ou_alice", now });
        assert.equal(miss.ok, false);
        if (!miss.ok) assert.match(miss.error, /pending 不存在|已超时/);

        const id = randomUUID();
        await writePendingFile(id, { expiresAt: new Date(now().getTime() + 600_000).toISOString() });
        const ok = await writeApprovalDecision({ approvalId: id, decision: "allow", decidedBy: "ou_alice", now });
        assert.equal(ok.ok, true);

        const dup = await writeApprovalDecision({ approvalId: id, decision: "deny", decidedBy: "ou_alice", now });
        assert.equal(dup.ok, false);
        if (!dup.ok) assert.match(dup.error, /已决定|只决定一次/, "重复决定拒绝");

        const raw = JSON.parse(await fs.readFile(path.join(approvalsDir(), `${id}.decision.json`), "utf-8"));
        assert.equal(raw.decision, "allow");
        assert.equal(raw.decidedBy, "ou_alice");
    });
});

// ============ listPendingApprovals / sweepStaleApprovals ============

test("listPending：跳过过期与损坏 pending；健康 pending 全量返回", async () => {
    await withClock(async ({ now, setT }) => {
        const good = randomUUID();
        await writePendingFile(good, { expiresAt: new Date(now().getTime() + 600_000).toISOString() });
        const expired = randomUUID();
        await writePendingFile(expired, { expiresAt: new Date(now().getTime() - 1000).toISOString() });
        await fs.writeFile(path.join(approvalsDir(), `${randomUUID()}.pending.json`), "{broken", "utf-8");

        const l1 = await listPendingApprovals(now());
        assert.deepEqual(l1.map((p) => p.approvalId), [good], "过期与损坏不入列");

        setT(now().getTime() + 700_000);
        const l2 = await listPendingApprovals(now());
        assert.deepEqual(l2, [], "过期后（runner 自己会 deny）不再推卡");
    });
});

test("sweep：宽限内不动（防误删在途）；过期+宽限连 pending/decision 一起清；只剩 decision 残留也可清", async () => {
    await withClock(async ({ now, setT }) => {
        const inFlight = randomUUID();  // 过期 5min（宽限内）
        await writePendingFile(inFlight, { expiresAt: new Date(now().getTime() - 5 * 60_000).toISOString() });
        const stale = randomUUID();     // 过期 20min（超宽限）
        await writePendingFile(stale, { expiresAt: new Date(now().getTime() - 20 * 60_000).toISOString() });
        await writeDecisionFile(stale, "deny");
        const residue = randomUUID();   // pending 已丢、只剩 decision 残留
        await writeDecisionFile(residue, "allow");
        const fresh = randomUUID();     // 未过期
        await writePendingFile(fresh, { expiresAt: new Date(now().getTime() + 600_000).toISOString() });

        const removed = await sweepStaleApprovals(now());
        assert.equal(removed, 3, "stale 的 pending+decision 两个目录项各计一次（=2）+ residue（=1）；in-flight 与 fresh 不动");
        const names = await fs.readdir(approvalsDir());
        assert.ok(names.includes(`${inFlight}.pending.json`), "宽限内在途不动");
        assert.ok(names.includes(`${fresh}.pending.json`), "未过期不动");
        assert.ok(!names.includes(`${stale}.pending.json`) && !names.includes(`${stale}.decision.json`), "超宽限连带清理");
        assert.ok(!names.includes(`${residue}.decision.json`), "decision 残留可清");
        assert.equal(APPROVAL_SWEEP_GRACE_MIN, 10, "宽限 10 分钟（方案 §5）");
        assert.equal(HEARTBEAT_MAX_AGE_MS, 90_000);
    });
});

test("心跳残留不清理：sweep 不碰 .listener-heartbeat 与 tmp 文件", async () => {
    await withClock(async ({ now }) => {
        await writeListenerHeartbeat(true, now());
        await fs.writeFile(path.join(approvalsDir(), "x.pending.json.tmp-123-abc"), "{}", "utf-8");
        await sweepStaleApprovals(now());
        const names = await fs.readdir(approvalsDir());
        assert.ok(names.includes(".listener-heartbeat"), "心跳保留");
        assert.ok(names.includes("x.pending.json.tmp-123-abc"), "tmp 由原子写自净，sweep 不碰");
    });
});

// ============ 单实例锁（wx 独占创建 = 原子；挡心跳 check-then-act 的并发双开竞态） ============

test("listen 锁：存活持有者拒绝（报 pid）/ 损坏接管 / 死 pid 接管 / 释放删除 / pidAlive 两形态", async () => {
    await withClock(async () => {
        await fs.mkdir(approvalsDir(), { recursive: true });

        // 1) 持有者存活（用测试进程自身 pid——确定性存活）：拒绝且报出 pid（含「持有者是自己」的异常残留）
        await fs.writeFile(listenLockPath(), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf-8");
        assert.deepEqual(await acquireListenLock(), { ok: false, holderPid: process.pid });

        // 2) 损坏文件 → 接管成功，锁内容归我
        await fs.writeFile(listenLockPath(), "not-json", "utf-8");
        assert.deepEqual(await acquireListenLock(), { ok: true });
        const mine = JSON.parse(await fs.readFile(listenLockPath(), "utf-8"));
        assert.equal(mine.pid, process.pid);

        // 3) 死 pid → 接管（刚退出的子进程 pid + 前提自检，排除 pid 复用极小概率翻车）
        const { spawn } = await import("child_process");
        const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
        await new Promise<void>((res) => child.on("exit", () => res()));
        assert.ok(child.pid);
        assert.equal(pidAlive(child.pid), false, "前提自检：刚退出的子进程必须判死");
        await fs.writeFile(listenLockPath(), JSON.stringify({ pid: child.pid, at: new Date().toISOString() }), "utf-8");
        assert.deepEqual(await acquireListenLock(), { ok: true }, "崩溃残留（死 pid）→ 自愈接管");

        // 4) 释放删除
        await releaseListenLock();
        assert.equal(await fs.stat(listenLockPath()).then(() => true, () => false), false, "释放后锁文件不存在");

        // 5) pidAlive 边界（导出面钉死：非正整数判死）
        assert.equal(pidAlive(process.pid), true);
        assert.equal(pidAlive(0), false);
        assert.equal(pidAlive(-1), false);
    });
});
