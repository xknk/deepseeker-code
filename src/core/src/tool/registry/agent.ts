/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 16:15:31
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-15 16:40:53
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\agent.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { runAgent } from "@/agent/runAgent.ts";
import { buildContextMessages } from "@/session/content.ts";
import { appendMessage } from "@/session/transcript.ts";
import { createUUID } from "@/common/index.ts";
import { RunAgentOptions } from "@/agent/type.ts";
import { CustomTool, MAX_AGENT_DEPTH, ToolSafetyLevel } from "../type.ts";

/**
 * @file tool/registry/agent.ts
 * @description 子 Agent 协同工具集：提供 spawn_agent，让主 agent 把独立子任务委派给子 agent 执行。
 */

/**
 * 创建「子 agent 协同」工具集（当前仅 spawn_agent）。
 * 关键设计：通过 getGlobalTools 闭包在运行时动态获取完整工具列表，使子 agent 能拿到全部工具（含自身），
 * 从而在定义期规避循环依赖（此时全局 agentTools 尚未填充完成）。
 */
export const createAgentTools = (getGlobalTools: () => CustomTool[]): CustomTool[] => [
    {
        type: "function",
        function: {
            name: "spawn_agent",
            description: "创建一个子 agent 处理独立子任务...",
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "交给子 agent 的任务描述" },
                    role: { type: "string", description: "子 agent 的角色/专长（可选）" },
                },
                required: ["task"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,   // spawn_agent 本身不改文件，子 agent 的写操作各自分级
            isSync: true,
            async execute(args: { task: string; role?: string }, ctx?) {
                if (!ctx) return "错误：spawn_agent 缺少运行上下文";
                if (ctx.depth >= MAX_AGENT_DEPTH) {
                    return `错误：已达最大 agent 嵌套深度（${MAX_AGENT_DEPTH}）`;
                }
                const { task, role } = args;
                const subSessionId = `${ctx.sessionId}__sub__${createUUID()}`;
                const rolePrefix = role
                    ? `你是专门负责「${role}」的子 agent。`
                    : `你是子 agent。`;

                console.log(`🐣 创建子 agent（depth=${ctx.depth + 1}）: ${task.slice(0, 80)}`);
                const parentSystemPrompt = ctx.parentSystemPrompt || '';

                const subSystem = [
                    rolePrefix,
                    "\n\n# 【你必须严格遵循的全局代码重构规范】",
                    parentSystemPrompt
                ].join("\n");

                const subMessages = await buildContextMessages(subSessionId, { role: "user", content: task }, subSystem);
                await appendMessage({ sessionId: subSessionId, role: 'user', content: task });

                let subResult = "";
                const subOptions: RunAgentOptions = {
                    sessionId: subSessionId,
                    // 动态获取最新、最全的工具列表（包括 fs, search 等）透传给子 Agent
                    toolSchemas: getGlobalTools(),
                    abortSignal: ctx.abortSignal,
                    modelWindow: ctx.modelWindow,
                    depth: ctx.depth + 1,
                    keepRecentUnits: ctx.keepRecentUnits,
                    compactRatio: ctx.compactRatio,
                    parentSystemPrompt: parentSystemPrompt,
                    events: ctx.events,
                };

                for await (const e of runAgent(subMessages, subOptions)) {
                    if (e.type === 'final') subResult = e.text;
                }
                return [
                    `子 agent 执行结果：\n${subResult}`,
                    `\n\n⚠️ [系统重要提示]：子 agent 刚才可能已经修改了本地代码...请务必重新读取文件。`
                ].join("");
            },
        },
    },
];
