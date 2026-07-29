/**
 * @file cli/src/components/ToolCard.tsx
 * @description 工具调用卡片：圆角框，展示 toolName + 安全等级徽标 + 参数 + 结果 + 成败。
 *  args/result 取自 AgentEvent（tool.start/tool.end）；安全等级查 agentTools 的 CustomTool。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME, safetyColor, safetyLabel } from "../theme.ts";
import { S } from "../strings.ts";
import { argsPreview, findTool, resultPreview, wrapText } from "../util.ts";

type Props = {
    toolName: string;
    args?: unknown;
    result?: string;
    ok?: boolean;
    status: "running" | "done";
    wrapW: number;
};

export const ToolCard = ({ toolName, args, result, ok, status, wrapW }: Props): React.ReactElement => {
    const tool = findTool(toolName);
    const level = (tool?.function as { safetyLevel?: string } | undefined)?.safetyLevel;
    const contentW = Math.max(16, wrapW);
    const argText = argsPreview(args);
    const outText = status === "done" ? resultPreview(result) : "";

    return (
        <Box
            flexDirection="column"
            marginTop={0.5}
            marginBottom={0.5}
            borderStyle="round"
            borderColor={status === "done" ? (ok ? THEME.ok : THEME.danger) : THEME.blue}
            paddingX={1}
            paddingY={0.5}
        >
            <Box marginBottom={0.5}>
                <Text color={THEME.blue} bold>⏺ {toolName}</Text>
                <Text color={safetyColor(level)} dimColor>{" "}{safetyLabel(level)}{" "}</Text>
                {status === "running" ? (
                    <Text color={THEME.gray}>{S.toolRunning("").replace("⏺ ", "运行中…")}</Text>
                ) : (
                    <Text color={ok ? THEME.ok : THEME.danger}>{" · "}{ok ? "成功" : "失败"}</Text>
                )}
            </Box>
            {argText ? (
                <Box flexDirection="column">
                    <Text dimColor>参数</Text>
                    {wrapText(argText, contentW).map((line, j) => (
                        <Text key={`a-${j}`} color={THEME.grayDim}>{line}</Text>
                    ))}
                </Box>
            ) : null}
            {outText ? (
                <Box flexDirection="column" marginTop={0.5}>
                    <Text dimColor>结果</Text>
                    {wrapText(outText, contentW).map((line, j) => (
                        <Text key={`r-${j}`} color={THEME.white}>{line}</Text>
                    ))}
                </Box>
            ) : null}
        </Box>
    );
};
