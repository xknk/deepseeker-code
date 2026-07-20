/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-16 11:00:00
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\glob.ts
 * @Description: 文件名 glob 搜索工具 —— 按模式找文件，与 search_grep（内容搜索）互补
 */
import fs from "fs/promises";
import path from "path";
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { WORKSPACE_ROOT, resolveSafePath, initializeWorkspaceIgnore, checkIsPathIgnored } from "../guard.ts";

/** 简易 glob → regex（支持 ** / * / ?），无新依赖 */
const globToRegex = (pattern: string): RegExp => {
    const re = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")   // 转义 regex 特殊字符
        .replace(/\*\*\//g, "(?:.*/)?")          // **/ 零或多层目录
        .replace(/\*\*/g, ".*")                  // 剩余 ** 任意字符
        .replace(/\*/g, "[^/]*")                 // * 单层（不含分隔符）
        .replace(/\?/g, ".");                    // ? 单字符
    return new RegExp(`^${re}$`);
};

/** 文件名 glob 搜索类工具集：glob（按模式匹配文件名，套用 gitignore 过滤）。 */
export const globTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "glob",
            description: "按文件名 glob 模式快速查找文件（如 '**/*.ts'、'src/**/test*'、'**/*.test.ts'）。与 search_grep（按内容检索）互补。自动套用 .gitignore / 通用黑名单过滤。",
            parameters: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "glob 模式，如 '**/*.ts' 或 'src/**/*.test.ts'" },
                    path: { type: "string", description: "限定搜索的起始目录（相对路径，可选，默认工作区根）" },
                },
                required: ["pattern"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { pattern: string; path?: string }) {
                try {
                    const root = args.path ? resolveSafePath(args.path) : WORKSPACE_ROOT;
                    const re = globToRegex(args.pattern);
                    await initializeWorkspaceIgnore();   // 复用 ignore 引擎（与 list_dir 一致）

                    const hits: string[] = [];
                    const scan = async (dir: string): Promise<void> => {
                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        for (const e of entries) {
                            const full = path.join(dir, e.name);
                            const rel = path.relative(WORKSPACE_ROOT, full).replace(/\\/g, "/");
                            if (checkIsPathIgnored(e.isDirectory() ? `${rel}/` : rel)) continue;
                            if (e.isDirectory()) {
                                if (re.test(rel)) hits.push(`${rel}/`);
                                await scan(full);
                            } else if (re.test(rel)) {
                                hits.push(rel);
                            }
                        }
                    };
                    await scan(root);

                    if (hits.length === 0) return `未匹配到任何文件（模式: ${args.pattern}）`;
                    if (hits.length > 200) {
                        return `[Glob: ${args.pattern} | 共 ${hits.length} 个匹配，已截断]\n`
                            + hits.slice(0, 200).join("\n")
                            + `\n\n[... 已隐藏剩余 ${hits.length - 200} 个 ...]`;
                    }
                    return `[Glob: ${args.pattern} | ${hits.length} 个匹配]\n` + hits.join("\n");
                } catch (error: any) {
                    return `glob 检索失败: ${error.message}`;
                }
            },
        },
    },
];
