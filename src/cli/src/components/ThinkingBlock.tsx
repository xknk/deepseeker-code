/**
 * @file cli/src/components/ThinkingBlock.tsx
 * @description 思考过程指示器（对齐 Claude Code）：
 *  - 流式中：braille spinner 动画 + 实时秒数「⠋ 思考中 · 3s」
 *  - 完成后：冻结的「✻ 思考 19s · ~1.2k tok」（时长/token 在收尾时算好，Static 渲染后不再变动）
 *  默认不展示原始 reasoning 文本（保持简洁；全文已落 transcript）。
 */
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { formatTokens } from "../util.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Props = {
    streaming: boolean;
    startedAt?: number;
    durationMs?: number;
    tokens?: number;
};

export const ThinkingBlock = ({ streaming, startedAt, durationMs, tokens }: Props): React.ReactElement => {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!streaming) return;
        const t = setInterval(() => setTick((v) => v + 1), 100);
        return () => clearInterval(t);
    }, [streaming]);

    if (streaming) {
        const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
        const spin = SPINNER[tick % SPINNER.length];
        return (
            <Box marginTop={0.5} marginBottom={0.5}>
                <Text color={THEME.thinking}>{spin} 思考中</Text>
                <Text color={THEME.grayDim}> · {elapsed}s</Text>
            </Box>
        );
    }

    const sec = durationMs ? Math.max(0, Math.round(durationMs / 1000)) : 0;
    const tok = tokens ? formatTokens(tokens) : "";
    return (
        <Box marginTop={0.5} marginBottom={0.5}>
            <Text color={THEME.thinking}>✻ 思考 {sec}s{tok ? "" : ""}</Text>
            {tok ? <Text color={THEME.grayDim}> · ~{tok} tok</Text> : null}
        </Box>
    );
};
