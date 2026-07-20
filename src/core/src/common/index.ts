/**
 * @file common/index.ts
 * @description 通用工具：会话 ID 到存储文件夹名的映射（getFileName）、UUID 生成（createUUID）。
 */
/**
 * 将（含后缀的）会话 ID 映射到它所属的主会话文件夹名：
 * - 子 agent ID（含 __sub__）→ 取其父主 ID；
 * - 摘要 ID（后缀 __rollingSummary）→ 剥离后缀取主 ID；
 * - 主 ID → 原样返回。
 * 文件夹归并到主会话下，而文件名本身保留各自完整 ID。
 */
export const getFileName = (mainSessionId: string) => {
    let fileName = mainSessionId;
    // 1. 特征判定一：如果是子 Agent 的会话 ID
    if (mainSessionId.includes('__sub__')) {
        // 强行溯源捞出它亲爹（主 Agent）的 ID 作为文件夹名字
        // 文件名保持为各自独立的子 agent 名字（例如 session123__sub__uuid456.json）
        fileName = mainSessionId.split('__sub__')[0];
    }
    // 2. 特征判定二：如果是你故意传入的摘要专属标识
    else if (mainSessionId.endsWith('__rollingSummary')) {
        // 剥离出主 ID 寻找文件夹
        // 文件名固定为统一的滚动摘要文件（例如 session123_rollingSummary.json）
        fileName = mainSessionId.replace('__rollingSummary', '');
    }
    return fileName
}

/** 生成 RFC4122 UUID（基于 Node crypto.randomUUID）。 */
export const createUUID = (): string => {
    return crypto.randomUUID();
}