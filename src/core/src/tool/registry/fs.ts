/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 20:30:00
 * @FilePath: \deepSeekCode\src\tool\registry\fs.ts
 * @Description: 原子层文件系统工具集成包 (read_file, list_dir, edit_file, create_file, delete_path)
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { CustomTool } from "../type.ts";
import { 
    WORKSPACE_ROOT, 
    resolveSafePath, 
    initializeWorkspaceIgnore, 
    checkIsPathIgnored, 
    requireUserApproval 
} from "../guard.ts";

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
            async execute(args: { path: string; start_line?: number; end_line?: number }) {
                try {
                    const absPath = resolveSafePath(args.path);
                    const raw = await fs.readFile(absPath, "utf-8");
                    const lines = raw.split(/\r?\n/);
                    
                    const totalLines = lines.length;
                    const start = args.start_line ? Math.max(1, args.start_line) : 1;
                    const end = args.end_line ? Math.min(totalLines, Math.max(start, args.end_line)) : Math.min(totalLines, start + 150 - 1);

                    const formattedCode = lines.slice(start - 1, end).map((line, index) => {
                        return `${String(start + index).padStart(5)}: ${line}`;
                    }).join("\n");

                    return `[File: ${args.path} | Lines ${start}-${end} of ${totalLines}]\n${formattedCode}${end < totalLines ? `\n\n[... 后面还有 ${totalLines - end} 行已被隐藏。]` : ""}`;
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
            async execute(args: { max_depth?: number }) {
                try {
                    const maxDepth = args.max_depth ? Math.max(1, args.max_depth) : 3;
                    await initializeWorkspaceIgnore(); // 从内存单例秒级加载

                    const scanDirLocal = async (currentPath: string, currentDepth: number): Promise<string[]> => {
                        if (currentDepth > maxDepth) return [];
                        const entries = await fs.readdir(currentPath, { withFileTypes: true });
                        let files: string[] = [];

                        for (const entry of entries) {
                            const fullPath = path.join(currentPath, entry.name);
                            const relPath = path.relative(WORKSPACE_ROOT, fullPath).replace(/\\/g, "/");
                            
                            if (checkIsPathIgnored(entry.isDirectory() ? `${relPath}/` : relPath)) continue;

                            if (entry.isDirectory()) {
                                files.push(`${relPath}/`);
                                files.push(...(await scanDirLocal(fullPath, currentDepth + 1)));
                            } else {
                                files.push(relPath);
                            }
                        }
                        return files;
                    };

                    const allFiles = await scanDirLocal(WORKSPACE_ROOT, 1);
                    if (allFiles.length === 0) return `工作区扫描完成，未发现可用文件。`;
                    return `[Workspace Universal Tree | Total Items: ${allFiles.length}]\n` + allFiles.map(f => ` - ${f}`).join("\n");
                } catch (error: any) {
                    return `项目树扫描失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "edit_file",
            description: "针对指定的文件进行局部精准修改。old_str 必须与原代码完全一致，且在全文中必须具备唯一性。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "准备修改的文件相对路径" },
                    old_str: { type: "string", description: "文件中现有的完整旧代码块" },
                    new_str: { type: "string", description: "准备替换进去的新代码块" }
                },
                required: ["path", "old_str", "new_str"]
            },
            async execute(args: { path: string; old_str: string; new_str: string }, ctx?) {
                try {
                    const absPath = resolveSafePath(args.path);
                    await requireUserApproval(
                        "edit_file", 
                        args.path, 
                        `【减少】:\n${args.old_str}\n【增加】:\n${args.new_str}`, 
                        ctx
                    );

                    const rawContent = await fs.readFile(absPath, "utf-8");
                    const isCRLF = rawContent.includes("\r\n");

                    const normalizedContent = rawContent.replace(/\r\n/g, "\n");
                    const normalizedOld = args.old_str.replace(/\r\n/g, "\n");
                    const normalizedNew = args.new_str.replace(/\r\n/g, "\n");

                    if (!normalizedContent.includes(normalizedOld)) {
                        return `❌ [代码修补失败]：未能在文件中找到指定的 old_str 旧代码块，请用 read_file 重新核对。`;
                    }

                    const matchCount = normalizedContent.split(normalizedOld).length - 1;
                    if (matchCount > 1) {
                        return `❌ [代码修补失败]：代码冲突！old_str 在全文中不唯一（共发现了 ${matchCount} 处）。请向上或向下多包裹几行上下文再提请修改。`;
                    }

                    const updatedContent = normalizedContent.replace(normalizedOld, normalizedNew);
                    await fs.writeFile(absPath, isCRLF ? updatedContent.replace(/\n/g, "\r\n") : updatedContent, "utf-8");

                    return `✅ [代码修补成功]：文件 [${args.path}] 已成功完成唯一性局部重构。`;
                } catch (error: any) {
                    return `操作被安全拦截或失败: ${error.message}`;
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
            async execute(args: { path: string; content?: string }, ctx?) {
                try {
                    const absPath = resolveSafePath(args.path);
                    const isExist = await fs.access(absPath).then(() => true).catch(() => false);
                    if (isExist) return `❌ [创建文件失败]：文件 [${args.path}] 已经存在。请改用 edit_file 工具！`;

                    const initialContent = args.content || "";
                    await requireUserApproval("create_file", args.path, `申请新建文件，初始长度: ${initialContent.length} 字符`, ctx);

                    await fs.mkdir(path.dirname(absPath), { recursive: true });
                    await fs.writeFile(absPath, initialContent, "utf-8");

                    return `✅ [文件创建成功]：已成功新建文件 [${args.path}]。`;
                } catch (error: any) {
                    return `操作被安全拦截或失败: ${error.message}`;
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
            async execute(args: { path: string }, ctx?) {
                try {
                    const absPath = resolveSafePath(args.path);

                    let stat: fsSync.Stats;
                    try {
                        stat = await fs.stat(absPath);
                    } catch {
                        return `❌ [销毁失败]：在工作区内未找到指定的路径 [${args.path}]。`;
                    }

                    const isDirectory = stat.isDirectory();
                    const targetTypeLabel = isDirectory ? "一整个文件夹目录" : "纯物理文件";

                    await requireUserApproval(
                        "delete_path",
                        args.path,
                        `⚠️【最高安全警报】申请永久销毁 [${args.path}]。目标物理属性为：${targetTypeLabel}。该操作完全不可逆！`,
                        ctx
                    );

                    if (isDirectory) {
                        await fs.rm(absPath, { recursive: true, force: true });
                    } else {
                        await fs.unlink(absPath);
                    }

                    return `✅ [路径销毁成功]：已成功永久销毁${targetTypeLabel} [${args.path}]。`;
                } catch (error: any) {
                    return `操作被安全拦截或失败: ${error.message}`;
                }
            }
        }
    }
];
