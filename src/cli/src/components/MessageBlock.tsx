/**
 * @file cli/src/components/MessageBlock.tsx
 * @description 纯文本消息行渲染：
 *  - user(>) / system(!) / info(›) / meta：原样
 *  - assistant(●)：RichText 行内 Markdown + 列表前缀固定列对齐 + 流式末尾闪烁光标
 *  - meta 轮次：横跨全宽的暗灰分割线「─ 第 N 轮 ────…」
 *  tool / thinking 行由 ToolCard / ThinkingBlock 单独渲染。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { strWidth, wrapText } from "../util.ts";
import { RichText } from "./RichText.tsx";
import { StreamingCursor } from "./StreamingCursor.tsx";
import type { ChatRow } from "../useChatState.ts";

type Props = { row: Extract<ChatRow, { kind: "user" | "assistant" | "system" | "info" | "meta" }>; wrapW: number };

/** 列表项前缀检测：`- ` / `* ` / `• ` / `1. ` 等。 */
const listPrefix = (line: string): { bullet: string; rest: string } | null => {
    const m = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    if (!m) return null;
    return { bullet: `${m[2]} `, rest: m[3] };
};

/** assistant 单行：列表项 → 固定列前缀 + 内容；普通行 → 直接 RichText。 */
const AssistantLine = ({ line }: { line: string }): React.ReactElement => {
    const list = listPrefix(line);
    if (list) {
        return (
            <Box flexDirection="row">
                <Box width={4} flexShrink={0}><Text color={THEME.grayDim}>{list.bullet}</Text></Box>
                <RichText text={list.rest} />
            </Box>
        );
    }
    return <RichText text={line} />;
};

export const MessageBlock = ({ row, wrapW }: Props): React.ReactElement => {
    if (row.kind === "meta") {
        // 轮次 → 全宽暗灰分割线
        if (/^第 \d+ 轮$/.test(row.text)) {
            const prefix = `─ ${row.text} `;
            const remain = Math.max(0, wrapW - strWidth(prefix));
            return (
                <Box marginTop={0.5} marginBottom={0.5}>
                    <Text color={THEME.divider}>{prefix}{"─".repeat(remain)}</Text>
                </Box>
            );
        }
        return (
            <Box marginTop={0.25} marginBottom={0.25}>
                <Text color={THEME.grayDim}>{"* "}{row.text}</Text>
            </Box>
        );
    }

    if (row.kind === "info") {
        const lines = wrapText(row.text, Math.max(8, wrapW));
        return (
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {lines.map((line, j) => (
                    <Text key={j} color={THEME.coralMuted}>
                        {j === 0 ? "› " : "  "}{line}
                    </Text>
                ))}
            </Box>
        );
    }

    if (row.kind === "user") {
        const lines = wrapText(row.text, Math.max(8, wrapW - 2));
        return (
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {lines.map((line, j) => (
                    <Text key={j}>
                        {j === 0 ? (
                            <>
                                <Text color={THEME.coralBright} bold>{"> "}</Text>
                                <Text color={THEME.white}>{line}</Text>
                            </>
                        ) : (
                            <Text color={THEME.white}>{"  "}{line}</Text>
                        )}
                    </Text>
                ))}
            </Box>
        );
    }

    if (row.kind === "system") {
        const lines = wrapText(row.text, Math.max(8, wrapW - 2));
        return (
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {lines.map((line, j) => (
                    <Text key={j} color={THEME.warn}>
                        {j === 0 ? "! " : "  "}{line}
                    </Text>
                ))}
            </Box>
        );
    }

    // assistant
    const contentW = Math.max(8, wrapW - 2);
    const lines = wrapText(row.text, contentW);
    return (
        <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
            {lines.map((line, j) => {
                const isLast = j === lines.length - 1;
                return (
                    <Box flexDirection="row" key={j}>
                        <Text bold color={THEME.coralBright}>{j === 0 ? "● " : "  "}</Text>
                        <AssistantLine line={line} />
                        {isLast && row.streaming ? <StreamingCursor /> : null}
                    </Box>
                );
            })}
        </Box>
    );
};
