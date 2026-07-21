/**
 * @file tool/registry/git.ts
 * @description Git 类工具集：把高频 git 操作包成专用工具，避免只读操作也走 DANGER 级 run_command 触发审批。
 *  - get_git_diff（SAFE，纯读，工作区改动差异，带截断保护）
 *  - git_status（SAFE，纯读，工作区状态 + 分支）
 *  - git_log（SAFE，纯读，提交历史）
 *  - git_commit（MUTATION，提交暂存区；可选 stage_all 一并 git add -A）
 *  设计：统一用 execFile（不走 shell，天然防注入）+ WORKSPACE_ROOT 锚定 + 非 git 仓库兜底。
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { WORKSPACE_ROOT } from "../guard.ts";

const execFileAsync = promisify(execFile);

/** 统一 git 执行入口：锚定工作区根，限制缓冲，返回 { stdout, stderr }。 */
function runGit(args: string[], maxBuffer = 1024 * 1024 * 3) {
    return execFileAsync("git", args, { cwd: WORKSPACE_ROOT, maxBuffer });
}

/** 判定是否「非 git 仓库」错误（兼容大小写与 stderr/message 两种来源）。 */
function isNotARepoError(e: any): boolean {
    const text = `${e?.message || ""} ${e?.stderr || ""}`.toLowerCase();
    return text.includes("not a git repository");
}

export const gitTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "get_git_diff",
            description: "获取当前工作区中所有相比于 Git 暂存区/最近一次提交的未提交代码改动（红绿色 Diff 差异）。适合在修改代码后、或运行测试前，自主走查修改是否精准无低级错误。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "指定查看某个文件的 diff 差异（可选，默认查看全工作区改动）" }
                }
            },
            safetyLevel: ToolSafetyLevel.SAFE, // 纯读操作，安全级别高
            isSync: true,
            async execute(args: { path?: string }): Promise<string> {
                try {
                    const diffArgs = ["diff", "HEAD", "--no-color"];
                    if (args.path) diffArgs.push("--", args.path);

                    const { stdout } = await runGit(diffArgs);
                    if (!stdout.trim()) {
                        return `[Git Diff]：当前工作区代码极其纯净，未发现任何相比于最新 Commit 的物理改动。`;
                    }

                    // 拦截机制：防止 Diff 文本过长撑爆大模型上下文
                    const maxDiffLines = 120;
                    const lines = stdout.split("\n");
                    if (lines.length > maxDiffLines) {
                        return [
                            `[Git Diff Summary | 变更行数较多，已自动截断前 ${maxDiffLines} 行进行视觉保护]`,
                            lines.slice(0, maxDiffLines).join("\n"),
                            `\n\n[... ⚠️ 提示：Diff 改动过长，已自动隐藏剩余的 ${lines.length - maxDiffLines} 行改动 ...]`,
                            `建议使用具体的文件路径参数 [path] 分文件精准核对差异。`
                        ].join("\n");
                    }
                    return `[Current Code Changes (Git Diff)]\n${stdout}`;
                } catch (error: any) {
                    if (isNotARepoError(error)) {
                        return `❌ [Diff 失败]：当前工作区尚未初始化 Git 仓库，无法嗅探代码版本改动差异。`;
                    }
                    return `读取代码差异失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "git_status",
            description: "查看当前 Git 工作区状态（当前分支、与远端的领先/落后、以及改动/暂存/未跟踪文件的精简清单）。纯读，免审批，用于替代走 run_command 跑 git status 的繁琐。",
            parameters: {
                type: "object",
                properties: {}
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(): Promise<string> {
                try {
                    // -sb：short + branch，首行给出分支与远端领先/落后，后续每行一个文件状态
                    const { stdout } = await runGit(["status", "-sb", "--no-column"]);
                    if (!stdout.trim()) {
                        return `[Git Status]：工作区干净，无任何未提交改动。`;
                    }
                    return `[Git Status | ${WORKSPACE_ROOT}]\n${stdout.trim()}`;
                } catch (error: any) {
                    if (isNotARepoError(error)) {
                        return `❌ [Git Status 失败]：当前工作区尚未初始化 Git 仓库。`;
                    }
                    return `读取 Git 状态失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "git_log",
            description: "查看当前分支的最近若干条提交历史（短哈希 + 日期 + 提交说明）。纯读，免审批。用于了解项目演进、定位某次改动或确认提交是否成功。",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "number", description: "返回的最近提交条数（默认 20，最大 100）" }
                }
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { limit?: number }): Promise<string> {
                try {
                    const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
                    const { stdout } = await runGit([
                        "log", `-n`, String(limit),
                        `--pretty=format:%h | %ad | %s`,
                        `--date=short`,
                        `--no-decorate`
                    ]);
                    if (!stdout.trim()) {
                        return `[Git Log]：当前分支尚无任何提交记录。`;
                    }
                    return `[Git Log | 最近 ${limit} 条]\n${stdout.trim()}`;
                } catch (error: any) {
                    if (isNotARepoError(error)) {
                        return `❌ [Git Log 失败]：当前工作区尚未初始化 Git 仓库。`;
                    }
                    return `读取 Git 历史失败: ${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "git_commit",
            description: "将当前暂存区的改动提交为一次新的 Git commit。可选 stage_all=true 一并执行 git add -A（暂存全部改动含新增/删除）后再提交。注意：不会自动 push。",
            parameters: {
                type: "object",
                properties: {
                    message: { type: "string", description: "本次提交的说明信息（commit message）" },
                    stage_all: { type: "boolean", description: "是否在提交前执行 git add -A 暂存全部改动（默认 false，仅提交已暂存内容）" }
                },
                required: ["message"]
            },
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            requireApproval: (args: { message: string; stage_all?: boolean }) =>
                `申请 Git 提交${args.stage_all ? "（🔥 含 git add -A 暂存全部改动）" : "（仅提交已暂存改动）"}\n提交说明: ${args.message}`,
            async execute(args: { message: string; stage_all?: boolean }): Promise<string> {
                try {
                    if (args.stage_all) {
                        await runGit(["add", "-A"]);
                    }
                    // git commit 的摘要输出在 stderr（如 "[main abc1234] msg, 2 files changed"）
                    const { stdout, stderr } = await runGit(["commit", "-m", args.message]);
                    const summary = `${stdout}${stderr}`.trim();
                    if (!summary) {
                        return `✅ [git_commit]：提交指令已执行，但未返回摘要（可能没有暂存的改动）。`;
                    }
                    return `[git_commit 提交完成]\n${summary}`;
                } catch (error: any) {
                    if (isNotARepoError(error)) {
                        return `❌ [Git Commit 失败]：当前工作区尚未初始化 Git 仓库。`;
                    }
                    const text = `${error?.stderr || error?.message || ""}`;
                    // nothing to commit 时 git 以非零码退出，给出友好提示
                    if (text.toLowerCase().includes("nothing to commit")) {
                        return `ℹ️ [git_commit]：没有可提交的改动（nothing to commit）。如需提交请先暂存（stage_all=true 或 git add）。`;
                    }
                    return `❌ [git_commit 失败]：${text.trim()}`;
                }
            }
        }
    }
];
