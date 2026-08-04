/**
 * @file common/index.ts
 * @description 通用工具：会话 ID 到存储文件夹名的映射（getFileName）、UUID 生成（createUUID）。
 */
import { randomUUID } from "node:crypto";
import fs from "fs/promises";
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
    return randomUUID();
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

// ============ 通用 JSON 读写 + Locale 类型 ============
/** 界面/AI 回复语言（中英文切换，cli/core 共享单一真相）。 */
export type Locale = "zh" | "en";

/**
 * 读取 JSON 文件并解析；文件不存在 / 损坏 / 解析失败一律静默返回 fallback（缺省 null），绝不抛错阻断启动。
 * 容错范式提炼自 hooks/loader.ts 与 tool/permissions.ts 的 readFile→JSON.parse 骨架。
 */
export const readJSONFile = async <T>(file: string, fallback: T | null = null): Promise<T | null> => {
    try {
        const raw = await fs.readFile(file, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
};

/**
 * 原子写 JSON（tmp + rename，防写中途崩溃留截断文件）。惯法提炼自 session/store.ts:115-120，
 * 供 prefs/trust 等用户配置持久化复用。调用方负责确保目标目录已存在（mkdir 兜底）。
 */
export const atomicWriteJSON = async (file: string, value: unknown): Promise<void> => {
    const tmpPath = `${file}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf-8");
        await fs.rename(tmpPath, file);
    } catch (e) {
        try { await fs.unlink(tmpPath); } catch { /* tmp 已不在，忽略 */ }
        throw e;
    }
};

// ============ 并发信号量（workflow 并行编排共用）============
/**
 * 轻量异步信号量（计数信号量）：限制同时进行的异步任务数量。
 *  - acquire()：拿到一个槽位（立即或排队等待）；返回 Promise，resolve 后即持有许可。
 *  - release()：释放槽位；若有等待者则直接【移交】（active 不变），否则 active-1。
 *  纯内存、单进程；用 max=1 即退化成互斥锁（串行化临界区，如 workflow 并行子 agent 的审批通道）。
 *  实现无 await 竞态：槽位移交在 release 内同步完成，active 始终精确反映在飞任务数。
 * @param max 最大并发数（<1 视为 1）
 */
export const createSemaphore = (max: number) => {
    if (max < 1) max = 1;
    let active = 0;
    const queue: Array<() => void> = [];
    const acquire = (): Promise<void> => {
        if (active < max) { active++; return Promise.resolve(); }
        return new Promise<void>(resolve => queue.push(resolve));
    };
    const release = (): void => {
        const next = queue.shift();
        if (next) { next(); return; }   // 移交槽位（active 不变）
        active = Math.max(0, active - 1);
    };
    return { acquire, release };
};

// ============ 系统提示词幂等注入（skills/agents/projectGuide 共用）============
/**
 * 向 message[0].content 幂等追加一个带 fence 锚点的块：
 *  - 只追加到 system 消息，绝不新增数组元素、绝不改下标 0/1
 *    （ensureSummarySlot / ensureFitsWindow 强依赖 [0]=system [1]=summary 槽）；
 *  - 用 fence（罕用定长串）作切除锚点：重复注入时先按 fence 切除旧块再重接（支持清单热更新）。
 *    fence 用罕用串而非人可读标题，避免标题被内容复述导致 split 误切其后全部注入。
 * @param message 上下文数组（原地修改 message[0].content）
 * @param fence   切除/重接锚点（罕用串，由调用方定义）
 * @param body    要注入的块正文（含人可读标题 + 清单）
 */
export const injectMarkedBlock = (message: any[], fence: string, body: string): void => {
    const sys = message[0];
    if (!sys || sys.role !== 'system' || typeof sys.content !== 'string') return;
    if (sys.content.includes(fence)) {
        sys.content = sys.content.split(fence)[0].trimEnd();
    }
    sys.content += `\n\n${fence}\n${body}`;
};