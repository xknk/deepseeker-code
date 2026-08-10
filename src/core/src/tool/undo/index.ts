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
import { getFileName } from "@/common/index.ts";

/**
 * 进程内互斥锁（按 rootId 串行）：主 agent 与子 agent 共享同一 rootId 的 jsonl，
 * markRestored 的"读改写"与 appendUndoRecord 的"追加"若并发，前者覆写会抹掉后者的新行。
 * 用 Promise 链串行化：每个调用排队等上一个完成；fn 自身 rejection 不会传染后续持锁者。
 * 注：rootId 数量受会话数上界（MAX_CONCURRENT_SESSIONS）约束，Map 项残留可忽略。
 */
const undoLocks = new Map<string, Promise<unknown>>();
const withUndoLock = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> => {
    let rootId: string;
    try { rootId = getFileName(sessionId); } catch { rootId = sessionId; }
    const prev = undoLocks.get(rootId) ?? Promise.resolve();
    const run = prev.then(() => fn());
    // 链推进 swallow：fn 失败仅回传给当前调用方，不影响后续排队的持锁者
    undoLocks.set(rootId, run.then(() => undefined, () => undefined));
    return run;
};

/**
 * 追加一条 UndoRecord 到会话索引 jsonl（自动注入 timestamp / bornDate）。
 * fs.appendFile 是单 syscall 原子追加，runAgent 同会话串行执行，无并发碰撞。
 */
export const appendUndoRecord = async (record: UndoRecord, sessionId: string): Promise<void> => {
    // ★ 互斥：与 markRestored 串行，避免并发覆写抹掉刚追加的记录
    return withUndoLock(sessionId, async () => {
        const enriched: UndoRecord = {
            ...record,
            timestamp: record.timestamp ?? new Date().toISOString(),
            bornDate: record.bornDate ?? getTodayDateString(),
        };
        const p = await getUndoIndexPath(sessionId);
        const line = JSON.stringify(enriched) + "\n";
        await fs.appendFile(p, line, { encoding: "utf-8", mode: 0o600 }); // ★ S-4：undo 索引限 0600（含文件路径等结构信息）
    });
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
    // ★ 互斥：与 appendUndoRecord 串行，避免"读→(并发追加)→写回"丢失更新（主/子 agent 共享同一 rootId jsonl）
    return withUndoLock(sessionId, async () => {
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
                // 原子替换：写临时文件 → rename（POSIX rename 原子；Windows 同盘 rename 同样原子）。
                // 避免 fs.writeFile 覆写中途崩溃/断电留下半截损坏 jsonl，导致整份会话索引不可读（readUndoIndex 会跳过损坏行）。
                const content = lines.join("\n").replace(/\n*$/, "\n"); // 显式补末尾换行，避免首条追加与原末行粘连
                const tmp = fp + ".tmp";
                await fs.writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 }); // ★ S-4：undo 索引限 0600
                await fs.rename(tmp, fp);
            }
        }
    });
};
