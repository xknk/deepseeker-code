/**
 * @file cli/src/lineDiff.ts
 * @description 行级 LCS diff（零依赖，供 diffView 渲染红绿对比）。
 *  算法：先裁公共前后缀，仅对中段做 O(n*m) DP；中段过大（>400 万格）退化为整删整增，
 *  防 write_file 全量重写大文件时爆内存。展示层由 collapseContext 折叠长上下文段。
 */

/** diff 行：ctx=未变 / del=删除 / add=新增。 */
export type DiffRow = { t: "ctx" | "del" | "add"; s: string };

/** 归一 CRLF 后按行拆分；空串 = 零行（"".split 会得到一个幽灵空行，把「全新增」误显示成「删空行 + 增」）。 */
const splitLines = (s: string): string[] => {
    const t = String(s ?? "").replace(/\r\n/g, "\n");
    return t === "" ? [] : t.split("\n");
};

/** 行级 diff：old → new 的最小编辑序列（公共前后缀计为 ctx）。 */
export const lineDiff = (oldStr: string, newStr: string): DiffRow[] => {
    const a = splitLines(oldStr);
    const b = splitLines(newStr);

    // 公共前后缀裁剪：LCS 只需算变化中段
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;

    const m1 = a.slice(s, a.length - e);
    const m2 = b.slice(s, b.length - e);
    const rows: DiffRow[] = [];
    for (let i = 0; i < s; i++) rows.push({ t: "ctx", s: a[i] });

    const n = m1.length, m = m2.length;
    if (n === 0 && m === 0) {
        // 中段无差异
    } else if (n * m > 4_000_000) {
        // 超大中段：DP 代价过高，退化为整删整增（保真不保最小）
        for (const l of m1) rows.push({ t: "del", s: l });
        for (const l of m2) rows.push({ t: "add", s: l });
    } else {
        // LCS DP（倒序填表）+ 正序回溯：等行优先 ctx，其次 del，最后 add
        const w = m + 1;
        const dp = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i * w + j] = m1[i] === m2[j]
                    ? dp[(i + 1) * w + j + 1] + 1
                    : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
            }
        }
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (m1[i] === m2[j]) { rows.push({ t: "ctx", s: m1[i] }); i++; j++; }
            else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { rows.push({ t: "del", s: m1[i] }); i++; }
            else { rows.push({ t: "add", s: m2[j] }); j++; }
        }
        while (i < n) { rows.push({ t: "del", s: m1[i] }); i++; }
        while (j < m) { rows.push({ t: "add", s: m2[j] }); j++; }
    }

    for (let k = 0; k < e; k++) rows.push({ t: "ctx", s: a[a.length - e + k] });
    return rows;
};

/** 折叠结果行：diff 行或「⋯ N 行未变」省略标记。 */
export type CollapsedRow = DiffRow | { t: "ellip"; n: number };

/**
 * 折叠连续 ctx 段：超过 keep*2+1 行的未变段只保留首尾各 keep 行，中段收成省略标记
 *  （对齐 Claude Code 终端 diff 只展示改动邻近上下文的观感）。
 */
export const collapseContext = (rows: DiffRow[], keep = 2): CollapsedRow[] => {
    const out: CollapsedRow[] = [];
    let i = 0;
    while (i < rows.length) {
        if (rows[i].t !== "ctx") { out.push(rows[i]); i++; continue; }
        let j = i;
        while (j < rows.length && rows[j].t === "ctx") j++;
        const run = j - i;
        if (run > keep * 2 + 1) {
            for (let k = 0; k < keep; k++) out.push(rows[i + k]);
            out.push({ t: "ellip", n: run - keep * 2 });
            for (let k = run - keep; k < run; k++) out.push(rows[i + k]);
        } else {
            for (let k = 0; k < run; k++) out.push(rows[i + k]);
        }
        i = j;
    }
    return out;
};
