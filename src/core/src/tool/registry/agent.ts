/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 16:15:31
 * @LastEditors: fanqianliang
 * @LastEditTime: 2026-07-29 10:00:00
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\agent.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { CustomTool, ToolContext, ToolSafetyLevel } from "../type.ts";
import { runSubagent } from "@/agent/subagent.ts";

/**
 * @file tool/registry/agent.ts
 * @description 子 Agent 协同工具集：提供 spawn_agent，让主 agent 把独立子任务委派给子 agent 执行。
 *  支持声明式子 Agent：spawn_agent 传 name 时，按 .deepSeekCode/agents/<name>.agent.md 声明加载
 *  系统词 / 工具白名单 / model（见 agents/loader.ts）；不传 name 走默认通用模板（向后兼容）。
 *
 *  ★ 派生/执行内核已抽至 agent/subagent.ts 的 runSubagent，本文件仅保留 spawn_agent 的「文案包装」
 *    （🎉 汇报框 + 🚨 同步通知），与 run_workflow（并行/流水线编排）共享同一派生内核，逻辑零分叉。
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
            description: "创建一个拥有独立执行环境的子 agent 处理隔离的特定子任务，子任务完成后自动汇总改动点与结论返回。可通过 name 指定声明式子 Agent（见系统提示词【可用子 Agent 目录】）以套用其专长系统词/工具白名单/model；不传 name 走默认通用子 agent。",
            parameters: {
                type: "object",
                properties: {
                    task: { type: "string", description: "交给子 agent 的具体微观任务描述（如 '编写 Button 组件的单元测试'）" },
                    name: { type: "string", description: "声明式子 Agent 名称（须与系统提示词中【可用子 Agent 目录】一致）。提供时按其声明加载系统词/工具白名单/model；不提供则走默认通用子 agent。" },
                    role: { type: "string", description: "子 agent 的角色/专长（可选，如 '测试专家'、'重构先锋'）。声明式 agent 自带 role 时作补充。" },
                },
                required: ["task"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { task: string; name?: string; role?: string }, ctx?: ToolContext): Promise<string> { // 💡 优化 1：强制约束返回值类型
                if (!ctx) return "❌ [派生失败]：spawn_agent 缺少必须的智能体运行上下文。";

                // ★ 派生内核：深度 / manifest / 子系统词 / 工具收权 / runAgent 驱动 / 异常熔断均在内
                const res = await runSubagent(args, ctx, getGlobalTools);

                // 失败（深度熔断 / manifest 未命中 / 崩溃 / 中止 / 外层异常）：原样透传 ❌ 错误串
                if (!res.ok) return res.output;

                // 💡 成功：【状态同步防护】注入高亮醒目的硬性契约提示
                // 强迫父 Agent 在拿到报告的第一时间，如果需要继续操作文件，必须先调用 read_file 刷新其对代码的"视网膜缓存"
                return [
                    `🎉 [子 Agent 执行完毕] 派生子任务汇报如下：\n`,
                    `==================================================\n`,
                    res.output,
                    `\n==================================================\n`,
                    `🚨【重要同步通知】: 该子 Agent 刚才极有可能已经高频修改、创建或删除了你管辖区内的本地源码文件。`,
                    `如果你（父级Agent）接下来需要对文件系统继续实施 edit_file、write_file 或验证，【你必须】首先调用 read_file 或 list_dir 重新读取最新磁盘状态，禁止盲目依赖你之前的记忆缓存，否则必然会引发唯一性冲突匹配失败！`
                ].join("");
            },
        },
    },
];
