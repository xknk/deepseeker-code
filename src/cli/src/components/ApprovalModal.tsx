/**
 * @file cli/src/components/ApprovalModal.tsx
 * @description 工具审批模态（纯展示）：展示 detail + toolName + 允许/拒绝两项。
 *  按键导航（↑↓/Enter/Esc）由 App 层 useInput 统一处理，调用 resolveApproval。
 *  ★ edit_file 的 detail 含【减少】/【增加】结构：解析成红绿 diff 展示（- 删 / + 增，
 *    上下文折叠），其余工具维持纯文本 wrapText。
 *  ★ I-6 第四批「查看完整内容」：core guard 经 meta 附带截断前全文（fullDetail），按 f 展开时
 *    以同一套红绿渲染基建显示未截断内容（展开态不设折叠行数封顶，仅绝对上限防糊屏）。
 */
import React from "react";
import { Box, Text } from "ink";
import { THEME } from "../theme.ts";
import { S } from "../strings.ts";
import { truncateMiddle, wrapText } from "../util.ts";
import { parseApprovalDiff, pairsToDisplayRows } from "../diffView.ts";

type Props = { toolName: string; detail: string; fullDetail?: string; expanded: boolean; selectedIndex: number; wrapW: number };

const OPTIONS = [
    { label: S.approvalAllow, value: 'allow-once', color: THEME.ok },
    // ★ I-4：会话级记忆（对标 CC「本会话不再询问」）——纯内存，会话结束失效
    { label: S.approvalAllowSession, value: 'allow-session', color: THEME.ok },
    { label: S.approvalAllowAlways, value: 'allow-always', color: THEME.warn },
    { label: S.approvalDeny, value: 'deny', color: THEME.danger },
];

/** 审批 diff 展示行数封顶（每处修改独立折叠上下文，总量再截断防超长 old_str 糊满屏）。 */
const MAX_DIFF_LINES = 18;
/** 展开完整内容时的绝对上限（截断前全文可能是上千行 diff；仍有界，只是宽绰得多）。 */
const MAX_FULL_LINES = 400;

export const ApprovalModal = ({ toolName, detail, fullDetail, expanded, selectedIndex, wrapW }: Props): React.ReactElement => {
    const contentW = Math.max(16, wrapW);
    // ★ I-6 展开态优先：有 fullDetail 且按 f 展开时渲染截断前全文（同一套解析/红绿管线，仅封顶不同）
    const showFull = expanded && !!fullDetail;
    const sourceText = showFull ? fullDetail! : detail;
    // edit_file：detail 解析为 header + 各处 old/new → 红绿 diff；解析失败回退纯文本
    const parsed = parseApprovalDiff(sourceText, toolName);
    const diffRows = parsed ? pairsToDisplayRows(parsed.sections) : null;
    const cap = showFull ? MAX_FULL_LINES : MAX_DIFF_LINES;

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={THEME.warn} paddingX={1} paddingY={1} marginTop={1}>
            <Text color={THEME.warn} bold>{S.approvalTitle} · {toolName}</Text>
            <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
                {parsed && diffRows ? (
                    <>
                        {wrapText(parsed.header, contentW).map((line, j) => (
                            <Text key={`h-${j}`} color={THEME.white}>{line}</Text>
                        ))}
                        {diffRows.slice(0, cap).map((r, i) => (
                            <Text key={`d-${i}`} color={
                                r.t === "del" ? THEME.danger : r.t === "add" ? THEME.ok : THEME.grayDim
                            }>
                                {r.t === "ellip"
                                    ? (r.n > 0 ? `  ⋯ ${r.n} 行未变` : "  ⋯")
                                    : `${r.t === "del" ? "- " : r.t === "add" ? "+ " : "  "}${truncateMiddle(r.s, Math.max(20, contentW - 2))}`}
                            </Text>
                        ))}
                        {diffRows.length > cap ? (
                            <Text color={THEME.grayDim}>{`  …（另有 ${diffRows.length - cap} 行未显示${showFull ? "" : "，按 f 查看完整内容"}）`}</Text>
                        ) : null}
                    </>
                ) : (
                    wrapText(sourceText || "(无说明)", contentW).map((line, j) => (
                        <Text key={j} color={THEME.white}>{line}</Text>
                    ))
                )}
            </Box>
            {fullDetail ? <Text color={THEME.grayDim}>{S.approvalFullHint}</Text> : null}
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
