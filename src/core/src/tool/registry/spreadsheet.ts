/**
 * @file tool/registry/spreadsheet.ts
 * @description 电子表格读取工具 read_xlsx：用 exceljs 解析 .xlsx 工作簿，按 sheet 转 Markdown 表格回灌模型。
 *  read_file 强制 UTF-8 文本流，读不了二进制 xlsx 容器（ZIP+XML，会满屏乱码）；本工具补齐表格类数据源
 *  （配置表 / 数据表 / 导出报表）。安全与 read_file 对齐：SAFE 级 + resolveReadablePath 跨界读 + 读保护闸门
 *  （敏感凭证拒读）+ 单元格内容脱敏。
 */
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { resolveReadablePath } from "../guard.ts";
import { assertReadable, maskSecretsInContent } from "./fs.ts";

// exceljs 体积可观且仅本工具用到——惰性动态加载，不影响其它工具与所有进程的启动开销。
const getExcelJs = async (): Promise<any> => {
    const mod = await import("exceljs");
    return (mod as any).default ?? mod;
};

/** 列号 1-based → Excel 列字母（1→A, 26→Z, 27→AA）。作 Markdown 表头，翻页时列标稳定不变。 */
const colLetter = (n: number): string => {
    let s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
};

/** 单元格值 → 紧凑字符串：公式取结果值、Date 转 ISO、富文本拼接、null/空 → 空串。 */
const cellToText = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    if (val instanceof Date) return val.toISOString();
    if (typeof val === "object") {
        const v = val as any;
        if (v.result !== undefined) return cellToText(v.result);            // 公式：取计算结果
        if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text ?? "").join(""); // 富文本
        if (v.text !== undefined) return String(v.text);                    // 超链接等
        return JSON.stringify(v);
    }
    return String(val);
};

/** Markdown 表格转义：管道符转义、换行折成空格（保单行单元格语义）。 */
const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** 电子表格读取类工具集（read_xlsx，详见上方 @file 说明）。 */
export const spreadsheetTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "read_xlsx",
            description: "读取 Excel 工作簿（.xlsx），把指定 sheet 的数据转为 Markdown 表格返回。read_file 读不了二进制 xlsx（会乱码），本工具用 exceljs 解析，适合读取配置表/数据表/导出报表。表头用 Excel 列字母（A/B/C…），数据行紧跟其后；大表可调 start_row 翻页。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Excel 文件路径（相对项目根或绝对路径）" },
                    sheet: { type: "string", description: "要读的 sheet：可传名称（如 'Sheet1'）或 1-based 索引（如 '1'）。缺省读第一个 sheet" },
                    start_row: { type: "number", description: "从第几行开始读（1-based，含）。缺省 1。大表配合 max_rows 翻页" },
                    max_rows: { type: "number", description: "最多返回的数据行数。缺省 200，上限 1000，防 Token 爆炸" },
                },
                required: ["path"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            // ★ Markdown 表格行膨胀大（每行有 | 分隔），独立预算脱离通用 16K 兜底。
            maxOutputCharacters: 48000,
            // ★ 复用 read_file 的内容脱敏：单元格内硬编码密钥（apiKey/token 串）回灌模型前先脱敏。
            privacyMaskingRules: maskSecretsInContent,
            async execute(args: { path: string; sheet?: string; start_row?: number; max_rows?: number }): Promise<string> {
                try {
                    const absPath = resolveReadablePath(args.path);
                    // ★ 读保护闸门（与 read_file 对称）：敏感凭证拒读。跨界读同 read_file（resolveReadablePath 不围栏）。
                    const readBlock = await assertReadable(absPath, args.path);
                    if (readBlock) return readBlock;

                    // ★ exceljs 只解 .xlsx（ZIP+XML）；.xls 老二进制 / 其它格式直接拒，免白跑解析。
                    if (!absPath.toLowerCase().endsWith(".xlsx")) {
                        return `❌ [格式不支持]：[${args.path}] 不是 .xlsx。read_xlsx 仅解析 Excel 工作簿（.xls 请先另存为 .xlsx）；其它文件请用 read_file。`;
                    }

                    const startRow = args.start_row ? Math.max(1, Math.floor(args.start_row)) : 1;
                    const maxRows = Math.min(args.max_rows ? Math.max(1, Math.floor(args.max_rows)) : 200, 1000);
                    const MAX_COLS = 30; // ★ 列数硬上限：超宽表截断，防 Markdown 表格撑爆输出

                    const ExcelJS = await getExcelJs();
                    const wb = new ExcelJS.Workbook();
                    await wb.xlsx.readFile(absPath); // 自带 ZIP 解压 + XML 解析（全量进内存，单人本地场景可接受）

                    if (wb.worksheets.length === 0) return `⚠️ [${args.path}] 工作簿无任何 sheet。`;

                    // 选 sheet：名称优先 → 1-based 索引 → 缺省第一个
                    let ws: any;
                    if (args.sheet !== undefined && args.sheet !== "") {
                        const idx = parseInt(args.sheet, 10);
                        ws = wb.worksheets.find((s: any) => s.name === args.sheet)
                            ?? (Number.isFinite(idx) && idx >= 1 ? wb.worksheets[idx - 1] : undefined);
                    } else {
                        ws = wb.worksheets[0];
                    }
                    if (!ws) return `⚠️ [${args.path}] 未找到 sheet「${args.sheet}」。可用：${wb.worksheets.map((s: any) => s.name).join(" / ")}。`;

                    const rowCount = ws.rowCount as number;
                    if (rowCount === 0) return `[${args.path} | sheet: ${ws.name}] 该 sheet 为空。`;
                    const endRow = Math.min(startRow + maxRows - 1, rowCount);

                    // 逐行读取（exceljs 行号 = Excel 物理行号，1-based）；realCols 取各数据行 cellCount 上界，更准。
                    let realCols = (ws.columnCount as number) || 0;
                    const dataRows: string[][] = [];
                    for (let r = startRow; r <= endRow; r++) {
                        const row = ws.getRow(r);
                        const colCount = Math.min(row.cellCount as number, MAX_COLS);
                        if ((row.cellCount as number) > realCols) realCols = row.cellCount as number;
                        const cells: string[] = [];
                        for (let c = 1; c <= colCount; c++) cells.push(cellToText(row.getCell(c).value));
                        dataRows.push(cells);
                    }

                    const colN = Math.min(Math.max(realCols, 1), MAX_COLS);
                    const headers = Array.from({ length: colN }, (_, i) => colLetter(i + 1));
                    const mkRow = (cells: string[]): string =>
                        "| " + Array.from({ length: colN }, (_, i) => esc(cells[i] ?? "")).join(" | ") + " |";

                    const lines = [
                        `[File: ${args.path} | sheet: ${ws.name} | 行: ${startRow}-${endRow} / 共 ${rowCount} | 列: ${colN}${realCols > MAX_COLS ? ` (实际 ${realCols}，已截到 ${MAX_COLS})` : ""}]`,
                        "| " + headers.join(" | ") + " |",
                        "| " + headers.map(() => "---").join(" | ") + " |",
                        ...dataRows.map(mkRow),
                    ];
                    if (dataRows.length === 0) lines.push("（该区间无数据行）");
                    if (endRow < rowCount) lines.push(`\n[... 后面还有 ${rowCount - endRow} 行，可把 start_row 设为 ${endRow + 1} 继续翻页。]`);
                    return lines.join("\n");
                } catch (error: any) {
                    // 加密工作簿 / 损坏文件：exceljs 抛错信息较明确，原样透出便于模型判断
                    return `读取 Excel 失败 [${args.path}]: ${error.message}`;
                }
            },
        },
    },
];
