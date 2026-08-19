/**
 * @file cli/src/components/ApprovalModal.tsx
 * @description 工具审批模态（纯展示）：展示 detail + toolName + 允许/拒绝两项。
 *  按键导航（↑↓/Enter/Esc）由 App 层 useInput 统一处理，调用 resolveApproval。
 *  ★ edit_file 的 detail 含【减少】/【增加】结构：解析成红绿 diff 展示（- 删 / + 增，
 *    上下文折叠），其余工具维持纯文本 wrapText。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { truncateMiddle, wrapText } from "../util.ts";
import { parseApprovalDiff, pairsToDisplayRows } from "../diffView.ts";

type Props = { toolName: string; detail: string; selectedIndex: number; wrapW: number };

const OPTIONS = [
    { label: S.approvalAllow, value: 'allow-once', color: THEME.ok },
    { label: S.approvalAllowAlways, value: 'allow-always', color: THEME.warn },
    { label: S.approvalDeny, value: 'deny', color: THEME.danger },
];

/** 审批 diff 展示行数封顶（每处修改独立折叠上下文，总量再截断防超长 old_str 糊满屏）。 */
const MAX_DIFF_LINES = 18;

export const ApprovalModal = ({ toolName, detail, selectedIndex, wrapW }: Props): React.ReactElement => {
    const contentW = Math.max(16, wrapW);
    // edit_file：detail 解析为 header + 各处 old/new → 红绿 diff；解析失败回退纯文本
    const parsed = parseApprovalDiff(detail, toolName);
    const diffRows = parsed ? pairsToDisplayRows(parsed.sections) : null;

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.warn} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.warn} bold>{S.approvalTitle} · {toolName}</Text>
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {parsed && diffRows ? (
                    <>
                        {wrapText(parsed.header, contentW).map((line, j) => (
                            <Text key={`h-${j}`} color={THEME.white}>{line}</Text>
                        ))}
                        {diffRows.slice(0, MAX_DIFF_LINES).map((r, i) => (
                            <Text key={`d-${i}`} color={
                                r.t === "del" ? THEME.danger : r.t === "add" ? THEME.ok : THEME.grayDim
                            }>
                                {r.t === "ellip"
                                    ? (r.n > 0 ? `  ⋯ ${r.n} 行未变` : "  ⋯")
                                    : `${r.t === "del" ? "- " : r.t === "add" ? "+ " : "  "}${truncateMiddle(r.s, Math.max(20, contentW - 2))}`}
                            </Text>
                        ))}
                        {diffRows.length > MAX_DIFF_LINES ? (
                            <Text color={THEME.grayDim}>{`  …（另有 ${diffRows.length - MAX_DIFF_LINES} 行未显示）`}</Text>
                        ) : null}
                    </>
                ) : (
                    wrapText(detail || "(无说明)", contentW).map((line, j) => (
                        <Text key={j} color={THEME.white}>{line}</Text>
                    ))
                )}
            </Box>
            <Text color={THEME.grayDim}>{S.approvalPrompt}</Text>
            {OPTIONS.map((opt, i) => {
                const active = i === selectedIndex;
                return (
                    <Box key={opt.label} flexDirection="row">
                        <Text color={active ? THEME.coralBright : undefined} bold>{active ? "› " : "  "}</Text>
                        <Text color={active ? THEME.white : THEME.gray} bold={active}>{opt.label}</Text>
                    </Box>
                );
            })}
        </Box>
    );
};
