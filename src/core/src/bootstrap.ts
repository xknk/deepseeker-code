/**
 * @file bootstrap.ts
 * @description 引擎初始化序列（与前端形态无关）：连接 MCP、加载 hooks/permissions/skills/agents/
 *  项目指引/斜杠命令。从 serve/index.ts 抽取为共享模块，供 Web 宿主与 CLI 宿主复用。
 *
 *  设计：initEngine(into) 把可变工具表 agentTools 作为入参传入（MCP/skills/agents 会向其注入工具），
 *       返回 dispose 函数（disposeAllMcpClients），由各宿主在退出钩子里调用。顺序与原 serve 一致。
 */
import type { CustomTool } from "@/tool/index.ts";
import { initMcpTools, disposeAllMcpClients } from "@/tool/mcp/loader.ts";
import { initHooks } from "@/hooks/loader.ts";
import { initPermissions } from "@/tool/permissions.ts";
import { initSkills } from "@/skills/loader.ts";
import { initAgents } from "@/agents/loader.ts";
import { initProjectGuide } from "@/projectGuide/loader.ts";
import { initCommands } from "@/commands/loader.ts";
import { sweepOrphanedWorktrees, disposeAllSessionWorktrees } from "@/tool/worktree/manager.ts";

/**
 * 初始化引擎：Node 版本特性检测 + 7 步声明式加载。
 * @param into 可变工具表（通常传 agentTools）；MCP/skills/agents 会向其注入工具。
 *              ★ 调用方须在 initEngine 之后再读取 into（注入发生在内部），勿在模块顶层快照。
 * @returns dispose 函数：清理所有 MCP 子进程，供退出钩子调用。
 */
export const initEngine = async (into: CustomTool[], opts?: { includeProject?: boolean }): Promise<() => void> => {
    // ★ includeProject：信任文件夹闸门。false（当前目录未被信任）时各 loader 跳过【项目级】配置
    //   （防恶意目录的 hooks 自动 spawn 执行 / CLAUDE.md 注入 system prompt / permissions 自动放行）。缺省 true（向后兼容）。
    const includeProject = opts?.includeProject ?? true;
    // Q-6：web_fetch 依赖 AbortSignal.any/timeout（Node 20.3+）。启动期特性检测，缺失则告警（其余功能不受影响）。
    if (typeof (AbortSignal as any).any !== "function" || typeof (AbortSignal as any).timeout !== "function") {
        console.error("❌ 当前 Node 版本缺少 AbortSignal.any/timeout（需 Node 20.3+），web_fetch 相关能力将不可用，建议升级 Node。");
    }
    // ★ P2-13 worktree 孤儿清扫：进程重启 = 上次 run_workflow 未清理的 worktree 全是孤儿。启动期回收，
    //   防 .git/worktrees 元数据与仓外工作树泄漏。best-effort，失败不阻断启动（非 git 仓库静默跳过）。
    await sweepOrphanedWorktrees().catch((e) => console.warn(`⚠️ [worktree] 启动期清扫失败（已忽略）: ${e?.message ?? e}`));
    // 连接配置的 MCP 服务器，把其工具注入 into（无配置时静默跳过）。MCP 仅读全局 mcp.json，无项目级源，不受 includeProject 影响。
    await initMcpTools(into);
    // ★ 加载声明式 hooks（settings.json；无配置时静默跳过）。未信任时跳过项目级（hooks 会 spawn 执行命令，高风险）
    await initHooks(includeProject);
    // ★ 加载细粒度权限规则（settings.json permissions.{allow,deny,ask}；无配置时静默跳过）。未信任时跳过项目级（防 auto-approve 绕审批）
    await initPermissions(includeProject);
    // ★ 加载 skills（builtin/global/project；有 skill 才注入 load_skill 工具）。未信任时跳过项目级
    await initSkills(into, includeProject);
    // ★ 加载声明式子 Agent（builtin/global/project；复用 spawn_agent，仅注册 manifest + 白名单校验）。未信任时跳过项目级
    await initAgents(into, includeProject);
    // ★ 缓存项目指引（CLAUDE.md/AGENTS.md/AGENT.md）到内存，供每轮自动注入 system prompt。未信任时整体跳过（无全局源，防提示注入）
    await initProjectGuide(includeProject);
    // ★ 加载斜杠命令（builtin/global/project；用户输入 /<name> 时前置展开）。未信任时跳过项目级
    await initCommands(includeProject);

    // ★ 返回退出清理：dispose 所有 MCP 子进程 + 清理 session worktree，避免孤儿化。
    //   各宿主在 SIGINT/SIGTERM/退出钩子里调用。worktree 清理异步、best-effort（退出时可能来不及，残留由启动期 sweep 兜底）。
    return () => {
        try { disposeAllMcpClients(); } catch { /* ignore */ }
        try { void disposeAllSessionWorktrees(); } catch { /* ignore */ }
    };
};
