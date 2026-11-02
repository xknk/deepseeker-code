import { toolFailure, asToolFailure, CustomTool, ToolContext, ToolSafetyLevel } from "../type.ts";
import { prepareSubagent, runPreparedSubagent } from "@/agent/subagent.ts";

/**
 * @file tool/registry/agent.ts
 * @description 子 Agent 协同工具集：提供 spawn_agent，让主 agent 把独立子任务委派给子 agent 执行。
 *  支持声明式子 Agent：spawn_agent 传 name 时，按 .deepseeker-code/agents/<name>.agent.md 声明加载
 *  系统词 / 工具白名单 / model（见 agents/loader.ts）；不传 name 走默认通用模板（向后兼容）。
 *
 *  ★ 子代理异步化（方案《子代理异步化与完成唤醒》，路径 B 唤醒式）：isSync:false + async* execute——
 *    首个 yield 立即返回 agent_id（不等待完成），generator 挂起 = 子代理在飞（对齐 run_in_background
 *    挂起语义）；子代理 runAgent 驱动完成后，结构化汇报经 agentWake.notifySubagentDone 推入主会话
 *    inbox（run 在跑 → 轮边界消化；idle → 程序化唤醒续跑）。
 *    ★ 中止语义：完成回调挂在首个 await 之后——宿主中止时执行层 runBackgroundTool 走 gen.return()，
 *      回调被拦在 await 前不执行 → 不产生中止后的唤醒（用户喊停就是停）。
 *  ★ 派生/执行内核已抽至 agent/subagent.ts 的 prepareSubagent / runPreparedSubagent，与 run_workflow
 *    （并行/流水线编排）共享同一派生内核，逻辑零分叉。
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
            description: [
                "异步派生拥有独立执行环境的子 agent 处理隔离子任务：调用立即返回 agent_id，不等待完成；子 agent 在后台执行，完成后其汇报会自动注入本会话并唤醒你继续推进（无需轮询、无需等待）。",
                "派出后你可立即继续派活 / 处理其他事务 / 回复用户；当前无其他事务时可简短告知已委派并结束本轮——汇报送达时你会被自动唤醒。",
                "name 可指定声明式子 Agent（见系统提示词【可用子 Agent 目录】，套用其系统词/工具白名单/model）；缺省走通用模板。",
                "续跑：传 resume_session_id（此前返回的 agent_id）复用该子 Agent 完整历史记忆，适合追问/继续未完任务（同样异步，完成后自动唤醒）。",
            ].join("\n"),
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "子 agent 的具体任务（如 '编写 Button 组件的单元测试'）；续跑时为新指令" },
                    name: { type: "string", description: "声明式子 Agent 名（须与【可用子 Agent 目录】一致）；缺省通用子 agent" },
                    role: { type: "string", description: "角色/专长补充（可选）；声明式 agent 自带 role 时作补充" },
                    resume_session_id: { type: "string", description: "续跑既有子 Agent：传此前返回的 agent_id（恢复其磁盘历史与记忆）。注意子 Agent 状态不随主会话 fork 回滚。缺省新建" },
                },
                required: ["task"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: false,
            async *execute(args: { task: string; name?: string; role?: string; resume_session_id?: string }, ctx?: ToolContext) {
                if (!ctx) { yield toolFailure("[派生失败]：spawn_agent 缺少必须的智能体运行上下文。"); return; }

                // ★ 前置阶段（校验 + 计算，首个 yield 之前）：深度 / manifest / 子系统词 / 工具收权 / 续跑校验。
                //   校验失败当场同步返回（模型立即看到，无子代理在飞，不产生唤醒）。
                const prep = await prepareSubagent(
                    { task: args.task, name: args.name, role: args.role, resumeSessionId: args.resume_session_id },
                    ctx,
                    getGlobalTools,
                );
                if (!prep.ok) {
                    //（#8b：output 为纯文本契约含 ❌ 前缀，asToolFailure 包结构——执行层按 status 判失败，不再嗅探前缀）
                    yield asToolFailure(prep.error);
                    return;
                }
                const agentId = prep.prepared.subSessionId;

                // ★ 首个 yield = 工具结果（立即返回，子代理此后在 generator 挂起期间后台执行）
                yield [
                    `✅ 子代理已异步启动 🆔 ${agentId}${prep.prepared.manifest ? `（声明式=${prep.prepared.manifest.name}）` : ""}`,
                    `任务摘要：${prep.prepared.taskBrief}${args.task.length > 60 ? "…" : ""}`,
                    `它完成后汇报会自动送达本会话并唤醒你继续；期间无需等待——可继续派活 / 处理其他事务，无其他事务时简短告知用户即可收尾本轮。`,
                    `（追问/续跑：spawn_agent 传 resume_session_id="${agentId}"，其历史记忆完整保留。）`,
                ].join("\n");

                // ★ 运行阶段：驱动子 agent runAgent 至终态（挂起在后台；此处 await 的恢复可能晚于主 run 结束）。
                //   notifyDone=true：完成回调在 runPreparedSubagent 内部、在飞释放**之前**触发（§4.2）——
                //   notify→pump 同步占 busy，quiescence 判据因此闭合（batch 验收不与唤醒 run 赛跑）；
                //   宿主中止时执行层 gen.return() 拦在本 await 前 → 回调不执行（aborted 同样不回调），无中止后唤醒。
                await runPreparedSubagent(prep.prepared, ctx, { notifyDone: true });
            },
        },
    },
];
