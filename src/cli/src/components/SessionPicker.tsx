/**
 * @file cli/src/components/SessionPicker.tsx
 * @description 历史会话选择模态（纯展示）：列出本工作区历史会话（首条 user 预览 + 消息数 + 相对时间），
 *  ↑↓ 选中、Enter 载入续接、Esc 取消。按键导航由 App 层 useInput 统一处理，调用 resolveSession。
 */
import React from "react";
import { Box, Text } from "ink";
import type { SessionSummary } from "@/session/store.ts";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { strWidth, truncateMiddle } from "../util.ts";

type Props = { sessions: SessionSummary[]; selectedIndex: number; wrapW: number };

const PAGE_SIZE = 8;

export const SessionPicker = ({ sessions, selectedIndex, wrapW }: Props): React.ReactElement => {
    // ★ 分页：selectedIndex 越过当前页时自动翻页（App 层 ↑↓ 改 selectedIndex，本组件跟随计算可视窗口）。
    //   解决原 slice(0,8) 硬上限导致超过 8 个会话时更早的不可达——数据层 listSessions 已返回全部，仅展示层受限。
    const start = Math.floor(selectedIndex / PAGE_SIZE) * PAGE_SIZE;
    const visible = sessions.slice(start, start + PAGE_SIZE);
    const contentW = Math.max(24, wrapW);
    // 预览宽度：给「› 」+ 选中高亮 + meta（"12条 · 3分钟前"）留位
    const metaSample = "  · 99条 · 刚刚";
    const previewW = Math.max(12, contentW - strWidth(metaSample) - 2);

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.blue} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.blue} bold>{S.sessionsTitle}</Text>
            <Text color={THEME.grayDim}>{S.sessionsPrompt}</Text>
            <Box flexDirection="column" marginTop={0.5}>
                {visible.map((s, i) => {
                    const active = start + i === selectedIndex;
                    const preview = truncateMiddle(s.preview || "(无预览)", previewW);
                    const meta = `  · ${s.messageCount}条 · ${S.relTime(s.updatedAt ?? "")}`;
                    return (
                        <Box key={s.sessionId} flexDirection="row">
                            <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                            <Text color={active ? THEME.white : THEME.gray} bold={active}>{preview}</Text>
                            <Text color={THEME.grayDim}>{meta}</Text>
                        </Box>
                    );
                })}
            </Box>
            {sessions.length > PAGE_SIZE ? (
                <Text color={THEME.grayDim}>{`第 ${start + 1}-${Math.min(start + PAGE_SIZE, sessions.length)} / ${sessions.length} 个（↑↓ 选择·自动翻页）`}</Text>
            ) : null}
        </Box>
    );
};
