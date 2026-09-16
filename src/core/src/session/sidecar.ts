/**
 * @file session/sidecar.ts
 * @description 工具结果侧车存档的共享契约（写侧 agent/toolExecution / 读侧 tool/registry/recall 收口）：
 *  超预算工具结果在【脱敏后、截断前】落盘 <会话目录>/tool-outputs/<tool_call_id>.txt，
 *  recall 工具传 with_full=<tool_call_id> 分页取回全文（见 recall-archive-architecture：侧车是缓存
 *  定位、非真相源；落盘时机必须在脱敏之后——安全红线）。
 *  此前「截断标记关键词 / tool_call.id 清洗 / 侧车路径拼装」在写读两文件各自硬编码——一侧改动即
 *  静默失去 with_full 取回能力（隐式字符串契约，2026-09-16 评审登记）。本模块同时承担写盘单点：
 *  目录 ensure 缓存 + 按会话总量闸（防超长输出高频时磁盘无界增长，此前只随 deleteSession 整目录清理）。
 */
import fs from "fs/promises";
import path from "path";
import { getSessionsDirPath } from "./store.ts";

/** 截断标记关键词：工具结果截断提示行含此串 → recall 据此标注 with_full 可取回（写读两侧共用，勿单独改文案）。 */
export const SIDECAR_ARCHIVED_MARK = "完整原文已存档";

/** 截断标记整行（工具结果视图用）：告知模型截断原文已存档、with_full 取回。 */
export const sidecarArchivedNote = (toolCallId: string): string =>
    `${SIDECAR_ARCHIVED_MARK}，recall 工具传 with_full="${toolCallId}" 可取回`;

/** tool_call.id 白名单清洗（id 来自模型，防路径注入）：写/读两侧共用同一口径。 */
export const safeSidecarId = (id: unknown): string => String(id).replace(/[^A-Za-z0-9_-]/g, "");

/** 侧车存档文件路径：<会话目录>/tool-outputs/<safeId>.txt（内容 = 脱敏后、截断前的工具原文）。 */
export const getToolOutputSidecarPath = (sessionId: string, toolCallId: string): string =>
    path.join(getSessionsDirPath(sessionId), "tool-outputs", `${safeSidecarId(toolCallId)}.txt`);

/** 会话目录下 tool-outputs 侧车目录路径。 */
export const getToolOutputSidecarDir = (sessionId: string): string =>
    path.join(getSessionsDirPath(sessionId), "tool-outputs");

// ★ 侧车目录 ensure 缓存：原实现每次写侧车都 fs.mkdir(recursive)——目录首次建立后进程内不会再消失
//   （deleteSession 删的是整个会话目录，该会话此后不再写侧车），重复 mkdir 是纯浪费系统调用。
//   与 store.ts ensuredSessionDirs / observability ensuredTraceDirs 同款模式。（自 toolExecution.ts 收拢）
const ensuredSidecarDirs = new Set<string>();

/** 按会话总量闸（字节）：tool-outputs 目录累计超限时淘汰最旧存档（最久远的最不可能被 recall 取回）。 */
export const SIDECAR_SESSION_CAP_BYTES = 64 * 1024 * 1024;

/** 列举侧车目录现存档（名称/大小/mtime）；目录不存在返回空。 */
const listSidecarFiles = async (dir: string): Promise<Array<{ name: string; size: number; mtimeMs: number }>> => {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
        try {
            const st = await fs.stat(path.join(dir, name));
            if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* 单文件 stat 失败跳过（并发清理窗口） */ }
    }
    return out;
};

/**
 * 侧车存档写盘单点（原 toolExecution 内联逻辑收拢）：
 *  ① ensure 目录（进程内缓存）；② 按会话总量闸淘汰最旧存档（总量 + 本次写入超 SIDECAR_SESSION_CAP_BYTES
 *  时按 mtime 旧→新删，直到放下或清空——闸只防磁盘无界增长，不做精确配额）；③ 写入全文。
 *  @param opts.capBytes 总量闸覆盖（单测用；缺省 SIDECAR_SESSION_CAP_BYTES）
 *  @returns 拼进截断标记行的提示（sidecarArchivedNote）；失败仅告警降级为普通截断提示，绝不阻断回灌。
 */
export const writeSidecarArchive = async (
    sessionId: string,
    toolCallId: string,
    content: string,
    opts?: { capBytes?: number },
): Promise<string | undefined> => {
    try {
        const dir = getToolOutputSidecarDir(sessionId);
        if (!ensuredSidecarDirs.has(dir)) {
            await fs.mkdir(dir, { recursive: true });
            ensuredSidecarDirs.add(dir);
        }
        const cap = opts?.capBytes ?? SIDECAR_SESSION_CAP_BYTES;
        const incoming = Buffer.byteLength(content, "utf-8");
        const files = await listSidecarFiles(dir);
        const total = files.reduce((s, f) => s + f.size, 0);
        if (total + incoming > cap) {
            const byOldest = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
            let freed = 0;
            for (const f of byOldest) {
                if (total - freed + incoming <= cap) break;
                try { await fs.unlink(path.join(dir, f.name)); freed += f.size; } catch { /* 已被并发删除 */ }
            }
        }
        await fs.writeFile(getToolOutputSidecarPath(sessionId, toolCallId), content, "utf-8");
        return sidecarArchivedNote(toolCallId);
    } catch (e) {
        console.warn("⚠️ [sidecar] 工具原文存档失败（已降级为普通截断提示）:", e instanceof Error ? e.message : e);
        return undefined;
    }
};
