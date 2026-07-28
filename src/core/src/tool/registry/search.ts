/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-15 14:56:55
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-20 16:10:21
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
import path from "path";
import fs from "fs/promises";

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
            async execute(args: { query: string; is_regex?: boolean }): Promise<string> { // 💡 优化 1：显式声明返回值类型，堵死上层接口编译报错
                try {
                    const cleanQuery = (args.query || "").trim();
                    if (!cleanQuery) return "❌ [检索失败]：传入的检索关键词不能为空。";

                    const pattern = args.is_regex ? cleanQuery : escapeRegExp(cleanQuery);

                    // 💡 优化 2：【核心防线】向 ripgrep 注入硬编码的全局黑名单路径过滤 (--glob)
                    // 强制排除外部依赖、编译产物、版本控制等纯垃圾噪音目录，保障大模型只能看到真正的源码
                    const rgArgs = [
                        "--line-number",
                        "--column",
                        "--no-heading",
                        "--color", "never",
                        "--max-count", "10",
                        "--glob", "!node_modules/**",
                        "--glob", "!dist/**",
                        "--glob", "!.git/**",
                        "--glob", "!.next/**",
                        "--glob", "!build/**",
                        "-e", pattern
                    ];

                    const { stdout } = await execFileAsync(rgPath, rgArgs, {
                        cwd: WORKSPACE_ROOT,
                        maxBuffer: 1024 * 1024 * 5 // 5MB 缓冲区防御
                    });

                    if (!stdout.trim()) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;

                    const resultLines = stdout.split("\n").filter(Boolean);
                    if (resultLines.length > 80) {
                        return resultLines.slice(0, 80).join("\n") + `\n\n[... 匹配项过多，已隐藏剩余的 ${resultLines.length - 80} 条结果，建议更换更精准的关键词重新检索 ...]`;
                    }
                    return resultLines.join("\n");
                } catch (error: any) {
                    // 💡 优化 3：优雅降级，ripgrep 找不到内容时正常退出码是 1，不属于常规报错
                    if (error.code === 1) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;
                    return `检索失败: ${error.message}`;
                }
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_project_guide",
            description: "读取项目根目录下的专属 AI 行为指引与开发指南（依次尝试 CLAUDE.md / AGENTS.md / AGENT.md，命中第一个）。该指南固化了本项目的构建命令、运行测试规范、核心技术栈及代码风格限制。在对陌生项目实施任何构建或测试命令前，必须优先读取此工具。",
            parameters: {
                type: "object",
                properties: {} // 无需参数，自动探测根目录 CLAUDE.md / AGENTS.md / AGENT.md
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(): Promise<string> {
                // F-5：事实标准是 CLAUDE.md（Claude Code / 本项目），新多 agent 约定 AGENTS.md（复数），旧占位 AGENT.md。
                //   逐个尝试命中第一个存在的，避免在大多数项目里因文件名错位永远走兜底骨架。
                const GUIDE_CANDIDATES = ["CLAUDE.md", "AGENTS.md", "AGENT.md"];
                for (const name of GUIDE_CANDIDATES) {
                    try {
                        const content = await fs.readFile(path.join(WORKSPACE_ROOT, name), "utf-8");
                        return `[Project Guide via ${name}]\n\n${content}`;
                    } catch { /* 该候选不存在，继续尝试下一个 */ }
                }
                // 全部候选都不存在 → 推荐一份基础骨架并提示模型可自行生成
                const baselineTemplate = [
                    "# Project Development Guide (For AI Agents)",
                    "",
                    "## Build and Test Commands",
                    "- Install dependencies: `npm install` 或 `pnpm install` (请根据项目实际 package.json 锁文件辨别)",
                    "- Production Build: `npm run build`",
                    "- Run Unit Tests: `npm test`",
                    "",
                    "## Code Architecture Guidelines",
                    "- Keep methods atomic and safe.",
                    "- Prefer incremental file refactoring using `edit_file` over whole file rewrites."
                ].join("\n");

                return [
                    `⚠️ [系统提示]：当前项目根目录下未发现 AI 指引文件（已尝试 ${GUIDE_CANDIDATES.join(" / ")}）。`,
                    `以下是系统为你自动生成的标准认知备忘骨架。如果你已经通过 list_dir 辨明了该技术栈的特异性，你可以自主决定调用 write_file 工具在项目根目录下生成一份正式的 [CLAUDE.md] 以为后续推理降低 Token 开销：\n`,
                    baselineTemplate
                ].join("\n");
            }
        }
    }
];

