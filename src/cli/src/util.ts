/**
 * @file cli/src/util.ts
 * @description 终端文本排版工具：换行包裹、截断、分隔线、安全等级工具查表。
 */
import { agentTools } from "@/tool/index.ts";

/** 字符串显示宽度（CJK / 全角 / Emoji 占 2 列），用于分割线等精确占位。 */
export const strWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x1100 && (
            code <= 0x115f ||
            (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
            (code >= 0xac00 && code <= 0xd7a3) ||
            (code >= 0xf900 && code <= 0xfaff) ||
            (code >= 0xfe30 && code <= 0xfe4f) ||
            (code >= 0xff00 && code <= 0xff60) ||
            (code >= 0xffe0 && code <= 0xffe6) ||
            (code >= 0x1f300 && code <= 0x1faff) ||
            (code >= 0x20000 && code <= 0x3fffd)
        )) w += 2;
        else w += 1;
    }
    return w;
};

/** 按宽度包裹文本（保留显式换行）。 */
export const wrapText = (text: string, width: number): string[] => {
    const w = Math.max(16, width);
    const t = text.replace(/\r\n/g, "\n");
    const out: string[] = [];
    for (const para of t.split("\n")) {
        let s = para;
        while (s.length > w) {
            out.push(s.slice(0, w));
            s = s.slice(w);
        }
        out.push(s);
    }
    return out.length ? out : [""];
};

/** token 数格式化：1234 → "1.2k"，500 → "500"。 */
export const formatTokens = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** 中段省略截断。 */
export const truncateMiddle = (s: string, max: number): string => {
    if (s.length <= max) return s;
    const keep = Math.max(8, max - 1);
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
};

/** 浅色分隔线。 */
export const dimRule = (width: number): string => {
    const n = Math.max(8, Math.min(width - 2, 96));
    return `╴${"─".repeat(n - 2)}╶`;
};

/** 全量参数预览（JSON），按上限截断。 */
export const argsPreview = (args: unknown, max = 400): string => {
    if (args == null) return "";
    let s: string;
    try { s = typeof args === "string" ? args : JSON.stringify(args); } catch { return String(args); }
    return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** 结果预览：按上限截断（完整结果已在 transcript，UI 仅展示头部）。 */
export const resultPreview = (result: string | undefined, max = 600): string => {
    if (!result) return "";
    const s = String(result).replace(/\s+\n/g, "\n").trimEnd();
    return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** 按 toolName 查 CustomTool（agentTools 为可变数组，须在 initEngine 后调用）。 */
export const findTool = (toolName: string) =>
    agentTools.find((t) => (t.function as { name?: string }).name === toolName);
