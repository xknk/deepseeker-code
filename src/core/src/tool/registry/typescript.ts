/**
 * @file tool/registry/typescript.ts
 * @description TS/JS 代码导航 + 类型诊断工具（LanguageService）。补 view_symbol_outline 仅语法 AST 的缺口——
 *  get_diagnostics：单文件语法 + 语义诊断（类型错误/未用变量等，带行号/列/严重度/TS 码）。
 *  goto_definition：符号跳转，返回定义位置 rel/path:line:col。
 *  find_references：符号反向引用，全项目调用/导入/读写位置 + 读写标注 + 行摘录（类型感知，免 grep 同名误报）。
 *
 *  三者均 SAFE 只读，复用 tsHost 的 in-process LanguageService（无 tsserver 进程、无 LSP 协议）。
 *  ★ typescript 非 core 运行时依赖：validateEnvironment 在模块加载失败时返 false → runAgent 把工具从
 *    模型工具表移除（自隐藏，零干扰）。VSCode 扩展内 esbuild 打包 typescript → 可用；CLI/发布版未必。
 *
 *  支持范围：.ts/.tsx/.js/.jsx/.mjs/.cjs/.d.ts。.vue SFC 不支持（需 vue-tsc/脚本块抽取，v1 不做）。
 *  项目级全量诊断可由 run_command 跑 `tsc --noEmit` 兜底；本工具聚焦单文件高频查询。
 */
import fs from "fs/promises";
import path from "path";
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { getTs, getLanguageService, posToLineCol, lineColToPos, realpathNative, checkSupportedSourceExt } from "../tsHost.ts";
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

/** 定义/声明落在 node_modules 或 .d.ts → 第三方库标注（goto_definition / find_references 共用）。 */
const isLibFile = (abs: string): boolean =>
    /(?:^|\/)node_modules\//.test(abs.replace(/\\/g, "/")) || /\.d\.ts$/i.test(abs);

/** 读门 + 扩展名闸门 + 体积上限（get_diagnostics / goto_definition 共用前置）。返回拦截提示串或 null（放行）。 */
const precheck = async (displayPath: string, absPath: string): Promise<string | null> => {
    const readBlock = await assertReadable(absPath, displayPath);
    if (readBlock) return readBlock;
    const extBlock = checkSupportedSourceExt(displayPath);
    if (extBlock) return extBlock;
    const stat = await fs.stat(absPath);
    if (stat.size > MAX_FILE_BYTES) {
        return `⚠️ [文件过大]：[${displayPath}] 约 ${Math.round(stat.size / 1024)}KB，超过 ${MAX_FILE_BYTES / 1024}KB 上限（防全量 type-check 吃内存）。`;
    }
    return null;
};

/** 诊断条目上限（避免病理文件数百条撑爆输出；超出由尾部提示 + 中心 truncateToolResult 双重兜底）。 */
const MAX_DIAG_ENTRIES = 300;

/** 批量诊断单次文件数上限（防一次传几十个文件把输出/耗时打爆；更多请分批或跑 tsc）。 */
const MAX_DIAG_FILES = 20;

/** 引用条目上限（符号过热时防数千行引用撑爆输出；超出尾部提示 + 中心 truncateToolResult 双重兜底）。 */
const MAX_REF_ENTRIES = 200;

/** 引用行摘录截断长度（过长行只留前缀，细节让模型按需 read_file 补）。 */
const REF_SNIPPET_MAX = 160;

type TsModule = NonNullable<Awaited<ReturnType<typeof getTs>>>;

/**
 * 单文件诊断主体（get_diagnostics 批量模式的单步）：返回该文件旧口径的完整输出。
 * 单文件调用（path）等价于长度 1 的批量。单文件失败（不存在/超限/被拦）不中断整批，
 * 以 ok:false 区分——批量汇总时计入"失败"数，单文件时原样直返（与历史行为一致）。
 */
const diagnoseOneFile = async (
    TS: TsModule, displayPath: string, checkJs?: boolean,
): Promise<{ ok: true; errors: number; warnings: number; text: string } | { ok: false; text: string }> => {
    try {
        const absPath = realpathNative(resolveReadablePath(displayPath));
        const block = await precheck(displayPath, absPath);
        if (block) return { ok: false, text: block };

        const { ls } = await getLanguageService(TS, absPath, { checkJs });
        const syntactic = ls.getSyntacticDiagnostics(absPath);
        const semantic = ls.getSemanticDiagnostics(absPath);
        const all = [...syntactic, ...semantic];
        if (all.length === 0) return { ok: true, errors: 0, warnings: 0, text: `✓ No diagnostics (0 errors, 0 warnings) for ${displayPath}` };

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
            `${displayPath}:${e.line}:${e.column}  ${e.label}${e.code ? " " + e.code : ""}  ${e.msg}`,
        ).join("\n");
        const tail = overflow ? `\n…(另有 ${overflow} 条诊断未显示，请缩小范围或用 run_command 跑 tsc 看全量)…` : "";
        return { ok: true, errors, warnings, text: `[Diagnostics: ${displayPath}] ${errors} error(s), ${warnings} warning(s)\n${body}${tail}` };
    } catch (e: any) {
        return { ok: false, text: `❌ 类型诊断失败 [${displayPath}]: ${e?.message ?? e}` };
    }
};

export const typescriptTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "get_diagnostics",
            description:
                "对一个或多个 TS/JS 文件取 TypeScript 语法 + 语义诊断（类型错误、未用变量、不可达代码等），输出带行号/列/严重度/TS 错误码，" +
                "格式对齐 tsc。用于精准定位编译/类型问题，替代手动跑 tsc 再解析输出。★ 改完多个文件后验证：传 paths 数组一次诊断全部（最多 20 个），勿逐文件多次调用。" +
                "支持 .ts/.tsx/.js/.jsx/.mjs/.cjs；.vue SFC 不支持（需 vue-tsc），其余扩展名（.java/.py/.go 等）直接拒绝、勿传入。项目级全量诊断请用 run_command 跑 `tsc --noEmit`。" +
                "依赖 typescript 模块（VSCode 扩展内可用；缺失则本工具自动隐藏）。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "目标文件相对路径（如 'src/services/user.ts'）。单文件诊断用；批量请改用 paths" },
                    paths: { type: "array", items: { type: "string" }, description: "★ 批量诊断：多个文件一次验证（单次最多 20 个，超出会拒绝）。传了 paths 则忽略 path" },
                    check_js: { type: "boolean", description: "对 .js/.jsx 文件开启语义检查（默认遵 tsconfig 的 checkJs；目标为 JS 且想要类型诊断时按需置 true）" },
                },
                required: [],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            maxOutputCharacters: 48000, // ★ 批量多文件后上调（原单文件 24K；中心 truncateToolResult 仍是最终兜底）
            privacyMaskingRules: maskSecretsInContent,
            validateEnvironment: async () => !!(await getTs()),
            async execute(args: { path?: string; paths?: string[]; check_js?: boolean }, _ctx?: ToolContext): Promise<string> {
                try {
                    const TS = await getTs();
                    if (!TS) return `⚠️ [类型诊断不可用]：typescript 模块未加载（VSCode 扩展内可用；CLI 环境未必安装 typescript）。可改用 run_command 跑 \`tsc --noEmit\`。`;

                    // ★ 批量模式：paths 数组优先；单条老参数（path）向后兼容归一为长度 1 的列表。
                    //   单文件失败（不存在/超限/被拦）不中断整批，计入失败数单独展示。
                    const targets = args.paths && args.paths.length > 0 ? args.paths : (args.path ? [args.path] : []);
                    if (targets.length === 0) return `❌ [参数缺失]：请传 path（单文件）或 paths（批量，改完多个文件后一次验证）。`;
                    if (targets.length > MAX_DIAG_FILES) return `❌ [参数超限]：单次批量诊断最多 ${MAX_DIAG_FILES} 个文件（收到 ${targets.length} 个）。请分批调用，或用 run_command 跑 \`tsc --noEmit\` 做项目级全量诊断。`;

                    const results = [];
                    for (const p of targets) results.push(await diagnoseOneFile(TS, p, args.check_js));

                    // 单文件：直返该文件完整输出（与历史行为一致）
                    if (results.length === 1) return results[0].text;

                    let totalErr = 0, totalWarn = 0, clean = 0, failed = 0;
                    const sections: string[] = [];
                    for (let i = 0; i < results.length; i++) {
                        const r = results[i];
                        if (!r.ok) { failed++; sections.push(`—— ${targets[i]}（诊断未产出）——\n${r.text}`); continue; }
                        totalErr += r.errors; totalWarn += r.warnings;
                        if (r.errors === 0 && r.warnings === 0) clean++;
                        sections.push(`—— ${targets[i]} ——\n${r.text}`);
                    }
                    return `[批量诊断: ${targets.length} 个文件] 共 ${totalErr} error(s), ${totalWarn} warning(s)；${clean} 个文件干净${failed ? `，${failed} 个诊断失败` : ""}\n\n${sections.join("\n\n")}`;
                } catch (e: any) {
                    return `❌ 类型诊断失败: ${e?.message ?? e}`;
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
                "替代 grep 猜测。支持 .ts/.tsx/.js/.jsx/.mjs/.cjs；.vue SFC 不支持，其余扩展名（.java/.py/.go 等）直接拒绝、勿传入。落点在 node_modules 或 .d.ts 时标注 (declaration/library)。" +
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
                        const isLib = isLibFile(def.fileName);
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
    {
        type: "function",
        function: {
            name: "find_references",
            description:
                "查找指定 TS/JS 文件某行某列符号在全项目的所有引用位置（调用/导入/读写），输出 rel/path:line:col + 读写标注 + 所在行代码摘录。" +
                "类型感知：只返回真实绑定，不含注释/字符串里的同名词（grep 的核心误报源）。用于改签名/重命名前的影响面排查、追踪调用方，" +
                "与 goto_definition 互为反向（一个查来源、一个查去向）。支持 .ts/.tsx/.js/.jsx/.mjs/.cjs；.vue SFC 不支持，其余扩展名（.java/.py 等）直接拒绝、勿传入。" +
                "行/列为 1-based（与编辑器一致）。引用覆盖以 program 内文件为界（tsconfig include 文件 + import 链可解析文件）；单符号超 200 处引用截断。" +
                "依赖 typescript 模块（VSCode 扩展内可用；缺失则本工具自动隐藏）。",
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
            maxOutputCharacters: 48000, // 200 条引用 × ~160 字符摘录的理论上界之内；中心 truncateToolResult 仍是最终兜底
            privacyMaskingRules: maskSecretsInContent,
            validateEnvironment: async () => !!(await getTs()),
            async execute(args: { path: string; line: number; column: number }, _ctx?: ToolContext): Promise<string> {
                const { path: displayPath, line, column } = args;
                try {
                    const TS = await getTs();
                    if (!TS) return `⚠️ [查找引用不可用]：typescript 模块未加载（VSCode 扩展内可用；CLI 环境未必安装 typescript）。`;
                    const absPath = realpathNative(resolveReadablePath(displayPath));
                    const block = await precheck(displayPath, absPath);
                    if (block) return block;

                    const { ls } = await getLanguageService(TS, absPath);
                    const program = ls.getProgram();
                    if (!program) return `❌ 无法取得 TS program（内部错误）。`;
                    const sf = program.getSourceFile(absPath);
                    if (!sf) return `❌ 文件未纳入 program：${displayPath}（可能无对应 tsconfig 或解析失败）。`;

                    const pos = lineColToPos(TS, sf, line, column);
                    const groups = ls.findReferences(absPath, pos);
                    if (!groups || groups.length === 0) {
                        return `No references found at ${displayPath}:${line}:${column}（确认定位在标识符上，非空白/字面量/关键字）。`;
                    }

                    const wsRoot = getContainingRoot(absPath);
                    // 引用行摘录：每文件整读一次按行缓存，取目标行 trim 后截断（读失败/空行省略摘录段）。
                    //   引用文件本身不经 precheck（已进 program 且多数为项目内源码）；中心截断 + 条目上限双重兜底体积。
                    const lineTextCache = new Map<string, string[]>();
                    const lineSnippet = async (abs: string, line1: number): Promise<string> => {
                        let lines = lineTextCache.get(abs);
                        if (!lines) {
                            try { lines = (await fs.readFile(abs, "utf-8")).split(/\r?\n/); } catch { lines = []; }
                            lineTextCache.set(abs, lines);
                        }
                        const text = (lines[line1 - 1] ?? "").trim();
                        if (!text) return "";
                        return "  " + (text.length > REF_SNIPPET_MAX ? text.slice(0, REF_SNIPPET_MAX) + "…" : text);
                    };

                    // 逐声明组输出（重载/多声明符号会有多组；跨文件符号另有 import [alias] 别名组）。
                    //   组内引用行：[def] 定义项（TS 部分声明记 (write)）、(write)/(read) 其余。
                    const sections: string[] = [];
                    let shown = 0, overflow = 0;
                    for (const g of groups) {
                        const defSf = program.getSourceFile(g.definition.fileName);
                        let defLoc = toDisplayPath(wsRoot, g.definition.fileName);
                        if (defSf && g.definition.textSpan) {
                            const lc = posToLineCol(TS, defSf, g.definition.textSpan.start);
                            defLoc = `${defLoc}:${lc.line}:${lc.column}`;
                        }
                        const defLib = isLibFile(g.definition.fileName) ? "  (declaration/library)" : "";
                        // definition.name 可能含换行（别名组带 "(alias) <签名>" 前缀）——压平成单行防输出折断
                        const defName = (g.definition.name || "(anonymous)").replace(/\s+/g, " ");
                        const header = `${defName}${g.definition.kind ? ` [${g.definition.kind}]` : ""} — ${g.references.length} 处引用（声明 ${defLoc}）${defLib}`;
                        const bodyLines: string[] = [];
                        for (const r of g.references) {
                            if (shown >= MAX_REF_ENTRIES) { overflow++; continue; }
                            shown++;
                            const refSf = program.getSourceFile(r.fileName);
                            const lc = refSf ? posToLineCol(TS, refSf, r.textSpan.start) : { line: 0, column: 0 };
                            const tag = r.isDefinition ? "[def]" : r.isWriteAccess ? "(write)" : "(read)";
                            const snippet = r.isDefinition ? "" : await lineSnippet(r.fileName, lc.line);
                            bodyLines.push(`  ${toDisplayPath(wsRoot, r.fileName)}:${lc.line}:${lc.column}  ${tag}${snippet}`);
                        }
                        sections.push([header, ...bodyLines].join("\n"));
                    }
                    const tail = overflow > 0 ? `\n…(另有 ${overflow} 处引用未显示；符号过热可改用 grep 按调用名扫描，或分文件缩小范围)…` : "";
                    return `[References: ${displayPath}:${line}:${column}]\n${sections.join("\n")}${tail}`;
                } catch (e: any) {
                    return `❌ 查找引用失败 [${displayPath}:${line}:${column}]: ${e?.message ?? e}`;
                }
            },
        },
    },
];
