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
import { dispatch } from "./hooks.ts";
import { getSessionWorktreeRoot } from "./worktree/sessionRegistry.ts";

/** 工作区根目录（全局默认）：优先取环境变量 WORKSPACE_ROOT，否则回退到进程当前目录。
 *  ★ 此常量在模块加载期冻结，仅供「目标天然是激活期主仓」的消费者用（worktree manager / projectGuide loader）。
 *    文件沙箱围栏（getActiveWorkspaceRoot / isProtectedWrite）已改为实时读 process.env.WORKSPACE_ROOT，
 *    以支持 VS Code 多根工作区下宿主运行期重定向项目根——勿再为此处冻结值门控文件访问。 */
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();

// ============ AsyncLocalStorage：按 agent 上下文切换「活动工作区根」============
/**
 * 工作区根的异步上下文存储。store 可携带两种键（互不依赖）：
 *  - workspaceRoot：显式覆盖活动根（run_workflow 的 worktree 隔离用 runWithWorkspaceRoot 设置；【替换】store）。
 *  - sessionId：外裹 session 上下文（runWithSessionContext），供 getActiveWorkspaceRoot/getActiveCwd
 *    经 per-session 注册表查「该 session 激活的 worktree」（独立 enter_worktree 工具用）。
 *
 * 子 agent 内所有 async 链（runAgent 流式消费 / processToolCall / Promise.all 并发 / undo 备份）自动继承 store；
 * resolveSafePath / assertWithinWorkspace / ignore 引擎据此读「活动根」。无 store → 回退 WORKSPACE_ROOT。
 *
 * ★ 禁区：ALS 不得用于 abort 监听器 / 原生事件发射器回调内（这类回调在注册方上下文之外同步触发，
 *   如 background.ts/command.ts 的 signal.addEventListener('abort')）。当前这类回调不做路径解析，安全。
 */
const workspaceAls = new AsyncLocalStorage<{ sessionId?: string; workspaceRoot?: string }>();

/**
 * 当前活动工作区根。优先级：
 *  1. ALS.workspaceRoot（显式覆盖——run_workflow 子 agent 用自己的 wt.path）
 *  2. session 注册表（ALS.sessionId 命中——enter_worktree 激活的 session worktree）
 *  3. 全局 WORKSPACE_ROOT（默认主工作区，向后兼容）
 * 即 workflow 子 agent 用 wt.path；主 agent 用 session worktree（若 enter 过）；其余回退全局。
 */
export const getActiveWorkspaceRoot = (): string => {
    const store = workspaceAls.getStore();
    if (store?.workspaceRoot) return store.workspaceRoot;
    if (store?.sessionId) {
        const wtRoot = getSessionWorktreeRoot(store.sessionId);
        if (wtRoot) return wtRoot;
    }
    // ★ 实时读 env（而非模块加载期冻结的 WORKSPACE_ROOT 常量）：
    //   VS Code 多根工作区下，宿主按「活动编辑器所属文件夹」运行期重定向（openChat/newSession 时
    //   重设 process.env.WORKSPACE_ROOT + chdir），此处实时读可让文件沙箱围栏立即跟随新根，无需重载窗口。
    return process.env.WORKSPACE_ROOT || process.cwd();
};

/** 显式覆盖活动根（run_workflow 的 worktree 隔离用；替换 store，不合并 sessionId——保 workflow 子 agent 用 wt.path）。 */
export const runWithWorkspaceRoot = <T>(root: string, fn: () => T): T =>
    workspaceAls.run({ workspaceRoot: root }, fn);

/**
 * 外裹 session 上下文（携带 sessionId）。chatProcessing 在消费 runAgent 的 for-await 外裹本函数，
 * 使整个 turn 内所有 async 链（工具调用 / 路径解析 / hook 派发）都能经 sessionId 查到 session worktree。
 */
export const runWithSessionContext = <T>(sessionId: string, fn: () => T): T =>
    workspaceAls.run({ sessionId }, fn);

/**
 * 当前活动 cwd：session worktree 激活时返回 worktree 路径，否则返回 fallback（零回归）。
 * runAgent 据此构造 toolCtx.cwd（替代原先冻结的 options.cwd）——使 run_command / isProtectedWrite
 * 等读 ctx.cwd 的逻辑在 enter_worktree 后也跟随到 worktree。
 * ★ 无 session worktree 时返回 fallback（= 原 options.cwd），行为与既有完全一致。
 */
export const getActiveCwd = (fallback: string): string => {
    const store = workspaceAls.getStore();
    if (store?.sessionId) {
        const wtRoot = getSessionWorktreeRoot(store.sessionId);
        if (wtRoot) return wtRoot;
    }
    return fallback;
};

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
    "*.tmp",  // ★ 原子写临时文件(makeTmpPath 产物):正常被 rename 消费、抛错被 unlink,仅硬中断泄漏;
              //   纳入忽略让 list_dir/read_file/git 不再曝光(泄漏残体的实盘清扫见 fs.ts 的 sweepStaleAtomicTmp)
];
const ignoreCache = new Map<string, ReturnType<typeof ignore>>();
const ignoreBuilding = new Map<string, Promise<ReturnType<typeof ignore>>>();

/**
 * 🛡️ 多根工作区允许根集合：VS Code 多根工作区下，宿主把「所有工作区文件夹」注册进来，
 *  resolveSafePath 据此判定——绝对路径落在【任一】文件夹内即放行（相对路径仍解析到活动根），
 *  仅拦截逃出整个工作区的路径。realpath 在 set 时一次性解析并缓存，避免每条路径重复磁盘读。
 *  空集合 → 回退单根（getActiveWorkspaceRoot 的 realpath），向后兼容 CLI 单目录场景。
 */
let allowedRootsReal: string[] = [];
export const setAllowedWorkspaceRoots = (roots: string[]): void => {
    const real: string[] = [];
    for (const r of roots) {
        if (!r) continue;
        try { real.push(fsSync.realpathSync(r)); } catch { real.push(path.resolve(r)); }
    }
    allowedRootsReal = Array.from(new Set(real));
};
/** 取已注册的允许根（realpath 后）。空 = 未注册多根（CLI 单目录场景），由调用方回退 cwd。 */
export const getAllowedWorkspaceRoots = (): string[] => [...allowedRootsReal];

/**
 * 给定绝对路径，返回它【所属】的允许根（多根工作区下落在某文件夹内即返回该文件夹；不在任一根内回退活动根）。
 * 用于「需要按文件所属根算相对路径 / 取对应 gitignore 引擎」的场景（read_file / view_symbol_outline 的忽略判定）。
 * ★ 不用本函数、直接拿活动根算相对路径时，跨根文件会得到 `../兄弟项目/...`，
 *   ① 触发 ignore 包 `.ignores()` 对含 `..` 路径抛 RangeError（"path should be a path.relative()d string"）；
 *   ② 即便不抛，也是用活动根的 gitignore 引擎去判兄弟根文件——引擎用错。
 * 取最长（最具体）匹配根，处理一个根嵌套在另一个根内的边界情况。
 */
export const getContainingRoot = (absPath: string): string => {
    let best: string | undefined;
    for (const r of allowedBoundaryRoots()) {
        const rel = path.relative(r, absPath);
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
            if (!best || r.length > best.length) best = r;
        }
    }
    return best ?? getActiveWorkspaceRoot();
};
/** 围栏判定用的根集合：有注册用注册集，否则回退单活动根（realpath，失败用原值）。 */
const allowedBoundaryRoots = (): string[] => {
    if (allowedRootsReal.length > 0) return allowedRootsReal;
    const r = getActiveWorkspaceRoot();
    try { return [fsSync.realpathSync(r)]; } catch { return [r]; }
};

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

    // ★ 围栏判定：base 显式传入（单测）→ 仅查该根；否则查「允许根集合」——多根工作区下绝对路径
    //   落在任一文件夹内即放行，相对路径仍解析到活动根；只有逃出整个工作区才拦截。安全无损。
    const boundaryRoots = base ? (() => { try { return [fsSync.realpathSync(root)]; } catch { return [root]; } })() : allowedBoundaryRoots();
    const escaped = boundaryRoots.every(r => {
        const rel0 = path.relative(r, truePhysicalPath);
        return rel0.startsWith("..") || path.isAbsolute(rel0);
    });

    if (escaped) {
        throw new Error(`🛑 [SECURITY ALERT] 检测到恶意的物理路径跨界逃逸！拒绝访问：${rel}`);
    }

    return truePhysicalPath;
};

/**
 * 📖 只读路径解析：供 read_file / view_symbol_outline / read_docx / read_pdf / read_xlsx /
 *  get_diagnostics / goto_definition / search_grep / glob 等 SAFE 只读工具使用。
 *
 * 与 resolveSafePath 的区别——【不施加工作区围栏】：允许 `..` 与绝对路径解析到本机任意位置。
 * 动因：单人本地 AI coding 定位下，agent 常需读活动根之外的兄弟项目 / 上层配置（如活动根为
 *   pms-front 时读 ../tms-front 的文件）。旧围栏在单根场景对 `..` 一律 SECURITY 拦截，迫使 agent
 *   改走绝对路径——而绝对路径同样逃出唯一注册根也被拦，陷入「指明了文件却读不到」的死局。
 * 安全不降级：密钥外泄防线收敛到 fs.ts 的 isSensitiveReadTarget（.env / 私钥 / credentials 等硬拒），
 *   read 系工具另带 maskSecretsInContent 内容脱敏。写/删/移动/notebook 工具仍走 resolveSafePath（围栏不动）。
 *
 * 仍以 ALS 活动根为相对锚（worktree 隔离 / 多根活动根切换语义一致）；不 realpath——read 非破坏，
 *   symlink 跟随即是「读任意位置」的既定契约，无 TOCTOU 风险（那是写路径专属）。
 */
export const resolveReadablePath = (rel: string): string => {
    const root = getActiveWorkspaceRoot();
    return path.resolve(root, rel);
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
    // ★ 围栏判定：base 显式入参（单测/worktree 隔离）→ 仅查该根；否则查「允许根集合」——与 resolveSafePath
    //   完全对齐：多根工作区下路径落在【任一】注册文件夹内即放行，仅拦截逃出整个工作区的路径。
    //   （原实现仅对比单个活动根，多根场景下落在 folder[1] 的跨项目写会被误判越界 → undo 备份安全熔断误触发。）
    const boundaryRoots = base ? (() => { try { return [fsSync.realpathSync(root)]; } catch { return [root]; } })() : allowedBoundaryRoots();
    const escaped = boundaryRoots.every(r => {
        const rel0 = path.relative(r, truePhysicalPath);
        return rel0.startsWith("..") || path.isAbsolute(rel0);
    });
    if (escaped) {
        throw new Error(`🛑 [SECURITY ALERT] 二次围栏复检发现越界（疑似 TOCTOU 软链接逃逸）：${absPath}`);
    }
};

/**
 * 🛡️ P1-7 受保护目录清单：写/删工具无论授权与否一律禁碰，防 VCS（.git/.hg/.svn）、凭证（.ssh/.aws）、
 * 项目配置（.deepseeker-code：hooks/permissions/skills/agents，防 agent 自我篡改提权）被改。
 * 仅作用于写工具（isUndoTrigger：edit_file/write_file/create_file/delete_path）；读不受限（模型可读 .git/.env 调试）。
 * 注：单个敏感文件（.env 等）不在此列——由 auto deny 清单（auto 模式）/ 人工审批（默认模式）处理，避免阻碍常规编辑。
 */
export const PROTECTED_WRITE_DIRS = ['.git', '.hg', '.svn', '.ssh', '.aws', '.deepseeker-code'];

/**
 * 命令执行子进程的凭证剔除：run_command / run_in_background 的 spawn env 剔除敏感变量，防 LLM 经
 * `env` / `printenv` / `/proc/self/environ` 读取后外泄到云端模型。两道防线：
 *  1) 硬编码 denylist：agent 自身基础设施密钥（必剔）。
 *  2) 敏感模式匹配：key 名含 KEY/TOKEN/SECRET/PASSWORD/PASSPHRASE/CREDENTIAL/PRIVATE/AUTH 的变量一律剔除
 *     （S-1：覆盖 GITHUB_TOKEN / NPM_TOKEN / AWS_SECRET_ACCESS_KEY 等第三方凭证——旧版只剔 3 个 agent 密钥，
 *      其余宿主凭证全量透传，可被 prompt injection 经 printenv 外泄）。
 * 保留 PATH/HOME/USER/SHELL/LANG/TERM 等基础变量——部署/构建命令仍可用其自有 PATH。
 */
const COMMAND_ENV_DENYLIST = ["DEEP_SEEK_API_KEY", "DEEPSEEKER_CODE_TOKEN", "TAVILY_API_KEY"];
const SENSITIVE_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|PRIVATE|AUTH)/i;

/** 复制 env 并剔除敏感凭证；默认基于 process.env。供 run_command / run_in_background 共用。 */
export const scrubCommandEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
    const next: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(env)) {
        if (COMMAND_ENV_DENYLIST.includes(k)) continue;     // 显式 denylist
        if (SENSITIVE_ENV_PATTERN.test(k)) continue;        // 敏感模式匹配（第三方凭证）
        next[k] = v;
    }
    return next;
};

/**
 * 路径是否落入受保护目录（含其子路径）。解析为绝对路径后按路径段匹配（小写归一），避免误判文件名巧合。
 * 异常/空路径 → false（不阻断，交由既有 resolveSafePath 围栏 + 审批）。
 */
export const isProtectedWrite = (relOrAbs: string, cwd?: string): boolean => {
    if (!relOrAbs) return false;
    try {
        const base = cwd || process.env.WORKSPACE_ROOT || process.cwd();
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
    if (!engine) return false;
    // ★ 防性 fail-open：ignore 包对含 `..` / 绝对路径的入参会抛 RangeError。文档承诺「未构建则不误判忽略」，
    //   此处把抛错也归一为 false（放行），与 fail-open 契约一致，杜绝上游误传跨根路径时整个工具崩。
    //   read 系工具已改走 resolveReadablePath（允许跨界读），不再依 getContainingRoot 算相对路径；
    //   本 catch 仅作 list_dir / glob 等扫描工具的兜底（它们用 path.relative 算 rel，偶现跨根 `..`）。
    try { return engine.ignores(checkPath); } catch { return false; }
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

    // ★ P1-8 PermissionRequest：审批请求发出前，观察事件（审计/记录）。best-effort，不阻断审批流
    await dispatch('PermissionRequest', { sessionId: ctx.sessionId, cwd: ctx.cwd, toolName, toolCallId, detail: safeDetail, safetyLevel, args }).catch(() => { });

    // ★ 三态决策：allow-once 仅本次 / allow-always 放行+写持久规则 / deny 拒绝
    const decision = await ctx.requestApproval(safeDetail, { toolName, toolCallId, sessionId: ctx.sessionId });
    const approved = decision !== 'deny';

    if (!approved) {
        ctx.onUIEvent?.({ type: "tool.denied", toolsId: toolCallId, toolName });
    } else if (decision === 'allow-always') {
        // ★ 持久化 allow 规则（M5 加固）：buildScopedAllowRule 返回保守作用域——命令类落精确串（run_command(npm test)）、
        //   路径类落顶层目录（edit_file(src/*)）；无法安全作用域（无主参数映射 / MCP / 缺值）时返回 null → 不持久化，
        //   降级为 allow-once（旧版回退裸工具名会把该工具所有后续调用静默放行，对 MCP DANGER 工具尤其危险）。
        //   项目级未信任目录时 addPermissionRule 内部降级（不落盘，仅本次生效）。
        const ruleStr = buildScopedAllowRule(toolName, args);
        if (ruleStr) {
            const persisted = await addPermissionRule('project', 'allow', ruleStr).catch(() => false);
            console.log(persisted
                ? `📌 [审批记忆] 已写持久 allow 规则：${ruleStr}（项目 .deepseeker-code/settings.json），后续命中该作用域免审`
                : `♻️ [审批] ${toolName} 本次放行${safetyLevel ? ` (${safetyLevel})` : ''}（未持久化：未信任目录或写入失败）`);
        } else {
            console.log(`♻️ [审批] ${toolName} 本次放行${safetyLevel ? ` (${safetyLevel})` : ''}（未持久化：无法安全生成作用域，避免裸工具名静默放行全部调用）`);
        }
    }
    return approved;
};
