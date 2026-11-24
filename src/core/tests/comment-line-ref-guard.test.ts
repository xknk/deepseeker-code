/**
 * @file tests/comment-line-ref-guard.test.ts
 * @description 注释行号引用禁令守门（评审修复施工单卡 5，2026-11-24）：注释里的「文件:行号」引用
 *  会随代码演进静默腐烂（改一行就全错、且没有任何机制提醒）——一律改成符号名引用。
 *
 *  覆盖两种形态：
 *  - 严格形态：`xx.ts:123`（含路径与扩展名的完整引用）；
 *  - 裸形态：注释里的 `:123`（前文已写了文件名、后文裸跟行号的偷懒写法）。
 *  排除：IP:端口、时间（它们的冒号前是数字/词字符，裸形态正则的前置断言天然排除）。
 *  只扫注释（AST 提取 CommentRange），字符串字面量与代码不在此禁令内。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.resolve(CORE_ROOT, ".."); // 仓库 src/（core + cli + vscode）

/** 严格形态：路径.扩展名:行号 */
const STRICT_RE = /[\w/.\\-]+\.(?:ts|tsx|js|mjs|mts|json|md):\d+/;
/** 裸形态：非词字符后的 :2-4位数字（冒号前是词字符的 IP:端口/时间天然排除；行号后不再跟数字） */
const BARE_RE = /(?<![\w.\\/-]):\d{2,4}(?!\d)/;

const EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "out", ".git", "tests"]);

const collectSourceFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_SEGMENTS.has(entry.name)) continue;
            collectSourceFiles(full, acc);
        } else if (EXTS.has(path.extname(entry.name))) {
            acc.push(full);
        }
    }
    return acc;
};

/** AST 提取全部注释文本（leading + trailing；每个注释带其行号，供 offender 报告定位） */
const extractComments = (file: string): Array<{ line: number; text: string }> => {
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const out: Array<{ line: number; text: string }> = [];
    const seen = new Set<number>(); // 注释起始位置去重（多节点共享同一段前导注释）
    const harvest = (node: ts.Node): void => {
        const fullStart = node.getFullStart();
        if (fullStart < node.getStart()) {
            for (const cr of ts.getLeadingCommentRanges(sf.getFullText(), fullStart) ?? []) {
                if (seen.has(cr.pos)) continue;
                seen.add(cr.pos);
                out.push({ line: sf.getLineAndCharacterOfPosition(cr.pos).line + 1, text: sf.getFullText().slice(cr.pos, cr.end) });
            }
        }
        for (const cr of ts.getTrailingCommentRanges(sf.getFullText(), node.end) ?? []) {
            if (seen.has(cr.pos)) continue;
            seen.add(cr.pos);
            out.push({ line: sf.getLineAndCharacterOfPosition(cr.pos).line + 1, text: sf.getFullText().slice(cr.pos, cr.end) });
        }
        ts.forEachChild(node, harvest);
    };
    sf.forEachChild(harvest);
    return out;
};

describe("注释行号引用禁令守门（卡 5：一律符号名引用，防注释行号静默腐烂）", () => {
    it("注释里不允许出现 xx.ts:123 严格形态与 :123 裸形态（IP:端口/时间天然排除）", () => {
        const offenders: string[] = [];
        for (const file of collectSourceFiles(SRC_ROOT)) {
            const rel = path.relative(SRC_ROOT, file).replace(/\\/g, "/");
            for (const c of extractComments(file)) {
                const strict = STRICT_RE.exec(c.text);
                if (strict) offenders.push(`${rel}:${c.line} 严格形态 → ${strict[0]}（注释原文：${c.text.replace(/\s+/g, " ").slice(0, 90)}）`);
                const bare = BARE_RE.exec(c.text);
                if (bare) offenders.push(`${rel}:${c.line} 裸形态 → ${bare[0]}（注释原文：${c.text.replace(/\s+/g, " ").slice(0, 90)}）`);
            }
        }
        assert.deepEqual(offenders, [],
            `发现注释行号引用（改符号名引用；行号会随代码演进静默腐烂）：\n${offenders.join("\n")}`);
    });
});
