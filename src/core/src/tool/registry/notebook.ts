/**
 * @file tool/registry/notebook.ts
 * @description NotebookEdit 工具（P2-10）：编辑 Jupyter .ipynb 的 cell（replace/insert/delete、改 cell_type）。
 *
 *  严格遵循 fs 写工具范式：resolveSafePath → 改 → assertWithinWorkspace → 原子写（tmp+rename）。
 *  safetyLevel MUTATION；参数必须叫 `path`（undo 备份与 isProtectedWrite 都读 args.path）。
 *  接入 name-based undo 闸门（MUTATION_TOOLS 含 'notebook_edit'）后自动继承：写前备份、保护目录硬拒、
 *  串行调度、undo_restore 可回退（.ipynb 是单 JSON 文件，整文件字节备份/还原正确）。
 *
 *  cell.source 形式保留：原数组写数组、原串写串（减小 git diff）；insert 新 cell 默认数组形式（Jupyter 惯例）。
 */
import fs from "fs/promises";
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { resolveSafePath, assertWithinWorkspace } from "../guard.ts";
import { makeTmpPath } from "./fs.ts";

export type NotebookEditMode = "replace" | "insert" | "delete";
export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookEditOp {
    cell_id?: string;
    cell_index?: number;
    new_source?: string;
    cell_type?: NotebookCellType;
    edit_mode: NotebookEditMode;
}

/** 字符串 → nbformat 数组形式（每行含尾部 \n，末行除外）。 */
const toArraySource = (s: string): string[] => {
    const lines = s.split("\n");
    return lines.map((l, i) => (i < lines.length - 1 ? l + "\n" : l));
};

/** 按原 cell.source 形式编码新源（数组→数组、串→串），减小 git diff。 */
const encodeSource = (newSource: string, originalIsArray: boolean): string[] | string =>
    originalIsArray ? toArraySource(newSource) : newSource;

/** 新建一个 cell（insert 用），数组形式 source + 必备字段。 */
const makeCell = (cellType: NotebookCellType, source: string): any => ({
    cell_type: cellType,
    source: toArraySource(source),
    metadata: {},
    ...(cellType === "code" ? { execution_count: null, outputs: [] } : {}),
});

/**
 * 纯函数：对已解析的 notebook 对象就地应用一次 cell 编辑。抛错=操作非法（调用方 catch → ❌）。
 * @returns 人可读的编辑摘要（用于工具结果）。
 * 导出供单测。
 */
export const applyNotebookEdit = (nb: any, op: NotebookEditOp): string => {
    const cells: any[] = nb.cells;
    const hasId = op.cell_id !== undefined && op.cell_id !== null && op.cell_id !== "";
    const hasIdx = typeof op.cell_index === "number";
    // 定位目标 cell 下标（cell_id 优先于 cell_index）；-1=未定位（insert 时=末尾追加）
    let idx = -1;
    if (hasId) idx = cells.findIndex((c: any) => c.id === op.cell_id);
    else if (hasIdx) idx = op.cell_index! < 0 || op.cell_index! >= cells.length ? -1 : op.cell_index!;

    if (op.edit_mode === "delete") {
        if (idx < 0) throw new Error(hasId ? `未找到 cell_id="${op.cell_id}"` : "delete 需 cell_id 或有效 cell_index");
        const removed = cells[idx];
        cells.splice(idx, 1);
        return `已删除 cell @${idx}（${removed.cell_type}）`;
    }

    if (op.edit_mode === "insert") {
        if (op.new_source === undefined || op.new_source === null) throw new Error("insert 需 new_source");
        const cellType = op.cell_type ?? "code";
        const cell = makeCell(cellType, op.new_source);
        if (idx < 0) {
            cells.push(cell);   // 无定位 → 末尾追加
            idx = cells.length - 1;
        } else {
            cells.splice(idx, 0, cell);  // 插在目标 cell 之前
        }
        return `已插入 ${cellType} cell @${idx}`;
    }

    // replace
    if (idx < 0) throw new Error(hasId ? `未找到 cell_id="${op.cell_id}"` : "replace 需 cell_id 或有效 cell_index");
    const cell = cells[idx];
    if (op.new_source !== undefined && op.new_source !== null) {
        cell.source = encodeSource(op.new_source, Array.isArray(cell.source));
    }
    if (op.cell_type && op.cell_type !== cell.cell_type) {
        const oldType = cell.cell_type;
        cell.cell_type = op.cell_type;
        // code ↔ markdown/raw 互转：补/清 execution_count 与 outputs
        if (op.cell_type === "code") {
            if (cell.execution_count === undefined) cell.execution_count = null;
            if (!Array.isArray(cell.outputs)) cell.outputs = [];
        } else {
            delete cell.execution_count;
            delete cell.outputs;
        }
        return `已替换 cell @${idx} 内容并转类型 ${oldType}→${op.cell_type}`;
    }
    return `已替换 cell @${idx} 内容（${cell.cell_type}）`;
};

export const notebookTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "notebook_edit",
            description: "编辑 Jupyter notebook（.ipynb）的单元格。支持三种模式：replace（替换某 cell 内容/类型）、insert（插入新 cell）、delete（删除 cell）。用 cell_id 或 cell_index 定位。仅支持 .ipynb 文件。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "要编辑的 .ipynb 文件路径" },
                    cell_id: { type: "string", description: "目标 cell 的 id（优先于 cell_index）" },
                    cell_index: { type: "number", description: "目标 cell 的下标（0 基，cell_id 未提供时用）" },
                    new_source: { type: "string", description: "新 cell 正文（replace/insert 必填；delete 不用）" },
                    cell_type: { type: "string", enum: ["code", "markdown", "raw"], description: "cell 类型（insert 默认 code；replace 可据此改类型）" },
                    edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "编辑模式，默认 replace" },
                },
                required: ["path", "edit_mode"],
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: any) =>
                `⚠️【Notebook 编辑审批】\n文件：${args?.path}\n模式：${args?.edit_mode ?? "replace"}${args?.cell_id ? ` / cell_id=${args.cell_id}` : args?.cell_index !== undefined ? ` / cell_index=${args.cell_index}` : ""}${args?.cell_type ? ` / 类型=${args.cell_type}` : ""}${args?.new_source !== undefined ? `\n新内容：\n${String(args.new_source).slice(0, 500)}` : ""}`,
            async execute(args: any): Promise<string> {
                const relPath = args?.path;
                if (typeof relPath !== "string" || !relPath.trim()) return "❌ [notebook_edit] 缺少参数 path。";
                if (!relPath.toLowerCase().endsWith(".ipynb")) return `❌ [notebook_edit] 仅支持 .ipynb 文件：${relPath}`;
                const edit_mode = (args?.edit_mode === "insert" || args?.edit_mode === "delete") ? args.edit_mode : "replace";
                let absPath;
                try { absPath = resolveSafePath(relPath); }
                catch (e: any) { return `❌ [notebook_edit] 路径解析失败：${e?.message ?? e}`; }

                let raw: string;
                try { raw = await fs.readFile(absPath, "utf-8"); }
                catch (e: any) { return `❌ [notebook_edit] 读取失败：${e?.message ?? e}`; }
                let nb: any;
                try { nb = JSON.parse(raw); }
                catch (e: any) { return `❌ [notebook_edit] JSON 解析失败（非合法 .ipynb）：${e?.message ?? e}`; }
                if (!nb || !Array.isArray(nb.cells)) return "❌ [notebook_edit] 非合法 notebook（缺 cells 数组）。";

                let summary: string;
                try {
                    summary = applyNotebookEdit(nb, {
                        cell_id: args?.cell_id,
                        cell_index: args?.cell_index,
                        new_source: args?.new_source,
                        cell_type: args?.cell_type,
                        edit_mode,
                    });
                } catch (e: any) { return `❌ [notebook_edit] ${e?.message ?? e}`; }

                try { assertWithinWorkspace(absPath); }
                catch (e: any) { return `❌ [notebook_edit] 二次围栏复检失败：${e?.message ?? e}`; }

                // 原子写（tmp + rename，与 write_file 同款）
                const tmpPath = makeTmpPath(absPath);
                try {
                    await fs.writeFile(tmpPath, JSON.stringify(nb, null, 2), "utf-8");
                    await fs.rename(tmpPath, absPath);
                } catch (e: any) {
                    await fs.unlink(tmpPath).catch(() => { /* ignore */ });
                    return `❌ [notebook_edit] 写入失败：${e?.message ?? e}`;
                }
                return `✅ [notebook_edit] ${summary}（${relPath}）`;
            },
        },
    },
];
