/**
 * @file session/rewind.ts
 * @description 对话级回滚（Checkpoints，统一动作面板方案第三批 C1）：
 *  每轮用户消息发送【前】记检查点（transcript 边界 + 将发文本预览），回滚 = 原地截断 transcript
 *  到该边界 + 压缩态回落。与 /fork 的关系：fork 保留原会话另开新线；rewind 原地截断当前会话，并存。
 *  - 检查点存 <会话目录>/checkpoints.json 侧车（独立小文件不进 transcript——回滚边界不能被自己截掉）；
 *    cap 50 条，同边界连续去重（重发/排队轮同点不重复记）。
 *  - 截断复用 fork 的字节级前缀拷贝模式（坏行/空行原样保留在保留区）；写后必须失效 transcript 的
 *    append 字节水位（resetAppendSizeWatermark），否则下次 append 失败回滚会截到旧的大水位留垃圾尾。
 *  - 压缩态（archivedMessageCount/rollingSummary）取保留区内最后一个 compaction 事件：检查点早于
 *    全部压缩 → 0/''，语义正确（压缩是运行期窗口治理，不是数据删除）；read-modify-write 保 title/校准。
 *  - busy 期间回滚在 host 层拒绝（生成中截断会产生撕裂转录）。
 *  - C2 文件级联动（按轮写集合恢复）待接入：届时在 Checkpoint 上补 writes 字段，回滚前先恢复文件。
 */
import fs from "fs/promises";
import path from "path";
import { createUUID, assertSafeSessionId } from "@/common/index.ts";
import { readTranscriptLines, isEventLine, resetAppendSizeWatermark } from "./transcript.ts";
import { getSessionsDirPath, getTranscriptPath, ensureSessionsDir, readStore, writeStore } from "./store.ts";

/** 检查点（选择器列表项，纯数据）：一次「用户消息发送前」的转录快照边界。 */
export type Checkpoint = {
    id: string;
    /** 记录时 transcript 最后一行的行 id；空转录为 null（回滚 = 清空全部） */
    lastLineId: string | null;
    /** 将发送的用户文本预览（首行截断；面板 "Before you sent" 展示用） */
    preview: string;
    ts: string;
};

const CHECKPOINT_CAP = 50;

const getCheckpointsPath = (sessionId: string): string =>
    path.join(getSessionsDirPath(sessionId), "checkpoints.json");

const readCheckpoints = async (sessionId: string): Promise<Checkpoint[]> => {
    try {
        const v = JSON.parse(await fs.readFile(getCheckpointsPath(sessionId), "utf-8"));
        return Array.isArray(v) ? v.filter((c) => !!c && typeof c.id === "string") : [];
    } catch {
        return []; // 不存在/损坏侧车 = 无检查点（不阻断发送与回滚主路径）
    }
};

const writeCheckpoints = async (sessionId: string, list: Checkpoint[]): Promise<void> => {
    await ensureSessionsDir(sessionId);
    await fs.writeFile(getCheckpointsPath(sessionId), JSON.stringify(list.slice(-CHECKPOINT_CAP)), "utf-8");
};

/**
 * 记录检查点：host 在用户消息落盘【前】调用（每轮一次）。preview = 将发送文本首行截断。
 * 失败只 warn 不抛（检查点是锦上添花，绝不阻断发送）。
 */
export const recordCheckpoint = async (sessionId: string, preview: string): Promise<void> => {
    try {
        const lines = await readTranscriptLines(sessionId);
        const rawLast = lines.length ? String((lines[lines.length - 1] as any)?.id ?? "") : "";
        const lastLineId = rawLast || null;
        const list = await readCheckpoints(sessionId);
        const last = list[list.length - 1];
        if (last && last.lastLineId === lastLineId) return; // 同边界连续去重
        list.push({
            id: `cp-${createUUID()}`,
            lastLineId,
            preview: preview.split("\n")[0].slice(0, 120),
            ts: new Date().toISOString(),
        });
        await writeCheckpoints(sessionId, list);
    } catch (e) {
        console.warn(`⚠️ [rewind] 检查点记录失败（不影响本轮发送）:`, e instanceof Error ? e.message : e);
    }
};

/** 枚举检查点（保序：旧 → 新；面板按此序展示，末尾提示「此检查点之后无新检查点」）。 */
export const listCheckpoints = async (sessionId: string): Promise<Checkpoint[]> => {
    assertSafeSessionId(sessionId);
    return readCheckpoints(sessionId);
};

/**
 * 回滚到检查点：原地截断 transcript 到记录时边界（保留区 = 该边界及之前）+ 压缩态回落 + 侧车截尾。
 * @returns 移除的行数（展示用）
 * @throws 检查点不存在 / 边界行已被回滚掉（转录中找不到 lastLineId）
 */
export const rewindToCheckpoint = async (sessionId: string, checkpointId: string): Promise<{ removedLines: number }> => {
    assertSafeSessionId(sessionId);
    const list = await readCheckpoints(sessionId);
    const idx = list.findIndex((c) => c.id === checkpointId);
    if (idx < 0) throw new Error(`检查点不存在：${checkpointId}`);
    const cp = list[idx];

    const lines = await readTranscriptLines(sessionId);
    const keepCount = cp.lastLineId ? lines.findIndex((l: any) => l?.id === cp.lastLineId) : -1;
    if (cp.lastLineId && keepCount < 0) {
        throw new Error("检查点边界行已不在转录中（可能已被回滚过），请关闭面板重新打开刷新列表");
    }
    const keepTarget = keepCount + 1; // 保留的可解析行数（-1 → 0 = 清空）

    // 压缩态回落：保留区内最后一个 compaction 事件（消息行/其它事件行跳过）
    let archivedMessageCount = 0;
    let rollingSummary = "";
    for (const l of lines.slice(0, keepTarget)) {
        if (!isEventLine(l) || l.dscEvent !== "compaction") continue;
        archivedMessageCount = l.archivedMessageCount;
        rollingSummary = l.summary;
    }

    // ★ 字节级前缀原地重写（fork.ts 同款：按原始文本行走，坏行/空行原样保留在保留区）
    const rawText = await fs.readFile(getTranscriptPath(sessionId), "utf-8");
    const kept: string[] = [];
    let good = 0;
    for (const s of rawText.split("\n")) {
        if (good >= keepTarget) break;
        kept.push(s);
        const t = s.trim();
        if (!t) continue;
        try { JSON.parse(t); good++; } catch { /* 坏行原样保留，不计 good */ }
    }
    let payload = kept.join("\n");
    if (payload.length > 0 && !payload.endsWith("\n")) payload += "\n";
    await fs.writeFile(getTranscriptPath(sessionId), payload, "utf-8");
    resetAppendSizeWatermark(getTranscriptPath(sessionId)); // 外部改写后水位必须失效（见函数注释）

    // state 回落（read-modify-write：保 title/校准/forkedFrom 等其余字段；无 state 的新会话跳过）
    try {
        const st = await readStore(sessionId);
        if (st && typeof st === "object") {
            await writeStore(sessionId, { ...st, archivedMessageCount, rollingSummary });
        }
    } catch { /* state 缺失不阻断（压缩态本就自包含于 transcript 的 compaction 事件） */ }

    // 侧车截尾：丢弃该检查点之后的记录；自身保留（可重复回滚到同点，幂等）
    await writeCheckpoints(sessionId, list.slice(0, idx + 1));

    return { removedLines: Math.max(0, lines.length - keepTarget) };
};
