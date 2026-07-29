/**
 * @file cli/src/theme.ts
 * @description 终端配色（Claude Code 风格：coral/橙主色 + 灰阶 + 状态色）。
 *  依赖终端 truecolor；不支持时 Ink/终端自动降级为最接近的基本色。
 */
export const THEME = {
    /** 主色：品牌头、用户输入标记 */
    coral: "#D77757",
    coralBright: "#ffa94d",
    coralMuted: "#c9782a",
    /** 文本 */
    white: "#f5f5f4",
    /** 正文（非加粗）：浅灰，衬托加粗白 */
    body: "#d6d3d1",
    gray: "#a8a29e",
    grayDim: "#78716c",
    /** 轮次分割线：极暗灰 */
    divider: "#4B5563",
    /** 分区/工具卡边框 */
    blue: "#38bdf8",
    /** 状态 */
    ok: "#34d399",
    warn: "#fbbf24",
    danger: "#f87171",
    /** 思考过程 */
    thinking: "#c4b5fd",
} as const;

/** 工具安全等级 → 徽标颜色 */
export const safetyColor = (level?: string): string => {
    switch (level) {
        case "danger": return THEME.danger;
        case "mutation": return THEME.warn;
        case "safe":
        default: return THEME.ok;
    }
};

/** 工具安全等级 → 中文徽标 */
export const safetyLabel = (level?: string): string => {
    switch (level) {
        case "danger": return "危险";
        case "mutation": return "写入";
        case "safe":
        default: return "只读";
    }
};
