/**
 * @file cli/src/components/QuestionModal.tsx
 * @description P2-12 结构化提问模态（纯展示）：展示问题 + 2-4 选项，支持单选/多选。
 *  按键导航（↑↓/Space/Enter/Esc）由 App 层 useInput 统一处理，调用 resolveQuestion。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { wrapText } from "../util.ts";
import type { QuestionOption } from "@/host/type.ts";

type Props = {
    question: string;
    options: QuestionOption[];
    multiSelect: boolean;
    cursor: number;
    checked: Set<number>;
    wrapW: number;
};

export const QuestionModal = ({ question, options, multiSelect, cursor, checked, wrapW }: Props): React.ReactElement => {
    const contentW = Math.max(16, wrapW);
    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.coralBright} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.coralBright} bold>❓ {multiSelect ? "多选提问" : "提问"}</Text>
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {wrapText(question || "(无问题)", contentW).map((line, j) => (
                    <Text key={j} color={THEME.white}>{line}</Text>
                ))}
            </Box>
            {options.map((opt, i) => {
                const active = i === cursor;
                const isChecked = checked.has(i);
                const marker = multiSelect ? (isChecked ? "[x] " : "[ ] ") : "";
                return (
                    <Box key={i} flexDirection="column">
                        <Box flexDirection="row">
                            <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                            <Text color={active ? THEME.white : THEME.gray} bold={active}>{marker}{opt.label}</Text>
                        </Box>
                        {opt.description ? (
                            <Text color={THEME.grayDim}>    {wrapText(opt.description, contentW - 4).map(l => l).join(" ")}</Text>
                        ) : null}
                    </Box>
                );
            })}
            <Text color={THEME.grayDim}>
                {multiSelect ? "↑↓ 移动 · Space 勾选 · Enter 提交 · Esc 取消" : "↑↓ 选择 · Enter 确认 · Esc 取消"}
            </Text>
        </Box>
    );
};
