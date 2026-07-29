/**
 * @file cli/src/components/PlanModal.tsx
 * @description 计划方案审批模态（纯展示）：展示模型提交的实现方案 + 接受/拒绝两项。
 *  接受 → resolvePlan(true) → submit 以 planMode:false 重跑进入实现；拒绝 → resolvePlan(false)。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { wrapText } from "../util.ts";

type Props = { plan: string; selectedIndex: number; wrapW: number };

const OPTIONS = [
    { label: S.planAccept, value: true },
    { label: S.planReject, value: false },
];

export const PlanModal = ({ plan, selectedIndex, wrapW }: Props): React.ReactElement => {
    const contentW = Math.max(16, wrapW);
    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.blue} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.blue} bold>{S.planTitle}</Text>
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {wrapText(plan || "(空方案)", contentW).map((line, j) => (
                    <Text key={j} color={THEME.white}>{line}</Text>
                ))}
            </Box>
            <Text color={THEME.grayDim}>{S.planPrompt}</Text>
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
