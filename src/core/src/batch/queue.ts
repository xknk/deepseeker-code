/**
 * @file batch/queue.ts
 * @description 挂机批处理队列（成本信任链第四环 F1）：三态目录 pending/ → running/ → done/ 的纯文件操作。
 *
 *  - 队列根：<项目>/.deepseeker-code/batch/（项目级，与 hooks/settings 同一 .deepseeker-code 约定）。
 *    位于保护段 → isProtectedWrite 使模型改不了工单（防自改预算/自过验收），天然成立。
 *  - 幂等：工单按 pending → running → done 一路搬家；runner 崩溃残留 running/ 的工单，
 *    下次 run 启动时重排队（requeueStaleRunning）——配合 worktree 启动期 sweep 兜底，重跑不丢任务。
 *  - 并发闸：.lock 文件（O_EXCL）防两个 runner 同时跑（挂机第一版并发=0）；持有者 pid 死亡时可被接管。
 *  - 目录覆盖可用 env DEEPSEEKER_CODE_BATCH_DIR 重定向（测试/诊断用），调用时实时读（不冻结）。
 */
import fs from "fs/promises";
import path from "path";
import { generateBatchId, readBatchTicket, type BatchLocale } from "./ticket.ts";

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
 * @returns 入队结果（失败带原因文案，调用方直接打印）。
 */
export const enqueueTicketFile = async (srcPath: string, locale: BatchLocale = "zh"): Promise<{ ok: true; id: string; title: string } | { ok: false; error: string }> => {
    const parsed = await readBatchTicket(srcPath, locale);
    if (!parsed.ok) return parsed;
    // 源文件原样搬运（校验在读取时已做；保留原文避免二次序列化走样）
    const source = await fs.readFile(srcPath, "utf-8");
    const id = generateBatchId();
    await fs.mkdir(stateDir("pending"), { recursive: true });
    await fs.writeFile(path.join(stateDir("pending"), `${id}.md`), source, "utf-8");
    return { ok: true, id, title: parsed.ticket.title };
};

/**
 * 取下一个待跑任务：先收割上次崩溃残留（running/ → pending/ 重排队），再取 pending/ 队首。
 * @returns 任务（id + 工单路径）或 null（队列空）。
 */
export const takeNextTicket = async (): Promise<{ id: string; path: string } | null> => {
    await requeueStaleRunning();
    const pending = await listState("pending");
    if (pending.length === 0) return null;
    const file = pending[0];
    const from = path.join(stateDir("pending"), file);
    const to = path.join(stateDir("running"), file);
    await fs.mkdir(stateDir("running"), { recursive: true });
    await fs.rename(from, to); // 原子搬家：崩溃后 either 端可见，幂等
    return { id: file.replace(/\.md$/, ""), path: to };
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
 */
export const finishTicket = async (id: string, reportMd: string): Promise<void> => {
    try {
        await fs.mkdir(stateDir("done"), { recursive: true });
        await fs.writeFile(reportPath(id), reportMd, "utf-8");
        await fs.rename(path.join(stateDir("running"), `${id}.md`), path.join(stateDir("done"), `${id}.md`)).catch(() => { });
    } catch (e: any) {
        console.warn(`⚠️ [batch] 报告落盘失败（任务结果以控制台输出为准）: ${e?.message ?? e}`);
    }
};

/** 清空 done/（batch clean）：返回删除文件数。 */
export const cleanDone = async (): Promise<number> => {
    const files = await listState("done");
    for (const f of (await fs.readdir(stateDir("done")).catch(() => [] as string[]))) {
        if (f.endsWith(".md") || f.endsWith(".report.md")) {
            await fs.rm(path.join(stateDir("done"), f), { force: true }).catch(() => { });
        }
    }
    return files.length;
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
