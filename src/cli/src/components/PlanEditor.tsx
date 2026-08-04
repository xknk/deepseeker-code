/**
 * @file cli/src/components/PlanEditor.tsx
 * @description 计划方案编辑器（受控）：圆角边框 + 标题，内嵌 MultilineInput（完全受控、多行/光标/Shift+Enter）。
 *  value/cursor 由 App 持有（编辑相位 planDraft/planCursor）；Enter→onSubmit（App confirmPlanEdit）。
 *  active 恒 true：编辑态下主输入框 inactive（menuActive 仍成立），仅本编辑器接收按键；
 *  Esc 由 App useInput 在 planEditing 分支捕获（取消编辑回选项），MultilineInput 无 Esc 处理，互不冲突。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { MultilineInput } from "./MultilineInput.tsx";

type Props = {
    value: string;
    cursor: number;
    onChange: (value: string, cursor: number) => void;
    onSubmit: () => void;
};

export const PlanEditor = ({ value, cursor, onChange, onSubmit }: Props): React.ReactElement => (
    <Box flexDirection="column" borderStyle="round" borderColor={THEME.blue} paddingX={1} paddingY={1} marginTop={1}>
        <Text color={THEME.blue} bold>{S.planEditTitle}</Text>
        <Box marginTop={0.5} marginBottom={0.5}>
            <MultilineInput
                value={value}
                cursor={cursor}
                onChange={onChange}
                onSubmit={onSubmit}
                active={true}
            />
        </Box>
        <Text color={THEME.grayDim}>{S.planEditHint}</Text>
    </Box>
);
