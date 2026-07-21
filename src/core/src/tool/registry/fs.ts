/**
 * @file tool/registry/fs.ts
 * @description 文件系统类工具集，覆盖读写删查全流程：
 *  read_file（分片读，带行号）、list_dir（带 gitignore 过滤的目录树）、
 *  edit_file（唯一性局部替换）、create_file（新建，拒覆盖）、
 *  delete_path（DANGER 递归删除）、write_file（全量覆盖写）。
 *  所有路径经 resolveSafePath 校验，防止工作区越界 / 软链接逃逸。
 */
import fs from "fs/promises";
import * as ts from "typescript";
import path from "path";
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import {
    WORKSPACE_ROOT,
    resolveSafePath,
    initializeWorkspaceIgnore,
    checkIsPathIgnored
} from "../guard.ts";
import { createReadStream } from "fs";
import * as readline from "readline"
import { Stats } from "fs";
export const fsTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "read_file",
            description: "读取指定文件的文本内容，并自动带上用于对齐定位的物理行号。支持大文件分片读取，防止 Token 爆炸。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "文件相对路径" },
                    start_line: { type: "number", description: "起始行号（从 1 开始，默认 1）" },
                    end_line: { type: "number", description: "结束行号（默认最多往后读 150 行）" }
                },
                required: ["path"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { path: string; start_line?: number; end_line?: number }) {
                try {
                    const absPath = resolveSafePath(args.path);

                    // 1. 先用最轻量的方式获取文件总行数（可选，若不需要显示 totalLines，甚至可以省略这一步以追求极致性能）
                    // 这里提供一个仅针对所需区间的高效单次流读取方案：
                    const start = args.start_line ? Math.max(1, args.start_line) : 1;
                    const maxLinesToRead = 150;
                    const end = args.end_line ? Math.max(start, args.end_line) : start + maxLinesToRead - 1;

                    const fileStream = createReadStream(absPath, { encoding: "utf-8" });
                    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

                    let currentLineNum = 0;
                    const requestedLines: string[] = [];

                    for await (const line of rl) {
                        currentLineNum++;
                        if (currentLineNum >= start && currentLineNum <= end) {
                            requestedLines.push(`${String(currentLineNum).padStart(5)}: ${line}`);
                        }
                        // 2. 核心优化：一旦读够了需要的行数，立刻关闭流，不往下读了！
                        if (currentLineNum > end) {
                            rl.close();
                            fileStream.destroy();
                            break;
                        }
                    }

                    const formattedCode = requestedLines.join("\n");
                    // hasMore：仅当确实读超了 end（文件在 end 之后还有行）才提示后续；
                    //   去掉旧条件 `requestedLines.length === (end-start+1)`——它在「恰好读到 EOF」时会误报还有内容
                    const hasMore = currentLineNum > end;
                    const realEnd = Math.min(currentLineNum, end);

                    if (requestedLines.length === 0) {
                        // 请求区间完全在文件之外（如 start 超出总行数）：明确提示，避免 header 行号倒挂
                        return `[File: ${args.path}] 请求的行区间 ${start}-${end} 无内容（文件总行数约 ${currentLineNum}）。`;
                    }
                    return `[File: ${args.path} | Lines ${start}-${realEnd}]\n${formattedCode}${hasMore ? `\n\n[... 后面还有代码已被隐藏，你可以调整 start_line 继续分片读取。]` : ""}`;

                } catch (error: any) {
                    return `读取文件失败 [${args.path}]: ${error.message}`;
                }
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_dir",
            description: "扫描并精简列出当前项目的工作区目录树。本工具自动合并通用忽略规则与多层子目录级 .gitignore 规范。",
            parameters: {
                type: "object",
                properties: {
                    max_depth: { type: "number", description: "最大嵌套扫描深度（默认值为 3）" }
                }
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { max_depth?: number }): Promise<string> {
                try {
                    const maxDepth = args.max_depth ? Math.max(1, args.max_depth) : 3;
                    await initializeWorkspaceIgnore();

                    const buildTreeText = async (currentPath: string, currentDepth: number, prefix = ""): Promise<string> => {
                        if (currentDepth > maxDepth) return "";

                        const entries = await fs.readdir(currentPath, { withFileTypes: true });

                        // 过滤掉被忽略的文件/文件夹
                        const validEntries = entries.filter(entry => {
                            const fullPath = path.join(currentPath, entry.name);
                            const relPath = path.relative(WORKSPACE_ROOT, fullPath).replace(/\\/g, "/");
                            return !checkIsPathIgnored(entry.isDirectory() ? `${relPath}/` : relPath);
                        });

                        let output = "";

                        // 🚨 注意：这里必须使用 for...of 循环，以便在循环内部正确使用 await 递归
                        for (let index = 0; index < validEntries.length; index++) {
                            const entry = validEntries[index];
                            const isLast = index === validEntries.length - 1;
                            const pointer = isLast ? "└── " : "├── ";

                            output += `${prefix}${pointer}${entry.name}${entry.isDirectory() ? "/" : ""}\n`;

                            if (entry.isDirectory()) {
                                const nextPrefix = prefix + (isLast ? "    " : "│   ");
                                const fullPath = path.join(currentPath, entry.name);
                                // 递归构建子树，并将生成的子树字符串拼接到当前输出中
                                const subTree = await buildTreeText(fullPath, currentDepth + 1, nextPrefix);
                                output += subTree;
                            }
                        }
                        return output;
                    };

                    // 🚨 关键修复：在此处调用递归函数，并直接 return 最终的树状字符串结果
                    const treeResult = await buildTreeText(WORKSPACE_ROOT, 1);

                    if (!treeResult.trim()) return `工作区扫描完成，未发现可用源码文件。`;

                    return `[Workspace Universal Tree | Max Depth: ${maxDepth}]\n${treeResult}`;

                } catch (error: any) {
                    // catch 块也严格返回 string，确保类型安全
                    return `项目树扫描失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "针对指定的文件进行局部精准修改。old_str 必须与原代码完全一致；默认要求在全文中唯一，若设 replace_all=true 则替换全部匹配处（适合批量重命名/统一改写）。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "准备修改的文件相对路径" },
                    old_str: { type: "string", description: "文件中现有的完整旧代码块" },
                    new_str: { type: "string", description: "准备替换进去的新代码块" },
                    replace_all: { type: "boolean", description: "是否替换全文所有匹配处（默认 false 仅替换唯一匹配；批量重命名/统一改写时设 true）" }
                },
                required: ["path", "old_str", "new_str"]
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { path: string; old_str: string; new_str: string; replace_all?: boolean }) =>
                `申请修改文件 [${args.path}]${args.replace_all ? "（🔥 批量替换全部匹配处）" : ""}\n【减少】:\n${args.old_str}\n【增加】:\n${args.new_str}`,
            async execute(args: { path: string; old_str: string; new_str: string; replace_all?: boolean }) {
                try {
                    const absPath = resolveSafePath(args.path);
                    const rawContent = await fs.readFile(absPath, "utf-8");
                    const isCRLF = rawContent.includes("\r\n");
                    const normalizedContent = rawContent.replace(/\r\n/g, "\n");
                    const normalizedOld = args.old_str.replace(/\r\n/g, "\n");
                    const normalizedNew = args.new_str.replace(/\r\n/g, "\n");
                    if (!normalizedContent.includes(normalizedOld)) {
                        return `❌ [代码修补失败]：未能在文件中找到指定的 old_str 旧代码块，请用 read_file 重新核对。`;
                    }
                    const matchCount = normalizedContent.split(normalizedOld).length - 1;
                    // replace_all=true：放行多匹配，全量替换；默认：要求唯一，否则报冲突
                    if (!args.replace_all && matchCount > 1) {
                        return `❌ [代码修补失败]：代码冲突！old_str 在全文中不唯一（共发现了 ${matchCount} 处）。请向上或向下多包裹几行上下文再提请修改，或显式设 replace_all=true 批量替换。`;
                    }
                    const updatedContent = args.replace_all
                        ? normalizedContent.split(normalizedOld).join(normalizedNew) // 字面量全量替换（不受正则元字符影响）
                        : normalizedContent.replace(normalizedOld, normalizedNew);   // 仅首个
                    await fs.writeFile(absPath, isCRLF ? updatedContent.replace(/\n/g, "\r\n") : updatedContent, "utf-8");
                    return args.replace_all
                        ? `✅ [代码修补成功]：文件 [${args.path}] 已批量替换全部 ${matchCount} 处匹配。`
                        : `✅ [代码修补成功]：文件 [${args.path}] 已成功完成唯一性局部重构。`;
                } catch (error: any) {
                    return `操作失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "create_file",
            description: "在工作区内创建一个全新的文件，并写入初始内容。如果文件已存在，本工具会拒绝执行以防止源码被全量误覆盖。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "新文件相对路径" },
                    content: { type: "string", description: "新文件的初始内容，可选" }
                },
                required: ["path"]
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { path: string; content?: string }) =>
                `申请新建文件 [${args.path}]，初始长度: ${(args.content || "").length} 字符`,
            async execute(args: { path: string; content?: string }): Promise<string> {
                let tmpPath: string | null = null;
                try {
                    const absPath = resolveSafePath(args.path);

                    // 💡 创建语义：文件已存在则拒绝（防止源码被全量误覆盖——修改请用 edit_file，覆盖请用 write_file）
                    //   仅当 ENOENT（确实不存在）才继续；EACCES 等其它错误原样上抛，避免被误判为"不存在"
                    try {
                        await fs.access(absPath);
                        return `❌ [创建失败]：文件 [${args.path}] 已存在。create_file 仅用于新建文件；如需修改请用 edit_file，如需覆盖请用 write_file。`;
                    } catch (e: any) {
                        if (e?.code !== "ENOENT") throw e;
                    }

                    const content = args.content ?? "";

                    // 💡 原子写入防御（Atomic Write）：先写同目录 .tmp 再 rename 瞬间落地，
                    //   避免写中途被中断/熔断导致文件变空或受损
                    tmpPath = `${absPath}.${Date.now()}.tmp`;
                    await fs.writeFile(tmpPath, content, "utf-8");
                    await fs.rename(tmpPath, absPath); // 操作系统层面的原子覆盖

                    return `✅ [创建成功]：新文件 [${args.path}] 已创建，写入 ${content.length} 字符。`;
                } catch (error: any) {
                    return `操作失败: ${error.message}`;
                } finally {
                    // ★ 残留 tmp 清理（rename 跨卷失败 / 被中断时兜底，与 write_file 对称）
                    if (tmpPath) {
                        try { await fs.unlink(tmpPath); } catch { /* 已被 rename 或本就不存在 */ }
                    }
                }
            }

        }
    },
    {
        type: "function",
        function: {
            name: "delete_path",
            description: "从本地磁盘内永久删除一个指定的文件或者一整个文件夹目录。如果是目录，工具会自动执行深度递归强行销毁。此操作不可逆，请万分小心。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "准备永久销毁的文件或文件夹目录的相对路径" }
                },
                required: ["path"]
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: async (args: { path: string }) => {
                // 💡 优化 2：在审批拦截阶段就进行极其严格的路径边界检查，防止欺骗
                const cleanPath = (args.path || "").trim();
                if (!cleanPath || cleanPath === "." || cleanPath === "./" || cleanPath === "/") {
                    return `🚨【高危路径警告】传入的是敏感根路径 [${args.path}]，execute 将拒绝执行。请指定更具体的子路径后再审批。`;
                }
                // 基于 resolveSafePath 后的规范化 rel 判定根/src（堵住 ./src 等变形绕过；与 execute 对称）
                let rel = "";
                try { rel = path.relative(WORKSPACE_ROOT, resolveSafePath(cleanPath)); } catch { /* 路径非法 */ }
                if (rel === "" || rel === "src") {
                    return `🚨【高危路径警告】[${args.path}] 规整后指向工作区根目录 / src 源码根，execute 将拒绝执行。请指定更具体的子路径后再审批。`;
                }

                let label = "文件或目录";
                try {
                    const stat = await fs.stat(resolveSafePath(cleanPath));
                    label = stat.isDirectory() ? "一整个文件夹目录" : "纯物理文件";
                } catch { /* 目标不存在时用通用标签 */ }
                return `⚠️【最高安全警报】申请永久销毁 [${cleanPath}]（目标物理属性为：${label}）。该操作完全不可逆！`;
            },
            async execute(args: { path: string }): Promise<string> { // 💡 显式声明返回值，保证类型安全
                try {
                    const cleanPath = (args.path || "").trim();

                    // 💡 优化 3：空路径直接拒；根目录 / src 源码根的判定放到 resolveSafePath 之后用规范化 rel，
                    //   以堵住 "./src"、"src/"、"src/sub/.." 等字面量变形绕过（resolveSafePath + path.relative 会规整它们）
                    if (!cleanPath || cleanPath === "." || cleanPath === "./" || cleanPath === "/") {
                        return `❌ [安全熔断]：禁止通过本工具直接摧毁项目根目录或传入空路径！`;
                    }

                    const absPath = resolveSafePath(cleanPath);

                    // 💡 优化 4：【路径穿越 + 根/src 保护二次核验】用 path.relative 得到规范化 rel（不依赖字符串前缀，规避 Windows 盘符大小写）：
                    //   rel === "" → 工作区根；rel === "src" → 源码根；rel 以 ".." 开头或为绝对路径 → 越界
                    const rel = path.relative(WORKSPACE_ROOT, absPath);
                    if (!rel || rel === "" || rel === "src" || rel.startsWith("..") || path.isAbsolute(rel)) {
                        return `❌ [安全熔断]：拒绝销毁工作区根目录 / src 源码根 / 越界路径 [${cleanPath}]！`;
                    }

                    let stat: Stats;
                    try {
                        stat = await fs.stat(absPath);
                    } catch {
                        return `❌ [销毁失败]：在工作区内未找到指定的路径 [${cleanPath}]。`;
                    }

                    const isDirectory = stat.isDirectory();
                    if (isDirectory) {
                        await fs.rm(absPath, { recursive: true, force: true });
                    } else {
                        await fs.unlink(absPath);
                    }

                    const targetTypeLabel = isDirectory ? "一整个文件夹目录" : "纯物理文件";
                    return `✅ [路径销毁成功]：已成功永久销毁${targetTypeLabel} [${cleanPath}]。`;
                } catch (error: any) {
                    return `操作失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "将完整内容全量写入指定文件（覆盖）。文件不存在则新建（含父目录）；已存在则整体覆盖。适合从零生成文件或大段重写；局部修改请改用 edit_file。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "目标文件相对路径" },
                    content: { type: "string", description: "要写入的完整文件内容" },
                },
                required: ["path", "content"],
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { path: string; content: string }) =>
                `申请全量写入文件 [${args.path}]（${args.content.length} 字符，若已存在将被整体覆盖）`,
            async execute(args: { path: string; content: string }): Promise<string> { // 💡 显式声明返回值，确保类型安全
                // 建立一个需要手动清理的临时路径变量
                let tmpPath: string | null = null;
                try {
                    const absPath = resolveSafePath(args.path);

                    // 自动创建多层父目录
                    await fs.mkdir(path.dirname(absPath), { recursive: true });

                    // 💡 优化 1：生成一个带有随机时戳或标识的临时文件路径
                    tmpPath = `${absPath}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;

                    // 💡 优化 2：全量写入临时文件（即使这里断电或被超时强杀，也不会污染和破坏原文件）
                    await fs.writeFile(tmpPath, args.content, "utf-8");

                    // 💡 优化 3：【核心原子替换】写入成功后，瞬间重命名覆盖原文件
                    // 这一步在绝大多数现代操作系统中都是原子操作（Atomic Operation）
                    await fs.rename(tmpPath, absPath);

                    return `✅ [文件写入成功]：已全量写入 [${args.path}]（${args.content.length} 字符）。`;
                } catch (error: any) {
                    // 💡 优化 4：异常兜底，如果临时文件写到一半报错，立刻将其从磁盘上抹去，防止留下垃圾文件
                    if (tmpPath) {
                        try {
                            await fs.unlink(tmpPath);
                        } catch { /* 忽略删除失败 */ }
                    }
                    return `操作失败: ${error.message}`;
                }
            }
        },
    },
    {
        type: "function",
        function: {
            name: "view_symbol_outline",
            description: "通过抽象语法树(AST)快速提取指定文件中的符号大纲（类、接口、函数名、导出项、入参签名等）。适合在不读取几千行具体代码的前提下，宏观了解文件架构。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "准备分析的文件相对路径（如 'src/services/user.ts'）" }
                },
                required: ["path"]
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { path: string }): Promise<string> {
                try {
                    const absPath = resolveSafePath(args.path);
                    const fileContent = await fs.readFile(absPath, "utf-8");

                    // 1. 创建内存中的 TypeScript 虚拟源文件
                    const sourceFile = ts.createSourceFile(
                        absPath,
                        fileContent,
                        ts.ScriptTarget.Latest,
                        true // 保持位置信息
                    );

                    const outlineLines: string[] = [];

                    // 2. 递归遍历 AST 节点的函数
                    const visit = (node: ts.Node, depth = 0) => {
                        const indent = "  ".repeat(depth);
                        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
                        const isExported = modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ? "export " : "";

                        // 提取接口 (Interface)
                        if (ts.isInterfaceDeclaration(node)) {
                            outlineLines.push(`${indent}├── [Interface] ${isExported}${node.name.text}`);
                        }
                        // 提取类 (Class)
                        else if (ts.isClassDeclaration(node)) {
                            const className = node.name ? node.name.text : "AnonymousClass";
                            outlineLines.push(`${indent}├── [Class] ${isExported}${className}`);
                            // 深入一层的类成员（方法、构造函数）
                            node.members.forEach(member => {
                                const memberModifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
                                const isPrivate = memberModifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword) ? "private " : "";

                                if (ts.isMethodDeclaration(member) && member.name) {
                                    const params = member.parameters.map(p => `${p.name.getText()}: ${p.type ? p.type.getText() : "any"}`).join(", ");
                                    outlineLines.push(`${indent}│   ├── [Method] ${isPrivate}${member.name.getText()}(${params})`);
                                } else if (ts.isConstructorDeclaration(member)) {
                                    outlineLines.push(`${indent}│   ├── [Constructor] constructor()`);
                                }
                            });
                        }
                        // 提取独立函数 (Function)
                        else if (ts.isFunctionDeclaration(node) && node.name) {
                            const params = node.parameters.map(p => `${p.name.getText()}: ${p.type ? p.type.getText() : "any"}`).join(", ");
                            outlineLines.push(`${indent}├── [Function] ${isExported}${node.name.text}(${params})`);
                        }
                        // 提取导出的常量变量声明（如导出的箭头函数等）
                        else if (ts.isVariableStatement(node) && isExported) {
                            node.declarationList.declarations.forEach(decl => {
                                if (decl.name && ts.isIdentifier(decl.name)) {
                                    outlineLines.push(`${indent}├── [Variable/Export] ${isExported}${decl.name.text}`);
                                }
                            });
                        }

                        // 继续遍历子节点
                        ts.forEachChild(node, (child) => visit(child, depth + 1));
                    };

                    // 3. 启动遍历
                    visit(sourceFile);

                    if (outlineLines.length === 0) {
                        return `[Outline: ${args.path}]\n文件内未检测到清晰的类、接口、或函数符号导出大纲。如果是纯文本或配置文件，建议改用 read_file。`;
                    }

                    return `[File Symbol Outline: ${args.path}]\n` + outlineLines.join("\n");
                } catch (error: any) {
                    return `符号大纲分析失败 [${args.path}]: ${error.message}`;
                }
            }
        }
    }
];
