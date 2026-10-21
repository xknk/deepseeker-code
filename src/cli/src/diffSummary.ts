/**
 * @file cli/src/diffSummary.ts
 * @description /diff 本 run 改动汇总的数据装配（纯 node 无 React，可脱离 Ink 单测）：
 *  undo 索引记录 → 每文件红绿 diff 行。「改前」取该文件本 run 最早一条未回退记录的备份内容
 *  （= 本 run 首次写前状态），「改后」取当前磁盘——即净变化视图；creation_marker（新建）以空串
 *  为改前；备份已清理 / 文件已不在磁盘等不可比对情形降级为 note 行，不抛错不阻断。
 */
import fs from "fs/promises";
import path from "path";
import { lineDiff, collapseContext, type CollapsedRow } from "./lineDiff.ts";
import type { UndoRecord } from "@/tool/undo/type.ts";
import { getUndoBackupRoot } from "@/tool/undo/store.ts";

/** 单文件汇总项：rows=null 表示不可比对或无净变化（note 说明原因）。 */
export type RunDiffFile = {
    path: string;
    note?: string;
    rows: CollapsedRow[] | null;
};

const readTextIfExists = async (p: string): Promise<string | null> => {
    try { return await fs.readFile(p, "utf-8"); } catch { return null; }
};

/**
 * 组装本 run 的每文件红绿 diff。
 * @param sessionId 会话 id（备份根按会话归并——子代理写入经主会话目录天然吃到）
 * @param records 本 run 时间窗内的 undo 记录（须未回退；时间过滤在调用方）
 */
export const buildRunDiff = async (sessionId: string, records: UndoRecord[]): Promise<RunDiffFile[]> => {
    // 同文件取最早一条记录（其备份 = 本 run 首次写前状态，对其余中间态做 diff 是噪声）
    const byPath = new Map<string, UndoRecord>();
    for (const r of records) {
        if (r.restored) continue;
        const prev = byPath.get(r.relativePath);
        if (!prev || (r.timestamp || "") < (prev.timestamp || "")) byPath.set(r.relativePath, r);
    }
    const root = process.env.WORKSPACE_ROOT ?? process.cwd();
    const out: RunDiffFile[] = [];
    for (const r of [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
        const abs = path.join(root, ...r.relativePath.split("/"));
        if (r.backupKind === "directory_tree") {
            out.push({ path: r.relativePath, note: "▤ 目录树改动（内容 diff 略，可 /rewind 回退）", rows: null });
            continue;
        }
        const disk = await readTextIfExists(abs);
        if (disk === null) {
            out.push({ path: r.relativePath, note: "（文件已不在磁盘——已被回退或手动删除）", rows: null });
            continue;
        }
        let before: string | null;
        if (r.backupKind === "creation_marker") {
            before = ""; // 新建文件：改前为空 → 全绿新增
        } else {
            // 与 restore.ts dispatchRestore 同一拼接契约（backupPath 仅审计用，不读取）
            before = await readTextIfExists(path.join(getUndoBackupRoot(sessionId), r.undoId, "content"));
        }
        if (before === null) {
            out.push({ path: r.relativePath, note: "（备份已被清理，无法生成红绿对比）", rows: null });
            continue;
        }
        const rows = collapseContext(lineDiff(before, disk));
        if (!rows.some(c => c.t === "add" || c.t === "del")) continue; // 无净变化：不进汇总
        out.push({ path: r.relativePath, rows });
    }
    return out;
};
