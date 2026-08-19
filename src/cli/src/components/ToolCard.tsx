/**
 * @file cli/src/components/ToolCard.tsx
 * @description 工具调用渲染（对齐 Claude Code，纯配色、无背景色、无动画）：
 *   头行：⏺(按安全等级着色) toolName(加粗)  <主参数暗色>  <状态图标：✓/✗，运行中省略>
 *   结果行：  ⎿  <结果前几行摘要>（done，默认前 3 行）/ 运行中…（running）
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
import { EDIT_TOOL_NAMES, extractEditPairs, pairsToDisplayRows } from "../diffView.ts";

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

    // 结果摘要（多行）——done 时取前若干非空行，每行按宽度截断；完整内容仍在 transcript。
    //  Static 区不可交互（Ink 限制，useInput 仅动态区生效），故以「默认多行」替代「点击展开」，
    //  让历史回放能看到更多结果（read_file 多行 / run_command stdout），缓解「历史展示不全」。
    const outLines = (() => {
        if (status !== "done") return [] as string[];
        return resultPreview(result, 1200).split("\n")
            .map((l) => l.trimEnd())
            .filter((l) => l.trim())
            .slice(0, 3)
            .map((l) => truncateMiddle(l, Math.max(20, wrapW - 6)));
    })();

    // 运行中实时进度末行（run_command 的 stdout 尾部）；无进度回退「运行中…」
    const runningLine = (() => {
        if (status !== "running" || !progress) return "";
        const last = progress.replace(/\r/g, "").split("\n").map((s) => s.trim()).filter(Boolean).pop() ?? "";
        return truncateMiddle(last, Math.max(20, wrapW - 6));
    })();

    // ★ 编辑类工具（edit_file/create_file/write_file）成功后的红绿 diff（对齐 Claude Code 终端样式）：
    //   纯 UI 层从 args 计算（lineDiff），不进工具结果字符串（避免 diff 回灌模型浪费 token）。
    //   上下文已折叠 + 总行数封顶，超大改动只示意首部（完整内容仍在 transcript / args 明细）。
    const MAX_DIFF_LINES = 14;
    const diffAll = (() => {
        if (status !== "done" || !ok) return null;
        if (!(EDIT_TOOL_NAMES as readonly string[]).includes(toolName)) return null;
        const pairs = extractEditPairs(toolName, args);
        return pairs ? pairsToDisplayRows(pairs) : null;
    })();
    const diffRows = diffAll ? diffAll.slice(0, MAX_DIFF_LINES) : null;
    const diffHidden = diffAll ? Math.max(0, diffAll.length - MAX_DIFF_LINES) : 0;

    return (
        <Box flexDirection="column" marginTop={0.3} marginBottom={0.3}>
            {/* 头行：⏺(安全色) + 工具名(加粗白) + 主参数(暗) + 状态图标；无背景色、无动画 */}
            <Box flexDirection="row" flexShrink={0}>
                <Text color={markerColor} bold>{"⏺ "}</Text>
                <Text color={THEME.white} bold>{toolName}</Text>
                {hint ? <Text color={THEME.grayDim}>{`  ${hint}`}</Text> : null}
                {statusIcon ? <Text color={statusColor}>{`  ${statusIcon}`}</Text> : null}
            </Box>
            {/* 结果行：⎿ 连接 · 多行摘要（done，前 3 行）/ 运行中…（running） */}
            {outLines.length > 0 ? (
                outLines.map((line, i) => (
                    <Box key={i} flexDirection="row" flexShrink={0}>
                        <Text color={THEME.grayDim}>{i === 0 ? "  ⎿  " : "     "}</Text>
                        <Text color={ok ? THEME.gray : THEME.danger}>{line}</Text>
                    </Box>
                ))
            ) : status === "running" ? (
                <Box flexDirection="row" flexShrink={0}>
                    <Text color={THEME.grayDim}>{"  ⎿  "}</Text>
                    <Text color={THEME.gray}>{runningLine || "运行中…"}</Text>
                </Box>
            ) : null}
            {/* 编辑类工具的红绿 diff（- 红 / + 绿 / 省略行暗灰）；与结果行同列缩进，前景色无背景（Ink Static 擦写约束） */}
            {diffRows && diffRows.length > 0 ? diffRows.map((r, i) => (
                <Box key={`diff-${i}`} flexDirection="row" flexShrink={0}>
                    <Text color={THEME.grayDim}>{"     "}</Text>
                    {r.t === "ellip" ? (
                        <Text color={THEME.grayDim}>{r.n > 0 ? `  ⋯ ${r.n} 行未变` : "  ⋯"}</Text>
                    ) : (
                        <Text color={r.t === "del" ? THEME.danger : r.t === "add" ? THEME.ok : THEME.grayDim}>
                            {`${r.t === "del" ? "- " : r.t === "add" ? "+ " : "  "}${truncateMiddle(r.s, Math.max(20, wrapW - 8))}`}
                        </Text>
                    )}
                </Box>
            )) : null}
            {diffHidden > 0 ? (
                <Box flexDirection="row" flexShrink={0}>
                    <Text color={THEME.grayDim}>{"     "}</Text>
                    <Text color={THEME.grayDim}>{`  …（另有 ${diffHidden} 行改动未显示）`}</Text>
                </Box>
            ) : null}
        </Box>
    );
};
