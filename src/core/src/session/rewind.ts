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
 *  - C2 文件级联动：检查点不存写集合（writes 字段不需要）——undo 索引记录自带 timestamp，按
 *    `记录.ts > 检查点.ts` 圈定该轮写入（检查点记在 user 消息落盘【前】，该轮全部工具写在其后；
 *    子代理写入经 undo 索引的主会话归并天然吃到）。每文件取最早一条未回退记录（其备份=首次写前
 *    状态=检查点时刻态），经 restoreForRewind 走完整 undo 链路（反向备份保手动改动可逆）；
 *    同文件其余未回退记录随恢复一并标记 restored（其效果已被覆盖，对已消失的变更做 undo 是语义错误）。
 *    时序红线：先文件恢复确认（modal 清单）→ 执行恢复 → 再截断对话，避免半途状态。
 */
import fs from "fs/promises";
import path from "path";
import { createUUID, assertSafeSessionId } from "@/common/index.ts";
import { readTranscriptLines, isEventLine, resetAppendSizeWatermark } from "./transcript.ts";
import { getSessionsDirPath, getTranscriptPath, ensureSessionsDir, readStore, writeStore } from "./store.ts";
import { readUndoIndex, markRestored } from "@/tool/undo/index.ts";
import { restoreForRewind } from "@/tool/undo/restore.ts";
import type { UndoRecord } from "@/tool/undo/type.ts";

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

// ———————————— C2 文件级联动 ————————————

/** 单文件回滚计划项（modal 确认清单用）：ok=false = 备份已被清理、无法恢复（对话照常截断，文件保持现状）。 */
export type RewindFilePlan = {
    relativePath: string;
    kind: "file_content" | "directory_tree" | "creation_marker";
    undoId: string;
    ok: boolean;
};

/** 圈定检查点之后的写集合：undo 索引（升序）过滤 `ts > sinceTs && !restored`，按 relativePath 分组，
 *  最早一条进 earliest（恢复目标），其余进 shadowed（恢复时随 earliest 一并标记 restored）。
 *  readUndoIndex 内部聚合该会话全部 undo-*.jsonl 并容错损坏行；目录/会话不合法时返回空（无可恢复）。 */
const collectPostCheckpointRecords = async (
    sessionId: string,
    sinceTs: string,
): Promise<{ earliest: UndoRecord[]; shadowed: UndoRecord[] }> => {
    const all = await readUndoIndex(sessionId);
    const post = all.filter((r) => !r.restored && (r.timestamp || "") > sinceTs);
    const byPath = new Map<string, UndoRecord>();
    const shadowed: UndoRecord[] = [];
    for (const r of post) {
        const prev = byPath.get(r.relativePath);
        if (!prev) { byPath.set(r.relativePath, r); continue; }
        if ((r.timestamp || "") < (prev.timestamp || "")) { byPath.set(r.relativePath, r); shadowed.push(prev); }
        else shadowed.push(r);
    }
    const earliest = [...byPath.values()].sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    return { earliest, shadowed };
};

/** 预检：回滚到某检查点会波及哪些文件（host.planRewind → modal 确认清单；不落盘不恢复）。 */
export const collectRewindFiles = async (sessionId: string, sinceTs: string): Promise<RewindFilePlan[]> => {
    const { earliest } = await collectPostCheckpointRecords(sessionId, sinceTs);
    const plans: RewindFilePlan[] = [];
    for (const r of earliest) {
        // creation_marker 的恢复动作 = 删除新建文件，不依赖备份内容；其余形态需备份仍在（cleanup 可能已回收）
        let ok = true;
        if (r.backupKind !== "creation_marker") {
            try { await fs.access(r.backupPath); } catch { ok = false; }
        }
        plans.push({ relativePath: r.relativePath, kind: r.backupKind, undoId: r.undoId, ok });
    }
    return plans.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};

/**
 * 执行检查点回滚的文件恢复（modal 确认后、对话截断【前】调用——时序红线：先文件、再截断）。
 * 逐文件走 restoreForRewind 完整链路（反向备份→还原→标记→反向记录）；单文件失败不阻断其余文件
 * （失败 = 文件留在当前态，无损可重试）。备份缺失的跳过并报告。@returns 每文件一行人类可读结果。
 */
export const restoreFilesForRewind = async (sessionId: string, sinceTs: string): Promise<string[]> => {
    const { earliest, shadowed } = await collectPostCheckpointRecords(sessionId, sinceTs);
    const results: string[] = [];
    const shadowDone = new Set<string>();
    for (const r of earliest) {
        if (r.backupKind !== "creation_marker") {
            try { await fs.access(r.backupPath); } catch {
                results.push(`⚠️ ${r.relativePath}：备份已被清理，无法恢复（文件保持现状）`);
                continue;
            }
        }
        try {
            const msg = await restoreForRewind(r, sessionId);
            results.push(`✅ ${msg}`);
            // 同文件其后未回退记录的效果已被本次覆盖，一并标记 restored（undo 队列不再含已消失的变更；
            // earliest 的反向记录仍可 undo_restore，可整体"撤销回滚"回到回滚前文件态）
            for (const s of shadowed) {
                if (s.relativePath !== r.relativePath || shadowDone.has(s.undoId)) continue;
                shadowDone.add(s.undoId);
                await markRestored(sessionId, s.undoId);
            }
        } catch (e) {
            results.push(`❌ ${r.relativePath}：恢复失败（${e instanceof Error ? e.message : e}），文件保持现状`);
        }
    }
    return results;
};
