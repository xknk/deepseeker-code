/**
 * @file tool/worktree/sessionRegistry.ts
 * @description per-session 活动 worktree 注册表（纯内存 Map）。
 *
 *  为独立 enter_worktree/exit_worktree 工具服务：run_workflow 的 worktree 隔离是「单次 subagent 作用域」
 *  （整个 subagent 包在一个 runWithWorkspaceRoot 内，结束即 remove）；而独立工具需让 worktree 跨轮次/
 *  跨工具持久。本注册表记录「某 session 当前激活的 worktree」，供 guard.ts 的 getActiveWorkspaceRoot /
 *  getActiveCwd 查询（经 runWithSessionContext 外裹的 ALS.sessionId 命中）。
 *
 *  ★ 多会话隔离：每会话独立 ALS {sessionId} → 独立注册表项 → 并发会话各在自己的 worktree 不冲突。
 *  ★ 纯内存：进程重启即丢失（崩溃 = worktree 孤儿，由启动期 sweepOrphanedWorktrees 回收）。
 */
import type { WorktreeHandle } from "./manager.ts";

const sessions = new Map<string, WorktreeHandle>();

/** 记录某 session 激活的 worktree（enter_worktree 用）。 */
export const setSessionWorktree = (sessionId: string, wt: WorktreeHandle): void => {
    sessions.set(sessionId, wt);
};

/** 取某 session 的活动 worktree 句柄（exit/查询用）。 */
export const getSessionWorktree = (sessionId: string): WorktreeHandle | undefined =>
    sessions.get(sessionId);

/** 取某 session 活动 worktree 的根路径（无则 undefined）。guard.getActiveWorkspaceRoot/getActiveCwd 消费。 */
export const getSessionWorktreeRoot = (sessionId: string): string | undefined =>
    sessions.get(sessionId)?.path;

/** 清除某 session 的活动记录并返回其句柄（exit_worktree 用：取出后 removeWorktree）。 */
export const clearSessionWorktree = (sessionId: string): WorktreeHandle | undefined => {
    const wt = sessions.get(sessionId);
    sessions.delete(sessionId);
    return wt;
};

/**
 * 取出全部 session 的活动 worktree 句柄并清空注册表（进程退出 dispose 用）。
 * 调用方对返回的句柄逐个 removeWorktree，防长跑进程的 worktree 泄漏。
 */
export const drainAllSessionWorktrees = (): WorktreeHandle[] => {
    const all = Array.from(sessions.values());
    sessions.clear();
    return all;
};
