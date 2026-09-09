/**
 * @file cli/src/components/ModelPicker.tsx
 * @description 模型选择模态（纯展示，对标 Claude Code /model）：内置候选模型扁平清单，
 *  ↑↓ 选中、Enter 切换、Esc 取消；任意其它模型 id 可 `/model <id>` 直输。
 *  按键导航由 App 层 useInput 统一处理，调用 resolveModel 回传所选模型 id。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { strWidth, truncateMiddle } from "../util.ts";

const PAGE_SIZE = 8;

type Props = { models: string[]; currentModel: string; selectedIndex: number; wrapW: number };

export const ModelPicker = ({ models, currentModel, selectedIndex, wrapW }: Props): React.ReactElement => {
    // ★ 分页：selectedIndex 越过当前页时自动翻页（与 SessionPicker 同一窗口算法）。
    const start = Math.floor(Math.max(0, selectedIndex) / PAGE_SIZE) * PAGE_SIZE;
    const visible = models.slice(start, start + PAGE_SIZE);
    const contentW = Math.max(24, wrapW);
    const metaSample = "  · （当前）";
    const modelW = Math.max(12, contentW - strWidth(metaSample) - 4);

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.blue} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.blue} bold>{S.modelPickerTitle(currentModel)}</Text>
            <Text color={THEME.grayDim}>{S.modelPickerPrompt}</Text>
            <Box flexDirection="column" marginTop={0.5}>
                {visible.map((m, i) => {
                    const idx = start + i;
                    const active = idx === selectedIndex;
                    const current = m === currentModel;
                    return (
                        <Box key={m} flexDirection="row">
                            <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                            <Text color={active ? THEME.white : THEME.gray} bold={active}>
                                {`${current ? "● " : "  "}${truncateMiddle(m, modelW)}`}
                            </Text>
                            {current ? <Text color={THEME.grayDim}>{`  · ${S.modelCurrentTag}`}</Text> : null}
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
};
