/**
 * @file cli/src/components/StatusStrip.tsx
 * @description 底部状态条：模型 / 计划模式 / 状态(生成中·就绪·中止中) / 会话 / 命令提示。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";

type Props = {
    model: string;
    busy: boolean;
    aborting: boolean;
    planMode: boolean;
    sessionShort: string;
    cols: number;
};

export const StatusStrip = ({ model, busy, aborting, planMode, sessionShort }: Props): React.ReactElement => {
    const stateText = aborting ? S.statusAborting : busy ? S.statusStreaming : S.statusIdle;
    const stateColor = busy ? THEME.coralBright : THEME.gray;
    const bits = [
        model ? `model: ${model}` : "",
        planMode ? S.statusPlan : "",
        `state: ${stateText}`,
        sessionShort ? `session: ${sessionShort}` : "",
    ].filter(Boolean);
    return (
        <Box flexDirection="column" flexShrink={0}>
            <Text color={THEME.coralMuted}>{bits.join("   ·   ")}</Text>
            <Text color={stateColor}>{""}</Text>
            <Text color={THEME.grayDim}>{S.cmdHint}</Text>
        </Box>
    );
};
