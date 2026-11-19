import fs from "fs/promises";

/**
 * rename 瞬时锁重试（tmp+rename 原子写盘的 Windows 自愈层）。
 *
 * 为什么存在：Windows 上 Defender 实时扫描 / 搜索索引器会对「刚写完的 tmp」短暂持锁，
 * 裸 fs.rename 偶发 EPERM。2026-11-19 CI 连挂两轮实锤：msg-map 登记撞 EPERM → 留痕降级
 * → 回执 id 永久缺席映射表 → 「反馈闭环全链」测试 until 空转到 60s 预算假超时；
 * 同一 commit 六天前 CI 绿 = runner 镜像漂移放大了旧脆弱点（代码零变化、失败率突变）。
 * 同日 attempt 2 里 da-sessions 同款 EPERM 被留痕降级吞掉未挂测试——证明重试即可自愈。
 *
 * 语义：只重试瞬时锁类错误码（EPERM/EACCES/EBUSY），退避 25ms 起指数递增、800ms 封顶
 *（默认 8 次，名义预算 ≤2.4s；全量并行饱和负载下 CPU 饥饿会拉长定时器、实际预算更大——
 * 2026-11-19 本机全量复现实锤 5 次/375ms 不够：Defender 在饱和负载下锁文件可超秒级）。
 * 映射登记本就不阻塞主流程，慢几秒无妨；结构性错误（ENOENT 等）立即抛出不拖延。
 * 调用方的 catch/留痕语义不变——重试只是把「偶发失败」修成「偶发多等几秒」。
 */

const TRANSIENT_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface RenameRetryOpts {
    tries?: number;                                        // 总尝试次数（含首次），默认 8
    sleep?: (ms: number) => Promise<void>;                 // 测试注入免真等
    rename?: (from: string, to: string) => Promise<void>;  // 测试注入假 fs
}

export const renameWithRetry = async (
    from: string,
    to: string,
    opts: RenameRetryOpts = {},
): Promise<void> => {
    const tries = opts.tries ?? 8;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
    const rename = opts.rename ?? fs.rename.bind(fs);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (e) {
            const code = (e as NodeJS.ErrnoException | null)?.code;
            if (!code || !TRANSIENT_LOCK_CODES.has(code)) throw e;
            lastErr = e;
            if (attempt < tries) await sleep(Math.min(25 * 2 ** (attempt - 1), 800)); // 25/50/100/200/400/800/800ms
        }
    }
    throw lastErr;
};
