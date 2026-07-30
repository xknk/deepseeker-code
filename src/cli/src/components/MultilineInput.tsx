/**
 * @file cli/src/components/MultilineInput.tsx
 * @description 多行输入（完全受控）：Enter 提交、Shift+Enter 换行、←→↑↓ 移动、Backspace/Delete、光标块。
 *  value+cursor 由 App 持有（onChange 回传 newValue/newCursor），便于斜杠 Tab 补全同步光标到末尾。
 *  active=false 时（模态打开）忽略编辑键；斜杠菜单时 active=true 配合 suppressSubmit
 *  （字符/Backspace 仍可输入以过滤命令、补全后输参数，仅 Enter 交 App 执行选中命令）。
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import { THEME } from "../theme.ts";

type Props = {
    value: string;
    cursor: number;
    onChange: (value: string, cursor: number) => void;
    onSubmit: () => void;
    active: boolean;
    /** 斜杠菜单激活时置 true：禁用 Enter 提交（交由 App 执行选中命令），但仍接受字符输入以过滤/补全/输参数。 */
    suppressSubmit?: boolean;
    placeholder?: string;
};

/** 字符偏移 → (行号, 列号)。 */
const lineColOf = (value: string, offset: number): [number, number] => {
    const before = value.slice(0, offset);
    const lines = before.split("\n");
    return [lines.length - 1, lines[lines.length - 1].length];
};

/** (行号, 列号) → 字符偏移。 */
const offsetOf = (value: string, lineIdx: number, col: number): number => {
    const lines = value.split("\n");
    let off = 0;
    for (let i = 0; i < lineIdx && i < lines.length; i++) off += lines[i].length + 1;
    return off + Math.min(col, lines[Math.min(lineIdx, lines.length - 1)]?.length ?? 0);
};

export const MultilineInput = ({ value, cursor, onChange, onSubmit, active, suppressSubmit, placeholder }: Props): React.ReactElement => {
    useInput((ch, key) => {
        if (!active) return;
        // 提交（无 Shift）。suppressSubmit 时交由 App 处理（斜杠菜单执行选中命令），本组件不提交。
        if (key.return && !key.shift && !suppressSubmit) {
            onSubmit();
            return;
        }
        // 换行（Shift+Enter，或某些终端把 Shift+Enter 报为 return+shift）
        if (key.return && key.shift) {
            onChange(value.slice(0, cursor) + "\n" + value.slice(cursor), cursor + 1);
            return;
        }
        if (key.backspace || (key.ctrl && ch === "h")) {
            if (cursor > 0) onChange(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
            return;
        }
        if (key.delete) {
            if (cursor < value.length) onChange(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
            return;
        }
        if (key.leftArrow) {
            if (cursor > 0) onChange(value, cursor - 1);
            return;
        }
        if (key.rightArrow) {
            if (cursor < value.length) onChange(value, cursor + 1);
            return;
        }
        const [lineIdx, col] = lineColOf(value, cursor);
        const lines = value.split("\n");
        if (key.upArrow) {
            if (lineIdx > 0) onChange(value, offsetOf(value, lineIdx - 1, col));
            return;
        }
        if (key.downArrow) {
            if (lineIdx < lines.length - 1) onChange(value, offsetOf(value, lineIdx + 1, col));
            return;
        }
        // 可打印字符（含中文）：Ink 逐字符回调，直接插入
        if (ch && !key.ctrl && !key.meta && ch !== "\r" && ch !== "\n" && ch !== "\t") {
            onChange(value.slice(0, cursor) + ch + value.slice(cursor), cursor + ch.length);
        }
    });

    const [curLine, curCol] = lineColOf(value, cursor);
    const lines = value.length ? value.split("\n") : [""];

    /** 渲染单行：非当前行直接输出；当前行在光标处插入醒目块光标。 */
    const renderLine = (line: string, i: number, isActive: boolean): React.ReactElement => {
        if (!isActive) return <Text key={i} color={THEME.white}>{line || " "}</Text>;
        const before = line.slice(0, curCol);
        const at = curCol < line.length ? line[curCol] : "";
        const after = curCol < line.length ? line.slice(curCol + 1) : "";
        return (
            <Text key={i}>
                <Text color={THEME.white}>{before}</Text>
                {at ? (
                    <Text inverse color={THEME.white}>{at}</Text>
                ) : (
                    <Text color={THEME.coralBright}>█</Text>
                )}
                <Text color={THEME.white}>{after}</Text>
            </Text>
        );
    };

    return (
        <Box flexDirection="row" flexShrink={0}>
            <Text bold color={THEME.coralBright}>{"> "}</Text>
            <Box flexGrow={1} minWidth={0}>
                {value === "" && placeholder ? (
                    <Text>
                        <Text color={THEME.coralBright}>█</Text>
                        <Text color={THEME.grayDim}> {placeholder}</Text>
                    </Text>
                ) : (
                    <Box flexDirection="column">
                        {lines.map((line, i) => renderLine(line, i, i === curLine))}
                    </Box>
                )}
            </Box>
        </Box>
    );
};
