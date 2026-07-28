/**
 * @file tool/undo/backup.ts
 * @description 写前备份入口 beforeMutationBackup：在 edit/write/create/delete 真正写盘前，
 *  快照原文件/目录到 backups/<undoId>/，写索引，触发清理。
 *  失败一律抛 Error —— 由 runAgent 据此阻断写入（凡改必可回退），绝不让异常逃逸成"静默放行"。
 *  备份内容文件名只用 undoId（UUID 白名单），relativePath 不参与路径拼接（防 ../ 越界）。
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { appConfig } from "@/config/index.ts";
import { createUUID } from "@/common/index.ts";
import { resolveSafePath, assertWithinWorkspace } from "../guard.ts";
import { getUndoBackupRoot, ensureUndoDir } from "./store.ts";
import { appendUndoRecord } from "./index.ts";
import { maybeCleanupAfterUndoAppend } from "./cleanup.ts";
import { getTodayDateString } from "@/observability/traceCalculate.ts";
import { UndoRecord, UndoOperationType } from "./type.ts";

/** 受 Undo 管理的变更工具名单（单一来源，供 runAgent 与本模块共用判断）。 */
const MUTATION_TOOLS = new Set<UndoOperationType>(['edit_file', 'write_file', 'create_file', 'delete_path']);

/** 判定某工具是否触发 Undo 写前备份（供 runAgent 调度层调用）。 */
export const isUndoTrigger = (toolName: string): boolean =>
    MUTATION_TOOLS.has(toolName as UndoOperationType);

/** Buffer 的 SHA-1 hex。 */
const sha1Buf = (buf: Buffer): string => crypto.createHash('sha1').update(buf).digest('hex');

/** 截断字符串到 n 字符（带省略号），用于 argsSnapshot 的人可读提示。 */
const truncate = (s: string | undefined, n = 200): string | undefined =>
    (s === undefined) ? undefined : (s.length > n ? s.slice(0, n) + "…" : s);

/**
 * 敏感文件 glob 判定（.env / 私钥 / 凭证 / 密钥库等），命中则按 undoBackupSensitive 策略处置。
 * 注：这是 undo 专属的隐私防线——备份是字节级全量，敏感文件若明文落盘 7 天风险较高。
 */
const isSensitivePath = (rel: string): boolean => {
    const p = rel.toLowerCase().replace(/\\/g, '/');
    return [
        /\.env(\.|$|\/)/,
        /\.pem$/, /\.key$/,
        /(^|\/)id_(rsa|ecdsa|ed25519|dsa)(\.pub)?$/,   // SSH 私钥（含子目录路径，如 deploy_keys/id_rsa）
        /secrets?\.(json|ya?ml|toml|ini|conf)$/i,
        /credentials?\.(json|ya?ml|toml|ini|conf)$/i,
        /\.pfx$/, /\.p12$/, /\.keystore$/, /\.jks$/,
    ].some(re => re.test(p));
};

/** 目录 manifest 哈希：文件相对路径 + 各文件 sha1 拼接后再 sha1，用于目录的脏写检测。异步实现避免大目录阻塞事件循环。 */
export const hashTreeManifest = async (dir: string): Promise<string> => {
    const h = crypto.createHash('sha1');
    const walk = async (d: string) => {
        let entries: fsSync.Dirent[];
        try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            const full = path.join(d, e.name);
            const rel = path.relative(dir, full).replace(/\\/g, '/');
            if (e.isDirectory()) { h.update(`D ${rel}\n`); await walk(full); }
            else if (e.isFile()) {
                try { h.update(`F ${rel} ${sha1Buf(await fs.readFile(full))}\n`); } catch { /* ignore */ }
            }
        }
    };
    await walk(dir);
    return h.digest('hex');
};

/** 目录总字节（递归）。 */
const getDirTreeBytes = async (dir: string): Promise<number> => {
    let total = 0;
    let entries: fsSync.Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) total += await getDirTreeBytes(full);
        else if (e.isFile()) { try { total += (await fs.stat(full)).size; } catch { /* ignore */ } }
    }
    return total;
};

type CommonFields = Pick<UndoRecord, 'undoId' | 'toolsId' | 'sessionId' | 'operationType' | 'relativePath' | 'timestamp' | 'bornDate'>;

/**
 * 写前备份入口。返回 UndoRecord（已备份并写索引）；
 * 若 undo 关闭或敏感策略 skip 则返回 null（直通写入，该次不可回退）。
 * 备份失败一律抛 Error —— 调用方（runAgent）据此阻断写入（凡改必可回退）。
 */
export async function beforeMutationBackup(
    toolName: string,
    args: any,
    toolCallId: string,
    sessionId: string,
): Promise<UndoRecord | null> {
    if (appConfig.undoEnabled === false) return null;
    if (!MUTATION_TOOLS.has(toolName as UndoOperationType)) {
        throw new Error(`[undo] 不在变更工具名单: ${toolName}`);
    }
    const relativePath = String(args?.path ?? "").replace(/\\/g, "/");

    // 敏感文件策略（隐私防线）
    if (relativePath && isSensitivePath(relativePath)) {
        const policy = appConfig.undoBackupSensitive ?? 'skip';
        if (policy === 'skip') return null; // 不备份，直通写入（该次不可回退）
        if (policy === 'deny') throw new Error(`敏感文件 [${relativePath}] 按策略(undoBackupSensitive=deny)拒绝备份，写入已阻断`);
        // 'allow' 继续
    }

    await ensureUndoDir(sessionId);
    const undoId = createUUID();
    const undoDir = path.join(getUndoBackupRoot(sessionId), undoId);
    const now = new Date();
    const common: CommonFields = {
        undoId,
        toolsId: toolCallId,
        sessionId,
        operationType: toolName as UndoOperationType,
        relativePath,
        timestamp: now.toISOString(),
        bornDate: getTodayDateString(),
    };

    let record: UndoRecord;
    switch (toolName) {
        case 'edit_file':
        case 'write_file': record = await backupFileOverwrite(common, undoDir, args); break;
        case 'create_file': record = await backupFileCreate(common); break;
        case 'delete_path': record = await backupDelete(common, undoDir, relativePath); break;
        default: throw new Error(`[undo] 未知工具: ${toolName}`);
    }

    await appendUndoRecord(record, sessionId);
    void maybeCleanupAfterUndoAppend(sessionId); // fire-and-forget 清理
    return record;
}

/** edit_file / write_file：原文件存在→拷贝全文；不存在→creation_marker（write_file 新建场景）。 */
async function backupFileOverwrite(common: CommonFields, undoDir: string, args: any): Promise<UndoRecord> {
    const absPath = resolveSafePath(common.relativePath);
    let exists = true;
    try { await fs.access(absPath); } catch { exists = false; }

    if (!exists) {
        // edit_file 理论不会到此（其 execute 要求 old_str 存在）；write_file 新建则记 creation_marker
        return { ...common, backupKind: 'creation_marker', backupPath: '', fileSizeBefore: 0 };
    }
    assertWithinWorkspace(absPath); // 读备份也走围栏（TOCTOU 收紧）
    const content = await fs.readFile(absPath);
    await fs.mkdir(undoDir, { recursive: true, mode: 0o700 }); // 同机用户隔离
    const contentPath = path.join(undoDir, 'content');
    await fs.writeFile(contentPath, content); // 原样字节备份，保留 CRLF
    return {
        ...common,
        backupKind: 'file_content',
        backupPath: contentPath,
        contentHashBefore: sha1Buf(content),
        fileSizeBefore: content.byteLength,
        argsSnapshot: {
            old_str: common.operationType === 'edit_file' ? truncate(args?.old_str) : undefined,
            new_str: common.operationType === 'edit_file' ? truncate(args?.new_str) : undefined,
            contentLength: typeof args?.content === "string" ? args.content.length : undefined,
        },
    };
}

/** create_file：原文件必不存在（工具语义拒覆盖）→ creation_marker，无内容需备份。 */
async function backupFileCreate(common: CommonFields): Promise<UndoRecord> {
    return { ...common, backupKind: 'creation_marker', backupPath: '', fileSizeBefore: 0 };
}

/** 递归收集目录内命中敏感判定的"相对该目录"路径（用于 delete_path 目录备份的敏感策略过滤）。
 *  wsRelDir 为该目录相对工作区的路径，用于拼出工作区相对路径后过 isSensitivePath（与单文件 beforeMutationBackup 口径一致）。 */
const collectSensitiveInDir = async (dir: string, wsRelDir: string): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (d: string) => {
        let entries: fsSync.Dirent[];
        try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { await walk(full); }
            else if (e.isFile()) {
                const relWithin = path.relative(dir, full).replace(/\\/g, "/");
                if (isSensitivePath(`${wsRelDir}/${relWithin}`)) found.push(relWithin);
            }
        }
    };
    await walk(dir);
    return found;
};

/** delete_path：文件→拷贝全文；目录→cpSync 整树（带单次体积熔断 + 敏感文件策略过滤）。 */
async function backupDelete(common: CommonFields, undoDir: string, relativePath: string): Promise<UndoRecord> {
    const absPath = resolveSafePath(relativePath);
    const st = await fs.stat(absPath);
    assertWithinWorkspace(absPath);
    await fs.mkdir(undoDir, { recursive: true, mode: 0o700 });

    if (st.isDirectory()) {
        const treeBytes = await getDirTreeBytes(absPath);
        const maxPerOp = appConfig.undoMaxBytesPerOp ?? (100 * 1024 * 1024);
        if (treeBytes > maxPerOp) {
            throw new Error(`目录 [${relativePath}] 体积约 ${treeBytes} 字节超过单次备份上限 ${maxPerOp}，写入已阻断（防磁盘拖垮；可调 undoMaxBytesPerOp 或拆分删除）`);
        }

        // ★ undo H-1 修复：顶层 relativePath 不命中 isSensitivePath，旧实现 cpSync 整树会把目录内 .env/私钥明文落盘，
        //   绕过 undoBackupSensitive 策略。此处递归扫描后按策略处置（deny 阻断 / skip 剔除 / allow 放行）。
        const policy = appConfig.undoBackupSensitive ?? 'skip';
        let sensitiveInTree: string[] = [];
        if (policy !== 'allow') {
            sensitiveInTree = await collectSensitiveInDir(absPath, relativePath);
            if (sensitiveInTree.length > 0 && policy === 'deny') {
                throw new Error(`目录 [${relativePath}] 内含敏感文件 ${sensitiveInTree.length} 个（如 ${sensitiveInTree[0]}），按策略(undoBackupSensitive=deny)拒绝备份，写入已阻断`);
            }
        }

        const treeDest = path.join(undoDir, 'tree');
        fsSync.cpSync(absPath, treeDest, { recursive: true, preserveTimestamps: true });

        // skip 策略：从备份副本剔除敏感文件（仍允许删除原目录，仅该部分不可回退）
        if (policy === 'skip' && sensitiveInTree.length > 0) {
            for (const relWithin of sensitiveInTree) {
                await fs.rm(path.join(treeDest, relWithin), { force: true }).catch(() => { /* 剔除失败不阻断 */ });
            }
        }

        return {
            ...common,
            backupKind: 'directory_tree',
            backupPath: treeDest,
            fileSizeBefore: treeBytes,
            contentHashBefore: await hashTreeManifest(absPath),
        };
    }
    const content = await fs.readFile(absPath);
    const contentPath = path.join(undoDir, 'content');
    await fs.writeFile(contentPath, content);
    return {
        ...common,
        backupKind: 'file_content',
        backupPath: contentPath,
        contentHashBefore: sha1Buf(content),
        fileSizeBefore: content.byteLength,
    };
}
