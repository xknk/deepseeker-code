/**
 * @file batch/queue.ts
 * @description 挂机批处理队列（成本信任链第四环 F1）：三态目录 pending/ → running/ → done/ 的纯文件操作。
 *
 *  - 队列根：<项目>/.deepseeker-code/batch/（项目级，与 hooks/settings 同一 .deepseeker-code 约定）。
 *    位于保护段 → isProtectedWrite 使模型改不了工单（防自改预算/自过验收），天然成立。
 *  - 幂等：工单按 pending → running → done 一路搬家；runner 崩溃残留 running/ 的工单，
 *    下次 run 启动时重排队（requeueStaleRunning）——配合 worktree 启动期 sweep 兜底，重跑不丢任务。
 *  - 并发闸：.lock 文件（O_EXCL）防两个 runner 同时跑（挂机第一版并发=0）；持有者 pid 死亡时可被接管。
 *  - 清理：clean 清 done/ 时同步回收附件目录（<batch>/attachments/<票id>，M5 附件链）——
 *    本次清掉的票直接删，其余无票可依的孤儿按宽限期删（防误删在途 sync 的下载目录）。
 *  - 目录覆盖可用 env DEEPSEEKER_CODE_BATCH_DIR 重定向（测试/诊断用），调用时实时读（不冻结）。
 */
import fs from "fs/promises";
import path from "path";
import { generateBatchId, readBatchTicket, parseBatchTicket, type BatchLocale } from "./ticket.ts";
import { writeFinishNotification } from "./feishu/notify.ts";

/** 锁错误文案（直接进 runner 控制台；缺省 zh 向后兼容）。 */
const LOCK_MSG: Record<BatchLocale, Record<string, any>> = {
    zh: {
        createFail: (e: string) => `锁创建失败：${e}`,
        held: (pid: number) => `已有 batch runner 在运行（pid ${pid}）。挂机模式串行，勿并发跑两个 runner。`,
    },
    en: {
        createFail: (e: string) => `Failed to create the lock file: ${e}`,
        held: (pid: number) => `Another batch runner is already running (pid ${pid}). Batch mode is serial — don't run two runners at once.`,
    },
};

export type BatchState = "pending" | "running" | "done";

/** 队列根目录（实时读 env：测试可重定向到临时目录）。 */
export const batchQueueRoot = (): string =>
    process.env.DEEPSEEKER_CODE_BATCH_DIR || path.join(process.cwd(), ".deepseeker-code", "batch");

const stateDir = (s: BatchState): string => path.join(batchQueueRoot(), s);
const lockPath = (): string => path.join(batchQueueRoot(), ".lock");

/** 扫一个状态目录下的工单文件名（升序 = FIFO；忽略报告与隐藏文件）。 */
const listState = async (s: BatchState): Promise<string[]> => {
    try {
        return (await fs.readdir(stateDir(s))).filter((f) => f.endsWith(".md") && !f.endsWith(".report.md")).sort();
    } catch {
        return []; // 目录不存在 = 该状态无任务（正常态）
    }
};

/** 三态快照（batch list 用）。 */
export const snapshotQueue = async (): Promise<Record<BatchState, string[]>> => ({
    pending: await listState("pending"),
    running: await listState("running"),
    done: (await listState("done")).map((f) => f.replace(/\.md$/, "")),
});

/** done/ 目录的报告路径。 */
export const reportPath = (id: string): string => path.join(stateDir("done"), `${id}.report.md`);

/** 取报告文本（无则 null）。 */
export const readReport = async (id: string): Promise<string | null> => {
    try {
        return await fs.readFile(reportPath(id), "utf-8");
    } catch {
        return null;
    }
};

/**
 * 入队：读源文件 → 解析校验（缺 accept 等在此拒绝）→ 生成 id → 写 pending/。
 * @param preId 预生成 id（M5 附件链：附件目录按票 id 命名，建票前就要知道 id；缺省现场生成）。
 * @returns 入队结果（失败带原因文案，调用方直接打印）。
 */
export const enqueueTicketFile = async (srcPath: string, locale: BatchLocale = "zh", preId?: string): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> => {
    const parsed = await readBatchTicket(srcPath, locale);
    if (!parsed.ok) return parsed;
    // 源文件原样搬运（校验在读取时已做；保留原文避免二次序列化走样）
    const source = await fs.readFile(srcPath, "utf-8");
    const id = preId ?? generateBatchId();
    await fs.mkdir(stateDir("pending"), { recursive: true });
    await fs.writeFile(path.join(stateDir("pending"), `${id}.md`), source, "utf-8");
    return { ok: true, id, title: parsed.ticket.title };
};

/**
 * 取下一个待跑任务：先收割上次崩溃残留（running/ → pending/ 重排队），再取 pending/ 中
 * 【第一个已到可跑时刻】的票（not-before 未到的跳过、原位保留——C2 意图词延迟执行，
 * FIFO 只在可跑票上生效；延后票不堵后面的即时票）。
 * @returns 任务（id + 工单路径）或 null（队列空 / 无可跑票）。
 */
export const takeNextTicket = async (): Promise<{ id: string; path: string } | null> => {
    await requeueStaleRunning();
    const first = await firstEligiblePending();
    if (!first) return null;
    const from = path.join(stateDir("pending"), first.file);
    const to = path.join(stateDir("running"), first.file);
    await fs.mkdir(stateDir("running"), { recursive: true });
    await fs.rename(from, to); // 原子搬家：崩溃后 either 端可见，幂等
    return { id: first.file.replace(/\.md$/, ""), path: to };
};

/**
 * 窥视队首但不取走（M6 总量硬闸）：超限停票信息需要知道「停在谁之前」，工单必须原样留在
 * pending/（下一批继续，不留半成品也不丢票）。run 持单飞锁，窥视与取走之间无并发竞争。
 * 与 takeNextTicket 同一可跑判定（not-before 跳过）——窥到的那张就是即将取走的那张。
 */
export const peekNextTicket = async (): Promise<{ id: string; path: string } | null> => {
    await requeueStaleRunning();
    const first = await firstEligiblePending();
    if (!first) return null;
    return { id: first.file.replace(/\.md$/, ""), path: path.join(stateDir("pending"), first.file) };
};

/** pending/ 中第一个已到可跑时刻的票（文件名升序 FIFO 之上的 not-before 过滤；无 → null）。 */
const firstEligiblePending = async (now = new Date()): Promise<{ file: string } | null> => {
    const pending = await listState("pending");
    for (const file of pending) {
        const t = await readBatchTicket(path.join(stateDir("pending"), file));
        if (t.ok && t.ticket.notBefore && new Date(t.ticket.notBefore).getTime() > now.getTime()) continue; // 未到点：跳过原位保留
        return { file };
    }
    return null;
};

// ============ C2 点火器 / C4 控制面的队列读侧（listen 专用，纯文件零 SDK） ============

/** pending 票元数据（「队列」一览与点火判定的数据源）。 */
export interface PendingTicketMeta {
    id: string;
    title: string;
    /** 最早可跑时刻（ISO；缺省=立即可跑）。 */
    notBefore?: string;
    /** 此刻是否已到可跑时刻。 */
    eligible: boolean;
}

/** 列 pending 票（文件名升序=FIFO；带标题与可跑判定；损坏票标 title 占位不炸）。 */
export const listPendingTickets = async (now = new Date()): Promise<PendingTicketMeta[]> => {
    const out: PendingTicketMeta[] = [];
    for (const file of await listState("pending")) {
        const id = file.replace(/\.md$/, "");
        const t = await readBatchTicket(path.join(stateDir("pending"), file));
        out.push(t.ok
            ? { id, title: t.ticket.title, notBefore: t.ticket.notBefore, eligible: !t.ticket.notBefore || new Date(t.ticket.notBefore).getTime() <= now.getTime() }
            : { id, title: id, eligible: true });
    }
    return out;
};

/** 列 running 票（串行队列至多一张；带标题）。 */
export const listRunningTickets = async (): Promise<{ id: string; title: string }[]> => {
    const out: { id: string; title: string }[] = [];
    for (const file of await listState("running")) {
        const id = file.replace(/\.md$/, "");
        const t = await readBatchTicket(path.join(stateDir("running"), file));
        out.push({ id, title: t.ok ? t.ticket.title : id });
    }
    return out;
};

/** runner 是否存活（.lock 持有者 pid 存活探测）：点火器的「无 runner 存活」判据；无锁/死 pid = 无 runner。 */
export const runnerLockHolderAlive = async (): Promise<boolean> => {
    const raw = await fs.readFile(lockPath(), "utf-8").catch(() => "");
    const ownerPid = parseInt(raw.split(" ")[0], 10);
    return Number.isFinite(ownerPid) && pidAlive(ownerPid);
};

/** 撤销 pending 票（C4「取消 <id>」）：删 pending/<id>.md；票不存在/已在跑 = false（取消只对没开跑的票有效）。 */
export const cancelPendingTicket = async (id: string): Promise<boolean> => {
    if (!/^[\w.-]+$/.test(id)) return false; // id 形态闸：防路径拼接
    return await fs.rm(path.join(stateDir("pending"), `${id}.md`), { force: false }).then(() => true, () => false);
};

// ============ C2/C4 跨进程协议文件（runner 写/读，listen 写/读；路径约定单点收拢） ============

/** 停止约定文件路径（「停」：listen 落 running/<id>.stop.json，runner 每轮工具边界检查，软停不杀进程）。 */
export const stopRequestPath = (id: string): string => path.join(stateDir("running"), `${id}.stop.json`);

/** 落停止请求（幂等覆盖写；payload 记谁在何时喊停，报告可溯源）。 */
export const writeStopRequest = async (id: string, by = "feishu", at = new Date()): Promise<void> => {
    await fs.mkdir(stateDir("running"), { recursive: true });
    await fs.writeFile(stopRequestPath(id), JSON.stringify({ ticketId: id, by, at: at.toISOString() }, null, 2), "utf-8").catch(() => { });
};

/** 读停止请求（runner 轮询用；无文件/损坏 = null）。 */
export const readStopRequest = async (id: string): Promise<{ ticketId: string; by: string; at: string } | null> => {
    try {
        const raw = JSON.parse(await fs.readFile(stopRequestPath(id), "utf-8"));
        return raw && typeof raw === "object" ? raw : null;
    } catch {
        return null;
    }
};

/** 进度心跳文件路径（「进度」：runner 在轮边界/工具启动时更新 running/<id>.progress.json）。 */
export const progressPath = (id: string): string => path.join(stateDir("running"), `${id}.progress.json`);

/** 进度心跳载荷（runner 写、listen 读；activity 不含命令全文——外发红线在展示侧另有闸）。 */
export interface TicketProgress {
    ticketId: string;
    pid: number;
    /** agent 轮次（从 1 起）。 */
    round: number;
    /** 正在干什么（人话短语，如「正在跑 npm test」）。 */
    activity: string;
    /** 本活动开始时刻（ISO）。 */
    since: string;
    startedAt: string;
    updatedAt: string;
}

/** 写进度心跳（runner 侧；失败吞——进度是增益不是关键路径）。 */
export const writeTicketProgress = async (p: TicketProgress): Promise<void> => {
    await fs.mkdir(stateDir("running"), { recursive: true });
    await fs.writeFile(progressPath(p.ticketId), JSON.stringify(p, null, 2), "utf-8").catch(() => { });
};

/** 读进度心跳（listen 侧；无文件/损坏 = null）。 */
export const readTicketProgress = async (id: string): Promise<TicketProgress | null> => {
    try {
        const raw = JSON.parse(await fs.readFile(progressPath(id), "utf-8"));
        return raw && typeof raw === "object" ? raw : null;
    } catch {
        return null;
    }
};

/** 崩溃残留重排队：running/ 全部搬回 pending/（工单内容没跑完即重跑；worktree 孤儿由启动期 sweep 清）。 */
export const requeueStaleRunning = async (): Promise<number> => {
    const stale = await listState("running");
    if (stale.length === 0) return 0;
    await fs.mkdir(stateDir("pending"), { recursive: true });
    for (const f of stale) {
        await fs.rename(path.join(stateDir("running"), f), path.join(stateDir("pending"), f)).catch(() => { });
    }
    return stale.length;
};

/**
 * 收尾：报告写 done/，工单 running → done/。任一步失败不抛（收尾失败不能击垮汇总打印）。
 * P4 反馈闭环：飞书票（frontmatter 带 feishu-chat）在此落完成通知文件（listen 扫描发送）——
 * 成功失败都通知；非飞书票零行为变化。通知失败不抛（通知是增益，报告才是事实源）。
 */
export const finishTicket = async (id: string, reportMd: string): Promise<void> => {
    try {
        await fs.mkdir(stateDir("done"), { recursive: true });
        await fs.writeFile(reportPath(id), reportMd, "utf-8");
        await fs.rename(path.join(stateDir("running"), `${id}.md`), path.join(stateDir("done"), `${id}.md`)).catch(() => { });
        // C2/C4 协议文件随票收尾清走（stop 残留会误导同 id 复跑判定；progress 残留会被「进度」读到死票）
        await fs.rm(stopRequestPath(id), { force: true }).catch(() => { });
        await fs.rm(progressPath(id), { force: true }).catch(() => { });
        // rename 在 Windows 高负载下对读者短暂不可见（源已去、目标未现的窗口）：两侧都读空时小退避重试。
        // 咽喉错过这次读取，完成通知文件就不会落盘、推送永远丢失（它监听器发送的唯一凭据），值得一秒的耐心。
        let ticketSrc: string | null = null;
        for (let i = 0; i < 6 && ticketSrc === null; i++) {
            ticketSrc = await fs.readFile(path.join(stateDir("done"), `${id}.md`), "utf-8").catch(() => null)
                ?? await fs.readFile(path.join(stateDir("running"), `${id}.md`), "utf-8").catch(() => null);
            if (ticketSrc === null) await new Promise((r) => setTimeout(r, 150));
        }
        if (ticketSrc !== null) {
            const parsed = parseBatchTicket(ticketSrc);
            if (parsed.ok && parsed.ticket.feishuChat) {
                await writeFinishNotification({
                    ticketId: id, reportMd,
                    chatId: parsed.ticket.feishuChat,
                    senderOpenId: parsed.ticket.feishuSender,
                    title: parsed.ticket.title,
                });
            }
        }
    } catch (e: any) {
        console.warn(`⚠️ [batch] 报告落盘失败（任务结果以控制台输出为准）: ${e?.message ?? e}`);
    }
};

/** 附件落盘根目录（M5 附件链：<batch>/attachments/<票id>/）。 */
export const attachmentsRoot = (): string => path.join(batchQueueRoot(), "attachments");

/**
 * 附件目录孤儿宽限期：sync 是「先落盘附件、后入队建票」，两件事之间有下载窗口。
 * 太新的「无票目录」可能属于一次在途 sync（clean 与 sync 可以同时跑），10 分钟内不动它——
 * 宁可晚清一次，不误删在途附件。超过宽限期的无票目录才算真孤儿。
 */
export const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** batch clean 结果：清掉的任务存档数 + 附件目录数。 */
export interface CleanResult {
    tasks: number;
    attachments: number;
}

/**
 * 回收附件目录（batch clean 的附件半边）：目录名即票 id，凡票已不在 pending/running 的，
 *  - 属于本次刚清掉的 done 票 → 直接删（存档都没了，附件留着就是孤儿）；
 *  - 完全无票可依的真孤儿 → 仅在目录 mtime 早于宽限期时删（见 ORPHAN_GRACE_MS）。
 * 异常一律吞：清理失败不能击垮 clean 命令。
 * @param clearedDoneIds 本次 clean 刚清掉的 done 票 id（免除宽限期判定）。
 */
export const cleanOrphanAttachments = async (clearedDoneIds: Iterable<string> = []): Promise<number> => {
    const root = attachmentsRoot();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
    if (!entries) return 0; // 无附件根 = 没跑过带附件 sync（正常态）

    const active = new Set<string>();
    for (const s of ["pending", "running", "done"] as BatchState[]) {
        for (const f of await listState(s)) active.add(f.replace(/\.md$/, ""));
    }
    const cleared = new Set(clearedDoneIds);
    const now = Date.now();
    let removed = 0;
    for (const e of entries) {
        if (!e.isDirectory() || active.has(e.name)) continue; // 队列里还有票 = 不动（含附件目录同名的保护段语义）
        const abs = path.join(root, e.name);
        if (!cleared.has(e.name)) {
            const st = await fs.stat(abs).catch(() => null);
            if (!st || now - st.mtimeMs < ORPHAN_GRACE_MS) continue; // 可能是在途 sync 刚建的
        }
        const ok = await fs.rm(abs, { recursive: true, force: true }).then(() => true, () => false);
        if (ok) removed++;
    }
    return removed;
};

/**
 * 清空 done/ 并回收附件目录（batch clean）：返回存档数与附件目录数。
 * pending/running 的票及其附件一律不动；顺带清掉 .pr.json 交付标记（batch pr 的幂等凭据，
 * 票存档都没了标记自然作废，不留孤儿文件）。
 */
export const cleanDone = async (): Promise<CleanResult> => {
    const files = await listState("done");
    for (const f of (await fs.readdir(stateDir("done")).catch(() => [] as string[]))) {
        if (f.endsWith(".md") || f.endsWith(".report.md") || f.endsWith(".pr.json")) {
            await fs.rm(path.join(stateDir("done"), f), { force: true }).catch(() => { });
        }
    }
    const attachments = await cleanOrphanAttachments(files.map((f) => f.replace(/\.md$/, "")));
    return { tasks: files.length, attachments };
};

/**
 * 票标 needs-review（§9-8 P2 动作半边）：改测试触碰启发式 / 交付预检冲突等来源统一走此写入。
 * 只动 frontmatter——已有 needs-review 行改值为 true，没有则在 frontmatter 末插入一行；
 * 正文原样保留（工单是存档，改写必须可审计地小）。
 * @returns true=本次写入生效；false=已标过或文件没有合法 frontmatter（不写）。
 */
export const markTicketNeedsReview = async (ticketPath: string): Promise<boolean> => {
    let source: string;
    try {
        source = await fs.readFile(ticketPath, "utf-8");
    } catch {
        return false;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!m) return false;
    const fmRaw = m[1];
    if (/^needs-review:\s*true\s*$/m.test(fmRaw)) return false; // 已标过：幂等
    const lines = fmRaw.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^needs-review:\s*/.test(l));
    if (idx >= 0) lines[idx] = "needs-review: true";
    else lines.push("needs-review: true");
    const updated = source.replace(m[0], `---\n${lines.join("\n")}\n---`);
    await fs.writeFile(ticketPath, updated, "utf-8");
    return true;
};

// ============ 运行锁（并发=0 红线：同一项目同时只允许一个 runner） ============

/** 进程存活探测（ESRCH = 无此进程）。 */
const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === "EPERM"; // EPERM = 存在但无权发信号，仍视为活着
    }
};

/**
 * 尝试持有运行锁（O_EXCL 原子创建）。已有锁时：持有者 pid 已死 → 接管（崩溃残留）；活着 → 拒绝。
 * @returns 持锁成功 true；失败带原因。
 */
export const acquireRunLock = async (locale: BatchLocale = "zh"): Promise<{ ok: true } | { ok: false; error: string }> => {
    await fs.mkdir(batchQueueRoot(), { recursive: true });
    const payload = `${process.pid} ${new Date().toISOString()}`;
    try {
        await fs.writeFile(lockPath(), payload, { flag: "wx" }); // wx = O_EXCL：已存在即抛 EEXIST
        return { ok: true };
    } catch (e: any) {
        if (e?.code !== "EEXIST") return { ok: false, error: LOCK_MSG[locale].createFail(e?.message ?? e) };
        const raw = await fs.readFile(lockPath(), "utf-8").catch(() => "");
        const ownerPid = parseInt(raw.split(" ")[0], 10);
        if (Number.isFinite(ownerPid) && pidAlive(ownerPid)) {
            return { ok: false, error: LOCK_MSG[locale].held(ownerPid) };
        }
        await fs.writeFile(lockPath(), payload).catch(() => { }); // 持有者已死：接管
        return { ok: true };
    }
};

/** 释放运行锁（仅当持有者仍是自己——防误删接管者的锁）。 */
export const releaseRunLock = async (): Promise<void> => {
    const raw = await fs.readFile(lockPath(), "utf-8").catch(() => "");
    if (parseInt(raw.split(" ")[0], 10) === process.pid) {
        await fs.rm(lockPath(), { force: true }).catch(() => { });
    }
};
