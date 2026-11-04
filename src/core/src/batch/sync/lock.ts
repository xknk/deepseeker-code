/**
 * @file batch/sync/lock.ts
 * @description 多入口工单流水线 P1：sync 单飞锁（<batch>/.sync.lock，O_EXCL，§5.2.3）。
 *
 *  定时器重叠调用 sync 是常态（§4.2 评审修订②）：第二个 sync 直接退出并提示，防重复建票。
 *  写法照抄 batch/queue.ts 的 acquireRunLock（O_EXCL 原子创建 + 持有者 pid 死亡可接管）。
 */
import fs from "fs/promises";
import path from "path";
import { batchQueueRoot } from "../queue.ts";
import type { SyncLocale } from "./config.ts";

const SYNC_LOCK_MSG: Record<SyncLocale, Record<string, any>> = {
    zh: {
        createFail: (e: string) => `sync 锁创建失败：${e}`,
        held: (pid: number) => `已有 sync 在运行（pid ${pid}）。定时器重叠时第二个同步直接退出，防重复建票。`,
    },
    en: {
        createFail: (e: string) => `Failed to create the sync lock: ${e}`,
        held: (pid: number) => `A sync is already running (pid ${pid}). The second overlapping sync exits immediately to prevent duplicate tickets.`,
    },
};

const syncLockPath = (): string => path.join(batchQueueRoot(), ".sync.lock");

/** 进程存活探测（ESRCH = 无此进程；EPERM = 存在但无权发信号，仍视为活着）。 */
const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === "EPERM";
    }
};

/** 尝试持有 sync 锁（O_EXCL）。已有锁且持有者活着 → 拒绝；持有者已死 → 接管。 */
export const acquireSyncLock = async (locale: SyncLocale = "zh"): Promise<{ ok: true } | { ok: false; error: string }> => {
    const msg = (SYNC_LOCK_MSG[locale] ?? SYNC_LOCK_MSG.zh);
    await fs.mkdir(batchQueueRoot(), { recursive: true });
    const payload = `${process.pid} ${new Date().toISOString()}`;
    try {
        await fs.writeFile(syncLockPath(), payload, { flag: "wx" }); // wx = O_EXCL：已存在即抛 EEXIST
        return { ok: true };
    } catch (e: any) {
        if (e?.code !== "EEXIST") return { ok: false, error: msg.createFail(e?.message ?? e) };
        const raw = await fs.readFile(syncLockPath(), "utf-8").catch(() => "");
        const ownerPid = parseInt(raw.split(" ")[0], 10);
        if (Number.isFinite(ownerPid) && pidAlive(ownerPid)) {
            return { ok: false, error: msg.held(ownerPid) };
        }
        await fs.writeFile(syncLockPath(), payload).catch(() => { }); // 持有者已死：接管
        return { ok: true };
    }
};

/** 释放 sync 锁（仅当持有者仍是自己——防误删接管者的锁）。 */
export const releaseSyncLock = async (): Promise<void> => {
    const raw = await fs.readFile(syncLockPath(), "utf-8").catch(() => "");
    if (parseInt(raw.split(" ")[0], 10) === process.pid) {
        await fs.rm(syncLockPath(), { force: true }).catch(() => { });
    }
};
