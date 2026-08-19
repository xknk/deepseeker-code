/**
 * @file cli/src/diffView.ts
 * @description 文件修改类工具（edit_file/create_file/write_file）的 UI 层 diff 视图数据：
 *  从工具调用 args 提取 old/new 内容对 → LCS 行级 diff → 上下文折叠，供 ToolCard /
 *  ApprovalModal 渲染红绿对比（对齐 Claude Code 终端样式）。
 *  ★ 纯 UI 层计算，不进工具结果字符串（避免 diff 回灌模型浪费 token）；
 *    也不依赖 git——「修改前」内容即 args 里的 old_str / 审批 detail 的【减少】段。
 */
import { lineDiff, collapseContext, type DiffRow } from "./lineDiff.ts";

/** 编辑类工具名单（ToolCard / ApprovalModal 据此特判 diff 渲染）。 */
export const EDIT_TOOL_NAMES = ["edit_file", "create_file", "write_file"] as const;

/** 一次替换对：old=修改前片段，label=批量模式下的「第 N 处」标注。 */
export type EditPair = { label: string; old: string; new: string };

/**
 * 从工具调用 args 提取替换对列表：
 *  - edit_file：edits 数组优先，退回单条 old_str/new_str；
 *  - create_file / write_file：旧内容未知（UI 层拿不到盘上文件），按「全新增」展示。
 *  返回 null 表示 args 里没有可展示的改动内容（非编辑工具 / 参数缺失）。
 */
export const extractEditPairs = (toolName: string, args: unknown): EditPair[] | null => {
    if (args == null || typeof args !== "object") return null;
    const o = args as Record<string, unknown>;
    if (toolName === "edit_file") {
        const list: Array<Record<string, unknown>> = Array.isArray(o.edits) && o.edits.length > 0
            ? (o.edits as Array<Record<string, unknown>>)
            : [o];
        const pairs = list.filter((e) => typeof e.old_str === "string" && (e.old_str as string).length > 0);
        if (pairs.length === 0) return null;
        return pairs.map((e, i) => ({
            label: pairs.length > 1 ? `第 ${i + 1} 处${e.replace_all ? "（批量替换全部匹配）" : ""}` : "",
            old: e.old_str as string,
            new: typeof e.new_str === "string" ? e.new_str : "",
        }));
    }
    if (toolName === "create_file" || toolName === "write_file") {
        return typeof o.content === "string" && o.content.length > 0 ? [{ label: "", old: "", new: o.content }] : null;
    }
    return null;
};

/** 展示行：diff 行（del/add/ctx）或折叠省略标记（ellip：n 行未变）。 */
export type DisplayRow = DiffRow | { t: "ellip"; n: number };

/**
 * 替换对 → 展示行（每对独立 diff，对与对之间插 ellip 分隔；上下文默认各留 2 行）。
 *  返回 null 表示全部替换对都没有实际改动（old===new）。
 */
export const pairsToDisplayRows = (pairs: EditPair[], keep = 2): DisplayRow[] | null => {
    const out: DisplayRow[] = [];
    let changed = false;
    for (const p of pairs) {
        const collapsed = collapseContext(lineDiff(p.old, p.new), keep);
        if (!collapsed.some((r) => r.t !== "ctx" && r.t !== "ellip")) continue; // 该处无实际改动，跳过
        changed = true;
        if (p.label) {
            if (out.length > 0) out.push({ t: "ellip", n: 0 });
            out.push({ t: "ctx", s: `—— ${p.label} ——` });
        }
        out.push(...collapsed);
    }
    return changed ? out : null;
};

/** 审批 detail 解析结果：头行 + 各处修改的 old/new（fs.ts requireApproval 的固定文案格式）。 */
export type ApprovalDiff = { header: string; sections: EditPair[] };

/**
 * 解析 edit_file 审批 detail 的【减少】/【增加】结构（fs.ts requireApproval 拼装的固定格式），
 * 供 ApprovalModal 红绿渲染。非该格式（其它工具 / 单行说明）返回 null，调用方回退纯文本。
 */
export const parseApprovalDiff = (detail: string, toolName: string): ApprovalDiff | null => {
    if (toolName !== "edit_file" || !detail.includes("【减少】:")) return null;
    const parts = detail.split(/\n(?=—— 第 )/);
    const sections: EditPair[] = [];
    for (const part of parts.slice(1)) {
        const label = (part.match(/^—— (第 \d+ 处[^\n]*)——/)?.[1] ?? "").trim();
        const rIdx = part.indexOf("【减少】:");
        const aIdx = part.indexOf("【增加】:");
        if (rIdx < 0 || aIdx < 0 || aIdx < rIdx) continue;
        const old = part.slice(rIdx + "【减少】:".length, aIdx).replace(/^\n+|\n+$/g, "");
        const neu = part.slice(aIdx + "【增加】:".length).replace(/^\n+|\n+$/g, "");
        sections.push({ label, old, new: neu });
    }
    return sections.length > 0 ? { header: parts[0], sections } : null;
};
