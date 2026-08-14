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
import { initOutputStyles } from "@/outputStyles/loader.ts";
import { initMemories } from "@/memory/loader.ts";
import { sweepOrphanedWorktrees, disposeAllSessionWorktrees } from "@/tool/worktree/manager.ts";
import { killAllBackgroundTasks } from "@/tool/registry/background.ts";

/**
 * 初始化引擎：Node 版本特性检测 + 声明式加载（并行）。
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

    // ★ 冷启动并行化（修 CLI/VSCode 首次启动慢）：原 9 步串行 await 累加是 2s 延迟主因——MCP 要 spawn 子进程
    //   握手（通常最慢），其余多为目录扫描 + JSON/MD 读取，串行下逐项叠加。下列 loader 互不依赖：各自读独立
    //   配置文件、写各自模块级 registry；并行阶段【只有 initMcpTools 写 into】（其余 6 个不接收 into 参数），
    //   故无并发写冲突。改 Promise.all → 总耗时 ≈ max(各步) 而非 sum。
    await Promise.all([
        // P2-13 worktree 孤儿清扫：进程重启 = 上次 run_workflow 未清理的 worktree 全是孤儿。best-effort，失败不阻断。
        sweepOrphanedWorktrees().catch((e: any) => console.warn(`worktree 启动期清扫失败（已忽略）: ${e?.message ?? e}`)),
        // 连接配置的 MCP 服务器并注入其工具（★ 通常最慢：spawn 子进程 + stdio 握手；无配置静默跳过）。仅读全局 mcp.json，不受 includeProject 影响。
        initMcpTools(into),
        // 加载声明式 hooks（settings.json；无配置时静默跳过）。未信任时跳过项目级（hooks 会 spawn 执行命令，高风险）
        initHooks(includeProject),
        // 加载细粒度权限规则（settings.json permissions.{allow,deny,ask}；无配置时静默跳过）。未信任时跳过项目级（防 auto-approve 绕审批）
        initPermissions(includeProject),
        // 缓存项目指引（CLAUDE.md/AGENTS.md/AGENT.md）到内存，供每轮自动注入 system prompt。未信任时整体跳过（无全局源，防提示注入）
        initProjectGuide(includeProject),
        // 加载斜杠命令（builtin/global/project；用户输入 /<name> 时前置展开）。未信任时跳过项目级
        initCommands(includeProject),
        // 加载输出风格（builtin/global/project；用户经 CLI /output-style <name> 选用，runAgent 注入 persona）。未信任时跳过项目级
        initOutputStyles(includeProject),
        // 加载持久记忆（global/project；runAgent 注入一行索引，memory_read 按需召回全文）。未信任时跳过项目级（防提示注入）
        initMemories(includeProject),
    ]);

    // ★ skills → agents 串行收尾（不可并入并行组）：两者都读 into 做工具白名单校验，依赖 mcp__* / load_skill
    //   已注入（见 agents/loader.ts 的 known = new Set(into.map(...))「已先于本步注入」注释）。若并行会在 MCP/skills
    //   注入前读 into → 误剔 agent/skill 引用的 MCP 工具与 load_skill（功能性 bug）。skills 需 MCP 先注入，agents 需
    //   MCP+skills(load_skill) 先注入，故严格 skills→agents 顺序。两者都只是扫几个 md（几十 ms），串行代价可忽略。
    await initSkills(into, includeProject);
    await initAgents(into, includeProject);

    // ★ 返回退出清理：dispose 所有 MCP 子进程 + 清理 session worktree，避免孤儿化。
    //   各宿主在 SIGINT/SIGTERM/退出钩子里调用。worktree 清理异步、best-effort（退出时可能来不及，残留由启动期 sweep 兜底）。
    return () => {
        try { disposeAllMcpClients(); } catch { /* ignore */ }
        try { void disposeAllSessionWorktrees(); } catch { /* ignore */ }
        // ★ B-2：终止所有运行中后台任务（dev server / watch 等 detached+unref 进程，不显式杀会在宿主退出后孤儿常驻）
        try { void killAllBackgroundTasks(); } catch { /* ignore */ }
    };
};
