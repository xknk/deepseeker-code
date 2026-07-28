/**
 * @file tool/undo/restore.ts
 * @description 回退分发：listUndoable / restoreByUndoId / restoreLast / dispatchRestore 等。
 *  覆盖式回退前做脏写检测（contentHashBefore 比对当前磁盘），回退前生成反向备份支持"撤销撤销"。
 *  所有目标路径一律重走 resolveSafePath（不缓存），防跨工作区越界；写前夕 assertWithinWorkspace。
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { resolveSafePath, assertWithinWorkspace } from "../guard.ts";
import { getUndoBackupRoot } from "./store.ts";
import { readUndoIndex, markRestored, appendUndoRecord } from "./index.ts";
import { hashTreeManifest } from "./backup.ts";
import { createUUID } from "@/common/index.ts";
import { getTodayDateString } from "@/observability/traceCalculate.ts";
import { UndoRecord } from "./type.ts";

const sha1File = async (absPath: string): Promise<string> => {
    const buf = await fs.readFile(absPath);
    return crypto.createHash('sha1').update(buf).digest('hex');
};

/** 列出会话内所有未回退的可回退项（时间倒序，最新在前）。 */
export const listUndoable = async (sessionId: string): Promise<UndoRecord[]> => {
    const all = await readUndoIndex(sessionId); // 升序（旧→新）
    return all.filter(r => !r.restored).reverse(); // 倒序（新→旧）
};

/** 最近一条可回退（LIFO）。 */
export const findLastRestorable = async (sessionId: string): Promise<UndoRecord | undefined> => {
    const list = await listUndoable(sessionId);
    return list[0];
};

/** 按 undoId 精确查找（含已回退的，便于上层报错提示）。 */
export const findByUndoId = async (sessionId: string, undoId: string): Promise<UndoRecord | undefined> => {
    const all = await readUndoIndex(sessionId);
    return all.find(r => r.undoId === undoId);
};

/** 按 undoId 精确优先，否则前缀匹配（用户/模型常只填前 8 位）。 */
export const findByUndoIdPrefix = async (sessionId: string, prefix: string): Promise<UndoRecord | undefined> => {
    const all = await readUndoIndex(sessionId);
    return all.find(r => r.undoId === prefix) ?? all.find(r => r.undoId.startsWith(prefix));
};

/** 按 undoId 精确回退。 */
export const restoreByUndoId = async (undoId: string, sessionId: string): Promise<string> => {
    const target = await findByUndoId(sessionId, undoId);
    if (!target) return `❌ [undo 失败]：找不到 undoId=${undoId.slice(0, 8)} 的记录，请用 undo_list 核对。`;
    if (target.restored) return `❌ [undo 失败]：该记录已被回退过（undoId=${undoId.slice(0, 8)}）。`;
    return doRestore(target, sessionId);
};

/** 回退最近一条未回退过的变更。 */
export const restoreLast = async (sessionId: string): Promise<string> => {
    const target = await findLastRestorable(sessionId);
    if (!target) return `ℹ️ 当前会话没有可回退的变更。`;
    return doRestore(target, sessionId);
};

/**
 * 回退单步：前置检查（目录已存在拒绝）→ 软警告（有更新变更）→ 反向备份 → 分发还原 → 标记已回退 → 追加反向记录。
 * 反向备份在还原之前（备份"回退前的当前态"）；还原抛错则记录不标记、可重试，反向备份成孤儿由清理回收。
 *
 * 注：不做"当前磁盘 hash vs 备份前 hash"的硬脏写拒绝——那会误拒正常的覆盖式回退：备份记录的是
 *   execute 前的原内容，回退后磁盘必然与之不同。改为"软警告 + 反向备份"保证可逆，而非硬拒绝。
 */
async function doRestore(target: UndoRecord, sessionId: string): Promise<string> {
    // 前置检查：目录回退时目标已存在 → 拒绝（保守，不覆盖用户新建的目录树）
    if (target.backupKind === 'directory_tree') {
        const abs = resolveSafePath(target.relativePath);
        let exists = false; try { await fs.access(abs); exists = true; } catch { /* 不存在 */ }
        if (exists) return `❌ [undo 拒绝]：目标路径 [${target.relativePath}] 已存在，拒绝覆盖。请先手动处理（删除或改名）后重试。`;
    }
    // 软警告：该文件在本次备份之后是否还有更新的未回退变更（提示回退顺序，不阻断）
    const newerWarning = await checkNewerChange(target, sessionId);

    const reverseId = await ensureReverseBackup(target, sessionId);
    let msg: string;
    try {
        msg = await dispatchRestore(target);
    } catch (e: any) {
        // 还原失败：保持记录未回退（可重试）；reverseId 若已生成则成孤儿，由 gcOrphanBackups 回收
        throw new Error(`回退执行失败（记录未标记已回退，可重试）: ${e?.message ?? e}`);
    }
    await markRestored(sessionId, target.undoId, reverseId ?? undefined);
    if (reverseId) await appendReverseRecord(target, reverseId, sessionId);
    return `✅ [undo 成功]：${msg}${reverseId ? `\n（反向备份 ${reverseId.slice(0, 8)} 已生成，可再次 undo_restore 回退此回退）` : ''}${newerWarning}`;
}

/**
 * 软警告检查：该 relativePath 在 target 之后是否还有更新的、未回退的变更。
 * 用于提示用户回退顺序（建议先回退最新的）。不阻断回退——反向备份已保证可逆。
 */
async function checkNewerChange(target: UndoRecord, sessionId: string): Promise<string> {
    const all = await readUndoIndex(sessionId);
    const hasNewer = all.some(r =>
        r.undoId !== target.undoId &&
        !r.restored &&
        r.relativePath === target.relativePath &&
        (r.timestamp || "") > (target.timestamp || "")
    );
    return hasNewer
        ? `\n⚠️ 注意：[${target.relativePath}] 在此次备份之后还有更新的未回退变更。本次回退会覆盖它们（已生成反向备份，可反向回退恢复）；若要按顺序回退，建议先回退最新的一项（undo_restore restore_last=true）。`
        : "";
}

/**
 * 反向备份：回退前把当前磁盘态再存一份，支持"撤销撤销"。仅当目标存在且内容与备份前不同时才存。
 * creation_marker 无原内容可存 → 不生成反向。
 */
async function ensureReverseBackup(target: UndoRecord, sessionId: string): Promise<string | null> {
    if (target.backupKind === 'creation_marker') return null;
    let absPath: string;
    try { absPath = resolveSafePath(target.relativePath); } catch { return null; }
    let exists = true; try { await fs.access(absPath); } catch { exists = false; }
    if (!exists) return null;

    // 当前内容与备份前一致 → 回退等于无操作，无需反向
    if (target.contentHashBefore) {
        try {
            const curHash = target.backupKind === 'directory_tree' ? hashTreeManifest(absPath) : await sha1File(absPath);
            if (curHash === target.contentHashBefore) return null;
        } catch { /* 比对失败则照常反向备份 */ }
    }

    const reverseId = createUUID();
    const reverseDir = path.join(getUndoBackupRoot(sessionId), reverseId);
    await fs.mkdir(reverseDir, { recursive: true, mode: 0o700 });
    assertWithinWorkspace(absPath);
    const st = await fs.stat(absPath);
    if (st.isDirectory()) {
        fsSync.cpSync(absPath, path.join(reverseDir, 'tree'), { recursive: true, preserveTimestamps: true });
    } else {
        await fs.writeFile(path.join(reverseDir, 'content'), await fs.readFile(absPath));
    }
    return reverseId;
}

/** 实际还原分发（假定前置检查已过）。 */
async function dispatchRestore(r: UndoRecord): Promise<string> {
    const absPath = resolveSafePath(r.relativePath);
    assertWithinWorkspace(absPath); // 写前夕 TOCTOU 复检

    switch (r.backupKind) {
        case 'creation_marker': {
            await fs.rm(absPath, { force: true });
            return `已删除新建文件 [${r.relativePath}]`;
        }
        case 'file_content': {
            // 父目录可能已被删，先重建
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            const backupAbs = path.join(getUndoBackupRoot(r.sessionId), r.undoId, 'content');
            const content = await fs.readFile(backupAbs);
            await fs.writeFile(absPath, content);
            return `已恢复 [${r.relativePath}] 至备份前内容（${r.fileSizeBefore ?? content.byteLength} 字节）`;
        }
        case 'directory_tree': {
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            const src = path.join(getUndoBackupRoot(r.sessionId), r.undoId, 'tree');
            fsSync.cpSync(src, absPath, { recursive: true, preserveTimestamps: true });
            return `已恢复目录树 [${r.relativePath}]（约 ${r.fileSizeBefore ?? 0} 字节）`;
        }
    }
}

/** 追加一条反向 UndoRecord，让用户能沿 reverseUndoId 链"撤销撤销"。 */
async function appendReverseRecord(target: UndoRecord, reverseId: string, sessionId: string): Promise<void> {
    const kind = target.backupKind === 'directory_tree' ? 'tree' : 'content';
    const reverseRecord: UndoRecord = {
        undoId: reverseId,
        toolsId: target.toolsId,
        sessionId,
        operationType: target.operationType,
        relativePath: target.relativePath,
        backupKind: target.backupKind,
        backupPath: path.join(getUndoBackupRoot(sessionId), reverseId, kind),
        contentHashBefore: target.contentHashBefore,
        fileSizeBefore: target.fileSizeBefore,
        timestamp: new Date().toISOString(),
        bornDate: getTodayDateString(),
        restored: false,
    };
    await appendUndoRecord(reverseRecord, sessionId);
}
