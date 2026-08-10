/**
 * @file tool/undo/store.ts
 * @description Undo 备份落盘路径计算：[dataDir]/undo/[userWorkspaceDir]/[主sessionId]/ 下，
 *  含索引 jsonl + backups/<undoId>/ 内容目录 + 全局清理冷时钟。与 observability/store.ts 同构。
 *  所有把 sessionId/undoId 转成磁盘路径段的函数首行均走 assertSafeSessionId 硬守路径穿越。
 */
import { appConfig } from "@/config/index.ts";
import path from "path";
import fs from "fs/promises";
import { getFileName, assertSafeSessionId } from "@/common/index.ts";
import { getTodayDateString } from "@/observability/traceCalculate.ts";

/** Undo 物理根目录（所有工作区的 undo 数据归此下）。 */
export const getUndoRootPath = (): string => path.join(appConfig.dataDir, 'undo');

/** 全局清理冷时钟路径（独立于会话目录，保护会话状态——与 trace 的 getGlobalClockPath 对称）。 */
export const getUndoClockPath = (): string => path.join(getUndoRootPath(), 'undo-cleanup-clock.json');

/**
 * 某会话的 undo 归档目录（剥子 agent 后缀归并到主会话，与 trace.getTraceDirPath 对称）。
 * 纯路径计算 + 安全校验，不创建目录（创建由 ensureUndoDir / getUndoIndexPath 负责）。
 */
export const getUndoDirPath = (mainSessionId: string): string => {
    const rootId = getFileName(mainSessionId);
    assertSafeSessionId(rootId, "undoSessionId");
    return path.join(getUndoRootPath(), appConfig.userWorkspaceDir, rootId);
};

/** 某会话的备份内容根目录 backups/（其下按 undoId 隔离）。 */
export const getUndoBackupRoot = (mainSessionId: string): string =>
    path.join(getUndoDirPath(mainSessionId), 'backups');

/** 确保某会话的 undo 归档目录存在。 */
export const ensureUndoDir = async (mainSessionId: string): Promise<void> => {
    await fs.mkdir(getUndoDirPath(mainSessionId), { recursive: true, mode: 0o700 }); // ★ S-4：undo 归档目录限 0700（备份含源码/可能含密钥内容）
};

/**
 * 解析某会话的 undo 索引 jsonl 路径（跨天断流继承 + 出生日期前缀，与 trace.getTraceStorePath 同构）。
 * 已存在以 __主id 结尾的 jsonl 则继承复用（跨天不断流），否则以今天日期为初生烙印新建。
 */
export const getUndoIndexPath = async (mainSessionId: string): Promise<string> => {
    const rootId = getFileName(mainSessionId);
    assertSafeSessionId(rootId, "undoSessionId");
    const dir = getUndoDirPath(mainSessionId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 }); // ★ S-4：undo 归档目录限 0700
    const files = await fs.readdir(dir);
    const existedFile = files.find(f => f.endsWith(`__${rootId}.jsonl`));
    const fileName = existedFile ?? `undo-${getTodayDateString()}__${rootId}.jsonl`;
    return path.join(dir, fileName);
};
