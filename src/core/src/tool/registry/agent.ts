/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 16:15:31
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-20 15:36:12
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\agent.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { runAgent } from "@/agent/runAgent.ts";
import { buildContextMessages } from "@/session/content.ts";
import { appendMessage } from "@/session/transcript.ts";
import { createUUID } from "@/common/index.ts";
import { RunAgentOptions } from "@/agent/type.ts";
import { CustomTool, MAX_AGENT_DEPTH, ToolContext, ToolSafetyLevel } from "../type.ts";

/**
 * @file tool/registry/agent.ts
 * @description 子 Agent 协同工具集：提供 spawn_agent，让主 agent 把独立子任务委派给子 agent 执行。
 */

/**
 * 子 agent 工具收权黑名单：嵌套深度 ≥ 1 的子 agent 不再拥有 shell 执行（run_command）
 * 与递归删除（delete_path）能力——这两者是爆炸半径最大的高危原语。
 * 保留 read/edit/write（委派代码工作合理）；MUTATION/DANGER 仍各自走审批网关作为真正后盾。
 */
const SUBAGENT_DENYLIST = new Set(["run_command", "delete_path"]);

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
            description: "创建一个拥有独立执行环境的子 agent 处理隔离的特定子任务。子任务完成后会自动将改动点及结论汇总返回。",
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "交给子 agent 的具体微观任务描述（如 '编写 Button 组件的单元测试'）" },
                    role: { type: "string", description: "子 agent 的角色/专长（可选，如 '测试专家'、'重构先锋'）" },
                },
                required: ["task"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { task: string; role?: string }, ctx?: ToolContext): Promise<string> { // 💡 优化 1：强制约束返回值类型
                if (!ctx) return "❌ [派生失败]：spawn_agent 缺少必须的智能体运行上下文。";
                
                if (ctx.depth >= MAX_AGENT_DEPTH) {
                    return `❌ [安全熔断]：已达到最大 Agent 嵌套深度（${MAX_AGENT_DEPTH}层）。禁止继续无限向下嵌套，请父层级 Agent 自行消化当前任务。`;
                }

                const { task, role } = args;
                const subSessionId = `${ctx.sessionId}__sub__${createUUID()}`;
                
                // 💡 优化 2：【精炼提示词防线】对子系统词进行强力结构化剪裁，赋予其极其高亮的“子任务执行者”认知，防上下文轰炸
                const rolePrefix = role ? `【你的专属角色】: ${role}` : "【你的专属角色】: 专注执行特定局部子任务的独立智能体助手";
                const parentSystemPrompt = ctx.parentSystemPrompt || '';

                const subSystem = [
                    `# 任务上下文`,
                    rolePrefix,
                    `当前所处的任务执行嵌套深度: Depth ${ctx.depth + 1} / ${MAX_AGENT_DEPTH}`,
                    `你的父级任务大纲参考: ${task.slice(0, 150)}...`,
                    `\n# 【核心重构铁律】`,
                    `你直接共享并操作本地文件系统。当你对文件全量写入或局部修改时，必须确保操作的绝对精准。完成指定子任务后，请使用最终的文本总结向父级 Agent 交付结果。`,
                    `\n# 【继承的全局代码规范】`,
                    parentSystemPrompt
                ].join("\n");

                console.log(`🐣 派生子 Agent [深度: ${ctx.depth + 1}/${MAX_AGENT_DEPTH}] 任务: "${task.slice(0, 50)}..."`);
                
                try {
                    // 构建并初始化子智能体的独立消息队列
                    const subMessages = await buildContextMessages(subSessionId, { role: "user", content: task }, subSystem);
                    await appendMessage({ sessionId: subSessionId, role: 'user', content: task });

                    let subResult = "";
                    let hasFinalResult = false;

                    const subOptions: RunAgentOptions = {
                        sessionId: subSessionId,
                        // ★ 子 agent 收权：任何经 spawn_agent 派生的子 agent（深度 ≥ 1）一律剔除
                        //   run_command / delete_path（SUBAGENT_DENYLIST），仅保留读写类工具，收敛递归派生的爆炸半径。
                        //   主 agent（depth 0）不经此处，仍保留全部工具。
                        //   （旧实现按 ctx.depth>=1 判定，实为父级深度，导致 depth=1 的常用子层漏网——此处按"被创建子 agent"语义修正。）
                        toolSchemas: getGlobalTools().filter((t: any) => !SUBAGENT_DENYLIST.has(t.function.name)),
                        abortSignal: ctx.abortSignal,
                        modelWindow: ctx.modelWindow,
                        depth: ctx.depth + 1,
                        keepRecentUnits: ctx.keepRecentUnits,
                        compactRatio: ctx.compactRatio,
                        parentSystemPrompt: parentSystemPrompt,
                        events: ctx.events,
                        onUIEvent: ctx.onUIEvent, // ★ 必须透传：否则子 agent 调用需审批工具时前端收不到弹窗，waitForUserApproval 永久挂起（死锁）
                        requestApproval: ctx.requestApproval, // ★ 同步透传宿主审批钩子，子 agent 高危工具仍走同一审批通道
                    };

                    // 💡 优化 3：【健壮性防线】对异步生存流进行全方位的异常与熔断监控
                    try {
                        for await (const e of runAgent(subMessages, subOptions)) {
                            if (ctx.abortSignal?.aborted) {
                                return `❌ [子Agent中断]：执行已被用户主动发起的 AbortSignal 强行熔断。`;
                            }
                            if (e.type === 'final') {
                                subResult = e.text;
                                hasFinalResult = true;
                            }
                        }
                    } catch (streamError: any) {
                        return `❌ [子Agent崩溃]：子 Agent 在迭代推理主循环时遭遇底层异常: ${streamError.message}`;
                    }

                    // 💡 优化 4：如果生成器异常结束未返回 final 文本，抓取最新的会话作为兜底摘要
                    if (!hasFinalResult || !subResult.trim()) {
                        subResult = `（未能获取到结构化 final 回报。请检查该子 Session [${subSessionId}] 的执行历史）`;
                    }

                    // 💡 优化 5：【状态同步防护】在向父 Agent 返回结果时，注入高亮醒目的硬性契约提示
                    // 强迫父 Agent 在拿到报告的第一时间，如果需要继续操作文件，必须先调用 read_file 刷新其对代码的“视网膜缓存”
                    return [
                        `🎉 [子 Agent 执行完毕] 派生子任务汇报如下：\n`,
                        `==================================================\n`,
                        subResult,
                        `\n==================================================\n`,
                        `🚨【重要同步通知】: 该子 Agent 刚才极有可能已经高频修改、创建或删除了你管辖区内的本地源码文件。`,
                        `如果你（父级Agent）接下来需要对文件系统继续实施 edit_file、write_file 或验证，【你必须】首先调用 read_file 或 list_dir 重新读取最新磁盘状态，禁止盲目依赖你之前的记忆缓存，否则必然会引发唯一性冲突匹配失败！`
                    ].join("");

                } catch (error: any) {
                    return `❌ [派生执行失败]: ${error.message}`;
                }
            },
        },
    },
];

