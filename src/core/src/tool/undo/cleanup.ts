/**
 * @file tool/undo/cleanup.ts
 * @description Undo 自适应清理：克隆 observability/trace.ts 的双闸（3天/容量）清理模式，
 *  参数化为 undo 自己的 retention/clock/正则/容量；并联动 gcOrphanBackups 清理无索引的内容备份。
 *  全程旁路 fire-and-forget，绝不阻塞主业务；冷时钟跨重启持久化。
 *
 *  与 trace 的差异：水位用递归字节统计（undo 含 backups/ 子目录，比 trace 的扁平 jsonl 更深）；
 *  清理后必须联动 gcOrphanBackups，否则"索引删了内容残留"会让水位永远降不下来。
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { appConfig } from "@/config/index.ts";
import { getUndoRootPath, getUndoClockPath } from "./store.ts";

// ==================== 🛠️ 双闸控制常数（与 trace.ts 同构） ====================
/** 大扫除物理冷却：3 天，限制磁盘扫描频次。 */
const CLEANUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
/** 活跃宽限：近 1 天仍被写的索引视为存活会话，软规则放过。 */
const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1000;
/** 容量硬回收目标：清到上限的 80% 再停手，避免边缘抖动。 */
const SIZE_RECLAIM_TARGET_RATIO = 0.8;
/** 容量闸冷却：刚回收过短期内不重复全量扫描。 */
const SIZE_CLEANUP_COOLDOWN_MS = 60 * 1000;

// ==================== ⚡ 进程级内存水位缓存（热路径零 IO） ====================
let workspaceUndoBytes = -1;
let diskLastCleanupAt = 0;
let clockLoaded = false;
let lastSizeCleanupAt = 0;
let cleanupInProgress = false;

/** 进程级单次加载磁盘冷时钟（只读一次，之后全程内存比对）。 */
const ensureClockLoaded = async (): Promise<void> => {
    if (clockLoaded) return;
    clockLoaded = true;
    try {
        const rawClock = await fs.readFile(getUndoClockPath(), "utf-8");
        diskLastCleanupAt = JSON.parse(rawClock).lastCleanupAt || 0;
    } catch {
        diskLastCleanupAt = 0; // 首次冷启动 / clock 损坏，安全降级为「从未清理」
    }
};

/**
 * 递归统计目录下所有文件总字节（undo 含 backups/ 子目录，需递归；
 *  trace 的 getDirBytes 仅算顶层，对 undo 的深层结构不准）。
 */
const getDirBytesRecursive = async (dir: string): Promise<number> => {
    let total = 0;
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            total += await getDirBytesRecursive(full);
        } else if (e.isFile()) {
            try { total += (await fs.stat(full)).size; } catch { /* ignore */ }
        }
    }
    return total;
};

/**
 * 每次备份追加后 fire-and-forget 调用。互斥锁防并发堆积；时间闸(3天)+容量闸双触发；
 * 软规则(过期+活跃宽限) → 硬驱逐(mtime 强删) → gcOrphanBackups(孤儿内容) 三阶清理。
 */
export async function maybeCleanupAfterUndoAppend(_sessionId: string): Promise<void> {
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    try {
        await ensureClockLoaded();
        const now = Date.now();
        const maxBytes = appConfig.undoMaxFolderBytes ?? (50 * 1024 * 1024);
        if (workspaceUndoBytes < 0) workspaceUndoBytes = await getDirBytesRecursive(getUndoRootPath());

        const isTimeExpired = (now - diskLastCleanupAt > CLEANUP_INTERVAL_MS);
        const isSizeOverflow = workspaceUndoBytes > maxBytes;
        if (!isTimeExpired && !isSizeOverflow) return;
        // 容量闸冷却：软规则可能清不动（全在活跃宽限），冷却期内不重复扫描；时间闸不受冷却限制
        if (isSizeOverflow && !isTimeExpired && (now - lastSizeCleanupAt < SIZE_CLEANUP_COOLDOWN_MS)) return;

        const reason = (isTimeExpired && isSizeOverflow) ? '容量+时间双闸' : isSizeOverflow ? '容量越过上限' : '3天冷却周期已满';
        console.log(`🧹 [Undo运维] 触发自适应清理（原因: ${reason}）`);

        let deleted = await cleanupOldUndoFiles();
        workspaceUndoBytes = await getDirBytesRecursive(getUndoRootPath());
        if (workspaceUndoBytes > maxBytes) {
            deleted += await evictOldestForSize(Math.floor(maxBytes * SIZE_RECLAIM_TARGET_RATIO));
            workspaceUndoBytes = await getDirBytesRecursive(getUndoRootPath());
        }
        // 联动清理孤儿内容备份（索引删了内容必删，否则水位永远降不下）
        deleted += await gcOrphanBackups();
        workspaceUndoBytes = await getDirBytesRecursive(getUndoRootPath());

        lastSizeCleanupAt = now;
        diskLastCleanupAt = now;
        const clockPath = getUndoClockPath();
        await fs.mkdir(path.dirname(clockPath), { recursive: true });
        await fs.writeFile(clockPath, JSON.stringify({ lastCleanupAt: now, updatedAt: new Date().toISOString() }, null, 2), "utf-8");

        if (deleted > 0) console.log(`✨ [Undo运维] 共销毁 ${deleted} 个 undo 资产（索引 + 孤儿内容），磁盘水位回落。`);
    } catch (e: any) {
        console.warn("⚠️ [Undo运维] 自动清理异常，已跳过:", e?.message ?? e);
    } finally {
        cleanupInProgress = false;
    }
}

/** 软规则：删出生日期过线（今天 − retentionDays）且已不活跃的索引 jsonl。 */
async function cleanupOldUndoFiles(): Promise<number> {
    const dir = getUndoRootPath();
    const retentionDays = Math.max(1, appConfig.undoRetentionDays ?? 7);
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const now = Date.now();
    let relativePaths: string[];
    try { relativePaths = await fs.readdir(dir, { recursive: true }); } catch { return 0; }

    const re = /^undo-(\d{4}-\d{2}-\d{2})__([\w-]+)\.jsonl$/;
    let deleted = 0;
    for (const rp of relativePaths) {
        const fileName = path.basename(rp);
        const m = fileName.match(re);
        if (!m) continue;
        const fileBornDay = new Date(`${m[1]}T00:00:00`);
        if (fileBornDay >= cutoff) continue; // ① 出生日未过线 → 放过
        const fullPath = path.join(dir, rp);
        try {
            const st = await fs.stat(fullPath);
            if (now - st.mtimeMs < ACTIVE_GRACE_MS) continue; // ② 仍活跃 → 放过
            await fs.unlink(fullPath);
            deleted += 1;
        } catch { /* 并发动过等，忽略 */ }
    }
    return deleted;
}

/** 硬驱逐兜底：容量仍超时按 mtime 升序强删最旧索引 jsonl 到目标水位（越过活跃保护，保磁盘最后手段）。 */
async function evictOldestForSize(targetBytes: number): Promise<number> {
    const dir = getUndoRootPath();
    let relativePaths: string[];
    try { relativePaths = await fs.readdir(dir, { recursive: true }); } catch { return 0; }
    const re = /^undo-(\d{4}-\d{2}-\d{2})__([\w-]+)\.jsonl$/;
    const candidates: { mtime: number; fullPath: string; size: number }[] = [];
    for (const rp of relativePaths) {
        if (!re.test(path.basename(rp))) continue; // 只动 undo 自己的文件，绝不误伤 clock 等
        try {
            const st = await fs.stat(path.join(dir, rp));
            candidates.push({ mtime: st.mtimeMs, fullPath: path.join(dir, rp), size: st.size });
        } catch { /* ignore */ }
    }
    candidates.sort((a, b) => a.mtime - b.mtime);
    let totalBytes = candidates.reduce((sum, c) => sum + c.size, 0);
    let deleted = 0;
    for (const c of candidates) {
        if (totalBytes <= targetBytes) break;
        try { await fs.unlink(c.fullPath); totalBytes -= c.size; deleted += 1; } catch { /* ignore */ }
    }
    if (deleted > 0) console.warn(`⚠️ [Undo运维] 容量硬驱逐：越过活跃保护强删 ${deleted} 个最旧 undo 索引（磁盘压力兜底）。`);
    return deleted;
}

/**
 * 孤儿内容备份回收：扫描所有会话的 backups/<undoId>/，若该 undoId 不出现在任何现存索引 jsonl 中，
 * 则整目录删除。防止"索引删了内容残留"的磁盘泄漏。
 */
export async function gcOrphanBackups(): Promise<number> {
    const root = getUndoRootPath();
    let deleted = 0;
    let workspaces: string[];
    try { workspaces = await fs.readdir(root); } catch { return 0; }
    for (const ws of workspaces) {
        const wsDir = path.join(root, ws);
        let stWs;
        try { stWs = await fs.stat(wsDir); } catch { continue; }
        if (!stWs.isDirectory()) continue;
        let sessions: string[];
        try { sessions = await fs.readdir(wsDir); } catch { continue; }
        for (const sess of sessions) {
            const sessDir = path.join(wsDir, sess);
            // 收集该会话所有"仍存活"的 undoId（来自现存索引）
            const liveIds = new Set<string>();
            let files: string[];
            try { files = await fs.readdir(sessDir); } catch { continue; }
            for (const f of files) {
                if (!f.startsWith("undo-") || !f.endsWith(".jsonl")) continue;
                try {
                    const raw = await fs.readFile(path.join(sessDir, f), "utf-8");
                    for (const line of raw.split("\n")) {
                        const t = line.trim();
                        if (!t) continue;
                        try {
                            const id = (JSON.parse(t) as { undoId?: string }).undoId;
                            if (id) liveIds.add(id);
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // 扫 backups/，删不在存活集合里的孤儿
            const backupsDir = path.join(sessDir, "backups");
            let undoDirs: string[];
            try { undoDirs = await fs.readdir(backupsDir); } catch { continue; }
            for (const ud of undoDirs) {
                if (liveIds.has(ud)) continue;
                try { await fs.rm(path.join(backupsDir, ud), { recursive: true, force: true }); deleted += 1; } catch { /* ignore */ }
            }
        }
    }
    return deleted;
}
