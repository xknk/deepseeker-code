/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 17:39:04
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-18 11:15:48
 * @FilePath: \deepSeekCode\src\core\src\tool\index.ts
 * @Description: 工具注册表 + spawn_agent（动态子 agent）
 */
import OpenAI from "openai";
import { runAgent } from "@/agent/runAgent.ts";
import { buildContextMessages } from "@/session/content.ts";
import { appendMessage } from "@/session/transcript.ts";
import { appConfig } from "@/config/index.ts";
import { createUUID } from "@/common/index.ts";
import { RunAgentEvents } from "@/agent/type.ts";

/** 工具执行上下文：runAgent 调用 execute 时传入，让工具能拿到会话信息 */
export interface ToolContext {
    sessionId: string;
    abortSignal?: AbortSignal;
    depth: number;   // agent 嵌套深度，主 agent 为 0
    keepRecentUnits: number,
    compactRatio: number,
    modelWindow: number,
    parentSystemPrompt: string,
    events: RunAgentEvents
}

// 扩展原生定义，允许包含自定义的 execute 函数（第二参数为运行上下文）
type CustomTool = OpenAI.Chat.Completions.ChatCompletionTool & {
    function: {
        execute: (args: any, ctx?: ToolContext) => Promise<any>;
    };
};

/** 最大 agent 嵌套深度（防无限递归） */
const MAX_AGENT_DEPTH = 3;

export const agentTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "getTime",
            description: "返回当前服务器的日期与时间（本地时区）",
            parameters: {
                type: "object",
                properties: {
                    location: { type: "string", description: "城市名称，如 Beijing" },
                },
                required: ["location"],
            },
            async execute() {
                return new Date().toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "medium" });
            },
        },
    },
    {
        type: "function",
        function: {
            name: "spawn_agent",
            description: "创建一个子 agent 处理独立子任务。子 agent 有自己独立的上下文，看不到主对话，完成后只返回结果摘要。仅用于：任务独立成块、需要大量工具调用/文件读取、可并行、探索性任务。简单任务（一两个工具就能完成）不要用，直接自己调用工具。",
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "交给子 agent 的任务描述，要具体且自包含（子 agent 看不到主对话历史）" },
                    role: { type: "string", description: "子 agent 的角色/专长，如'代码审查'、'SQL专家'（可选）" },
                },
                required: ["task"],
            },
            async execute(args: { task: string; role?: string }, ctx?: ToolContext) {
                if (!ctx) return "错误：spawn_agent 缺少运行上下文";
                if (ctx.depth >= MAX_AGENT_DEPTH) {
                    return `错误：已达最大 agent 嵌套深度（${MAX_AGENT_DEPTH}），不能再创建子 agent`;
                }
                const { task, role } = args;
                const subSessionId = `${ctx.sessionId}__sub__${createUUID()}`;
                const rolePrefix = role
                    ? `你是专门负责「${role}」的子 agent。专注完成交给你的任务，你看不到主对话历史，完成后给出简洁的结果摘要。`
                    : `你是子 agent。专注完成交给你的任务，你看不到主对话历史，完成后给出简洁的结果摘要。`;

                console.log(`🐣 创建子 agent（depth=${ctx.depth + 1}, role=${role || '通用'}）: ${task.slice(0, 80)}`);
                // 动态拼接系统提示词，把主agnet的提示词，拼接到子agent上
                const parentSystemPrompt = ctx.parentSystemPrompt || '';

                const subSystem = [
                    rolePrefix,
                    "\n\n# 【你必须严格遵循的全局代码重构规范】",
                    parentSystemPrompt
                ].join("\n");
                // 子 agent 首次运行：构建上下文（transcript 空）+ 落盘 task
                const subMessages = await buildContextMessages(subSessionId, { role: "user", content: task }, subSystem);
                await appendMessage({ sessionId: subSessionId, role: 'user', content: task });

                // 运行子 agent（透传 abortSignal、深度 +1、继承工具集使其也能 spawn）
                const subResult = await runAgent(subMessages, {
                    sessionId: subSessionId,
                    toolSchemas: agentTools,
                    abortSignal: ctx.abortSignal,
                    modelWindow: ctx.modelWindow,
                    depth: ctx.depth + 1,
                    keepRecentUnits: ctx.keepRecentUnits,
                    compactRatio: ctx.compactRatio,
                    parentSystemPrompt: parentSystemPrompt,
                    events: ctx.events,
                });
                return [
                    `子 agent（${role || '通用'}）执行结果：\n${subResult}`,
                    `\n\n⚠️ [系统重要提示]：子 agent 刚才可能已经调用工具直接修改了本地磁盘中的部分源代码文件。`,
                    `主 agent 接下来如果你需要用到与上述任务关联的任何文件内容，【请务必通过相关读取工具重新读取该文件】，以刷新你上下文中的代码快照，切勿盲目信任你历史消息里残留的旧代码片段！`
                ].join("");
            },
        },
    },
];
