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
import { rgPath } from "vscode-ripgrep"; // 需要安装: npm install vscode-ripgrep
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { getActiveWorkspaceRoot, resolveSafePath, getAllowedWorkspaceRoots } from "../guard.ts";
import { execFileSmart } from "@/common/index.ts";
import { maskSecretsInContent } from "./fs.ts";
import path from "path";
import fs from "fs/promises";

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
            description: "在工作区的所有文件中检索匹配的代码行，每个命中带前后各 2 行上下文（可直接判断用法、免紧跟一次 read_file）；默认按字面量关键词匹配，如需正则传 is_regex=true。多根工作区下用 path 限定搜索目录：可传项目目录名（如 'frontend'）自动匹配工作区根，或传绝对路径 / 相对默认根的 ../兄弟目录。★ 当用户在对话里指明了某个项目时，务必把该项目作为 path 传入——否则只会搜索 IDE 头部所示的活动根，常与用户意图不符。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "检索内容。默认为字面量关键词（如 'function runAgent'）；is_regex=true 时按正则解析（如 'function\\s+runAgent'）。" },
                    is_regex: { type: "boolean", description: "是否将 query 作为正则表达式解析，默认 false（字面量匹配，自动转义特殊字符）" },
                    path: { type: "string", description: "限定搜索的目录（可选）。默认搜索 IDE 头部所示活动根。多根场景下：传项目目录名（如 'frontend'）自动匹配工作区根；或传绝对路径 / 相对默认根的 ../<兄弟目录>；均经沙箱校验。用户提到具体项目时必填。" }
                },
                required: ["query"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            // ★ 300 行（含上下文）约 48K 字符，配独立预算脱离通用 16K 兜底，避免被二次截回 ~100 行
            maxOutputCharacters: 48000,
            // ★ 复用 read_file 的内容级脱敏：源码内硬编码密钥（apiKey/token 等）经 grep 命中行回灌模型前先脱敏
            privacyMaskingRules: maskSecretsInContent,
            async execute(args: { query: string; is_regex?: boolean; path?: string }, ctx?: ToolContext): Promise<string> { // 💡 优化 1：显式声明返回值类型，堵死上层接口编译报错
                try {
                    const cleanQuery = (args.query || "").trim();
                    if (!cleanQuery) return "❌ [检索失败]：传入的检索关键词不能为空。";

                    const pattern = args.is_regex ? cleanQuery : escapeRegExp(cleanQuery);

                    // 💡 优化 2：【核心防线】向 ripgrep 注入硬编码的全局黑名单路径过滤 (--glob)
                    // 强制排除外部依赖、编译产物、版本控制等纯垃圾噪音目录，保障大模型只能看到真正的源码
                    // ★ 搜索根作为【显式 path 参数】（正斜杠），而非 cwd 选项：
                    //   Windows 下 process.cwd() 返回反斜杠（如 D:\code\自研\...），spawn/execFile 用「反斜杠+中文」
                    //   作 cwd 派生 rg 会失败（ENOENT 或无限卡死，实测 search_grep 查 import 卡 >90s）。
                    //   显式 path 参数由 rg 直接解析，绕开 cwd 解析坑——实测唯一稳定方式（391 行秒级）。
                    // ★ 多根工作区：args.path 指定搜索目录时经 resolveSafePath 校验（须落在任一工作区根内），
                    //   支持 ../<兄弟目录> 跨项目检索；缺省搜索当前活动根。
                    // ★ 多根工作区：args.path 支持直接传「项目目录名」（basename）自动匹配工作区根。
                    //   模型常以项目名（如 "frontend"）而非完整绝对路径表达意图；而 IDE 头部所示「活动根」
                    //   由 activate 时定的主根决定，与对话里指明的项目可能不一致——若不锚定，缺省会误搜活动根。
                    //   仅当传入是「裸目录名」（非绝对路径、无分隔符）时才按 basename 匹配；绝对路径 / ../兄弟 等
                    //   仍走 resolveSafePath 原逻辑，向后兼容、无误伤。
                    const resolveSearchRoot = (): string => {
                        if (!args.path) return ctx?.cwd ?? getActiveWorkspaceRoot();
                        const p = args.path.trim();
                        const looksLikeBareName = !path.isAbsolute(p) && !p.includes("/") && !p.includes("\\");
                        if (looksLikeBareName) {
                            const hit = getAllowedWorkspaceRoots().find(r => {
                                const bn = path.basename(r);
                                return bn === p || bn.toLowerCase() === p.toLowerCase();
                            });
                            if (hit) return hit;
                        }
                        return resolveSafePath(args.path);
                    };
                    const searchRoot = resolveSearchRoot().replace(/\\/g, "/");
                    const rgArgs = [
                        "--threads", "1", // 单线程：全树并行 reader 偶发卡死的额外兜底（结果不变，小输出无性能影响）
                        "--line-number",
                        "--column",
                        "--no-heading",
                        "--color", "never",
                        "-C", "2", // ★ 每个命中带前后各 2 行上下文：模型一次看懂用法，免去紧跟的 read_file 往返（减调用次数的关键）
                        "--max-count", "10",
                        "--glob", "!node_modules/**",
                        "--glob", "!dist/**",
                        "--glob", "!.git/**",
                        "--glob", "!.next/**",
                        "--glob", "!build/**",
                        // S-5：与 read_file 的 isSensitiveReadTarget 对齐——即便未被 .gitignore 收录，
                        //   也排除凭证/私钥类文件，防 grep 把密钥回灌模型上下文（maskSecretsInContent 不覆盖连接串）。
                        "--glob", "!.env*",
                        "--glob", "!*.pem",
                        "--glob", "!*.key",
                        "--glob", "!*credentials*",
                        "--glob", "!id_rsa*",
                        "-e", pattern,
                        searchRoot,
                    ];

                    const { stdout } = await execFileSmart(rgPath, rgArgs, {
                        // 不传 cwd：避免反斜杠+中文路径派生 rg 失败（搜索根已作为显式 path 参数传入）
                        maxBuffer: 1024 * 1024,
                        // ★ 兜底硬超时：极端文件卡住 rg 时最多 30s 判失败返回，绝不让 search_grep 挂死 agent
                        timeout: 30_000,
                        killSignal: "SIGKILL",
                    });

                    if (!stdout.trim()) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;

                    const resultLines = stdout.split("\n").filter(Boolean);
                    const MAX_GREP_LINES = 300; // 含上下文行后单匹配膨胀，由 200 上调以容纳更多命中
                    if (resultLines.length > MAX_GREP_LINES) {
                        return resultLines.slice(0, MAX_GREP_LINES).join("\n") + `\n\n[... 匹配项过多，已隐藏剩余的 ${resultLines.length - MAX_GREP_LINES} 条结果，建议更换更精准的关键词，或用 path 参数限定到具体目录/项目后重试 ...]`;
                    }
                    return resultLines.join("\n");
                } catch (error: any) {
                    // 💡 优化 3：优雅降级，ripgrep 找不到内容时正常退出码是 1，不属于常规报错
                    if (error.code === 1) return `未找到与 "${args.query}" 相关的任何代码匹配项。`;
                    // ★ 超时（30s 兜底触发）：给友好提示而非裸"检索失败"，建议缩小范围
                    if (error.killed || error.signal) return `⏳ [检索超时]：30s 内未完成（疑似命中巨型/异常文件）。建议缩小关键词或限定目录后重试。`;
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
                        const content = await fs.readFile(path.join(getActiveWorkspaceRoot(), name), "utf-8");
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

