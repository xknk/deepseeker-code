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

export const createUUID = (): string => {
    return crypto.randomUUID();
}