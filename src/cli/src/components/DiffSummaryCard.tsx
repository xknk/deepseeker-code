/**
 * @file cli/src/components/DiffSummaryCard.tsx
 * @description /diff 本 run 改动汇总卡（纯展示，★ I-3 第四批）：复用审批弹窗同款红绿渲染基建
 *  （lineDiff + collapseContext 产出的 CollapsedRow），红删绿增、上下文灰显、折叠省略；
 *  不可比对文件（备份已清理/文件已不在磁盘）以 note 行呈现。每文件行数封顶防大 diff 糊满屏。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { truncateMiddle } from "../util.ts";
import type { RunDiffFile } from "../diffSummary.ts";

/** 单文件展示行数封顶（净变化视图本就收敛；超长说明是 write_file 全量重写类，折叠已挡大头）。 */
const MAX_ROWS_PER_FILE = 40;

type Props = { title: string; files: RunDiffFile[]; wrapW: number };

export const DiffSummaryCard = ({ title, files, wrapW }: Props): React.ReactElement => {
    const contentW = Math.max(16, wrapW);
    return (
        <Box flexDirection="column" marginTop={1}>
            <Text color={THEME.grayDim} bold>{title}</Text>
            {files.map((f) => (
                <Box key={f.path} flexDirection="column" marginTop={0.5}>
                    <Text color={THEME.white} bold>{truncateMiddle(f.path, Math.max(20, contentW))}</Text>
                    {f.note ? (
                        <Text color={THEME.grayDim}>{`  ${f.note}`}</Text>
                    ) : f.rows ? (
                        <>
                            {f.rows.slice(0, MAX_ROWS_PER_FILE).map((r, i) => (
                                <Text key={i} color={r.t === "del" ? THEME.danger : r.t === "add" ? THEME.ok : THEME.grayDim}>
                                    {r.t === "ellip"
                                        ? (r.n > 0 ? `  ⋯ ${r.n} 行未变` : "  ⋯")
                                        : `${r.t === "del" ? "- " : r.t === "add" ? "+ " : "  "}${truncateMiddle(r.s, Math.max(20, contentW - 2))}`}
                                </Text>
                            ))}
                            {f.rows.length > MAX_ROWS_PER_FILE ? (
                                <Text color={THEME.grayDim}>{`  …（另有 ${f.rows.length - MAX_ROWS_PER_FILE} 行未显示）`}</Text>
                            ) : null}
                        </>
                    ) : null}
                </Box>
            ))}
        </Box>
    );
};
