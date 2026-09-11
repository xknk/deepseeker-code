/**
 * @file cli/src/components/MessageBlock.tsx
 * @description 纯文本消息行渲染：
 *  - user(>) / system(!) / info(›) / meta：原样
 *  - assistant(●)：RichText 行内 Markdown + 列表前缀固定列对齐 + 代码围栏/GFM 表格块渲染 + 流式末尾闪烁光标
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

// ———————— 块级 markdown：代码围栏 / GFM 表格（CLI 端补齐，2026-09-11）————————

type Block =
  | { kind: "line"; text: string }
  | { kind: "fence"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

const isFenceMark = (l: string): boolean => /^\s*```/.test(l);
const isMdRow = (l: string): boolean => l.includes("|");
const isMdSep = (l: string): boolean => /^[ \t|:-]+$/.test(l) && l.includes("-") && l.includes("|");
const mdCells = (l: string): string[] =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** 文本 → 块序列：围栏（流式中未闭合到 EOF 的部分也按代码渲染）/ 表格（表头+分隔行+数据行）/ 普通行。 */
const parseBlocks = (text: string): Block[] => {
  const src = String(text || "").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < src.length) {
    if (isFenceMark(src[i])) {
      const body: string[] = [];
      i++;
      while (i < src.length && !isFenceMark(src[i])) body.push(src[i++]);
      if (i < src.length) i++; // 消费闭合 ```
      blocks.push({ kind: "fence", lines: body });
      continue;
    }
    if (isMdRow(src[i]) && i + 1 < src.length && isMdSep(src[i + 1])) {
      const header = mdCells(src[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < src.length && isMdRow(src[i])) rows.push(mdCells(src[i++]));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    blocks.push({ kind: "line", text: src[i++] });
  }
  return blocks;
};

/** 按显示宽度截断（CJK 宽字符不劈半、超宽补 …），不足补空格对齐。 */
const fitCell = (s: string, w: number): string => {
  if (strWidth(s) <= w) return s + " ".repeat(w - strWidth(s));
  let out = "";
  let width = 0;
  const limit = Math.max(1, w - 1); // 给 … 留 1 格
  for (const ch of s) {
    const cw = strWidth(ch);
    if (width + cw > limit) break;
    out += ch;
    width += cw;
  }
  return out + "…";
};

/** 列宽 = 列内最宽单元格（单列上限 30）；总宽超 contentW 时从最宽列逐列压缩（下限 1，保对齐优先于可读）。 */
const tableWidths = (header: string[], rows: string[][], contentW: number): number[] => {
  const n = Math.max(1, header.length);
  const w = Array.from({ length: n }, (_, c) => {
    let m = strWidth(header[c] ?? "");
    for (const r of rows) m = Math.max(m, strWidth(r[c] ?? ""));
    return Math.min(m, 30);
  });
  const total = () => w.reduce((a, b) => a + b, 0) + 2 * (n - 1);
  while (total() > contentW && Math.max(...w) > 1) {
    const maxW = Math.max(...w);
    w[w.indexOf(maxW)] = maxW - 1;
  }
  return w;
};

/** 视觉行：流式折叠按视觉行粒度；代码/表格行不走 wrapText（折行毁代码与表格对齐）。 */
type VLine =
  | { k: "text"; s: string }
  | { k: "code"; s: string }
  | { k: "thead"; cells: string[]; w: number[] }
  | { k: "tsep"; w: number[] }
  | { k: "trow"; cells: string[]; w: number[] };

const buildVLines = (text: string, contentW: number): VLine[] => {
  const out: VLine[] = [];
  for (const b of parseBlocks(text)) {
    if (b.kind === "line") {
      for (const l of wrapText(b.text, contentW)) out.push({ k: "text", s: l });
    } else if (b.kind === "fence") {
      for (const l of b.lines) out.push({ k: "code", s: l });
    } else {
      const w = tableWidths(b.header, b.rows, contentW);
      out.push({ k: "thead", cells: b.header, w }, { k: "tsep", w });
      for (const r of b.rows) out.push({ k: "trow", cells: r, w });
    }
  }
  return out.length ? out : [{ k: "text", s: "" }];
};

/** 视觉行渲染（"● " gutter 由外层按序号给：首行 ● 、其余对齐空格）。 */
const AssistantVLine = ({ v }: { v: VLine }): React.ReactElement => {
  switch (v.k) {
    case "text":
      return <AssistantLine line={v.s} />;
    case "code":
      return (
        <Box flexDirection="row">
          <Text color={THEME.divider}>{"│ "}</Text>
          <Text color={THEME.gray}>{v.s.length ? v.s : " "}</Text>
        </Box>
      );
    case "thead":
      return (
        <Box flexDirection="row">
          {v.w.map((cw, i) => (
            <Box key={i} width={cw + 2} flexShrink={0}>
              <Text bold color="#ffffff">{fitCell(v.cells[i] ?? "", cw)}</Text>
            </Box>
          ))}
        </Box>
      );
    case "tsep":
      return (
        <Box flexDirection="row">
          {v.w.map((cw, i) => (
            <Box key={i} width={cw + 2} flexShrink={0}>
              <Text color={THEME.divider}>{"─".repeat(cw)}</Text>
            </Box>
          ))}
        </Box>
      );
    case "trow":
      return (
        <Box flexDirection="row">
          {v.w.map((cw, i) => (
            <Box key={i} width={cw + 2} flexShrink={0}>
              <Text color={THEME.body}>{fitCell(v.cells[i] ?? "", cw)}</Text>
            </Box>
          ))}
        </Box>
      );
  }
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
    // ★ 块级解析（代码围栏/GFM 表格）→ 视觉行；流式裁剪按视觉行粒度（N=streamTail），稳定 Ink 重绘区域高度 → 治闪屏/错位。
    //   仅对 streaming 行生效；收尾后整行进 Static 渲染全文，不丢内容。被裁掉的部分上方给一行折叠提示。
    const allLines = buildVLines(row.text, contentW);
    let vlines = allLines;
    let folded = 0;
    if (row.streaming && streamTail && allLines.length > streamTail) {
        folded = allLines.length - streamTail;
        vlines = allLines.slice(folded);
    }
    return (
        <Box flexDirection="column" marginTop={0.5} marginBottom={0.5}>
            {folded > 0 ? (
                <Text color={THEME.grayDim}>{"  ↑ …已折叠 "}{folded}{" 行…"}</Text>
            ) : null}
            {vlines.map((v, j) => {
                const isLast = j === vlines.length - 1;
                return (
                    <Box flexDirection="row" key={j}>
                        <Text bold color={THEME.coralBright}>{j === 0 ? "● " : "  "}</Text>
                        <AssistantVLine v={v} />
                        {isLast && row.streaming ? <StreamingCursor /> : null}
                    </Box>
                );
            })}
            {row.usage && !row.streaming ? <UsageFooter usage={row.usage} /> : null}
        </Box>
    );
};
