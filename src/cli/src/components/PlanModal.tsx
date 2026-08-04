/**
 * @file cli/src/components/PlanModal.tsx
 * @description 计划方案审批模态（纯展示，轻量）：方案全文已作为 Static 消息渲染在上方（RichText），
 *  此处动态区只保留 标题 + 提示 + 接受/修改/拒绝 三选项（约 7 行）——切换选项时 Ink 全量擦写面积小 → 不闪屏
 *  （Ink log-update 无行级 diff，闪屏与动态区高度成正比；方案移 Static 是治闪关键）。
 *  接受 → resolvePlan({action:'accept'})；修改 → 进入 PlanEditor；拒绝 → resolvePlan({action:'reject'})。
 *  按键导航（↑↓/Enter/Esc）由 App useInput 处理。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";

type Props = { selectedIndex: number };

const OPTIONS = [
    { label: S.planAccept, color: THEME.ok },
    { label: S.planEdit, color: THEME.blue },
    { label: S.planReject, color: THEME.danger },
];

export const PlanModal = ({ selectedIndex }: Props): React.ReactElement => (
    <Box flexDirection="column" borderStyle="round" borderColor={THEME.blue} paddingX={1} paddingY={1} marginTop={1}>
        <Text color={THEME.blue} bold>{S.planTitle}</Text>
        <Text color={THEME.grayDim}>{S.planPrompt}</Text>
        {OPTIONS.map((opt, i) => {
            const active = i === selectedIndex;
            return (
                <Box key={opt.label} flexDirection="row">
                    <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                    <Text color={active ? THEME.white : opt.color} bold={active}>{opt.label}</Text>
                </Box>
            );
        })}
    </Box>
);
