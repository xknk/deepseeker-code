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
import { formatTokens, strWidth, wrapText } from "../util.ts";
import { RichText } from "./RichText.tsx";
import { StreamingCursor } from "./StreamingCursor.tsx";
import type { ChatRow } from "../useChatState.ts";
import type { TraceBase } from "@/observability/type.ts";

/** 真实 token 用量行尾：↑ prompt  ↓ completion · cache 命中率。 */
const UsageFooter = ({ usage }: { usage: NonNullable<TraceBase['usage']> }): React.ReactElement => {
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? 0;
    const cachePct = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : null;
    return (
        <Text color={THEME.grayDim}>
            {"  ↑ "}{formatTokens(prompt)}{"  ↓ "}{formatTokens(completion)}
            {cachePct != null ? `  · cache ${cachePct}%` : ""}
        </Text>
    );
};

type Props = { row: Extract<ChatRow, { kind: "user" | "assistant" | "system" | "info" | "meta" }>; wrapW: number; streamTail?: number };

/** 列表项前缀检测：`- ` / `* ` / `• ` / `1. ` 等。 */
const listPrefix = (line: string): { bullet: string; rest: string } | null => {
    const m = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    if (!m) return null;
    return { bullet: `${m[2]} `, rest: m[3] };
};

/** assistant 单行：Markdown 标题 → 加粗白；列表项 → 固定列前缀 + 内容；普通行 → 直接 RichText。 */
const AssistantLine = ({ line }: { line: string }): React.ReactElement => {
    // 标题行（# ~ ######）：剥掉 # 前缀，加粗白整行（计划方案的 ## 分节标题即刻可读）
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) return <Text bold color="#ffffff">{heading[1]}</Text>;
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

export const MessageBlock = ({ row, wrapW, streamTail }: Props): React.ReactElement => {
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
    const allLines = wrapText(row.text, contentW);
    // ★ 流式裁剪：动态区只渲染尾部 N 行（N=streamTail），稳定 Ink 重绘区域高度 → 治闪屏/错位。
    //   仅对 streaming 行生效；收尾后整行进 Static 渲染全文，不丢内容。被裁掉的部分上方给一行折叠提示。
    let lines = allLines;
    let folded = 0;
    if (row.streaming && streamTail && allLines.length > streamTail) {
        folded = allLines.length - streamTail;
        lines = allLines.slice(folded);
    }
    return (
        <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
            {folded > 0 ? (
                <Text color={THEME.grayDim}>{"  ↑ …已折叠 "}{folded}{" 行…"}</Text>
            ) : null}
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
            {row.usage && !row.streaming ? <UsageFooter usage={row.usage} /> : null}
        </Box>
    );
};
