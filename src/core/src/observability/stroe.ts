import { appConfig } from "@/config/index.ts";
import path from "path";
import fs from "fs/promises";
import { getTodayDateString } from "./traceCalculate.ts";
import { getFileName } from "@/common/index.ts"

/**
 * @description: 获取绝对路径-用于存储
 * @param {string} mainTraceId
 * @return {*}
 */
export const getTraceDirPath = (mainTraceId: string): string => {
    return path.join(appConfig.dataDir, 'trace', appConfig.userWorkspaceDir, getFileName(mainTraceId));
}
/**
 * @description: 获取最外层路径-用于清理冗余文件
 * @param {*} string
 * @return {*}
 */
export const getTracePath = (): string => {
    return path.join(appConfig.dataDir, 'trace');
}

/** 确保 Trace 文件夹存在（在数据目录下创建） */
export const ensureTraceDir = async (mainTraceId: string): Promise<void> => {
    // 💡 修复：确保是在 appConfig.dataDir 下创建 Trace 文件夹
    await fs.mkdir(getTraceDirPath(mainTraceId), { recursive: true });
}

/** 
 * @description: 【全局物理冷时钟路径】：完全与业务会话隔离，存放在全局 trace 根目录下
 * 100% 保护主摘要文件的 updatedAt 不受任何多余污染
 */
export const getGlobalClockPath = (): string => {
    return path.join(getTracePath(), 'trace-cleanup-clock.json');
};

export const getTraceStorePath = async (mainTraceId: string): Promise<string> => {
    // 💡 修复级联截断 Bug：只切断最后一段 __sub__，保留完整上级链路前缀，防止多子 Agent 并发写入冲突
    const rootId = getFileName(mainTraceId);

    // 确保大外层的 trace 专属物理根目录存在
    await ensureTraceDir(rootId);

    // 锁定当前工作区下的具体 trace 物理目录
    const dir = getTraceDirPath(rootId);

    // 读取当前文件夹下已有的日志文件
    const files = await fs.readdir(dir);
    // 寻找在本地磁盘中，是不是已经存在以这个 mainmainTraceId 结尾的日志文件了
    const existedFile = files.find(f => f.endsWith(`__${rootId}.jsonl`));

    let fileName = "";
    if (existedFile) {
        // A. 已经存在：直接继承该物理文件句柄！不管今天是不是跨天了，都在这里流式追加，【100%解决断流】 [INDEX]
        fileName = existedFile;
    } else {
        // B. 全新任务开局：捕获今天的日期，和主 mainTraceId 焊死，作为它永恒的“初生时间烙印” [INDEX]
        const todayStr = getTodayDateString();
        fileName = `trace-${todayStr}__${rootId}.jsonl`;
    }

    return path.join(dir, fileName);
}

