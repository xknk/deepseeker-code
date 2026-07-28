/**
 * @file tool/undo/index.ts
 * @description Undo 索引 JSONL 的追加 / 读取 / 标记已回退，复刻 observability/trace.ts 的 appendTraceEvent 模式。
 *  索引与备份内容解耦：索引在 undo-YYYY-MM-DD__主id.jsonl（每行一个 UndoRecord），内容在 backups/<undoId>/。
 */
import fs from "fs/promises";
import path from "path";
import { UndoRecord } from "./type.ts";
import { getUndoDirPath, getUndoIndexPath } from "./store.ts";
import { getTodayDateString } from "@/observability/traceCalculate.ts";

/**
 * 追加一条 UndoRecord 到会话索引 jsonl（自动注入 timestamp / bornDate）。
 * fs.appendFile 是单 syscall 原子追加，runAgent 同会话串行执行，无并发碰撞。
 */
export const appendUndoRecord = async (record: UndoRecord, sessionId: string): Promise<void> => {
    const enriched: UndoRecord = {
        ...record,
        timestamp: record.timestamp ?? new Date().toISOString(),
        bornDate: record.bornDate ?? getTodayDateString(),
    };
    const p = await getUndoIndexPath(sessionId);
    const line = JSON.stringify(enriched) + "\n";
    await fs.appendFile(p, line, "utf-8");
};

/**
 * 读取某会话所有 UndoRecord（聚合该会话目录下所有 undo-*__主id.jsonl，兼容跨天多文件）。
 * 返回按 timestamp 升序（旧→新），调用方按需 reverse 取 LIFO。
 * 任何单行/单文件损坏都被跳过，绝不抛错击垮回退流程。
 */
export const readUndoIndex = async (sessionId: string): Promise<UndoRecord[]> => {
    let dir: string;
    try { dir = getUndoDirPath(sessionId); } catch { return []; }
    let files: string[];
    try { files = await fs.readdir(dir); } catch { return []; }
    const records: UndoRecord[] = [];
    for (const f of files) {
        if (!f.startsWith("undo-") || !f.endsWith(".jsonl")) continue;
        try {
            const raw = await fs.readFile(path.join(dir, f), "utf-8");
            for (const line of raw.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try { records.push(JSON.parse(trimmed) as UndoRecord); } catch { /* 跳过损坏行 */ }
            }
        } catch { /* 文件被并发删等，忽略 */ }
    }
    records.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    return records;
};

/**
 * 标记某 undoId 已回退（并记录反向 undoId）。JSONL 不可原地改写，故逐个 jsonl 文件读改写。
 * 仅改动含目标记录的那个文件，无目标则空操作。回退低频，重写开销可接受。
 */
export const markRestored = async (sessionId: string, undoId: string, reverseUndoId?: string): Promise<void> => {
    let dir: string;
    try { dir = getUndoDirPath(sessionId); } catch { return; }
    let files: string[];
    try { files = await fs.readdir(dir); } catch { return; }
    for (const f of files) {
        if (!f.startsWith("undo-") || !f.endsWith(".jsonl")) continue;
        const fp = path.join(dir, f);
        let raw: string;
        try { raw = await fs.readFile(fp, "utf-8"); } catch { continue; }
        let changed = false;
        const lines = raw.split("\n").map(line => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            try {
                const rec = JSON.parse(trimmed) as UndoRecord;
                if (rec.undoId === undoId) {
                    rec.restored = true;
                    if (reverseUndoId) rec.reverseUndoId = reverseUndoId;
                    changed = true;
                    return JSON.stringify(rec);
                }
                return line;
            } catch { return line; }
        });
        if (changed) {
            await fs.writeFile(fp, lines.join("\n"), "utf-8");
        }
    }
};
