/**
 * @file tool/registry/typescript.ts
 * @description TS/JS 代码导航 + 类型诊断工具（LanguageService）。补 view_symbol_outline 仅语法 AST 的缺口——
 *  get_diagnostics：单文件语法 + 语义诊断（类型错误/未用变量等，带行号/列/严重度/TS 码）。
 *  goto_definition：符号跳转，返回定义位置 rel/path:line:col。
 *
 *  两者均 SAFE 只读，复用 tsHost 的 in-process LanguageService（无 tsserver 进程、无 LSP 协议）。
 *  ★ typescript 非 core 运行时依赖：validateEnvironment 在模块加载失败时返 false → runAgent 把工具从
 *    模型工具表移除（自隐藏，零干扰）。VSCode 扩展内 esbuild 打包 typescript → 可用；CLI/发布版未必。
 *
 *  支持范围：.ts/.tsx/.js/.jsx/.mjs/.cjs/.d.ts。.vue SFC 不支持（需 vue-tsc/脚本块抽取，v1 不做）。
 *  项目级全量诊断可由 run_command 跑 `tsc --noEmit` 兜底；本工具聚焦单文件高频查询。
 */
import fs from "fs/promises";
import path from "path";
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { getTs, getLanguageService, posToLineCol, lineColToPos, realpathNative } from "../tsHost.ts";
import { resolveReadablePath, getContainingRoot } from "../guard.ts";
import { assertReadable, maskSecretsInContent } from "./fs.ts";

/** 单文件体积上限（防 minified 巨型文件 AST/type-check 吃内存）——同 view_symbol_outline。 */
const MAX_FILE_BYTES = 1024 * 1024;

/** 把绝对路径转成相对工作区所属根的展示路径；工作区外（如 TS 内置 lib）取末三段避免冗长绝对路径。 */
const toDisplayPath = (wsRoot: string, abs: string): string => {
    const rel = path.relative(wsRoot, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
    return abs.replace(/\\/g, "/").split("/").slice(-3).join("/");
};

/** 读门 + 体积上限（get_diagnostics / goto_definition 共用前置）。返回拦截提示串或 null（放行）。 */
const precheck = async (displayPath: string, absPath: string): Promise<string | null> => {
    const readBlock = await assertReadable(absPath, displayPath);
    if (readBlock) return readBlock;
    const stat = await fs.stat(absPath);
    if (stat.size > MAX_FILE_BYTES) {
        return `⚠️ [文件过大]：[${displayPath}] 约 ${Math.round(stat.size / 1024)}KB，超过 ${MAX_FILE_BYTES / 1024}KB 上限（防全量 type-check 吃内存）。`;
    }
    return null;
};

/** 诊断条目上限（避免病理文件数百条撑爆输出；超出由尾部提示 + 中心 truncateToolResult 双重兜底）。 */
const MAX_DIAG_ENTRIES = 300;

export const typescriptTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "get_diagnostics",
            description:
                "对单个 TS/JS 文件取 TypeScript 语法 + 语义诊断（类型错误、未用变量、不可达代码等），输出带行号/列/严重度/TS 错误码，" +
                "格式对齐 tsc。用于精准定位编译/类型问题，替代手动跑 tsc 再解析输出。支持 .ts/.tsx/.js/.jsx/.mjs/.cjs；" +
                ".vue SFC 不支持（需 vue-tsc）。项目级全量诊断请用 run_command 跑 `tsc --noEmit`。" +
                "依赖 typescript 模块（VSCode 扩展内可用；缺失则本工具自动隐藏）。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "目标文件相对路径（如 'src/services/user.ts'）" },
                    check_js: { type: "boolean", description: "对 .js/.jsx 文件开启语义检查（默认遵 tsconfig 的 checkJs；目标为 JS 且想要类型诊断时按需置 true）" },
                },
                required: ["path"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            maxOutputCharacters: 24000,
            privacyMaskingRules: maskSecretsInContent,
            validateEnvironment: async () => !!(await getTs()),
            async execute(args: { path: string; check_js?: boolean }, _ctx?: ToolContext): Promise<string> {
                try {
                    const TS = await getTs();
                    if (!TS) return `⚠️ [类型诊断不可用]：typescript 模块未加载（VSCode 扩展内可用；CLI 环境未必安装 typescript）。可改用 run_command 跑 \`tsc --noEmit\`。`;
                    const absPath = realpathNative(resolveReadablePath(args.path));
                    const block = await precheck(args.path, absPath);
                    if (block) return block;

                    const { ls } = await getLanguageService(TS, absPath, { checkJs: args.check_js });
                    const syntactic = ls.getSyntacticDiagnostics(absPath);
                    const semantic = ls.getSemanticDiagnostics(absPath);
                    const all = [...syntactic, ...semantic];
                    if (all.length === 0) return `✓ No diagnostics (0 errors, 0 warnings) for ${args.path}`;

                    type Entry = { line: number; column: number; label: string; code: string; msg: string };
                    const entries: Entry[] = [];
                    let errors = 0, warnings = 0;
                    for (const d of all) {
                        const cat = d.category;
                        let label: string;
                        if (cat === TS.DiagnosticCategory.Error) { label = "error"; errors++; }
                        else if (cat === TS.DiagnosticCategory.Warning) { label = "warning"; warnings++; }
                        else if (cat === TS.DiagnosticCategory.Suggestion) label = "suggestion";
                        else label = "info";
                        let line = 0, column = 0;
                        if (d.file && typeof d.start === "number") {
                            ({ line, column } = posToLineCol(TS, d.file, d.start));
                        }
                        entries.push({
                            line, column, label,
                            code: typeof d.code === "number" ? `TS${d.code}` : "",
                            msg: TS.flattenDiagnosticMessageText(d.messageText, "\n"),
                        });
                    }
                    entries.sort((a, b) => a.line - b.line || a.column - b.column);

                    const overflow = entries.length > MAX_DIAG_ENTRIES ? entries.length - MAX_DIAG_ENTRIES : 0;
                    const shown = overflow ? entries.slice(0, MAX_DIAG_ENTRIES) : entries;
                    const body = shown.map(e =>
                        `${args.path}:${e.line}:${e.column}  ${e.label}${e.code ? " " + e.code : ""}  ${e.msg}`,
                    ).join("\n");
                    const tail = overflow ? `\n…(另有 ${overflow} 条诊断未显示，请缩小范围或用 run_command 跑 tsc 看全量)…` : "";
                    return `[Diagnostics: ${args.path}] ${errors} error(s), ${warnings} warning(s)\n${body}${tail}`;
                } catch (e: any) {
                    return `❌ 类型诊断失败 [${args.path}]: ${e?.message ?? e}`;
                }
            },
        },
    },
    {
        type: "function",
        function: {
            name: "goto_definition",
            description:
                "跳转到指定 TS/JS 文件某行某列符号的定义位置，返回 rel/path:line:col（可多处）。用于跨文件追踪函数/类型/变量的来源，" +
                "替代 grep 猜测。支持 .ts/.tsx/.js/.jsx/.mjs/.cjs；.vue SFC 不支持。落点在 node_modules 或 .d.ts 时标注 (declaration/library)。" +
                "行/列为 1-based（与编辑器一致）。依赖 typescript 模块（VSCode 扩展内可用；缺失则本工具自动隐藏）。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "目标文件相对路径（如 'src/index.ts'）" },
                    line: { type: "integer", description: "符号所在行号（1-based）" },
                    column: { type: "integer", description: "符号所在列号（1-based）" },
                },
                required: ["path", "line", "column"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            privacyMaskingRules: maskSecretsInContent,
            validateEnvironment: async () => !!(await getTs()),
            async execute(args: { path: string; line: number; column: number }, _ctx?: ToolContext): Promise<string> {
                const { path: displayPath, line, column } = args;
                try {
                    const TS = await getTs();
                    if (!TS) return `⚠️ [跳转定义不可用]：typescript 模块未加载（VSCode 扩展内可用；CLI 环境未必安装 typescript）。`;
                    const absPath = realpathNative(resolveReadablePath(displayPath));
                    const block = await precheck(displayPath, absPath);
                    if (block) return block;

                    const { ls } = await getLanguageService(TS, absPath);
                    const program = ls.getProgram();
                    if (!program) return `❌ 无法取得 TS program（内部错误）。`;
                    const sf = program.getSourceFile(absPath);
                    if (!sf) return `❌ 文件未纳入 program：${displayPath}（可能无对应 tsconfig 或解析失败）。`;

                    const pos = lineColToPos(TS, sf, line, column);
                    const defs = ls.getDefinitionAtPosition(absPath, pos);
                    if (!defs || defs.length === 0) {
                        return `No definition found at ${displayPath}:${line}:${column}（确认定位在标识符上，非空白/字面量/关键字）。`;
                    }

                    const wsRoot = getContainingRoot(absPath);
                    const out = defs.map(def => {
                        const defSf = program.getSourceFile(def.fileName);
                        let loc = toDisplayPath(wsRoot, def.fileName);
                        if (defSf && def.textSpan) {
                            const lc = posToLineCol(TS, defSf, def.textSpan.start);
                            loc = `${toDisplayPath(wsRoot, def.fileName)}:${lc.line}:${lc.column}`;
                        }
                        const isLib = /(?:^|\/)node_modules\//.test(def.fileName.replace(/\\/g, "/")) || /\.d\.ts$/i.test(def.fileName);
                        const name = def.name || "(anonymous)";
                        const kind = def.kind ? ` [${def.kind}]` : "";
                        return `${name}${kind} → ${loc}${isLib ? "  (declaration/library)" : ""}`;
                    });
                    return `[Goto Definition: ${displayPath}:${line}:${column}]\n${out.join("\n")}`;
                } catch (e: any) {
                    return `❌ 跳转定义失败 [${displayPath}:${line}:${column}]: ${e?.message ?? e}`;
                }
            },
        },
    },
];
