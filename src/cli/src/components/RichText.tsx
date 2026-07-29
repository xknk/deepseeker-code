/**
 * @file cli/src/components/RichText.tsx
 * @description 轻量级行内 Markdown 渲染：**加粗** → 加粗白；`代码` → 珊瑚橘；其余 → 浅灰正文。
 *  仅做行内切割（正则），不处理块级语法；已由上层 wrapText 按行切好。
 */
import React from "react";
import { Text } from "ink";
import { THEME } from "../theme.ts";

type Seg = { t: string; bold?: boolean; code?: boolean };

/** 切割一段文本为 [普通/加粗/代码] 片段。 */
const parseInline = (s: string): Seg[] => {
    const segs: Seg[] = [];
    const re = /\*\*([^*]+?)\*\*|`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
        if (m.index > last) segs.push({ t: s.slice(last, m.index) });
        if (m[1] != null) segs.push({ t: m[1], bold: true });
        else if (m[2] != null) segs.push({ t: m[2], code: true });
        last = re.lastIndex;
    }
    if (last < s.length) segs.push({ t: s.slice(last) });
    return segs.length ? segs : [{ t: s }];
};

type Props = { text: string; dim?: boolean };

export const RichText = ({ text, dim }: Props): React.ReactElement => (
    <Text>
        {parseInline(text).map((s, i) =>
            s.bold
                ? <Text key={i} bold color="#ffffff">{s.t}</Text>
                : s.code
                    ? <Text key={i} color={THEME.coralBright}>{s.t}</Text>
                    : <Text key={i} color={dim ? THEME.grayDim : THEME.body}>{s.t}</Text>,
        )}
    </Text>
);
