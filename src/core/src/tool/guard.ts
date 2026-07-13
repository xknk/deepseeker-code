/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-13 08:08:35
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-13 08:17:28
 * @FilePath: \deepSeekCode\src\core\src\tool\guard.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 20:15:00
 * @FilePath: \deepSeekCode\src\tool\registry\guard.ts
 * @Description: 安全卫士防线核心中心（物理沙箱逃逸穿透防御 + 多层级 Gitignore 递归解析判定）
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import ignore from "ignore"; // 需要安装: npm install ignore
import { ToolContext } from "./type.ts";

export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();

// 闭包私有变量：锁定多层级 rules 引擎与初始化状态单例
const ig = ignore(); // 用于模拟 gitignore 规则过滤文件
let isIgnoreInitialized = false;

/**
 * 🛡️ 物理沙箱防护锁：通过操作系统磁盘扇区原形解析，彻底掐断软链接（Symlink）跨界逃逸攻击
 */
export const resolveSafePath = (rel: string): string => {
    const candidateAbsPath = path.resolve(WORKSPACE_ROOT, rel);
    let truePhysicalPath = candidateAbsPath;

    try {
        if (fsSync.existsSync(candidateAbsPath)) {
            truePhysicalPath = fsSync.realpathSync(candidateAbsPath); // 解析真实物理路径，防止软链接跨界逃逸   
        } else {
            const parentDir = path.dirname(candidateAbsPath);
            if (fsSync.existsSync(parentDir)) {
                const trueParentDir = fsSync.realpathSync(parentDir);
                truePhysicalPath = path.join(trueParentDir, path.basename(candidateAbsPath));
            }
        }
    } catch (e: any) {
        throw new Error(`路径预解析失败，可能遭遇恶意路径安全注入: ${e.message}`);
    }

    const trueWorkspaceRoot = fsSync.realpathSync(WORKSPACE_ROOT);
    const relativePart = path.relative(trueWorkspaceRoot, truePhysicalPath);

    if (relativePart.startsWith("..") || path.isAbsolute(relativePart)) {
        throw new Error(`🛑 [SECURITY ALERT] 检测到恶意的物理路径跨界逃逸！拒绝访问：${rel}`);
    }

    return truePhysicalPath;
};

/**
 * 递归扫描全盘内部私有闭包函数，支持 Monorepo 级多层子目录 ignore 动态联动
 */
const scanIgnoreFilesRecursive = async (dirPath: string): Promise<void> => {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isFile() && (entry.name === ".gitignore" || entry.name === ".agentignore")) {
                const fullPath = path.join(dirPath, entry.name);
                const content = await fs.readFile(fullPath, "utf-8");
                const relDir = path.relative(WORKSPACE_ROOT, dirPath).replace(/\\/g, "/");

                const rules = content.split(/\r?\n/).map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("#")) return "";
                    return relDir ? `${relDir}/${trimmed}` : trimmed;
                }).filter(Boolean);

                if (rules.length > 0) ig.add(rules);
            }
        }

        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
                await scanIgnoreFilesRecursive(path.join(dirPath, entry.name));
            }
        }
    } catch { }
};

/**
 * 💡 初始化通用全语言黑名单，并递归扫描整个项目中的所有配置文件
 */
export const initializeWorkspaceIgnore = async (): Promise<void> => {
    if (isIgnoreInitialized) return; // 拦截二次扫描，消灭频繁磁盘 I/O 损耗

    ig.add([
        ".git", "node_modules", "vendor",
        "__pycache__", ".venv", ".pytest_cache",
        ".gradle", "build", "target", ".settings",
        ".vs", "Debug", "Release", "out",
        ".DerivedData", "Pods",
        ".idea", ".vscode", "*.log", ".env"
    ]);

    await scanIgnoreFilesRecursive(WORKSPACE_ROOT);
    isIgnoreInitialized = true;
};

/**
 * 💡 对外导出的裁判纯函数
 */
export const checkIsPathIgnored = (checkPath: string): boolean => {
    return ig.ignores(checkPath);
};

/**
 * 💡 意识层高危行为数据化单向拦截网关
 */
export const requireUserApproval = async (toolName: string, filePath: string, details: string, ctx?: ToolContext): Promise<void> => {
    if (!ctx || !ctx.events) {
        throw new Error(`系统安全拦截：缺少事件上下文，拒绝自动执行高危写盘工具。`);
    }
    const currentToolsId = `appr_${ctx.sessionId}_${Date.now()}`;

    // 发射纯粹的、无函数闭包污染的符合 TraceBase 埋点资产规范的日志对象
    ctx.events({
        sessionId: ctx.sessionId,
        eventType: "tool_guard_block",
        timestamp: new Date().toISOString(),
        meteData: { tools_id: currentToolsId, depth: ctx.depth, toolName, toolSource: "guard", ok: false },
        payload: { input: filePath, output: details }

    });

    console.log(`⏳ [物理沙箱隔离挂起中]：等待用户解密解锁凭证凭证 ID = ${currentToolsId}`);

    const { waitForUserApproval } = await import("./approvalGate.ts");
    const isApproved = await waitForUserApproval(currentToolsId);

    if (!isApproved) {
        throw new Error(`用户拒绝了本次 [${toolName}] 的写入申请，操作已被安全熔断。`);
    }
};
