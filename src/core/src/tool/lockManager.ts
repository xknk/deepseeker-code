/**
 * @file tool/lockManager.ts
 * @description 互斥锁管理器：为 isSync:false 后台任务提供 exclusiveLock 互斥语义。
 *
 *  冲突策略：acquire 时若 key 已被占用，直接返回 false（拒绝执行），不排队、不挂起——
 *  避免无限等待与死锁。后台任务结束（generator 完成）时由调用方 release。
 *
 *  设计为纯内存 Set（单进程内互斥即可；多进程/多实例不在 v1 范围）。
 */

/** 当前被持有的锁 key 集合 */
const heldLocks = new Set<string>();

/** 尝试获取锁；成功 true，已被占用 false（原子，无 await） */
export function acquireLock(key: string): boolean {
    if (heldLocks.has(key)) return false;
    heldLocks.add(key);
    return true;
}

/** 释放锁（幂等：未持有也安全） */
export function releaseLock(key: string): void {
    heldLocks.delete(key);
}

/** 锁是否正被持有 */
export function isLockHeld(key: string): boolean {
    return heldLocks.has(key);
}

/**
 * 计算工具的 exclusiveLock key。
 * @param lock string（固定 key）| 函数（按 args/ctx 动态生成）| undefined（无锁）
 * @returns 解析出的 key；无锁或解析异常时返回 null
 */
export function computeLockKey(
    lock: string | ((args: any, ctx: any) => string) | undefined,
    args: any,
    ctx: any,
): string | null {
    if (!lock) return null;
    if (typeof lock === 'function') {
        try {
            const k = lock(args, ctx);
            return typeof k === 'string' && k.length > 0 ? k : null;
        } catch {
            return null;
        }
    }
    return lock;
}

/** 清空全部锁（测试 / 重置用） */
export function clearLocks(): void {
    heldLocks.clear();
}
