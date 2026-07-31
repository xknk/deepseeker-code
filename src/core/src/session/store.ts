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
 *  路径分拣见 getStatePath / getTranscriptPath：状态(<id>.state.json)与转录(<id>.jsonl)物理隔离，
 *  统一收拢到主会话文件夹下（主/子/摘要靠文件名内嵌完整 ID 区分）。
 */
import { appConfig } from "@/config/index.ts";
import fs from "fs/promises";
import path from "path";
import { createUUID, getFileName, assertSafeSessionId, isSafeSessionId, readJSONFile } from "@/common/index.ts"
import type { Todo } from "@/observability/type.ts";

/** 获取全局 sessions 文件夹的绝对/相对路径 */
export const getSessionsDirPath = (mainSessionId: string): string => {
    assertSafeSessionId(mainSessionId); // ★ 路径穿越硬守：拒绝含 '..'/'/' 等的非法 sessionId
    const fileName = getFileName(mainSessionId)
    return path.join(appConfig.dataDir, 'sessions', appConfig.userWorkspaceDir, fileName);
}

/**
 * 本工作区 sessions 根目录：所有主会话文件夹的父目录（不含具体会话段）。
 * 供 listSessions 枚举历史会话、--continue 取最近会话用。
 */
export const getWorkspaceSessionsDir = (): string =>
    path.join(appConfig.dataDir, 'sessions', appConfig.userWorkspaceDir);


/**
 * @description 状态文件路径（JSON 对象，整文件覆盖语义）：rolling 摘要 / todos / 会话元信息。
 *  文件名内嵌完整 sessionId，使主会话与其子 agent（getFileName 折叠后共享同一文件夹）互不覆盖。
 *  与 getTranscriptPath 物理隔离——杜绝“JSON 对象覆盖”与“JSONL 追加”抢同一文件而互相破坏。
 */
export const getStatePath = (sessionId: string): string => {
    assertSafeSessionId(sessionId); // ★ 文件名直接插值，单独硬守防穿越
    return path.join(getSessionsDirPath(sessionId), `${sessionId}.state.json`);
}

/**
 * @description 转录文件路径（JSONL 追加日志，append-only）：每条消息一行。
 */
export const getTranscriptPath = (sessionId: string): string => {
    assertSafeSessionId(sessionId);
    return path.join(getSessionsDirPath(sessionId), `${sessionId}.jsonl`);
}

/**
 * @deprecated 历史别名，等价于 getStatePath（状态文件）。新代码请直接用 getStatePath / getTranscriptPath。
 */
export const getStorePath = (sessionId: string): string => getStatePath(sessionId);

/** 确保 sessions 文件夹存在（在数据目录下创建），并顺带做一次性历史文件迁移 */
export const ensureSessionsDir = async (sessionId: string): Promise<void> => {
    // 💡 修复：确保是在 appConfig.dataDir 下创建 sessions 文件夹
    await fs.mkdir(getSessionsDirPath(sessionId), { recursive: true });
    // 一次性迁移：旧版 store/transcript 共用 `${sessionId}.json`（格式互斥会互相破坏），
    // 按“逐行可解析=JSONL 转录 / 整体单对象=状态”判定后分流到 .jsonl / .state.json。失败静默，绝不阻塞会话。
    await migrateLegacyFiles(sessionId).catch(() => { });
}

/**
 * 一次性历史迁移：旧架构把 JSONL 转录与 JSON 状态塞进同一个 `${sessionId}.json`。
 *  - 无旧文件 → 跳过；
 *  - 目标转录文件已存在（已迁移过/并发已处理）→ 跳过；
 *  - 旧文件逐行都能 JSON.parse → 视作转录，rename 为 .jsonl；
 *  - 旧文件整体是单个 JSON 对象 → 视作状态，rename 为 .state.json；
 *  - 都不是 → 原地保留并告警，交由人工判断。
 * 主会话与其子 agent 的旧文件各自独立处理（文件名内嵌完整 ID，共享文件夹不串扰）。
 */
const migrateLegacyFiles = async (sessionId: string): Promise<void> => {
    assertSafeSessionId(sessionId);
    const dir = getSessionsDirPath(sessionId);
    const legacy = path.join(dir, `${sessionId}.json`);
    const transcriptPath = getTranscriptPath(sessionId);
    const statePath = getStatePath(sessionId);

    let legacyText: string;
    try {
        legacyText = await fs.readFile(legacy, "utf-8");
    } catch {
        return; // 无旧文件（ENOENT）或读取异常 → 无需迁移
    }
    // 目标转录文件已存在 → 已迁移过，跳过（并发去重）
    try { await fs.access(transcriptPath); return; } catch { /* 未迁移，继续 */ }

    const raw = legacyText.trim();
    if (raw.length === 0) {
        await fs.rename(legacy, transcriptPath); // 空旧文件：当作空转录归位
        return;
    }
    // 判定一：逐行均可解析 → JSONL 转录（迁移后 appendMessage 继续追加）
    const lines = raw.split("\n");
    const isJsonl = lines.every((s) => { try { JSON.parse(s); return true; } catch { return false; } });
    if (isJsonl) {
        await fs.rename(legacy, transcriptPath);
        return;
    }
    // 判定二：整体是单个 JSON 对象 → 状态快照
    try {
        const v = JSON.parse(raw);
        if (typeof v === "object" && v !== null) {
            await fs.rename(legacy, statePath);
            return;
        }
    } catch { /* 非 JSON，落入下方告警 */ }
    console.warn(`[session/store] 旧文件既非 JSONL 也非单对象，保留原样待人工确认: ${legacy}`);
}

/** 写入整个会话存储（JSON pretty）。写入前确保目录存在。 */
export const writeStore = async (sessionId: string, store: any) => {
    // 1. 先确保存放文件的文件夹已经存在
    await ensureSessionsDir(sessionId);
    // 2. ★ 原子写：先落 .tmp 再 rename，避免写中途崩溃留下截断的 state.json
    //    （readStore 会把截断文件当空 {} → archivedMessageCount 归零 → 已归档旧消息重入上下文，破坏压缩语义）。
    const finalPath = getStatePath(sessionId);
    const tmpPath = `${finalPath}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tmpPath, finalPath);
}

/** 读取或创建会话身份：若 sessionId 已有记录则复用，否则新建并落盘一个带元信息的空条目。 */
export const getOrCreateSessionId = async (sessionId: string | undefined): Promise<string> => {
    // readStore 对缺失/损坏文件返回 {}（truthy 但无 sessionId）→ 用 sessionId 字段判定是否已持久化，避免旧实现返回 undefined。
    const existing = sessionId ? await readStore(sessionId) : null;
    const isPersisted = !!(existing && typeof (existing as any).sessionId === "string");
    const entry = isPersisted
        ? existing
        : {
            sessionId: createUUID(), // 身份id
            updatedAt: new Date().toISOString(), // 更新时间
            createAt: new Date().toISOString(), // 创建时间
            archivedMessageCount: 0, // 总条数消息
            rollingSummary: "", // 滚动总结摘要
            consecutiveFailures: 0, // 失败消息
        };
    // ★ 兑现"创建即落盘"契约：新建身份时持久化带元信息的空条目（旧实现遗漏，导致 createAt 等元信息丢失）。
    if (!isPersisted) {
        await writeStore((entry as any).sessionId, entry);
    }
    return (entry as any).sessionId;
}

/** 从硬盘读取整个会话数据库 */
export const readStore = async (sessionId: string): Promise<any> => {
    await ensureSessionsDir(sessionId);
    const p = getStatePath(sessionId);
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
            console.warn(`[session/store] state.json 无效或已截断，已忽略: ${p}`, err.message);
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

// ============ 历史会话枚举（/sessions 选择器 + --continue） ============

/** 历史会话摘要（供 UI 选择器展示）。 */
export type SessionSummary = {
    sessionId: string;
    createAt?: string;
    updatedAt?: string;
    messageCount: number;
    /** 首条 user 消息预览（已折叠空白、截断）。 */
    preview: string;
};

/**
 * 枚举本工作区的全部主会话：sessions 根目录下每个子文件夹 = 一个主会话
 * （文件夹名即主 sessionId；子 agent 经 getFileName 折叠进同一文件夹，不会单独成项）。
 * 单个会话解析失败静默跳过，绝不抛错。按 updatedAt（回退目录 mtime）降序返回（最新在前）。
 */
export const listSessions = async (): Promise<SessionSummary[]> => {
    const root = getWorkspaceSessionsDir();
    let entries: any[];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return []; // 目录不存在（从未建过会话）→ 空
    }
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        // 纵深防御：跳过非法文件夹名（合法 sessionId 仅 [A-Za-z0-9_-]）
        if (!isSafeSessionId(sessionId)) continue;
        const dirPath = path.join(root, sessionId);

        // 元信息来自 <id>.state.json（缺失/损坏 → undefined，不阻断）
        const state: any = await readJSONFile<any>(getStatePath(sessionId));

        // 消息数与首条 user 预览来自 <id>.jsonl
        let messageCount = 0;
        let preview = "";
        try {
            const raw = await fs.readFile(getTranscriptPath(sessionId), "utf-8");
            for (const s of raw.split("\n")) {
                const line = s.trim();
                if (!line) continue;
                let msg: any;
                try { msg = JSON.parse(line); } catch { continue; } // 跳过损坏行
                messageCount++;
                if (!preview && msg?.role === "user" && typeof msg.content === "string") {
                    preview = msg.content.replace(/\s+/g, " ").trim();
                }
            }
        } catch { /* 无 jsonl（空会话）→ 0 条 */ }

        // updatedAt：优先 state.updatedAt，回退目录 mtime
        let updatedAt: string | undefined = state?.updatedAt;
        if (!updatedAt) {
            try { updatedAt = (await fs.stat(dirPath)).mtime.toISOString(); } catch { /* 忽略 */ }
        }
        summaries.push({
            sessionId,
            createAt: state?.createAt,
            updatedAt,
            messageCount,
            preview: preview.slice(0, 80),
        });
    }
    // 按 updatedAt 降序（最新在前）；无时间者沉底
    summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return summaries;
};

/**
 * 取本工作区最近一次会话的 sessionId（--continue 用）。
 * 即 listSessions 的首条（已按 updatedAt 降序）；无历史则 null。
 */
export const getMostRecentSessionId = async (): Promise<string | null> => {
    const list = await listSessions();
    return list.length > 0 ? list[0].sessionId : null;
};