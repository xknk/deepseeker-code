/**
 * @file cli/src/components/ForkPicker.tsx
 * @description 分叉锚点选择模态（纯展示，仿 SessionPicker）：列出当前会话各轮 assistant 检查点
 *  （轮号 + 当时提问预览 → 回复预览），↑↓ 选中、Enter 分叉、Esc 取消。
 *  键盘导航由 App 层 useInput 统一处理，调用 resolveFork。
 */
import React from "react";
import { Box, Text } from "ink";
import type { ForkAnchor } from "@/session/fork.ts";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { truncateMiddle } from "../util.ts";

type Props = { anchors: ForkAnchor[]; selectedIndex: number; wrapW: number };

const PAGE_SIZE = 8;

export const ForkPicker = ({ anchors, selectedIndex, wrapW }: Props): React.ReactElement => {
    // 分页与 SessionPicker 同款：selectedIndex 越过当前页自动翻页
    const start = Math.floor(selectedIndex / PAGE_SIZE) * PAGE_SIZE;
    const visible = anchors.slice(start, start + PAGE_SIZE);
    const contentW = Math.max(24, wrapW);
    // 左右两栏预览：提问占 ~45%，回复占余量（回复通常更长）
    const userW = Math.max(10, Math.floor(contentW * 0.45));
    const replyW = Math.max(10, contentW - userW - 4);

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.blue} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.blue} bold>{S.forkTitle}</Text>
            <Text color={THEME.grayDim}>{S.forkPrompt}</Text>
            <Box flexDirection="column" marginTop={0.5}>
                {visible.map((a, i) => {
                    const active = start + i === selectedIndex;
                    const user = truncateMiddle(a.userPreview || "(无提问)", userW);
                    const reply = truncateMiddle(a.assistantPreview, replyW);
                    return (
                        <Box key={a.lineId} flexDirection="row">
                            <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                            <Text color={active ? THEME.white : THEME.gray} bold={active}>{`#${a.roundNo} ${user}`}</Text>
                            <Text color={THEME.grayDim}>{` → ${reply}`}</Text>
                        </Box>
                    );
                })}
            </Box>
            {anchors.length > PAGE_SIZE ? (
                <Text color={THEME.grayDim}>{`第 ${start + 1}-${Math.min(start + PAGE_SIZE, anchors.length)} / ${anchors.length} 个（↑↓ 选择·自动翻页）`}</Text>
            ) : null}
        </Box>
    );
};
