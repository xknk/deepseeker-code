/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-12 09:16:30
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-18 11:15:31
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\session\store.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file session/store.ts
 * @description 会话级持久化存储：以主会话 ID 归档，落盘为 JSON 文件。
 *  提供 readStore / writeStore（整库读写）、getOrCreateSessionId（会话身份）、
 *  getRollingState / setRollingState（滚动摘要与压缩失败熔断计数，供上下文压缩断路器使用）。
 *  路径分拣见 getStorePath：主 / 子 / 摘要数据统一收拢到主会话文件夹下。
 */
import { appConfig } from "@/config/index.ts";
import fs from "fs/promises";
import path from "path";
import { createUUID, getFileName, assertSafeSessionId } from "@/common/index.ts"
import type { Todo } from "@/observability/type.ts";

/** 获取全局 sessions 文件夹的绝对/相对路径 */
export const getSessionsDirPath = (mainSessionId: string): string => {
    assertSafeSessionId(mainSessionId); // ★ 路径穿越硬守：拒绝含 '..'/'/' 等的非法 sessionId
    const fileName = getFileName(mainSessionId)
    return path.join(appConfig.dataDir, 'sessions', appConfig.userWorkspaceDir, fileName);
}


/** 获取单个 JSON 文件的完整路径：[数据目录]/sessions/[sessionId].json */
/**
 * @description: 动态路径分拣器：将主、子、摘要数据统一收拢在以主会话 ID 命名的专属文件夹下
 */
export const getStorePath = (sessionId: string): string => {
    assertSafeSessionId(sessionId); // ★ 文件名 `${sessionId}.json` 直接插值，单独硬守防穿越
    // 3. 终极物理落盘对齐：所有文件，无论主、子、摘要，统统关进主 ID 文件夹这个“大庙”里
    return path.join(
        getSessionsDirPath(sessionId),
        `${sessionId}.json`       // 👈 核心：在这个文件夹下长出不同的 json 文件
    );
}

/** 确保 sessions 文件夹存在（在数据目录下创建） */
export const ensureSessionsDir = async (sessionId: string): Promise<void> => {
    // 💡 修复：确保是在 appConfig.dataDir 下创建 sessions 文件夹
    await fs.mkdir(getSessionsDirPath(sessionId), { recursive: true });
}

/** 写入整个会话存储（JSON pretty）。写入前确保目录存在。 */
export const writeStore = async (sessionId: string, store: any) => {
    // 1. 先确保存放文件的文件夹已经存在
    await ensureSessionsDir(sessionId);
    // 2. 安全地写入文件
    await fs.writeFile(getStorePath(sessionId), JSON.stringify(store, null, 2), "utf-8");
}

/** 读取或创建会话身份：若 sessionId 已有记录则复用，否则新建并落盘一个带元信息的空条目。 */
export const getOrCreateSessionId = async (sessionId: string | undefined): Promise<string> => {
    let entry = sessionId ? await readStore(sessionId) : null
    if (!entry) {
        entry = {
            sessionId: createUUID(), // 身份id
            updatedAt: new Date().toISOString(), // 更新时间
            createAt: new Date().toISOString(), // 创建时间
            archivedMessageCount: 0, // 总条数消息
            rollingSummary: "", // 滚动总结摘要
            consecutiveFailures: 0, // 失败消息
        }
    }
    return entry.sessionId
}

/** 从硬盘读取整个会话数据库 */
export const readStore = async (sessionId: string): Promise<any> => {
    await ensureSessionsDir(sessionId);
    const p = getStorePath(sessionId);
    try {
        const raw = (await fs.readFile(p, "utf-8")).trim();
        if (raw.length === 0) {
            return {};
        }
        const store = JSON.parse(raw) as any;
        return typeof store === "object" && store !== null ? store : {};
    } catch (err: unknown) {
        // 如果文件不存在 (ENOENT)，返回空对象
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
        // 空文件、写入中断、截断等导致 JSON 不完整：当作空库，避免整站聊天不可用
        if (err instanceof SyntaxError) {
            console.warn(`[session/store] sessions.json 无效或已截断，已忽略: ${p}`, err.message);
            return {};
        }
        throw err;
    }
}

type RollingState = {
    rollingSummary: string,
    archivedMessageCount: number,
    consecutiveFailures: number,
    updatedAt?: string,
}
/** 
 * 获取当前会话的上下文归档状态
 * 返回数据将直接用于 buildMessagesForModel 的断路器判断
 */
export async function getRollingState(
    sessionId: string,
): Promise<RollingState> {
    const store = await readStore(sessionId);
    if (!store) {
        return { rollingSummary: "", archivedMessageCount: 0, consecutiveFailures: 0 };
    }

    return {
        rollingSummary: typeof store.rollingSummary === "string" ? store.rollingSummary : "",
        archivedMessageCount:
            typeof store.archivedMessageCount === "number" && store.archivedMessageCount >= 0
                ? store.archivedMessageCount
                : 0,
        // 读取持久化的连续失败次数，若不存在则默认为 0
        consecutiveFailures:
            typeof (store as any).consecutiveFailures === "number" ? (store as any).consecutiveFailures : 0,
    };
}

/** 
 * 保存归档状态：当上下文合并成功或失败时，由 builder 调用更新 
 */
export async function setRollingState(
    sessionId: string,
    state: RollingState
): Promise<void> {
    const store = await readStore(sessionId);
    if (!store) return;
    store.rollingSummary = state.rollingSummary;
    store.archivedMessageCount = state.archivedMessageCount;
    // 关键：将失败计数同步回存储层
    (store as any).consecutiveFailures = state.consecutiveFailures;

    await writeStore(sessionId, store);
}

/**
 * 读取当前会话的任务清单（由 todo_write 工具维护，供前端/其他逻辑读取）
 */
export async function getTodos(sessionId: string): Promise<Todo[] | undefined> {
    const store = await readStore(sessionId);
    return Array.isArray(store?.todos) ? store.todos : undefined;
}

/**
 * 覆盖写入当前会话的任务清单（整表替换语义，对齐 Claude Code TodoWrite）
 */
export async function setTodos(sessionId: string, todos: Todo[]): Promise<void> {
    const store = await readStore(sessionId);
    store.todos = todos;
    await writeStore(sessionId, store);
}