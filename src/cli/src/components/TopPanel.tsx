/**
 * @file cli/src/components/TopPanel.tsx
 * @description 顶部双列欢迎卡片（对齐 Claude Code）：
 *  - 信息行：* Welcome to deepSeekCode v1.0.0（橘）+ 工作目录（灰）
 *  - 双列圆角橘框：左列 Welcome back! + 像素机器人 + 快捷键；右列 Tips / 分隔线 / What's new
 *  - 中间垂直分割线由固定高度的 │ 列实现（Ink 无原生 per-side border）。
 *  作为 <Static> 首项渲染：位于最顶端、只绘制一次（零闪屏），随对话增长超过屏幕后滚走（同 CC）。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { VERSION } from "../strings.ts";

/** 像素机器人（4 行，居中显示）。 */
const ROBOT = [
    "  ╭─────╮  ",
    "  │ ◕ ◕ │  ",
    "  ╰╥═══╥╯  ",
    "   ╨   ╨   ",
];

/** 双列内固定高度，保证垂直分割线与两列等高。 */
const INNER_H = 8;

export const TopPanel = ({ cwd, cols }: { cwd: string; cols: number }): React.ReactElement => {
    const panelW = Math.min(88, Math.max(60, cols));
    const innerW = panelW - 2;
    const leftW = Math.floor(innerW * 0.33);
    const rightW = innerW - leftW - 1;
    const ruleLen = Math.max(8, rightW - 2);

    const VDivider = (
        <Box flexDirection="column" width={1} flexShrink={0}>
            {Array.from({ length: INNER_H }).map((_, i) => (
                <Text key={i} color={THEME.coral}>│</Text>
            ))}
        </Box>
    );

    return (
        <Box flexDirection="column" width={panelW} marginBottom={1}>
            {/* 信息行 */}
            <Text>
                <Text color={THEME.coralBright} bold>* Welcome to </Text>
                <Text bold color={THEME.white}>deep</Text>
                <Text bold color={THEME.coralBright}>Seek</Text>
                <Text bold color={THEME.white}>Code</Text>
                <Text color={THEME.coralMuted}>  {VERSION}</Text>
            </Text>
            <Text color={THEME.grayDim}>{cwd}</Text>

            {/* 双列卡片 */}
            <Box flexDirection="row" borderStyle="round" borderColor={THEME.coral} marginTop={1} paddingX={0} paddingY={0}>
                {/* 左列：欢迎语 + 机器人 + 快捷键（水平居中、垂直居中） */}
                <Box flexDirection="column" width={leftW} height={INNER_H} alignItems="center" justifyContent="center">
                    <Text color={THEME.white} bold>Welcome back!</Text>
                    {ROBOT.map((l, i) => (
                        <Text key={i} color={THEME.coralBright}>{l}</Text>
                    ))}
                    <Text color={THEME.grayDim}>Ctrl+C 退出 · Esc 中止</Text>
                    <Text color={THEME.grayDim}>输入 / 查看命令</Text>
                </Box>

                {VDivider}

                {/* 右列：Tips / 分隔线 / What's new（垂直两端分布） */}
                <Box flexDirection="column" width={rightW} height={INNER_H} justifyContent="space-between" paddingX={1}>
                    <Box flexDirection="column">
                        <Text color={THEME.coralBright} bold>Tips for getting started</Text>
                        <Text color={THEME.white}>输入需求开始，输入 / 唤出命令。</Text>
                    </Box>
                    <Text color={THEME.grayDim}>{"─".repeat(ruleLen)}</Text>
                    <Box flexDirection="column">
                        <Text color={THEME.coralBright} bold>What&apos;s new</Text>
                        <Text color={THEME.white}>已对接本地 Tool Call 智能函数调用。</Text>
                    </Box>
                </Box>
            </Box>
        </Box>
    );
};
