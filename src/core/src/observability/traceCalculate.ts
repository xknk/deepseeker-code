/**
 * @file observability/traceCalculate.ts
 * @description Trace 运维的纯计算辅助：getDirBytes（目录总字节，仅冷启动 / 清理后调用）、
 *  getTodayDateString（当天日期串，用于 trace 文件名的日期前缀）。
 */
import fs from "fs/promises";
import path from "path";

/**
 * @description: 单次统计某个目录下所有文件的总字节数
 * 仅在「冷启动初始化」与「清理后重算」时调用，热路径永不触发
 */
export const getDirBytes = async (dir: string): Promise<number> => {
    try {
        const files = await fs.readdir(dir);
        let total = 0;
        for (const file of files) {
            total += (await fs.stat(path.join(dir, file))).size;
        }
        return total;
    } catch {
        return 0; // 容错：文件夹尚未建立，水位算 0
    }
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
