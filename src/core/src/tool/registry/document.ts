/**
 * @file tool/registry/document.ts
 * @description 文档读取工具集：read_docx（Word .docx）/ read_pdf（.pdf）。
 *  read_file 强制 UTF-8 文本流，读不了二进制 docx/pdf 容器（满屏乱码）；本文件用 mammoth / unpdf
 *  解析，补齐文档类数据源（规格说明 / 设计文档 / 需求 / 报告）。安全与 read_file 对齐：
 *  SAFE 级 + resolveSafePath 围栏 + 读保护闸门（敏感凭证拒读 / gitignore 跳过）+ 内容脱敏。
 */
import path from "path";
import fs from "fs/promises";
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { resolveSafePath, getContainingRoot } from "../guard.ts";
import { assertReadable, maskSecretsInContent } from "./fs.ts";

/** 动态加载 mammoth（CJS interop 兼容 default / namespace 两种导出形态）。 */
const getMammoth = async (): Promise<any> => {
    const m: any = await import("mammoth");
    return m.extractRawText ? m : m.default;
};
/** 动态加载 unpdf。 */
const getUnpdf = async (): Promise<any> => import("unpdf");

/** 文档读取类工具集（read_docx / read_pdf，详见上方 @file 说明）。 */
export const documentTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "read_docx",
            description: "读取 Word 文档（.docx），用 mammoth 提取正文纯文本返回（保留段落换行）。read_file 读不了二进制 docx（会乱码），本工具适合读取规格说明/设计文档/需求文档。大文档可调 start_char 翻页。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Word 文档路径（相对项目根或绝对路径）" },
                    start_char: { type: "number", description: "从第几个字符开始读（0-based）。缺省 0。大文档翻页用" },
                    max_chars: { type: "number", description: "最多返回的字符数。缺省 30000，上限 50000，防 Token 爆炸" },
                },
                required: ["path"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            // ★ 文档正文可能很长，独立预算脱离通用 16K 兜底（与 read_file 同口径的宽松读取）。
            maxOutputCharacters: 48000,
            privacyMaskingRules: maskSecretsInContent,
            async execute(args: { path: string; start_char?: number; max_chars?: number }): Promise<string> {
                try {
                    const absPath = resolveSafePath(args.path);
                    // ★ 读保护闸门（与 read_file 对称）：敏感凭证拒读 + gitignore/通用忽略跳过；多根按文件所属根。
                    const checkBase = getContainingRoot(absPath);
                    const relForCheck = path.relative(checkBase, absPath).replace(/\\/g, "/");
                    const readBlock = await assertReadable(relForCheck, args.path, checkBase);
                    if (readBlock) return readBlock;

                    if (!absPath.toLowerCase().endsWith(".docx")) {
                        return `❌ [格式不支持]：[${args.path}] 不是 .docx。read_docx 仅解析 Word 文档（.doc 老格式请先另存为 .docx）；其它文件用 read_file。`;
                    }

                    const start = args.start_char ? Math.max(0, Math.floor(args.start_char)) : 0;
                    const maxChars = Math.min(args.max_chars ? Math.max(1, Math.floor(args.max_chars)) : 30000, 50000);

                    const mammoth = await getMammoth();
                    const result = await mammoth.extractRawText({ path: absPath });
                    const full: string = result?.value ?? "";
                    if (!full.trim()) return `[${args.path}] 文档正文为空（可能是纯图片/扫描页，mammoth 提取不到文字层）。`;

                    const total = full.length;
                    const slice = full.slice(start, start + maxChars);
                    const lines = [
                        `[File: ${args.path} | 字符: ${start}-${start + slice.length} / 共 ${total}]`,
                        slice,
                    ];
                    if (start + slice.length < total) lines.push(`\n[... 后面还有 ${total - (start + slice.length)} 字符，可把 start_char 设为 ${start + slice.length} 继续翻页。]`);
                    return lines.join("\n");
                } catch (error: any) {
                    return `读取 Word 文档失败 [${args.path}]: ${error.message}`;
                }
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_pdf",
            description: "读取 PDF 文档，用 pdfjs(unpdf) 提取文字层文本返回。read_file 读不了二进制 PDF（会乱码）。★ 仅对【文字版 PDF】有效——扫描件/图片型 PDF 无文字层，提取为空需 OCR。大文档可调 start_char 翻页。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "PDF 文档路径（相对项目根或绝对路径）" },
                    start_char: { type: "number", description: "从第几个字符开始读（0-based）。缺省 0。大文档翻页用" },
                    max_chars: { type: "number", description: "最多返回的字符数。缺省 30000，上限 50000，防 Token 爆炸" },
                },
                required: ["path"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            maxOutputCharacters: 48000,
            privacyMaskingRules: maskSecretsInContent,
            async execute(args: { path: string; start_char?: number; max_chars?: number }): Promise<string> {
                try {
                    const absPath = resolveSafePath(args.path);
                    const checkBase = getContainingRoot(absPath);
                    const relForCheck = path.relative(checkBase, absPath).replace(/\\/g, "/");
                    const readBlock = await assertReadable(relForCheck, args.path, checkBase);
                    if (readBlock) return readBlock;

                    if (!absPath.toLowerCase().endsWith(".pdf")) {
                        return `❌ [格式不支持]：[${args.path}] 不是 .pdf。read_pdf 仅解析 PDF 文档；其它文件用 read_file。`;
                    }

                    const start = args.start_char ? Math.max(0, Math.floor(args.start_char)) : 0;
                    const maxChars = Math.min(args.max_chars ? Math.max(1, Math.floor(args.max_chars)) : 30000, 50000);

                    // unpdf：先 getDocumentProxy(Uint8Array) 再 extractText（mergePages=true 合并全文）。
                    const buf = await fs.readFile(absPath);
                    const unpdf = await getUnpdf();
                    const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf));
                    const { text, totalPages } = await unpdf.extractText(pdf, { mergePages: true });
                    const full: string = text ?? "";
                    if (!full.trim()) return `[${args.path}] PDF 未提取到文字（疑似扫描件/图片型 PDF，无文字层，需 OCR）。总页数：${totalPages}。`;

                    const total = full.length;
                    const slice = full.slice(start, start + maxChars);
                    const lines = [
                        `[File: ${args.path} | 页数: ${totalPages} | 字符: ${start}-${start + slice.length} / 共 ${total}]`,
                        slice,
                    ];
                    if (start + slice.length < total) lines.push(`\n[... 后面还有 ${total - (start + slice.length)} 字符，可把 start_char 设为 ${start + slice.length} 继续翻页。]`);
                    return lines.join("\n");
                } catch (error: any) {
                    return `读取 PDF 失败 [${args.path}]: ${error.message}`;
                }
            },
        },
    },
];
