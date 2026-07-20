/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-15 14:56:55
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-15 16:39:29
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\search.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file tool/registry/search.ts
 * @description 内容检索类工具集。search_grep：基于 ripgrep（vscode-ripgrep）在工作区全文检索，
 *  返回带行列号的匹配行；支持字面量（默认自动转义）与正则两种模式。与 glob（按文件名）互补。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { rgPath } from "vscode-ripgrep"; // 需要安装: npm install vscode-ripgrep
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { WORKSPACE_ROOT } from "../guard.ts";

const execFileAsync = promisify(execFile);

/** 将字符串中的正则特殊字符转义，用于把字面量关键词安全地当作正则 pattern。 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 内容检索类工具集（search_grep，详见上方 @file 说明）。 */
export const searchTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "search_grep",
            description: "在工作区的所有文件中检索匹配的代码行，返回带行列号的平铺线索，用于快速定位符号定义或报错位置。默认按字面量关键词匹配；如需正则，传 is_regex=true。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "检索内容。默认为字面量关键词（如 'function runAgent'）；is_regex=true 时按正则解析（如 'function\\s+runAgent'）。" },
                    is_regex: { type: "boolean", description: "是否将 query 作为正则表达式解析，默认 false（字面量匹配，自动转义特殊字符）" }
                },
                required: ["query"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { query: string; is_regex?: boolean }) {
                try {
                    const pattern = args.is_regex ? args.query : escapeRegExp(args.query);
                    const rgArgs = ["--line-number", "--column", "--no-heading", "--color", "never", "--max-count", "10", "-e", pattern];
                    const { stdout } = await execFileAsync(rgPath, rgArgs, {
                        cwd: WORKSPACE_ROOT,
                        maxBuffer: 1024 * 1024 * 5
                    });
                    if (!stdout.trim()) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;
                    const resultLines = stdout.split("\n").filter(Boolean);
                    if (resultLines.length > 80) {
                        return resultLines.slice(0, 80).join("\n") + `\n\n[... 匹配项过多，已隐藏剩余的 ${resultLines.length - 80} 条结果 ...]`;
                    }
                    return resultLines.join("\n");
                } catch (error: any) {
                    if (error.code === 1) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;
                    return `检索失败: ${error.message}`;
                }
            },
        },
    },
];
