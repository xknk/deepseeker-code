/**
 * @file cli/src/components/StatusStrip.tsx
 * @description 底部状态条：模型 / 计划模式 / 状态(生成中·就绪·中止中) / 会话 / 命令提示。
 *  P2-16：若宿主传入 customLine（用户 statusLine.command 的 stdout 首行），则用其替代内置段位行
 *   （对标 Claude Code statusLine）；否则维持内置段位。
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
    autoMode: boolean;
    sessionShort: string;
    cols: number;
    /** P2-16 自定义状态栏文本（statusLine.command 产出）；非空则替代内置段位行。 */
    customLine?: string;
};

export const StatusStrip = ({ model, busy, aborting, planMode, autoMode, sessionShort, customLine }: Props): React.ReactElement => {
    const stateText = aborting ? S.statusAborting : busy ? S.statusStreaming : S.statusIdle;
    const stateColor = busy ? THEME.coralBright : THEME.gray;
    const bits = [
        model ? `model: ${model}` : "",
        planMode ? S.statusPlan : "",
        autoMode ? S.statusAuto : "",
        `state: ${stateText}`,
        sessionShort ? `session: ${sessionShort}` : "",
    ].filter(Boolean);
    return (
        <Box flexDirection="column" flexShrink={0}>
            <Text color={THEME.coralMuted}>{customLine && customLine.trim() ? customLine : bits.join("   ·   ")}</Text>
            <Text color={stateColor}>{""}</Text>
            <Text color={THEME.grayDim}>{S.cmdHint}</Text>
        </Box>
    );
};
