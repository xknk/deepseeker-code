/**
 * @file cli/src/components/ThinkingBlock.tsx
 * @description 思考过程指示器（对齐 Claude Code）：
 *  - 收起态（默认）：极简一行「⠋ 思考中 · 3s」/「✻ Thought for 19s」，无上下留白（避免多轮堆积撑高）。
 *  - 展开态（streaming 思考 + expanded）：渲染思考全文（暗紫、折行、超长裁尾 + 折叠提示），Ctrl+T 切换。
 *  默认不展示 reasoning 全文（保持简洁；全文已落 transcript）。已完成思考恒为收起态（Static 冻结，不重绘）。
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { wrapText } from "../util.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** 展开态思考文本最多渲染行数（避免巨长 reasoning 撑爆动态区，全文见 transcript）。 */
const EXPAND_MAX_LINES = 15;

type Props = {
    streaming: boolean;
    startedAt?: number;
    durationMs?: number;
    tokens?: number;
    /** 思考全文（展开态读取；收起态不展示）。 */
    text?: string;
    /** 是否展开显示思考全文（仅对 streaming 思考生效）。 */
    expanded?: boolean;
    /** 折行宽度（展开态折行用）。 */
    wrapW?: number;
};

export const ThinkingBlock = ({ streaming, startedAt, durationMs, text, expanded, wrapW }: Props): React.ReactElement => {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!streaming) return;
        // 200ms（5fps）：braille 仍顺滑，且减少空闲重绘（动态区高度已由正文裁剪稳定，此处进一步降噪）。
        const t = setInterval(() => setTick((v) => v + 1), 200);
        return () => clearInterval(t);
    }, [streaming]);

    // 展开态：仅 streaming 思考展开（已完成思考进 Static 冻结，恒收起）。渲染全文，超长裁尾 + 折叠提示。
    const showText = expanded && streaming && !!text && text.trim().length > 0;
    if (showText) {
        const w = Math.max(16, (wrapW ?? 80) - 2);
        const all = wrapText(text as string, w);
        let lines = all;
        let folded = 0;
        if (all.length > EXPAND_MAX_LINES) {
            folded = all.length - EXPAND_MAX_LINES;
            lines = all.slice(folded);
        }
        return (
            <Box flexDirection="column" marginTop={0.25} marginBottom={0.25}>
                <Box>
                    <Text color={THEME.thinking}>{SPINNER[tick % SPINNER.length]} 思考中 · </Text>
                    <Text color={THEME.grayDim}>展开（Ctrl+T 收起）</Text>
                </Box>
                {folded > 0 ? (
                    <Text color={THEME.grayDim}>{"  ↑ …已折叠 "}{folded}{" 行（全文见 transcript）…"}</Text>
                ) : null}
                {lines.map((line, j) => (
                    <Text key={j} color={THEME.thinking} dimColor>{line || " "}</Text>
                ))}
            </Box>
        );
    }

    // 收起态（默认）：极简一行，无上下留白
    if (streaming) {
        const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
        const spin = SPINNER[tick % SPINNER.length];
        return (
            <Box>
                <Text color={THEME.thinking}>{spin} 思考中</Text>
                <Text color={THEME.grayDim}> · {elapsed}s</Text>
            </Box>
        );
    }

    // 已完成态：有耗时（实时收尾）显示秒数；无耗时（历史回放）只显示标题，避免「Thought for 0s」误导。
    if (durationMs != null) {
        const sec = Math.max(0, Math.round(durationMs / 1000));
        return (
            <Box>
                <Text color={THEME.thinking}>✻ Thought for {sec}s</Text>
            </Box>
        );
    }
    return (
        <Box>
            <Text color={THEME.thinking}>✻ Thoughts</Text>
        </Box>
    );
};
