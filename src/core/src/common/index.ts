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

// ============ 会话 ID 安全校验（防路径穿越）============
/**
 * 合法 sessionId 字符白名单：仅允许字母、数字、下划线、连字符。
 *  - UUID（hex + '-'）✅、`${parent}__sub__${uuid}` ✅、`${id}__rollingSummary` ✅ 均通过；
 *  - 拒绝 '.', '/', '\\', ':', 空格, '%' 等所有路径元字符（拒掉 '.' 即杀掉 '..'）。
 */
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 布尔判定（HTTP 边界用，不抛错）：返回 true 表示可安全用作文件系统路径段。
 * 非字符串 / 空 / 超 200 字符 / 含非法字符 → false。
 */
export const isSafeSessionId = (id: unknown): id is string =>
    typeof id === "string" && id.length > 0 && id.length <= 200 && SAFE_SESSION_ID_RE.test(id);

/**
 * 存储层硬守（纵深防御，违例抛错）：在任何把 sessionId 转成磁盘路径段的函数首行调用。
 * 即便上游漏校验，这里也能兜住内部派生 ID / 未来新调用路径。
 * 注：此处不复用 isSafeSessionId 守卫——对已是 string 的形参取反会把类型收窄成 never，故直接内联判定。
 */
export const assertSafeSessionId = (sessionId: string, label = "sessionId"): void => {
    if (sessionId.length === 0 || sessionId.length > 200 || !SAFE_SESSION_ID_RE.test(sessionId)) {
        throw new Error(`🛑 [SECURITY] 非法 ${label}: ${JSON.stringify(sessionId.slice(0, 48))}（仅允许字母/数字/下划线/连字符）`);
    }
};