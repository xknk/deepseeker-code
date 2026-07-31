/**
 * @file cli/src/components/ToolCard.tsx
 * @description 工具调用渲染（对齐 Claude Code，纯配色、无背景色、无动画）：
 *   头行：⏺(按安全等级着色) toolName(加粗)  <主参数暗色>  <状态图标：✓/✗，运行中省略>
 *   结果行：  ⎿  <结果首行摘要>（done）/ 运行中…（running）
 *   - 不用背景色：Ink 在「动态区 → Static」切换时擦不干净带底色的整行，会留错位残影。
 *   - 不用 spinner 动画：工具执行期间唯一的重绘源就是 spinner 的逐帧 setTick，Ink 擦除失准会把
 *     上一帧叠在下面（表现为同一工具出现两行不同的 ⠋/⠸）。去掉动画 → 执行期间零重绘 → 无叠帧。
 *     进度由「⎿ 运行中…」行 + 底部状态条「生成中」表达。
 *   - 安全等级用 ⏺ 标记颜色表达（蓝=只读 / 橙=写入 / 红=危险）。
 *   - 完整参数/结果见 transcript，UI 仅展示主参数 + 结果首行。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { argHint, findTool, resultPreview, strWidth, truncateMiddle } from "../util.ts";

type Props = {
    toolName: string;
    args?: unknown;
    result?: string;
    ok?: boolean;
    status: "running" | "done";
    /** 运行中实时进度（tool.progress，如 run_command 的 stdout）；done 后不展示。 */
    progress?: string;
    wrapW: number;
};

export const ToolCard = ({ toolName, args, result, ok, status, progress, wrapW }: Props): React.ReactElement => {
    const tool = findTool(toolName);
    const level = (tool?.function as { safetyLevel?: string } | undefined)?.safetyLevel;
    // ⏺ 标记色随安全等级（替代文字徽标）：只读=蓝 / 写入=橙 / 危险=红
    const markerColor = level === "danger" ? THEME.danger : level === "mutation" ? THEME.warn : THEME.blue;

    // 状态图标：完成才显示（✓/✗）；运行中省略，进度交给「⎿ 运行中…」行 + 底部状态条。
    const statusIcon = status === "running" ? "" : ok ? "✓" : "✗";
    const statusColor = ok ? THEME.ok : THEME.danger;

    // 主参数：先按 60 字符取预览，再按可用宽度收紧（给工具名 + 状态图标 + 留白留位）
    const hint = truncateMiddle(argHint(args, 60), Math.max(8, wrapW - strWidth(toolName) - 12));

    // 结果首行摘要（单行截断）——多行结果只取首个非空行，完整内容已在 transcript
    const outLine = (() => {
        if (status !== "done") return "";
        const first = resultPreview(result, 400).split("\n").find((l) => l.trim()) ?? "";
        return truncateMiddle(first, Math.max(20, wrapW - 6));
    })();

    // 运行中实时进度末行（run_command 的 stdout 尾部）；无进度回退「运行中…」
    const runningLine = (() => {
        if (status !== "running" || !progress) return "";
        const last = progress.replace(/\r/g, "").split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "";
        return truncateMiddle(last, Math.max(20, wrapW - 6));
    })();

    return (
        <Box flexDirection="column" marginTop={0.3} marginBottom={0.3}>
            {/* 头行：⏺(安全色) + 工具名(加粗白) + 主参数(暗) + 状态图标；无背景色、无动画 */}
            <Box flexDirection="row" flexShrink={0}>
                <Text color={markerColor} bold>{"⏺ "}</Text>
                <Text color={THEME.white} bold>{toolName}</Text>
                {hint ? <Text color={THEME.grayDim}>{`  ${hint}`}</Text> : null}
                {statusIcon ? <Text color={statusColor}>{`  ${statusIcon}`}</Text> : null}
            </Box>
            {/* 结果行：⎿ 连接 · 单行摘要（done）/ 运行中…（running） */}
            {outLine ? (
                <Box flexDirection="row" flexShrink={0}>
                    <Text color={THEME.grayDim}>{"  ⎿  "}</Text>
                    <Text color={ok ? THEME.gray : THEME.danger}>{outLine}</Text>
                </Box>
            ) : status === "running" ? (
                <Box flexDirection="row" flexShrink={0}>
                    <Text color={THEME.grayDim}>{"  ⎿  "}</Text>
                    <Text color={THEME.gray}>{runningLine || "运行中…"}</Text>
                </Box>
            ) : null}
        </Box>
    );
};
