/**
 * @file cli/src/components/ApprovalModal.tsx
 * @description 工具审批模态（纯展示）：展示 detail + toolName + 允许/拒绝两项。
 *  按键导航（↑↓/Enter/Esc）由 App 层 useInput 统一处理，调用 resolveApproval。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { wrapText } from "../util.ts";

type Props = { toolName: string; detail: string; selectedIndex: number; wrapW: number };

const OPTIONS = [
    { label: S.approvalAllow, value: true, color: THEME.ok },
    { label: S.approvalDeny, value: false, color: THEME.danger },
];

export const ApprovalModal = ({ toolName, detail, selectedIndex, wrapW }: Props): React.ReactElement => {
    const contentW = Math.max(16, wrapW);
    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.warn} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.warn} bold>{S.approvalTitle} · {toolName}</Text>
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {wrapText(detail || "(无说明)", contentW).map((line, j) => (
                    <Text key={j} color={THEME.white}>{line}</Text>
                ))}
            </Box>
            <Text color={THEME.grayDim}>{S.approvalPrompt}</Text>
            {OPTIONS.map((opt, i) => {
                const active = i === selectedIndex;
                return (
                    <Box key={opt.label} flexDirection="row">
                        <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                        <Text color={active ? THEME.white : THEME.gray} bold={active}>{opt.label}</Text>
                    </Box>
                );
            })}
        </Box>
    );
};
