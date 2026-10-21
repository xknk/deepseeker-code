/**
 * @file cli/src/components/RewindPicker.tsx
 * @description 回退选择模态（纯展示，★ I-3 第四批 /rewind）：列出当前会话未回退的文件改动
 *  （listUndoable，新→旧），↑↓ 选中、Enter 按该检查点选择性回退（restoreByUndoId，非仅
 *  restoreLast）、Esc 取消；对标 VSCode 检查点回滚面板与 CC 形态。按键导航由 App 层 useInput
 *  统一处理，调用 resolveRewind 回传所选 undoId。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { strWidth, truncateMiddle } from "../util.ts";
import type { UndoRecord } from "@/tool/undo/type.ts";

const PAGE_SIZE = 8;

type Props = { records: UndoRecord[]; selectedIndex: number; wrapW: number };

/** 备份形态标记（免翻译符号）：＋=新建（回退=删除）· ▤=目录树 · ~=内容改写。 */
const kindMark = (k: UndoRecord["backupKind"]): string => (k === "creation_marker" ? "＋" : k === "directory_tree" ? "▤" : "~");

export const RewindPicker = ({ records, selectedIndex, wrapW }: Props): React.ReactElement => {
    // ★ 分页：selectedIndex 越过当前页时自动翻页（与 ModelPicker 同一窗口算法）。
    const start = Math.floor(Math.max(0, selectedIndex) / PAGE_SIZE) * PAGE_SIZE;
    const visible = records.slice(start, start + PAGE_SIZE);
    const contentW = Math.max(24, wrapW);
    const metaSample = "  · edit_file · 59 分钟前";
    const pathW = Math.max(16, contentW - strWidth(metaSample) - 4);

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.warn} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.warn} bold>{S.rewindTitle}</Text>
            <Text color={THEME.grayDim}>{S.rewindPrompt}</Text>
            <Box flexDirection="column" marginTop={0.5}>
                {visible.map((r, i) => {
                    const idx = start + i;
                    const active = idx === selectedIndex;
                    return (
                        <Box key={r.undoId} flexDirection="row">
                            <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                            <Text color={THEME.grayDim}>{kindMark(r.backupKind)} </Text>
                            <Text color={active ? THEME.white : THEME.gray} bold={active}>
                                {truncateMiddle(r.relativePath, pathW)}
                            </Text>
                            <Text color={THEME.grayDim}>{`  · ${truncateMiddle(r.operationType, 20)} · ${S.relTime(r.timestamp)}`}</Text>
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
};
