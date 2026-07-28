/**
 * @file tool/registry/undo.ts
 * @description Undo 工具集：
 *  - undo_list  (SAFE)：列出当前会话可回退项（按时间倒序），纯读免审；
 *  - undo_restore (MUTATION)：按 undoId 或最近一项回退文件/目录变更，需用户审批。
 *  拆成两个工具，避免 list 误触发审批（MUTATION/DANGER 统一审批会在调度层拦截）。
 */
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { listUndoable, restoreByUndoId, restoreLast, findByUndoIdPrefix } from "../undo/restore.ts";

export const undoTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "undo_list",
            description: "列出当前会话内所有可回退的文件/目录变更（由 edit_file/write_file/create_file/delete_path 产生），按时间倒序。返回每项的 undoId（前8位）、操作类型、相对路径、时间。仅查看，不改文件。回退请用 undo_restore。",
            parameters: {
                type: "object",
                properties: {},
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(_args: any, ctx: ToolContext): Promise<string> {
                if (!ctx?.sessionId) return `❌ [undo_list 失败]：缺少会话上下文。`;
                const list = await listUndoable(ctx.sessionId);
                if (!list.length) return `（当前会话没有可回退的变更。）`;
                const lines = list.map((r, i) =>
                    `${i + 1}. undoId=${r.undoId.slice(0, 8)} · ${r.operationType} · ${r.relativePath} · ${r.timestamp}`
                );
                return `[可回退项 ${list.length} 条，按时间倒序]\n${lines.join("\n")}\n\n用 undo_restore(undoId=...) 精确回退，或 undo_restore(restore_last=true) 回退最近一项。`;
            },
        },
    },
    {
        type: "function",
        function: {
            name: "undo_restore",
            description: "回退本会话内的一次文件/目录变更：恢复被覆盖的旧内容、删除新建的文件、或还原被删除的目录树。回退本身会再做一次备份，因此支持“撤销撤销”。若目标文件自备份后被其他操作改写，回退会拒绝以防脏写。仅在用户明确要求撤销/回退/复原时调用，不得主动撤销用户已确认的变更。",
            parameters: {
                type: "object",
                properties: {
                    undoId: { type: "string", description: "要回退的具体记录 undoId（来自 undo_list，可只填前 8 位前缀）" },
                    restore_last: { type: "boolean", description: "设为 true 则回退最近一条未回退过的变更（无需 undoId）" },
                },
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: any) =>
                args?.restore_last
                    ? `申请回退最近一次文件变更（restore_last）。该操作会改写磁盘文件。`
                    : `申请回退文件变更（undoId=${String(args?.undoId ?? "").slice(0, 8)}）。该操作会改写磁盘文件。`,
            async execute(args: any, ctx: ToolContext): Promise<string> {
                if (!ctx?.sessionId) return `❌ [undo_restore 失败]：缺少会话上下文。`;
                try {
                    if (args?.restore_last) return await restoreLast(ctx.sessionId);
                    if (!args?.undoId) return `❌ [undo_restore 失败]：需提供 undoId，或设 restore_last=true。`;
                    // 支持前缀匹配（用户/模型可能只填前 8 位）
                    const target = await findByUndoIdPrefix(ctx.sessionId, String(args.undoId));
                    if (!target) return `❌ [undo_restore 失败]：找不到 undoId 前缀 "${args.undoId}" 对应的记录，请用 undo_list 核对。`;
                    return await restoreByUndoId(target.undoId, ctx.sessionId);
                } catch (e: any) {
                    return `❌ [undo_restore 失败]：${e?.message ?? e}`;
                }
            },
        },
    },
];
