/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-13 08:08:35
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-20 09:55:55
 * @FilePath: \deepSeekCode\src\core\src\tool\guard.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file tool/guard.ts
 * @description 安全卫士防线核心中心：物理沙箱逃逸穿透防御（resolveSafePath）+
 *  多层级 Gitignore 递归解析判定（initializeWorkspaceIgnore / checkIsPathIgnored）+
 *  执行层统一审批网关（requestApproval）。
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import ignore from "ignore"; // 需要安装: npm install ignore
import { AsyncLocalStorage } from "node:async_hooks";
import { ToolContext, ToolSafetyLevel } from "./type.ts";
import { truncateApprovalDetail } from "@/agent/truncate.ts";
import { addPermissionRule, buildScopedAllowRule } from "./permissions.ts";

/** 工作区根目录（全局默认）：优先取环境变量 WORKSPACE_ROOT，否则回退到进程当前目录。
 *  ★ 现为「回退默认值」——真正生效的围栏基座由 ALS（getActiveWorkspaceRoot）决定：
 *    无 store 时回退此常量（= 现状，零回归）；worktree 隔离时由 runWithWorkspaceRoot 覆盖。 */
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();

// ============ AsyncLocalStorage：按 agent 上下文切换「活动工作区根」============
/**
 * 工作区根的异步上下文存储。run_workflow 的 worktree 模式用 runWithWorkspaceRoot 包住整个子 agent
 * 运行，子 agent 内所有 async 链（runAgent 流式消费 / processToolCall / Promise.all 并发 / undo 备份）
 * 自动继承该 store；resolveSafePath / assertWithinWorkspace / ignore 引擎据此读「活动根」。
 * 无 store → 回退 WORKSPACE_ROOT（主工作区，向后兼容）。
 *
 * ★ 禁区：ALS 不得用于 abort 监听器 / 原生事件发射器回调内（这类回调在注册方上下文之外同步触发，
 *   如 background.ts/command.ts 的 signal.addEventListener('abort')）。当前这类回调不做路径解析，安全。
 */
const workspaceAls = new AsyncLocalStorage<{ workspaceRoot: string }>();

/** 当前活动工作区根：ALS store 优先，否则回退全局 WORKSPACE_ROOT。 */
export const getActiveWorkspaceRoot = (): string => workspaceAls.getStore()?.workspaceRoot ?? WORKSPACE_ROOT;

/** 在 root 上下文里执行 fn（fn 及其所有 async 续延均视 root 为工作区根）。用于 worktree 隔离。 */
export const runWithWorkspaceRoot = <T>(root: string, fn: () => T): T =>
    workspaceAls.run({ workspaceRoot: root }, fn);

// ============ ignore 引擎：按 base 多实例（替代原单例）============
/**
 * 每 base 一份 ignore 引擎 + 并发构建去重。主工作区与各 worktree 各持一份（worktree 有独立检出的 .gitignore）。
 * - ignoreCache：同步读缓存（checkIsPathIgnored 用），构建完成后落位。
 * - ignoreBuilding：同 base 并发构建去重（首个 caller 建 Promise，余者 await 同一份）。
 * key 用 base 原始字符串（WORKSPACE_ROOT 常量 / 我们设置的 worktreePath，表达一致）。
 */
const BUILTIN_IGNORE_RULES = [
    ".git", "node_modules", "vendor",
    "__pycache__", ".venv", ".pytest_cache",
    ".gradle", "build", "target", ".settings",
    ".vs", "Debug", "Release", "out",
    ".DerivedData", "Pods",
    ".idea", ".vscode", "*.log", ".env",
];
const ignoreCache = new Map<string, ReturnType<typeof ignore>>();
const ignoreBuilding = new Map<string, Promise<ReturnType<typeof ignore>>>();

/**
 * 🛡️ 物理沙箱防护锁：通过操作系统磁盘扇区原形解析，彻底掐断软链接（Symlink）跨界逃逸攻击
 */
export const resolveSafePath = (rel: string, base?: string): string => {
    // ★ base 优先级：显式传入（单测）> ALS 活动根（worktree 隔离）> 全局 WORKSPACE_ROOT（现状）
    const root = base ?? getActiveWorkspaceRoot();
    const candidateAbsPath = path.resolve(root, rel);
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

    const trueWorkspaceRoot = fsSync.realpathSync(root);
    const relativePart = path.relative(trueWorkspaceRoot, truePhysicalPath);

    if (relativePart.startsWith("..") || path.isAbsolute(relativePart)) {
        throw new Error(`🛑 [SECURITY ALERT] 检测到恶意的物理路径跨界逃逸！拒绝访问：${rel}`);
    }

    return truePhysicalPath;
};

/**
 * 🛡️ 写操作前夕二次围栏复检（TOCTOU 收紧）：
 *  resolveSafePath 入口已 realpath + 围栏判定，但「检查」与「写」之间存在竞争窗口——
 *  软链接可在两步间被替换为指向工作区外的目标（如 rm foo; ln -s /etc/passwd foo）。
 *  本函数在 destructive fs 操作前再次 realpath 并复检围栏，把窗口收窄到「检查后立即操作」。
 *  注：完全闭环需 O_NOFOLLOW 打开（Node 无直接 API），作为残留风险；工作区根围栏已兜底最严重后果。
 */
export const assertWithinWorkspace = (absPath: string, base?: string): void => {
    const root = base ?? getActiveWorkspaceRoot();
    let truePhysicalPath = absPath;
    try {
        if (fsSync.existsSync(absPath)) {
            truePhysicalPath = fsSync.realpathSync(absPath);
        } else {
            const parentDir = path.dirname(absPath);
            if (fsSync.existsSync(parentDir)) {
                truePhysicalPath = path.join(fsSync.realpathSync(parentDir), path.basename(absPath));
            }
        }
    } catch (e: any) {
        throw new Error(`路径二次解析失败（疑似软链接逃逸）: ${e.message}`);
    }
    const trueWorkspaceRoot = fsSync.realpathSync(root);
    const relativePart = path.relative(trueWorkspaceRoot, truePhysicalPath);
    if (relativePart.startsWith("..") || path.isAbsolute(relativePart)) {
        throw new Error(`🛑 [SECURITY ALERT] 二次围栏复检发现越界（疑似 TOCTOU 软链接逃逸）：${absPath}`);
    }
};

/**
 * 🛡️ P1-7 受保护目录清单：写/删工具无论授权与否一律禁碰，防 VCS（.git/.hg/.svn）、凭证（.ssh/.aws）、
 * 项目配置（.deepSeekCode：hooks/permissions/skills/agents，防 agent 自我篡改提权）被改。
 * 仅作用于写工具（isUndoTrigger：edit_file/write_file/create_file/delete_path）；读不受限（模型可读 .git/.env 调试）。
 * 注：单个敏感文件（.env 等）不在此列——由 auto deny 清单（auto 模式）/ 人工审批（默认模式）处理，避免阻碍常规编辑。
 */
export const PROTECTED_WRITE_DIRS = ['.git', '.hg', '.svn', '.ssh', '.aws', '.deepSeekCode'];

/**
 * 路径是否落入受保护目录（含其子路径）。解析为绝对路径后按路径段匹配（小写归一），避免误判文件名巧合。
 * 异常/空路径 → false（不阻断，交由既有 resolveSafePath 围栏 + 审批）。
 */
export const isProtectedWrite = (relOrAbs: string, cwd?: string): boolean => {
    if (!relOrAbs) return false;
    try {
        const base = cwd || WORKSPACE_ROOT;
        const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(base, relOrAbs);
        const lower = abs.replace(/\\/g, '/').toLowerCase();
        return PROTECTED_WRITE_DIRS.some(d => {
            const seg = ('/' + d).toLowerCase();
            return lower.endsWith(seg) || lower.includes(seg + '/');
        });
    } catch { return false; }
};

/**
 * 递归扫描全盘内部私有闭包函数，支持 Monorepo 级多层子目录 ignore 动态联动。
 * ★ base 相对化：relDir 以传入 base（非全局 WORKSPACE_ROOT）为锚，使每个 worktree 各持正确前缀的规则集。
 * @param engine 本 base 的 ignore 引擎实例（规则加入此 engine，不碰全局）
 */
const scanIgnoreFilesRecursive = async (dirPath: string, base: string, engine: ReturnType<typeof ignore>): Promise<void> => {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isFile() && (entry.name === ".gitignore" || entry.name === ".agentignore")) {
                const fullPath = path.join(dirPath, entry.name);
                const content = await fs.readFile(fullPath, "utf-8");
                const relDir = path.relative(base, dirPath).replace(/\\/g, "/");

                const rules = content.split(/\r?\n/).map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("#")) return "";
                    return relDir ? `${relDir}/${trimmed}` : trimmed;
                }).filter(Boolean);

                if (rules.length > 0) engine.add(rules);
            }
        }

        for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
                await scanIgnoreFilesRecursive(path.join(dirPath, entry.name), base, engine);
            }
        }
    } catch { }
};

/**
 * 为指定 base 构建一份 ignore 引擎：通用黑名单 + 递归扫描该 base 的 .gitignore/.agentignore。
 * 主工作区与各 worktree 各调一次（worktree 有独立检出的 .gitignore）。
 */
const buildIgnoreEngine = async (base: string): Promise<ReturnType<typeof ignore>> => {
    const engine = ignore();
    engine.add(BUILTIN_IGNORE_RULES);
    await scanIgnoreFilesRecursive(base, base, engine);
    return engine;
};

/**
 * 取（必要时构建）某 base 的 ignore 引擎，并发同 base 去重（首个 caller 建 Promise，余者 await 同一份）。
 * 构建完成后落 ignoreCache（供 checkIsPathIgnored 同步读）。
 */
const getIgnoreForBase = (base: string): Promise<ReturnType<typeof ignore>> => {
    let p = ignoreBuilding.get(base);
    if (!p) {
        p = buildIgnoreEngine(base).then(engine => {
            ignoreCache.set(base, engine);
            ignoreBuilding.delete(base);
            return engine;
        }).catch(e => {
            // 构建失败：清出 building 表，抛出由调用方处理（不污染缓存）
            ignoreBuilding.delete(base);
            throw e;
        });
        ignoreBuilding.set(base, p);
    }
    return p;
};

/**
 * 💡 初始化（幂等）：为「活动工作区根」构建 ignore 引擎。
 *  base 优先级：显式传入 > ALS 活动根 > 全局 WORKSPACE_ROOT。已构建则即时返回（拦截二次扫描，消灭磁盘 I/O）。
 */
export const initializeWorkspaceIgnore = async (base?: string): Promise<void> => {
    const root = base ?? getActiveWorkspaceRoot();
    await getIgnoreForBase(root);
};

/**
 * 💡 对外导出的裁判纯函数（同步）：读 base 的已构建引擎判定忽略。
 *  ★ 须先 await initializeWorkspaceIgnore(base) 才有缓存；未构建则 fail-open 返回 false（不误判忽略）。
 *  base 优先级同 initializeWorkspaceIgnore。
 */
export const checkIsPathIgnored = (checkPath: string, base?: string): boolean => {
    const root = base ?? getActiveWorkspaceRoot();
    const engine = ignoreCache.get(root);
    return engine ? engine.ignores(checkPath) : false;
};

/**
 * 💡 意识层高危行为数据化单向拦截网关
 */
/**
 * 🛂 执行层统一审批网关：在调度工具前由 runAgent 调用。
 * 工具自身不再调用此函数，只通过 CustomTool.function.requireApproval 声明风险。
 * 返回 true=放行，false=用户拒绝（对外仍是 boolean，runAgent 无需感知三态）。
 *
 * ★ 三态审批（对标 CC）：宿主回传 'allow-once' | 'allow-always' | 'deny'。
 *   - allow-always：放行 + 调 addPermissionRule 写持久 allow 规则（按工具名），下次 checkPermission 命中免审；
 *   - 项目级未信任时 addPermissionRule 内部降级（不落盘，仅本次生效），不产生无效规则。
 * 旧的 sessionApproved 会话记忆已被持久规则取代（跨会话、更干净）。
 */
export const requestApproval = async (
    toolName: string,
    toolCallId: string,
    detail: string,
    ctx: ToolContext,
    safetyLevel?: ToolSafetyLevel,
    // 本次调用的参数：仅供构造精确值作用域的 allow 规则（宿主审批通道不感知）。
    args?: any,
): Promise<boolean> => {
    // 🔒 审批详情瘦身闸：大 diff（如上千行 edit_file 的 old_str/new_str）仅保留头尾，
    //   防止单条 SSE 帧过大与前端渲染卡顿；完整改动可经工具参数或 read_file 核对。
    const safeDetail = truncateApprovalDetail(detail);

    // ★ 宿主注入审批（前端无关）：核心不再硬编码 HTTP approvalGate，改由各宿主决定审批通道：
    //   Web→SSE+/api/approve；CLI→Ink 模态；VSCode（预留）→IDE 弹窗。
    //   未注入钩子时安全默认拒绝，防核心被裸调时高危工具无审批直放行。
    if (!ctx.requestApproval) {
        ctx.onUIEvent?.({ type: "tool.denied", toolsId: toolCallId, toolName });
        return false;
    }

    console.log(`⏳ [审批挂起] ${toolName} | 会话=${ctx.sessionId} | 凭证=${toolCallId}（交由宿主审批）`);

    // ★ 三态决策：allow-once 仅本次 / allow-always 放行+写持久规则 / deny 拒绝
    const decision = await ctx.requestApproval(safeDetail, { toolName, toolCallId, sessionId: ctx.sessionId });
    const approved = decision !== 'deny';

    if (!approved) {
        ctx.onUIEvent?.({ type: "tool.denied", toolsId: toolCallId, toolName });
    } else if (decision === 'allow-always') {
        // ★ 持久化「精确值作用域」allow 规则（如 run_command(npm test)）：下次 checkPermission 命中该精确值免审。
        //   避免写裸工具名导致 rm -rf 等破坏性调用也被静默放行。项目级未信任目录时降级为"仅本次放行"。
        const ruleStr = buildScopedAllowRule(toolName, args);
        const persisted = await addPermissionRule('project', 'allow', ruleStr).catch(() => false);
        console.log(persisted
            ? `📌 [审批记忆] 已写持久 allow 规则：${ruleStr}（项目 .deepSeekCode/settings.json），后续命中该精确值免审`
            : `♻️ [审批] ${toolName} 本次放行${safetyLevel ? ` (${safetyLevel})` : ''}（未持久化：未信任目录或写入失败）`);
    }
    return approved;
};
