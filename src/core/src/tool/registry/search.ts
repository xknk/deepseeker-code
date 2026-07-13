/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 18:40:00
 * @FilePath: \deepSeekCode\src\tool\registry\search.ts
 * @Description: 零依赖、跨平台的全局文本检索工具 (完美兼容 Windows，安全且防爆)
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { rgPath } from "vscode-ripgrep"; // 需要安装: npm install vscode-ripgrep
import { CustomTool } from "../type.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();

function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const searchTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "search_grep",
            description: "在工作区的所有文件中，利用关键词检索匹配的代码行，返回带有完整行列号的平铺线索，用于快速定位符号定义或报错位置。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "检索的关键词，例如：'function runAgent'" }
                },
                required: ["query"],
            },
            async execute(args: { query: string }) {
                try {
                    const safeQuery = escapeRegExp(args.query);
                    const rgArgs = ["--line-number", "--column", "--no-heading", "--color", "never", "--max-count", "10", "-e", safeQuery];

                    const { stdout } = await execFileAsync(rgPath, rgArgs, {
                        cwd: WORKSPACE_ROOT,
                        maxBuffer: 1024 * 1024 * 5
                    });

                    if (!stdout.trim()) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;

                    const resultLines = stdout.split("\n").filter(Boolean);
                    if (resultLines.length > 80) {
                        return resultLines.slice(0, 80).join("\n") + `\n\n[... 匹配项过多，已隐藏剩余的 ${resultLines.length - 80} 条结果 ...]`;
                    }
                    return stdout;
                } catch (error: any) {
                    if (error.code === 1) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;
                    return `检索失败: ${error.message}`;
                }
            },
        },
    },
];
