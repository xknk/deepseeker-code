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
import { appConfig } from "@/config/index.ts";

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
 * 3. 后台排空剩余 generator，abort/完成/异常时释放锁。
 *
 * @param gen 工具 execute 返回的 AsyncGenerator
 * @param lockKey 互斥锁 key（null 表示无锁）
 * @param toolName 工具名（日志用）
 * @param signal  中止信号：abort 时立即收尾 generator 并释放锁，避免后台任务脱离中止控制继续占用资源/锁
 * @returns 即时结果字符串（回给模型上下文，不等待后台完成）
 */
export async function runBackgroundTool(
    gen: AsyncGenerator<any>,
    lockKey: string | null,
    toolName: string,
    signal?: AbortSignal,
): Promise<string> {
    let aborted = false;
    let lockReleased = false;
    // 先声明引用槽再赋值，避免 const 互引的 TDZ（finalize ↔ onAbort/bgTimer 互相引用）
    let onAbort: () => void = () => { };
    let bgTimer: ReturnType<typeof setTimeout> | undefined;   // 兜底超时句柄（finalize 内清理）
    const releaseLockOnce = () => { if (!lockReleased && lockKey) { releaseLock(lockKey); lockReleased = true; } };

    // 收尾：解绑 abort 监听 + 清兜底定时器 + 关闭 generator + 释放锁（幂等，abort/超时/正常结束/异常均可安全调用）
    const finalize = async () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (bgTimer) clearTimeout(bgTimer);   // ★ 兜底超时：正常结束/abort/异常均清掉，避免误触
        try { await gen.return(undefined as any); } catch { /* 并发消费/已结束均忽略 */ }
        releaseLockOnce();
    };
    onAbort = () => { aborted = true; void finalize(); };

    // 1. 抢锁（极小概率：early-check 后被并发抢占，则不启动后台）
    if (lockKey && !acquireLock(lockKey)) {
        // generator 未被消费，主动关闭避免资源泄漏
        try { await gen.return(undefined as any); } catch { /* ignore */ }
        return `🔒 [互斥锁阻塞]：锁 [${lockKey}] 已被占用，[${toolName}] 未启动。`;
    }

    // ★ abort 已发生：直接收尾，不启动后台（避免脱离中止控制的任务继续占用资源/锁）
    if (signal?.aborted) {
        await finalize();
        return `❌ [已中止]：[${toolName}] 后台任务未启动（用户已中断）。`;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    // 2. 取首个 yield 作为即时结果
    let first;
    try {
        first = await gen.next();
    } catch (e: any) {
        await finalize();
        return `❌ [后台启动失败]：${e?.message ?? e}`;
    }

    const immediate = first.done
        ? "(后台任务未产出即时结果，已直接结束)"
        : normalizeYield(first.value);

    // 若 generator 已立即结束（无后台部分），直接收尾
    if (first.done) {
        await finalize();
        return immediate;
    }

    // ★ 兜底超时：generator 卡死且无人 abort 时，强制 finalize 释放锁，防同 key 后台任务永久阻塞。
    //   abort 仍是主取消通道，此定时器仅作最后防线；默认 30min（appConfig.MAX_BACKGROUND_TOOL_MS）远超合理后台任务时长。
    bgTimer = setTimeout(() => {
        console.warn(`⏰ [后台任务 ${toolName}] 超过兜底上限 ${appConfig.MAX_BACKGROUND_TOOL_MS}ms 未结束，强制释放锁 ${lockKey ?? "(无)"}`);
        aborted = true;
        void finalize();
    }, appConfig.MAX_BACKGROUND_TOOL_MS);

    // 3. 后台排空剩余 generator（fire-and-forget），abort/超时/完成/异常时均经 finalize 释放锁
    void (async () => {
        try {
            while (!aborted) {
                const r = await gen.next();
                if (r.done) break;
                // 后续 yield 不进入模型上下文（仅作为后台存活期间的产出，如流式日志）
            }
            console.log(`🔓 [后台任务 ${toolName}] ${aborted ? "已中止" : "正常结束"}，锁 ${lockKey ?? "(无)"} 已释放`);
        } catch (e: any) {
            console.warn(`⚠️ [后台任务 ${toolName}] 异常退出（锁已释放）: ${e?.message ?? e}`);
        } finally {
            await finalize();
        }
    })();

    return immediate;
}
