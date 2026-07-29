/**
 * @file cli/src/components/SlashMenu.tsx
 * @description 斜杠命令菜单（纯展示）：统一条目 { name, description }，↑↓ 选中、Tab 补全、Esc 关闭。
 *  条目由 App 合并（本地命令 + 核心注册命令）后传入。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";

export type MenuEntry = { name: string; description: string };

type Props = { entries: MenuEntry[]; selectedIndex: number; cols: number };

const MAX_ROWS = 10;

export const SlashMenu = ({ entries, selectedIndex, cols }: Props): React.ReactElement => {
    const visible = entries.slice(0, MAX_ROWS);
    const more = entries.length > MAX_ROWS;
    const cmdW = Math.min(22, Math.max(8, ...visible.map((e) => e.name.length)) + 1);
    const descMax = Math.max(12, cols - cmdW - 6);

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.coral} paddingX={1} paddingY={0} marginTop={1}>
            {visible.map((e, i) => {
                const active = i === selectedIndex;
                const desc = e.description.length > descMax ? `${e.description.slice(0, descMax - 1)}…` : e.description;
                const gap = Math.max(1, cmdW - e.name.length);
                return (
                    <Box key={e.name} flexDirection="row">
                        <Text color={active ? THEME.coralBright : undefined} bold>{active ? "❯ " : "  "}</Text>
                        <Text color={active ? THEME.white : THEME.gray} bold={active}>/{e.name}</Text>
                        <Text color={THEME.grayDim}>{" ".repeat(gap)}</Text>
                        <Text color={active ? THEME.gray : THEME.grayDim}>{desc}</Text>
                    </Box>
                );
            })}
            {more ? <Text color={THEME.coralMuted}>… 还有 {entries.length - MAX_ROWS} 条</Text> : null}
        </Box>
    );
};
