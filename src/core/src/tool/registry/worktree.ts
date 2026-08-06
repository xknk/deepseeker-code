/**
 * @file tool/registry/worktree.ts
 * @description 独立 worktree 工具集（P2-13）：让模型主动把会话切换进 git worktree 工作、再切回。
 *
 *  与 run_workflow 的 isolation:"worktree" 区别：后者是「单次 subagent 作用域」（整个 subagent 包在一个
 *  runWithWorkspaceRoot 内，结束即 remove）；本工具集是「会话作用域」——enter 后跨轮次/跨工具持久，
 *  经 per-session 注册表（sessionRegistry）+ 外裹 session ALS（chatProcessing）+ getActiveCwd/getActiveWorkspaceRoot
 *  优先级查询实现：enter 后所有文件操作 / run_command / 路径解析自动落到 worktree，exit 后回主仓。
 *
 *  清理：模型显式 exit_worktree；启动期 sweepOrphanedWorktrees 回收崩溃孤儿；进程退出 dispose 清全部。
 *  worktree 落仓外 tmpdir（见 manager.ts），不污染项目目录；改动在临时分支上，需 commit/merge 才能回主仓。
 */
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { createWorktree, removeWorktree, harvestDiff, isNotARepoError } from "../worktree/manager.ts";
import {
    setSessionWorktree,
    getSessionWorktree,
    clearSessionWorktree,
} from "../worktree/sessionRegistry.ts";

export const worktreeTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "enter_worktree",
            description: "把当前会话切换进一个新的 git worktree（基于主仓当前 HEAD 的临时分支）。切换后，本会话后续所有文件读写、run_command、路径解析都落在该 worktree 内（与主工作区隔离），便于做实验性改动而不污染主仓。改动需后续 commit/merge 才能并回主仓。仅主工作区是 git 仓库时可用。",
            parameters: {
                type: "object",
                properties: {
                    reason: { type: "string", description: "为何要进入 worktree（简述任务，便于审批展示与溯源）" },
                },
                required: ["reason"],
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: (args: any) =>
                `⚠️【进入 worktree 审批】\n原因：${args?.reason ?? "(未提供)"}\n（将创建临时分支的 git worktree 并把会话工作区切换过去；改动隔离，需 commit/merge 才能并回主仓）`,
            async execute(args: any, ctx?: ToolContext): Promise<string> {
                const sessionId = ctx?.sessionId;
                if (!sessionId) return "❌ [enter_worktree] 缺少会话上下文（sessionId）。";
                if (getSessionWorktree(sessionId)) {
                    return `⚠️ 当前会话已在 worktree 内（${getSessionWorktree(sessionId)?.path}）。请先 exit_worktree 再重新进入，避免泄漏。`;
                }
                let wt;
                try {
                    // stepId 用 "session" 稳定命名（区别于 run_workflow 的数字 stepId），一个 session 同一时刻只一个
                    wt = await createWorktree(sessionId, "session");
                } catch (e: any) {
                    if (isNotARepoError(e)) return "❌ [enter_worktree] 主工作区不是 git 仓库，无法创建 worktree。";
                    return `❌ [enter_worktree] 创建 worktree 失败：${e?.message ?? e}`;
                }
                setSessionWorktree(sessionId, wt);
                return [
                    `✅ 已进入 worktree。`,
                    `路径：${wt.path}`,
                    `分支：${wt.branch}（基座 HEAD ${wt.baseSha.slice(0, 8)}）`,
                    `本会话后续的文件操作 / run_command 已自动落到此 worktree。完成后用 exit_worktree 退出（或先 commit 再退出以保留改动）。`,
                ].join("\n");
            },
        },
    },
    {
        type: "function",
        function: {
            name: "exit_worktree",
            description: "退出当前会话的 worktree 并删除它（临时分支一并删除）。退出后会话工作区回到主仓。⚠️ 未提交的改动会随删除丢失——如需保留，先在 worktree 内 commit（或用 get_git_diff 查看改动）再退出。",
            parameters: {
                type: "object",
                properties: {
                    keep_changes: { type: "boolean", description: "已无用：本工具总是删除 worktree。如需保留改动，请先 commit。" },
                },
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: (args: any) =>
                `⚠️【退出 worktree 审批】\n（将删除当前 worktree 及其临时分支；未提交改动会丢失。如需保留请先 commit。）`,
            async execute(_args: any, ctx?: ToolContext): Promise<string> {
                const sessionId = ctx?.sessionId;
                if (!sessionId) return "❌ [exit_worktree] 缺少会话上下文（sessionId）。";
                const wt = clearSessionWorktree(sessionId);
                if (!wt) return "ℹ️ 当前会话不在任何 worktree 内（无需退出）。";
                // 删除前收割 diff 快照（让模型/用户知道丢弃了什么；best-effort，失败不阻断清理）
                const diff = await harvestDiff(wt).catch(() => "");
                await removeWorktree(wt).catch(() => { });
                const diffNote = diff && !diff.includes("无改动")
                    ? `\n\n⚠️ 该 worktree 有未提交改动（已随删除丢失，摘要如下）：\n${diff.slice(0, 1500)}`
                    : "";
                return `✅ 已退出并删除 worktree（分支 ${wt.branch}）。会话工作区已回到主仓。${diffNote}`;
            },
        },
    },
    {
        type: "function",
        function: {
            name: "worktree_status",
            description: "查询当前会话是否在 worktree 内及其状态（路径/分支/基座）。进入前或想确认当前工作区时调用。",
            parameters: { type: "object", properties: {} },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(_args: any, ctx?: ToolContext): Promise<string> {
                const sessionId = ctx?.sessionId;
                if (!sessionId) return "（无会话上下文）";
                const wt = getSessionWorktree(sessionId);
                if (!wt) return "当前会话不在 worktree 内（工作区为主仓）。";
                return `当前会话在 worktree 内：\n- 路径：${wt.path}\n- 分支：${wt.branch}\n- 基座 HEAD：${wt.baseSha.slice(0, 8)}`;
            },
        },
    },
];
