/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-16 11:00:00
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\glob.ts
 * @Description: 文件名 glob 搜索工具 —— 按模式找文件，与 search_grep（内容搜索）互补
 */
import fs from "fs/promises";
import path from "path";
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { getActiveWorkspaceRoot, resolveReadablePath, initializeWorkspaceIgnore, checkIsPathIgnored } from "../guard.ts";

/**
 * glob → regex（支持 ** 与 * 与 ?），无新依赖。
 * ★ 单次字符级遍历：早期实现用链式 .replace，后插入的非捕获分组里自带的 ? 和 *
 *   会被后续 replace 二次破坏（? 被改成点号、* 被改成非斜杠通配），导致「双星 + 斜杠」
 *   这类深层模式永远匹配失败（实际编译成乱码正则）。单次遍历一次性消费 glob 元字符，杜绝二次替换污染。
 */
/** 找 s[start] 处 '{' 的配对 '}'（计嵌套深度）；无配对返回 -1（按字面量处理）。 */
const findMatchingBrace = (s: string, start: number): number => {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") { depth--; if (depth === 0) return i; }
    }
    return -1;
};

/** 顶层按 ',' 拆分（跳过嵌套 {} 内的逗号），供花括号多选展开用。 */
const splitTopLevel = (s: string): string[] => {
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of s) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts;
};

/**
 * glob 模式 → 锚定正则。支持 *（单层）、**（跨层）、?（单字符）与花括号多选 {a,b,c}（递归嵌套亦可）。
 * ★ 花括号展开 → (?:a|b|c)：多类型/多目录查找（如 `*.{ts,tsx,vue}`、`src/{api,components}/**`）一次调用完成——
 *   此前 { } 被当字面量转义，模型查两类文件只能分多次调用。未配对的 '{' 按字面量处理（保守不炸）。
 */
const globToRegex = (pattern: string): RegExp => {
    const walk = (s: string): string => {
        let re = "";
        let i = 0;
        while (i < s.length) {
            const c = s[i];
            if (c === "{") {
                const close = findMatchingBrace(s, i);
                if (close === -1) { re += "\\{"; i++; continue; }
                const alts = splitTopLevel(s.slice(i + 1, close));
                re += `(?:${alts.map(a => walk(a)).join("|")})`;
                i = close + 1;
                continue;
            }
            if (c === "*" && s[i + 1] === "*") {
                if (s[i + 2] === "/") { re += "(?:.*/)?"; i += 3; }   // **/ 零或多层目录（可选）
                else { re += ".*"; i += 2; }                          // ** 任意字符（含分隔符）
            } else if (c === "*") { re += "[^/]*"; i++; }             // * 单层（不含分隔符）
            else if (c === "?") { re += "."; i++; }                   // ? 单字符
            else { re += /[.+^$}()|[\]\\]/.test(c) ? "\\" + c : c; i++; } // 普通字符（含中文）：转义 regex 特殊字符（'}' 兜底转义；'{' 已由上方配对逻辑处理）
        }
        return re;
    };
    return new RegExp(`^${walk(pattern)}$`);
};

/** 文件名 glob 搜索类工具集：glob（按模式匹配文件名，套用 gitignore 过滤）。 */
export const globTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "glob",
            description: "按文件名 glob 模式快速查找文件（如 '**/*.ts'、'src/**/test*'、'**/*.test.ts'）。★ 支持花括号多选：'**/*.{ts,tsx,vue}'、'src/{api,components}/**' 一次查多类型/多目录，勿分多次调用。与 search_grep（按内容检索）互补。自动套用 .gitignore / 通用黑名单过滤。",
            parameters: {
                type: "object",
                properties: {
                    pattern: { type: "string", description: "glob 模式，支持 * / ** / ? 与花括号多选 {a,b}（如 '**/*.{ts,vue}'、'src/{api,components}/**'）" },
                    path: { type: "string", description: "限定搜索的起始目录（相对路径，可选，默认工作区根）" },
                },
                required: ["pattern"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { pattern: string; path?: string }, ctx?: ToolContext): Promise<string> { // 💡 优化 1：约束明确的返回值类型
                try {
                    const cleanPattern = (args.pattern || "").trim();
                    if (!cleanPattern) return "❌ [Glob失败]：传入的检索 pattern 不能为空。";

                    // ★ 显式根（与 run_command/fs 工具签名统一）：优先 ctx.cwd（已与 ALS 同源），否则回退 ALS 活动根。
                    //   消除对全局 ALS 的隐式依赖，使工具更可测、可覆盖（ctx.cwd 与 getActiveWorkspaceRoot() 等价）。
                    //   ★ 跨界扫描：args.path 走 resolveReadablePath（不围栏），支持 ../兄弟目录 / 绝对路径作扫描起点。
                    const activeRoot = ctx?.cwd ?? getActiveWorkspaceRoot();
                    const root = args.path ? resolveReadablePath(args.path) : activeRoot;
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
                            const rel = path.relative(activeRoot, full).replace(/\\/g, "/");
                            return !checkIsPathIgnored(e.isDirectory() ? `${rel}/` : rel);
                        });

                        // 顺序或受控并发处理，防止瞬时倾泻数万个文件句柄
                        for (const e of validEntries) {
                            scannedCount++;
                            if (scannedCount > MAX_SCAN_LIMIT) break;

                            // ★ M-3 修复：跳过符号链接，防止工作区内指向外部的软链把工作区外文件名带进结果（路径越界/信息泄露）。
                            if (e.isSymbolicLink()) continue;

                            const full = path.join(dir, e.name);
                            const rel = path.relative(activeRoot, full).replace(/\\/g, "/");

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
