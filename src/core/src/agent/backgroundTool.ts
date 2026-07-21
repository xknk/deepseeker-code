/**
 * @file agent/backgroundTool.ts
 * @description isSync:false 后台工具的执行收集器：把 AsyncGenerator 的【首个 yield】作为
 *  即时结果回给 agent（不阻塞循环），剩余部分在后台排空（fire-and-forget），
 *  generator 结束（后台任务完成）时释放互斥锁。
 *
 *  生命周期契约（与 runAgent 约定）：
 *  - isSync:false 工具的 execute 必须返回 AsyncGenerator；
 *  - 首个 yield = 即时返回给模型的句柄/确认（如 task_id）；
 *  - generator 随后挂起 = 后台任务存活；generator 完成/抛错 = 后台结束 → 释放锁。
 *
 *  鲁棒性：后台排空异常仅告警，不击垮主循环；锁在 finally 中必定释放。
 */
import { acquireLock, releaseLock } from "@/tool/lockManager.ts";

/** 把单个 yield 值归一化为字符串（兼容 string 与 {content} 载荷） */
function normalizeYield(v: any): string {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && 'content' in v) return String((v as any).content ?? '');
    return String(v ?? '');
}

/**
 * 启动一个 isSync:false 后台工具：
 * 1. 抢锁（失败则不启动，直接返回锁阻塞信息）；
 * 2. 取首个 yield 作为即时结果；
 * 3. 后台排空剩余 generator，完成时释放锁。
 *
 * @param gen 工具 execute 返回的 AsyncGenerator
 * @param lockKey 互斥锁 key（null 表示无锁）
 * @param toolName 工具名（日志用）
 * @returns 即时结果字符串（回给模型上下文，不等待后台完成）
 */
export async function runBackgroundTool(
    gen: AsyncGenerator<any>,
    lockKey: string | null,
    toolName: string,
): Promise<string> {
    // 1. 抢锁（极小概率：early-check 后被并发抢占，则不启动后台）
    if (lockKey && !acquireLock(lockKey)) {
        // generator 未被消费，主动关闭避免资源泄漏
        try { await gen.return(undefined as any); } catch { /* ignore */ }
        return `🔒 [互斥锁阻塞]：锁 [${lockKey}] 已被占用，[${toolName}] 未启动。`;
    }

    // 2. 取首个 yield 作为即时结果
    let first;
    try {
        first = await gen.next();
    } catch (e: any) {
        if (lockKey) releaseLock(lockKey);
        return `❌ [后台启动失败]：${e?.message ?? e}`;
    }

    const immediate = first.done
        ? "(后台任务未产出即时结果，已直接结束)"
        : normalizeYield(first.value);

    // 若 generator 已立即结束（无后台部分），直接释放锁
    if (first.done) {
        if (lockKey) releaseLock(lockKey);
        return immediate;
    }

    // 3. 后台排空剩余 generator（fire-and-forget），完成/异常时释放锁
    void (async () => {
        try {
            while (true) {
                const r = await gen.next();
                if (r.done) break;
                // 后续 yield 不进入模型上下文（仅作为后台存活期间的产出，如流式日志）
            }
            console.log(`🔓 [后台任务 ${toolName}] 正常结束，锁 ${lockKey ?? '(无)'} 已释放`);
        } catch (e: any) {
            console.warn(`⚠️ [后台任务 ${toolName}] 异常退出（锁已释放）: ${e?.message ?? e}`);
        } finally {
            try { await gen.return(undefined as any); } catch { /* ignore */ }
            if (lockKey) releaseLock(lockKey);
        }
    })();

    return immediate;
}
