/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-16 11:00:00
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\glob.ts
 * @Description: 文件名 glob 搜索工具 —— 按模式找文件，与 search_grep（内容搜索）互补
 */
import fs from "fs/promises";
import path from "path";
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { getActiveWorkspaceRoot, resolveSafePath, initializeWorkspaceIgnore, checkIsPathIgnored } from "../guard.ts";

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
            async execute(args: { pattern: string; path?: string }): Promise<string> { // 💡 优化 1：约束明确的返回值类型
                try {
                    const cleanPattern = (args.pattern || "").trim();
                    if (!cleanPattern) return "❌ [Glob失败]：传入的检索 pattern 不能为空。";

                    const root = args.path ? resolveSafePath(args.path) : getActiveWorkspaceRoot();
                    const re = globToRegex(cleanPattern);
                    await initializeWorkspaceIgnore();

                    const hits: string[] = [];
                    let scannedCount = 0;
                    const MAX_SCAN_LIMIT = 10000; // 💡 优化 2：【最高性能防线】全局扫描文件数量硬熔断，防止在超巨型未标记项目中无限死循环

                    // 💡 优化 3：【防句柄爆炸】将纯异步递归改为受控的深度优先/广度优先迭代，或者顺序 await 限制并发数
                    const scan = async (dir: string): Promise<void> => {
                        if (scannedCount > MAX_SCAN_LIMIT) return;

                        const entries = await fs.readdir(dir, { withFileTypes: true });
                        
                        // 过滤掉被忽略的实体
                        const validEntries = entries.filter(e => {
                            const full = path.join(dir, e.name);
                            const rel = path.relative(getActiveWorkspaceRoot(), full).replace(/\\/g, "/");
                            return !checkIsPathIgnored(e.isDirectory() ? `${rel}/` : rel);
                        });

                        // 顺序或受控并发处理，防止瞬时倾泻数万个文件句柄
                        for (const e of validEntries) {
                            scannedCount++;
                            if (scannedCount > MAX_SCAN_LIMIT) break;

                            // ★ M-3 修复：跳过符号链接，防止工作区内指向外部的软链把工作区外文件名带进结果（路径越界/信息泄露）。
                            if (e.isSymbolicLink()) continue;

                            const full = path.join(dir, e.name);
                            const rel = path.relative(getActiveWorkspaceRoot(), full).replace(/\\/g, "/");

                            if (e.isDirectory()) {
                                // 💡 优化 4：精准匹配，如果大模型只想找文件，避免把中间每一层父级文件夹都塞进结果集
                                // 通常只有当模式明确以 '/' 结尾或者模式带有文件夹特征时，才推进目录项本身
                                if (cleanPattern.endsWith("/") && re.test(`${rel}/`)) {
                                    hits.push(`${rel}/`);
                                }
                                // 老老实实向下递推，内部采用线性循环，由于 validEntries 已过滤，I/O 压力极小
                                await scan(full);
                            } else if (re.test(rel)) {
                                hits.push(rel);
                            }
                        }
                    };

                    await scan(root);

                    if (hits.length === 0) return `未匹配到任何文件（模式: ${cleanPattern}）`;
                    
                    // 提示大模型触发了全局安全扫描上限
                    const prefix = scannedCount > MAX_SCAN_LIMIT ? `⚠️ [已达到项目安全扫描上限 ${MAX_SCAN_LIMIT} 节点] ` : "";

                    if (hits.length > 200) {
                        return `${prefix}[Glob: ${cleanPattern} | 共 ${hits.length} 个匹配，已截断]\n`
                            + hits.slice(0, 200).join("\n")
                            + `\n\n[... 匹配项过多，已隐藏剩余 ${hits.length - 200} 个结果，请缩小搜索起始目录 path ...]`;
                    }
                    return `${prefix}[Glob: ${cleanPattern} | ${hits.length} 个匹配]\n` + hits.join("\n");
                } catch (error: any) {
                    return `glob 检索失败: ${error.message}`;
                }
            },
        },
    },
];
