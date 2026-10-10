/**
 * @file cli/src/components/QuestionModal.tsx
 * @description P2-12 结构化提问模态（纯展示）：展示问题 + 2-4 选项，支持单选/多选。
 *  按键导航（↑↓/Space/Enter/Esc）由 App 层 useInput 统一处理，调用 resolveQuestion。
 *  选项末恒有「Other」自由输入档（对标 Claude Code）：光标移到 Other 行 Enter 进入编辑态，
 *  内嵌 MultilineInput 接管打字（同 PlanEditor 模式），Enter 提交 freeText / Esc 返回选项。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { wrapText } from "../util.ts";
import { MultilineInput } from "./MultilineInput.tsx";
import type { QuestionOption } from "@/host/type.ts";

type Props = {
    question: string;
    options: QuestionOption[];
    multiSelect: boolean;
    cursor: number;
    checked: Set<number>;
    wrapW: number;
    /** Other 自由输入编辑态：true 时 Other 行内嵌输入框接管按键。 */
    editing: boolean;
    draft: string;
    draftCursor: number;
    onDraftChange: (value: string, cursor: number) => void;
    onDraftSubmit: () => void;
};

export const QuestionModal = ({ question, options, multiSelect, cursor, checked, wrapW, editing, draft, draftCursor, onDraftChange, onDraftSubmit }: Props): React.ReactElement => {
    const contentW = Math.max(16, wrapW);
    const onOther = cursor === options.length && !editing;
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
            {/* Other 自由输入档：编辑态内嵌 MultilineInput（active 恒 true，主输入框此时 inactive 不冲突） */}
            <Box flexDirection="column" marginTop={0.5}>
                <Box flexDirection="row">
                    <Text color={onOther ? THEME.coralBright : undefined} bold>{onOther ? "› " : "  "}</Text>
                    <Text color={editing || onOther ? THEME.white : THEME.gray} bold={onOther}>✎ Other{editing ? "（输入后 Enter 提交）" : " — 自由输入"}</Text>
                </Box>
                {editing ? (
                    <Box flexDirection="row" marginLeft={2} marginTop={0.5}>
                        <MultilineInput value={draft} cursor={draftCursor} onChange={onDraftChange} onSubmit={onDraftSubmit} active={true} placeholder="粘贴 token / 路径等，Enter 提交" />
                    </Box>
                ) : null}
            </Box>
            <Text color={THEME.grayDim}>
                {editing ? "Enter 提交 · Esc 返回选项" : multiSelect ? "↑↓ 移动 · Space 勾选 · Enter 提交 · Esc 取消" : "↑↓ 选择 · Enter 确认 · Esc 取消"}
            </Text>
        </Box>
    );
};
