/**
 * @file session/transcript.ts
 * @description 会话转录（JSONL 追加日志）：readTranscriptLines 读取全部行（消息 + 事件混合序列），
 *  readMessages 过滤事件行只返回消息；appendMessage / appendEvent 以 append 方式追加单条记录。
 *  ★ 事件行（事件日志化）：与消息行同文件的带标记行（dscEvent 字段判别），记录 run/round/压缩边界——
 *    单文件 append-only 语义不动，崩溃恢复/会话分叉/审计不再依赖盲扫启发式。
 *    事件行无 role → 所有按 role 分派的读取方（replay / VSCode / 预览）天然跳过，零改动兼容。
 */
import fs from "fs/promises";
import OpenAI from "openai";
import { ensureSessionsDir, getTranscriptPath } from "./store.ts";
import { createUUID } from "@/common/index.ts";
import { appConfig } from "@/config/index.ts";

// ———— 事件行类型（事件日志化） ————

/** 单轮/单 run 用量快照（transcript 永久留存；trace 侧 3 天自动清理，二者互补） */
export type UsageSnapshot = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
};

/** transcript 事件负载（不含 id/ts，由 appendEvent 统一盖章） */
export type TranscriptEvent =
    /** 一次 runAgent 调用（= 一次用户输入的 turn）开始。消费：run 配对恢复、fork turn 锚点、回放分 turn */
    | { dscEvent: 'run.start'; runId: string; depth: number }
    /** run 闭合。stopReason 与 runAgent Stop hook 同枚举。消费：恢复判定（缺失=崩溃）、审计、永久计量 */
    | { dscEvent: 'run.end'; runId: string; stopReason: 'normal' | 'aborted' | 'error' | 'repeat' | 'limit'; rounds: number; usage?: UsageSnapshot }
    /** 一个 round 完整落盘（assistant + 全部 tool 结果已 flush）后才写；abort/error/repeat 路径不写——缺失即取证信号 */
    | { dscEvent: 'round.end'; runId: string; round: number; usage?: UsageSnapshot }
    /** 压缩边界（truncate 两处 setRollingState 成功后）。消费：desync 交叉校验、fork 摘要派生（transcript 自包含） */
    | { dscEvent: 'compaction'; archivedMessageCount: number; summary: string }
    /** 恢复层补写的闭墓标记（幂等）：崩溃 run 一次性闭合，回放「已中断」标记 */
    | { dscEvent: 'run.abandoned'; runId: string; reason: string };

/** 磁盘上的事件行（sessionId 与消息行同规则剥除；id 与消息行同构，供 fork 锚定） */
export type TranscriptEventLine = { id: string; ts: string } & TranscriptEvent;
export type TranscriptLine = (OpenAI.Chat.ChatCompletionMessageParam & { id?: string }) | TranscriptEventLine;
/** 事件行判别：OpenAI 消息 schema 顶层永无 dscEvent 键，一行属性检查即可 */
export const isEventLine = (l: any): l is TranscriptEventLine => typeof l?.dscEvent === 'string';

/**
 * 从 .jsonl 读取某次对话的全部行（消息行 + 事件行，保序混合序列）。
 * 恢复（recovery）/ 分叉（fork）/ 回放增强消费；坏行跳过并告警，与 readMessages 同容错语义。
 */
export const readTranscriptLines = async (sessionId: string): Promise<TranscriptLine[]> => {
    // 确保目录存在
    await ensureSessionsDir(sessionId);
    const p = getTranscriptPath(sessionId);
    try {
        const text = await fs.readFile(p, "utf-8");
        // 将文件内容按行拆分，每行解析为一个 JSON 对象；个别坏行跳过并告警，避免单点损坏击垮整段历史
        const lines: any[] = [];
        for (const s of text.split("\n")) {
            const line = s.trim();
            if (line.length === 0) continue; // 过滤空行
            try {
                lines.push(JSON.parse(line));
            } catch {
                console.warn(`⚠️ [transcript] 跳过无法解析的损坏行: ${line.slice(0, 120)}`);
            }
        }
        return lines;
    } catch (err: unknown) {
        // 如果文件不存在（新会话），返回空数组作为历史记录
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
        throw err;
    }
}

/**
 * 从 .jsonl 读取某次对话的全部上下文消息（过滤事件行）。
 * 用于在发起 API 请求前，把之前的记忆带上；事件行对既有消息消费方（content/replay/VSCode）不可见。
 */
export const readMessages = async (sessionId: string): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> =>
    (await readTranscriptLines(sessionId)).filter((l) => !isEventLine(l)) as OpenAI.Chat.ChatCompletionMessageParam[];

type MessageWithId = OpenAI.Chat.ChatCompletionMessageParam & {
    id?: string;
    ts?: string; // 落盘时刻（recall staleness 校验基准；cleanMsg 回传模型前剥离）
    sessionId: string;
    is_compaction_checkpoint?: boolean, // 该条消息是否为摘要
    last_compressed_id?: string, // 最后压缩id
    // tool_calls / tool_call_id 由 ChatCompletionMessageParam 自带，无需在此重列
};

/**
 * 单行追加的共享基元（appendMessage / appendEvent 共用，半行防护单点）：
 * ★ 短重试：磁盘瞬时忙/锁（尤其 Windows）下 appendFile 偶发失败，重试 3 次降低「内存已 push、磁盘未落」
 *   导致重启后转录不一致的概率。部分写入防御：appendFile 可能写入部分字节后抛错（磁盘满/中断），
 *   若直接重试会再追加完整行 → JSONL 出现「半行 + 全行」。失败时先截断回写入前大小，再重试。
 * ★ 成功路径免 stat（2026-09-15）：原实现每次 append 前都 fs.stat 拿写入前大小——但该值只在
 *   失败截断分支才用得上。改用进程内字节水位（path → 已知长度，本进程成功 append 后累加），
 *   首次（缓存 miss）仍 stat 校准；失败截断目标 = 水位值 = 精确的写入前大小，语义与原实现逐位一致。
 *   单人本地单进程写同一会话文件；deleteSession 删文件后条目过期无害（下次失败路径截断目标略偏，
 *   极端场景，且原实现同样无法防御外部改写）。
 */
const appendSizeCache = new Map<string, number>(); // path → 已知字节长度（写入前大小）
/** @param handle P2-2 合批快路径：调用方已 open 的追加句柄（省逐条 open+close）；缺省走旧路径 fs.appendFile。
 *   重试/截断回滚/水位语义与旧路径完全一致（truncate 按 path 进行，句柄以 O_APPEND 打开互不干扰）。 */
const appendLineWithRetry = async (p: string, payload: string, handle?: fs.FileHandle | null): Promise<void> => {
    const MAX_ATTEMPTS = 3;
    const payloadBytes = Buffer.byteLength(payload, "utf-8");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let beforeSize = appendSizeCache.get(p);
        if (beforeSize === undefined) {
            beforeSize = 0;
            try { beforeSize = (await fs.stat(p)).size; } catch { /* 文件不存在 → beforeSize=0 */ }
        }
        try {
            if (handle) await handle.appendFile(payload, "utf-8"); // O_APPEND：总是落到当前文件尾
            else await fs.appendFile(p, payload, "utf-8");
            appendSizeCache.set(p, beforeSize + payloadBytes); // ★ 水位推进：下次 append 免 stat
            return;
        } catch (e) {
            try { await fs.truncate(p, beforeSize); } catch { /* 截断失败则放弃重试避免重复追加 */ }
            appendSizeCache.set(p, beforeSize); // 截断成功与否，写入前大小不变，保持精确
            if (attempt === MAX_ATTEMPTS) throw e; // 交由外层统一告警
            await new Promise(r => setTimeout(r, 50 * attempt)); // 50ms / 100ms 退避
        }
    }
}

export const appendMessage = async (entry: MessageWithId): Promise<void> => {
    try {
        await ensureSessionsDir(entry.sessionId);

        // 用展开保留全部字段（含 tool_calls / tool_call_id），不要手动列举字段以免遗漏配对键
        const { sessionId, ...rest } = entry;
        // ★ ts 盖章：recall 检索的 staleness 校验基准（观察时刻 vs 文件 mtime）。事件行有 ts、消息行原先没有，
        //   此处统一补齐；cleanMsg 发往模型前剥离，不污染 API 消息体。
        const line = { id: createUUID(), ts: new Date().toISOString(), ...rest };

        const p = getTranscriptPath(sessionId);
        const payload = JSON.stringify(line) + "\n";
 // ★ 编码体检：内容含 U+FFFD（无效 UTF-8 的替换符）多半是 Windows 子进程 GBK 输出被误解码，
 // 或用户粘贴了乱码文本。不擅改内容，原样落盘 + 打日志便于追溯乱码来源。
 if (payload.includes("\uFFFD")) {
 const fffdCount = (payload.match(/\uFFFD/g) || []).length;
 console.warn(`⚠️ [transcript] 消息含 ${fffdCount} 个乱码字符（U+FFFD），已原样写入历史。来源可能是 GBK 子进程输出或乱码粘贴。`);
 }
        await appendLineWithRetry(p, payload);
    } catch (e) {
        // 容错优先：持续失败仍不阻断推理，但明确告警内存/磁盘可能不一致
        console.warn(`⚠️ 消息落盘失败（已重试 3 次，内存与磁盘转录可能不一致）:`, e);
    }
}

/**
 * 批量追加多条消息（P2-2 落盘合批）：open('a') 一次、逐条 handle.appendFile、finally close——
 * Windows + 杀软实时扫描下小文件 open+append 常见 5~20ms/次，一个 N 工具轮的 N+1 次独立写夹在轮间，
 * 合批后每轮只付一次打开成本。行构造与 appendMessage 同式（id/ts 盖章 + U+FFFD 体检，两处同步维护），
 * 顺序语义与逐条 appendMessage 完全一致（按请求序逐行落盘）。
 * 单条失败：appendLineWithRetry 已含重试+截断回滚；仍抛错则该条起回落逐条旧路径（appendMessage，
 * 失败行已被截断回滚，逐条重写不产生半行/重复）。与 appendMessage 同容错——任何失败只 warn 不抛。
 */
export const appendMessages = async (sessionId: string, entries: MessageWithId[]): Promise<void> => {
    if (entries.length === 0) return;
    if (entries.length === 1) return appendMessage(entries[0]);
    try {
        await ensureSessionsDir(sessionId);
        const p = getTranscriptPath(sessionId);
        const payloads = entries.map((entry) => {
            const { sessionId: _sid, ...rest } = entry;
            return JSON.stringify({ id: createUUID(), ts: new Date().toISOString(), ...rest }) + "\n";
        });
        // 编码体检（与单条路径同款，批量汇总计数；不擅改内容，原样落盘便于追溯乱码来源）
        const FFFD = String.fromCharCode(0xfffd); // 无效 UTF-8 替换符（ASCII 写法，避免源码转义歧义）
        const fffdTotal = payloads.reduce((n, pl) => n + (pl.split(FFFD).length - 1), 0);
        if (fffdTotal > 0) console.warn(`[transcript] 批量消息含 ${fffdTotal} 个乱码字符（U+FFFD），已原样写入历史。来源可能是 GBK 子进程输出或乱码粘贴。`);
        let handle: fs.FileHandle | null = null;
        let i = 0;
        try {
            handle = await fs.open(p, "a");
            for (; i < payloads.length; i++) await appendLineWithRetry(p, payloads[i], handle);
        } catch (e) {
            console.warn(`[transcript] 批量落盘第 ${i + 1}/${payloads.length} 条失败，该条起回落逐条旧路径:`, e instanceof Error ? e.message : e);
            for (; i < entries.length; i++) await appendMessage(entries[i]);
        } finally {
            if (handle) await handle.close().catch(() => { /* 关闭失败无害：句柄随进程回收 */ });
        }
    } catch (e) {
        console.warn(`批量消息落盘失败（内存与磁盘转录可能不一致）:`, e);
    }
}

/**
 * 追加一条边界事件行（事件日志化）。appConfig.transcriptEvents 关闭时 no-op——
 * 发射点（runAgent / truncate / recovery）一律无脑调用，不散落开关判断。
 * 盖章 id/ts 与消息行同构（行 id 唯一性作用域 = 单会话内；fork 前缀沿用源 id 是有意的溯源保留）。
 * 失败只 warn 不抛（与 appendMessage 同容错策略，绝不击垮推理）。
 */
export const appendEvent = async (sessionId: string, ev: TranscriptEvent): Promise<void> => {
    if (!appConfig.transcriptEvents) return;
    try {
        await ensureSessionsDir(sessionId);
        const line: TranscriptEventLine = { id: createUUID(), ts: new Date().toISOString(), ...ev };
        await appendLineWithRetry(getTranscriptPath(sessionId), JSON.stringify(line) + "\n");
    } catch (e) {
        console.warn(`⚠️ [transcript] 事件行落盘失败（${ev.dscEvent}，恢复/分叉将回退启发式）:`, e);
    }
}
