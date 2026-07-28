/**
 * @file observability/traceCalculate.ts
 * @description Trace 运维的纯计算辅助：getDirBytes（目录总字节，仅冷启动 / 清理后调用）、
 *  getTodayDateString（当天日期串，用于 trace 文件名的日期前缀）。
 */
import fs from "fs/promises";
import path from "path";

/**
 * @description: 递归统计某个目录下【所有层级】文件的总字节数
 * 仅在「冷启动初始化」与「清理后重算」时调用，热路径永不触发。
 * ★ 修复：旧版非递归只统计直接子条目（目录 stat≈0），导致 50MB 容量大闸长期失效。
 *   现与清理函数（readdir recursive）同口径，正确反映真实占用。
 */
export const getDirBytes = async (dir: string): Promise<number> => {
    let total = 0;
    const stack: string[] = [dir];
    while (stack.length) {
        const cur = stack.pop() as string;
        let entries;
        try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; } // 目录不存在/无权限 → 跳过
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) {
                stack.push(p);
            } else {
                try { total += (await fs.stat(p)).size; } catch { /* 单文件失败跳过，不影响整体统计 */ }
            }
        }
    }
    return total;
};
/**
 * @description: 辅助函数：获取最工整的当天日期字符串（形如 2026-06-17）
 */
export const getTodayDateString = (): string => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
