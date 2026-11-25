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
import { renameWithRetry } from "@/common/fsRetry.ts";
import { msgText } from "@/session/contentParts.ts";
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

// ★ 热路径 IO 缓存：ensureSessionsDir 在每次 appendMessage/appendEvent/readStore/writeStore 上都被调，
//   原实现每次 mkdir + 旧版迁移 readFile（ENOENT）= 每条落盘/读盘 2 次纯浪费系统调用（Windows+Defender 更疼）。
//   进程内记住"已 ensure"的目录即归零——与 observability/store.ts 的 ensuredTraceDirs 同款修复。
//   deleteSession 删目录时同步失效，防复用陈旧条目。
const ensuredSessionDirs = new Set<string>();

/** 确保 sessions 文件夹存在（在数据目录下创建），并顺带做一次性历史文件迁移 */
export const ensureSessionsDir = async (sessionId: string): Promise<void> => {
    const dir = getSessionsDirPath(sessionId);
    if (ensuredSessionDirs.has(dir)) return; // ★ 命中缓存：目录本进程内已确认存在且迁移已尝试过
    // 💡 修复：确保是在 appConfig.dataDir 下创建 sessions 文件夹
    await fs.mkdir(dir, { recursive: true });
    // 一次性迁移：旧版 store/transcript 共用 `${sessionId}.json`（格式互斥会互相破坏），
    // 按“逐行可解析=JSONL 转录 / 整体单对象=状态”判定后分流到 .jsonl / .state.json。失败静默，绝不阻塞会话。
    await migrateLegacyFiles(sessionId).catch(() => { });
    ensuredSessionDirs.add(dir); // 迁移失败亦标记（原实现本就静默吞掉，不重试）
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
        await renameWithRetry(legacy, transcriptPath); // 空旧文件：当作空转录归位
        return;
    }
    // 判定一：逐行均可解析 → JSONL 转录（迁移后 appendMessage 继续追加）
    const lines = raw.split("\n");
    const isJsonl = lines.every((s) => { try { JSON.parse(s); return true; } catch { return false; } });
    if (isJsonl) {
        await renameWithRetry(legacy, transcriptPath);
        return;
    }
    // 判定二：整体是单个 JSON 对象 → 状态快照
    try {
        const v = JSON.parse(raw);
        if (typeof v === "object" && v !== null) {
            await renameWithRetry(legacy, statePath);
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
    try {
        await renameWithRetry(tmpPath, finalPath);
    } catch (e) {
        // rename 失败（含瞬时锁重试耗尽）：tmp 留在会话目录会永久泄漏——清掉再上抛
        await fs.unlink(tmpPath).catch(() => { /* tmp 已不在，忽略 */ });
        throw e;
    }
}

// ★ 会话级写锁：state.json 的 read-modify-write 在 await 间可能交错（压缩写摘要 vs SessionEnd hook / todo 写 store），
//   后写覆盖先写会导致滚动摘要 / todo 静默丢失。per-session 互斥锁串行化写操作（读不锁，读到稍旧值可接受）。
const storeLocks = new Map<string, Promise<unknown>>();
const withStoreLock = <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = storeLocks.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn, fn); // 无论前一个 resolve/reject 都继续，防排队链被打断
    storeLocks.set(sessionId, run.then(() => { }, () => { })); // 链尾兜底 catch，隔离失败不阻塞后续
    return run;
};

/** 读取或创建会话身份：若 sessionId 已有记录则复用，否则新建并落盘一个带元信息的空条目。 */
export const getOrCreateSessionId = async (sessionId: string | undefined): Promise<string> => {
    return withStoreLock(sessionId ?? "<anon>", async () => {
        // readStore 对缺失/损坏文件返回 {}（truthy 但无 sessionId）→ 用 sessionId 字段判定是否已持久化，避免旧实现返回 undefined。
        const existing = sessionId ? await readStore(sessionId) : null;
        const isPersisted = !!(existing && typeof (existing as any).sessionId === "string");
        const entry = isPersisted
            ? existing
            : {
                // ★ 优先用传入的 sessionId（createServer 已生成的 uuid），仅无传入时才新建——
                //   保证 createServer 生成的 sessionId 与落盘身份一致，兑现"创建即落盘"契约。
                sessionId: sessionId || createUUID(),
                updatedAt: new Date().toISOString(), // 更新时间
                createAt: new Date().toISOString(), // 创建时间
                archivedMessageCount: 0, // 总条数消息
                rollingSummary: "", // 滚动总结摘要
                consecutiveFailures: 0, // 失败消息
                // ★ 项目根盖章（2026-10-21）：记录会话归属项目，会话按项目分桶外的兜底元信息——
                //   多根工作区切根修复后分桶键即跟随项目，此章供诊断/未来跨桶工具用（旧会话无此字段）。
                projectRoot: process.cwd(),
            };
        // ★ 兑现"创建即落盘"契约：新建身份时持久化带元信息的空条目（旧实现遗漏，导致 createAt 等元信息丢失）。
        if (!isPersisted) {
            await writeStore((entry as any).sessionId, entry);
        }
        return (entry as any).sessionId;
    });
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
    /** ★ 估算校准系数（真实 prompt_tokens / 本地估算 的 EMA）：跨 run 持久化，让后续 run 复用前一 run 攒的
     *  真实校准，避免 calibRatio 每 run 重置回 1.4（致实现 run 对压缩时机判断从零开始、更晚压缩）。 */
    calibRatio?: number,
    /** 上一轮 API 真实 prompt_tokens（缓存感知压缩阈值用，跨 run 持久化）。 */
    lastRealPromptTokens?: number,
    /** 上一轮前缀缓存命中 token 数（与 lastRealPromptTokens 配对算命中率）。 */
    lastCachedTokens?: number,
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
        // ★ 跨 run 持久化的压缩校准状态（缺省 undefined，调用方按 ?? 回落默认）。
        //  P1-4 起这是「扁平镜像视图」：压缩主链路（runAgent/compactSessionNow）须走 getCalibration(sessionId, modelId)
        //  按 per-model 分键读——切模型后各模型校准互不污染，扁平字段只是最近写入模型的镜像。
        calibRatio: typeof store.calibRatio === "number" ? store.calibRatio : undefined,
        lastRealPromptTokens: typeof store.lastRealPromptTokens === "number" ? store.lastRealPromptTokens : undefined,
        lastCachedTokens: typeof store.lastCachedTokens === "number" ? store.lastCachedTokens : undefined,
    };
}

/** 
 * 保存归档状态：当上下文合并成功或失败时，由 builder 调用更新 
 */
export async function setRollingState(
    sessionId: string,
    state: RollingState
): Promise<void> {
    return withStoreLock(sessionId, async () => {
        const store = await readStore(sessionId);
        if (!store) return;
        store.rollingSummary = state.rollingSummary;
        store.archivedMessageCount = state.archivedMessageCount;
        // 关键：将失败计数同步回存储层
        (store as any).consecutiveFailures = state.consecutiveFailures;

        await writeStore(sessionId, store);
    });
}

/** 单模型维度的压缩校准快照（P1-4）：字段语义与 RollingState 扁平三字段一致。 */
type CalibrationEntry = {
    calibRatio?: number,
    lastRealPromptTokens?: number,
    lastCachedTokens?: number,
}

/**
 * ★ P1-4 按模型维度取校准状态：store.calibByModel[modelId] 命中优先（新分键数据），
 *  未命中回退旧扁平字段（P1-4 之前会话的盘上形状 / fork 派生直写）——同一会话切模型后
 *  各模型的校准互不污染（32K 小窗与 250K 工作窗的 EMA 口径不可共用）。
 *  纯函数：只读入参 store，不碰 IO / 锁。modelId 缺省视为直接要扁平视图。
 */
export const calibrationEntryFor = (store: any, modelId?: string): CalibrationEntry => {
    if (modelId) {
        const byModel = store?.calibByModel;
        const hit = byModel && typeof byModel === "object" ? byModel[modelId] : undefined;
        if (hit && typeof hit === "object") {
            return {
                calibRatio: typeof hit.calibRatio === "number" ? hit.calibRatio : undefined,
                lastRealPromptTokens: typeof hit.lastRealPromptTokens === "number" ? hit.lastRealPromptTokens : undefined,
                lastCachedTokens: typeof hit.lastCachedTokens === "number" ? hit.lastCachedTokens : undefined,
            };
        }
    }
    return {
        calibRatio: typeof store?.calibRatio === "number" ? store.calibRatio : undefined,
        lastRealPromptTokens: typeof store?.lastRealPromptTokens === "number" ? store.lastRealPromptTokens : undefined,
        lastCachedTokens: typeof store?.lastCachedTokens === "number" ? store.lastCachedTokens : undefined,
    };
};

/**
 * 读取 sessionId × modelId 的压缩校准状态（P1-4 主消费入口：runAgent 启动 / compactSessionNow）。
 * 分键规则见 calibrationEntryFor：per-model 命中优先，旧扁平字段兜底。
 */
export const getCalibration = async (sessionId: string, modelId?: string): Promise<CalibrationEntry> => {
    const store = await readStore(sessionId);
    return calibrationEntryFor(store, modelId);
};

/**
 * ★ 原子更新跨 run 压缩校准状态（calibRatio / lastRealPromptTokens / lastCachedTokens），不动 rollingSummary 等。
 *  runAgent 在 finally 末尾调用，让下一 run（续接/实现阶段）复用本 run 攒的真实校准与缓存命中率，
 *  避免 calibRatio 每 run 重置回 1.4。走 withStoreLock 与 setRollingState 串行，互不覆盖。
 *  仅写入传入的数值字段，undefined 跳过（保留 store 原值）。
 *  ★ P1-4 按 modelId 分键写入 store.calibByModel；同时把该模型的最终值镜像回写旧扁平字段
 *  （fork 派生 / 旧读侧直读 store.calibRatio 的语义不因分键而读空——扁平字段=「最近写入模型」的镜像）。
 */
export const updateCalibration = async (
    sessionId: string,
    modelId: string,
    calib: { calibRatio?: number; lastRealPromptTokens?: number; lastCachedTokens?: number },
): Promise<void> => {
    return withStoreLock(sessionId, async () => {
        const store = await readStore(sessionId);
        if (!store) return;
        const id = modelId?.trim() || "default";
        const byModel = store.calibByModel && typeof store.calibByModel === "object"
            ? store.calibByModel
            : (store.calibByModel = {} as Record<string, CalibrationEntry>);
        const cur = byModel[id] && typeof byModel[id] === "object"
            ? byModel[id]
            : (byModel[id] = {} as CalibrationEntry);
        if (typeof calib.calibRatio === "number" && Number.isFinite(calib.calibRatio)) cur.calibRatio = calib.calibRatio;
        if (typeof calib.lastRealPromptTokens === "number") cur.lastRealPromptTokens = calib.lastRealPromptTokens;
        if (typeof calib.lastCachedTokens === "number") cur.lastCachedTokens = calib.lastCachedTokens;
        // 旧扁平字段镜像回写（= 最近写入模型的值），fork 透传与旧读侧语义保持
        if (typeof cur.calibRatio === "number") store.calibRatio = cur.calibRatio;
        if (typeof cur.lastRealPromptTokens === "number") store.lastRealPromptTokens = cur.lastRealPromptTokens;
        if (typeof cur.lastCachedTokens === "number") store.lastCachedTokens = cur.lastCachedTokens;
        await writeStore(sessionId, store);
    });
};

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
    return withStoreLock(sessionId, async () => {
        const store = await readStore(sessionId);
        store.todos = todos;
        await writeStore(sessionId, store);
    });
}

// ============ 历史会话枚举（/sessions 选择器 + --continue） ============

/** 历史会话摘要（供 UI 选择器展示）。 */
export type SessionSummary = {
    sessionId: string;
    /** 用户自定义名称（重命名写入 state.title）；缺省时 UI 回退到 preview。 */
    title?: string;
    createAt?: string;
    updatedAt?: string;
    messageCount: number;
    /** 首条 user 消息预览（已折叠空白、截断）。 */
    preview: string;
    /** 创建时的项目根绝对路径（getOrCreateSessionId 建档盖章；旧会话无此字段 → undefined）。 */
    projectRoot?: string;
    /** 归档标记（state.archived === true；缺省/undefined = 未归档）。归档会话在历史抽屉收进折叠段，不改时间序。 */
    archived?: boolean;
};

/**
 * 历史会话索引项（列表首屏所需的轻量字段）：与 SessionSummary 的差别只是不带 messageCount——
 * 消息数必须读完整 transcript 逐行数，是列表加载里唯一的「全量 IO」项，故拆出去按需取（countSessionMessages）。
 */
export type SessionIndexItem = Omit<SessionSummary, "messageCount">;

/** user 消息 → 列表预览文本（多模态 parts 取纯文本视图；乱码过滤与标记）。 */
const previewOfUserMsg = (msg: any): string => {
    // ★ 多模态：content 可能是 parts 数组（贴图轮），取纯文本视图做预览
    const t = (msgText(msg.content) || "（该条消息带图片附件）").replace(/\s+/g, " ").trim();
    // ★ 乱码预览过滤：被错误解码的输入/输出会产生 U+FFFD 替换符（乱码不可恢复），
    // 从 preview 中剥离并打标记，避免历史列表整片「�」影响可读性。
    if (t.includes("\uFFFD")) {
        const stripped = t.replace(/\uFFFD+/g, "");
        const cleaned = stripped.trim();
        // ★ 替换符占比过半 = 整条已不可读（实测旧测试会话：29 字符里 20 个替换符，残留是希腊/拉丁扩展
        //   杂烩的字形汤）——如实标注无法显示，不再把残留拼出来恶心列表；少量乱码的正常消息仍保留可读部分。
        const mostlyGarbage = t.length === 0 || (t.length - stripped.length) * 2 >= t.length;
        return !cleaned || mostlyGarbage ? "（该条消息内容为乱码，无法正常显示）" : `（含乱码片段）${cleaned}`;
    }
    return t;
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

        // 消息数与首条 user 预览来自 <id>.jsonl（读全文逐行数消息——VSCode 面板列表不走这里，见 listSessionIndex）
        let messageCount = 0;
        let preview = "";
        try {
            const raw = await fs.readFile(getTranscriptPath(sessionId), "utf-8");
            for (const s of raw.split("\n")) {
                const line = s.trim();
                if (!line) continue;
                let msg: any;
                try { msg = JSON.parse(line); } catch { continue; } // 跳过损坏行
                if (typeof msg?.dscEvent === 'string') continue; // ★ 事件行（事件日志化）不计入消息数
                messageCount++;
                if (!preview && msg?.role === "user" && msg.content != null) preview = previewOfUserMsg(msg);
            }
        } catch { /* 无 jsonl（空会话）→ 0 条 */ }

        // updatedAt：优先 state.updatedAt，回退目录 mtime
        summaries.push({
            sessionId,
            title: typeof state?.title === "string" ? state.title : undefined,
            createAt: state?.createAt,
            updatedAt: state?.updatedAt ?? (await dirMtime(dirPath)),
            messageCount,
            preview: clipPreview(preview),
            projectRoot: typeof state?.projectRoot === "string" ? state.projectRoot : undefined,
            archived: state?.archived === true,
        });
    }
    // 按 updatedAt 降序（最新在前）；无时间者沉底
    summaries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return summaries;
};

// ============ 历史会话索引（VSCode 面板列表懒加载） ============

/** 列表预览截断长度。 */
const PREVIEW_MAX_CHARS = 80;
/** 预览截断：与 @/session/content.ts 的 sliceHeadNoSplit 同口径（切点前一位是高代理则退一位）。
 *  此处不直接 import 那个助手——content.ts 反向依赖本模块（getRollingState），会形成环依赖；
 *  本函数只服务列表预览（不进 API 消息），三行内联比造环更稳。 */
const clipPreview = (t: string): string => {
    if (t.length <= PREVIEW_MAX_CHARS) return t;
    const prev = t.charCodeAt(PREVIEW_MAX_CHARS - 1);
    return t.slice(0, prev >= 0xd800 && prev <= 0xdbff ? PREVIEW_MAX_CHARS - 1 : PREVIEW_MAX_CHARS);
};
/** 索引取预览只读 transcript 头部：首条 user 消息通常就在文件头，不必把整个会话读进内存。 */
const PREVIEW_HEAD_BYTES = 64 * 1024;
/** 头部没找到首条 user（首条消息带大图/超长粘贴，单行就超头部）时的放宽上限；仍没有则无预览。 */
const PREVIEW_WIDE_BYTES = 1024 * 1024;
/** 索引并发度：每会话两个小文件读（state.json + transcript 头），串行在会话多时拖慢面板首开。 */
const INDEX_CONCURRENCY = 16;

/** 目录 mtime 的 ISO 串（目录不可 stat → undefined）：state.updatedAt 缺失时的排序兜底。 */
const dirMtime = async (dir: string): Promise<string | undefined> => {
    try { return (await fs.stat(dir)).mtime.toISOString(); } catch { return undefined; /* 目录也不可 stat */ }
};

/** 读文件头 bytes 字节并按完整行切分：末尾半行丢弃——切点可能落在多字节字符或 JSON 中间。 */
const readHeadLines = async (file: string, bytes: number): Promise<string[]> => {
    const fh = await fs.open(file, "r");
    try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        const text = buf.subarray(0, bytesRead).toString("utf-8");
        const cut = bytesRead < bytes ? -1 : text.lastIndexOf("\n");
        return (cut >= 0 ? text.slice(0, cut) : text).split("\n");
    } finally {
        await fh.close();
    }
};

/** 首条 user 消息预览：只读 transcript 头部（先头部上限，没找到再放宽一档）。无 transcript → 空串。 */
const readPreview = async (sessionId: string): Promise<string> => {
    const file = getTranscriptPath(sessionId);
    try {
        for (const bytes of [PREVIEW_HEAD_BYTES, PREVIEW_WIDE_BYTES]) {
            for (const line of await readHeadLines(file, bytes)) {
                if (!line.trim()) continue;
                let msg: any;
                try { msg = JSON.parse(line); } catch { continue; } // 跳过损坏行
                if (typeof msg?.dscEvent === 'string') continue; // 事件行不是消息
                if (msg?.role === "user" && msg.content != null) return clipPreview(previewOfUserMsg(msg));
            }
        }
    } catch { /* 无 jsonl（空会话）→ 无预览 */ }
    return "";
};

/**
 * 枚举本工作区的会话索引（VSCode 面板历史列表用）：排序与字段语义同 listSessions，只是不含 messageCount。
 * ★ 轻量：元信息读 state.json（小文件）、预览只读 transcript 头部——不读任何会话全文。listSessions 会把每个
 *   会话的完整 transcript 读进内存数行数，会话越多列表越慢（实测 95 个会话要全量读 14MB）；列表打开只需要
 *   「标题 + 时间」认出会话，消息数属明细，由 countSessionMessages 按可见行另取。
 * 单个会话解析失败静默跳过，绝不抛错。
 */
export const listSessionIndex = async (): Promise<SessionIndexItem[]> => {
    const root = getWorkspaceSessionsDir();
    let entries: any[];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return []; // 目录不存在（从未建过会话）→ 空
    }
    // 纵深防御：跳过非法文件夹名（合法 sessionId 仅 [A-Za-z0-9_-]）
    const ids = entries.filter((e) => e.isDirectory() && isSafeSessionId(e.name)).map((e) => e.name);
    const items: SessionIndexItem[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= ids.length) return;
            const sessionId = ids[i];
            try {
                const [state, preview] = await Promise.all([
                    readJSONFile<any>(getStatePath(sessionId)),
                    readPreview(sessionId),
                ]);
                items.push({
                    sessionId,
                    title: typeof state?.title === "string" ? state.title : undefined,
                    createAt: state?.createAt,
                    updatedAt: state?.updatedAt ?? (await dirMtime(path.join(root, sessionId))),
                    preview,
                    projectRoot: typeof state?.projectRoot === "string" ? state.projectRoot : undefined,
                    archived: state?.archived === true,
                });
            } catch { /* 单个会话解析失败 → 跳过，不阻断其余 */ }
        }
    };
    await Promise.all(Array.from({ length: Math.min(INDEX_CONCURRENCY, ids.length) }, worker));
    // 按 updatedAt 降序（最新在前）；无时间者沉底
    items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return items;
};

/** 会话消息数（列表懒加载明细）：读完整 transcript 数消息行，事件行不计；无 transcript / 非法 id → 0。 */
export const countSessionMessages = async (sessionId: string): Promise<number> => {
    if (!isSafeSessionId(sessionId)) return 0; // 路径穿越硬守（getTranscriptPath 亦会 assert，这里先判免抛）
    try {
        const raw = await fs.readFile(getTranscriptPath(sessionId), "utf-8");
        let count = 0;
        for (const s of raw.split("\n")) {
            const line = s.trim();
            if (!line) continue;
            let msg: any;
            try { msg = JSON.parse(line); } catch { continue; } // 跳过损坏行
            if (typeof msg?.dscEvent === 'string') continue;
            count++;
        }
        return count;
    } catch {
        return 0; // 无 jsonl（空会话）
    }
};

/** 会话是否仍在盘上（state.json 或 transcript 任一存在）：续接/复活前的廉价存在性检查，无建目录等副作用。 */
export const sessionExists = async (sessionId: string): Promise<boolean> => {
    if (!isSafeSessionId(sessionId)) return false;
    const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);
    const [state, transcript] = await Promise.all([exists(getStatePath(sessionId)), exists(getTranscriptPath(sessionId))]);
    return state || transcript;
};

/**
 * 取本工作区最近一次会话的 sessionId（--continue 用）。
 * ★ 快路径（2026-09-15）：只读各会话的 state.json（小文件）+ 目录 mtime 兜底排序，不读任何
 *   transcript——原实现经 listSessions 把【每个】会话的完整 jsonl 读进内存数行数取预览，
 *   长会话历史越多启动越慢，而 --continue 只需要一个 id。排序语义与 listSessions 首条一致：
 *   updatedAt 降序（字符串比较同口径）；全部拿不到时间戳时取目录枚举序首个（对齐稳定排序沉底语义）。
 */
export const getMostRecentSessionId = async (): Promise<string | null> => {
    const root = getWorkspaceSessionsDir();
    let entries: any[];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return null; // 目录不存在（从未建过会话）
    }
    let best: { sessionId: string; updatedAt: string } | undefined;
    let noTimestampFirst: string | undefined; // 全体无时间戳时的兜底（枚举序首个）
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionId = entry.name;
        if (!isSafeSessionId(sessionId)) continue; // 纵深防御：跳过非法文件夹名
        // 挂机批处理会话（batch-*，成本信任链第四环）不参与 --continue：挂机一夜后早上一开 -c
        // 续进的应是人的对话，不是批任务（同 usageLog 剔除受控会话前缀的惯例，但 batch 是真实消费）
        if (sessionId.startsWith("batch-")) continue;
        const state: any = await readJSONFile<any>(getStatePath(sessionId));
        let updatedAt: string | undefined = state?.updatedAt;
        if (!updatedAt) {
            try { updatedAt = (await fs.stat(path.join(root, sessionId))).mtime.toISOString(); } catch { /* 目录也不可 stat */ }
        }
        if (!updatedAt) {
            noTimestampFirst ??= sessionId;
            continue;
        }
        if (!best || updatedAt > best.updatedAt) best = { sessionId, updatedAt };
    }
    return best?.sessionId ?? noTimestampFirst ?? null;
};

/**
 * 重命名会话：把自定义标题写入 <id>.state.json 的 title 字段（不动 sessionId/文件夹名，
 * 保证 transcript/state 路径稳定）。限长 200 字符防滥用。经会话写锁串行化，不与摘要/todo 写冲突。
 */
export const renameSession = async (sessionId: string, title: string): Promise<void> => {
    assertSafeSessionId(sessionId); // 路径穿越硬守
    const clean = String(title ?? "").trim().slice(0, 200);
    return withStoreLock(sessionId, async () => {
        const store = await readStore(sessionId);
        store.title = clean;
        store.updatedAt = new Date().toISOString();
        await writeStore(sessionId, store);
    });
};

/**
 * 归档 / 取消归档会话：标记写入 <id>.state.json 的 archived 字段。与重命名同款写路径
 * （会话写锁串行化），但刻意【不动 updatedAt】——归档只改列表分组（活跃段 → 折叠段），
 * 不改会话自身的时间序，两段内部仍按原 updatedAt 降序。
 * 取消归档时 delete 掉字段而非写 false：state.json 保持最小，缺省即未归档。
 * ★ 只有 transcript、没有 state.json 的旧会话：readStore 返回 {}，直接写出会丢 updatedAt/createAt
 *   元信息（列表时间回退到目录 mtime，且该 mtime 已被本次写刷新）——写前从目录 mtime 补齐，
 *   兑现「归档动作本身不改变时间序」。
 */
export const setSessionArchived = async (sessionId: string, archived: boolean): Promise<void> => {
    assertSafeSessionId(sessionId); // 路径穿越硬守
    return withStoreLock(sessionId, async () => {
        const store = await readStore(sessionId);
        if (typeof store.updatedAt !== "string" || typeof store.createAt !== "string") {
            let dirIso = "";
            try { dirIso = (await fs.stat(getSessionsDirPath(sessionId))).mtime.toISOString(); } catch { /* 目录缺失则用当下 */ }
            if (typeof store.updatedAt !== "string") store.updatedAt = dirIso || new Date().toISOString();
            if (typeof store.createAt !== "string") store.createAt = dirIso || store.updatedAt;
        }
        if (archived) store.archived = true;
        else delete store.archived;
        await writeStore(sessionId, store);
    });
};

/**
 * 删除会话：递归移除整个会话文件夹（state + transcript + 子 agent 折叠文件）。
 * 仅 fs.rm 失败时抛错；文件夹不存在（force:true）静默成功。调用方负责在删除活动会话后置空 sessionId。
 */
export const deleteSession = async (sessionId: string): Promise<void> => {
    assertSafeSessionId(sessionId); // 路径穿越硬守——拒绝 '..'/'/' 等非法 id 误删其他目录
    const dir = getSessionsDirPath(sessionId);
    await fs.rm(dir, { recursive: true, force: true });
    ensuredSessionDirs.delete(dir); // ★ 目录已删，失效 ensure 缓存（防同 id 重建后跳过 mkdir）
};