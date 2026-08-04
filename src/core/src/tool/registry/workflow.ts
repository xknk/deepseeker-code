/**
 * @file tool/registry/workflow.ts
 * @description P0-3 多 subagent 并行编排工具集：提供 run_workflow，把「大规模审查 / 迁移分析 / 多角度调研」
 *  这类可分解任务一次性扇出给多个独立子 agent 并发执行（parallel），或串成数据流水线逐级精炼（pipeline），
 *  突破 spawn_agent 只能串行委派的能力上限（对标分析 G6）。
 *
 *  两种原语：
 *  - parallel（默认）：N 个步骤各自独立子 agent，受并发上限节流并发执行，结果按原序聚合（屏障语义）。
 *      适用：互相独立的只读/分析任务（审查 N 个模块、对 N 个方案各派一个调研 agent）。
 *  - pipeline：步骤串行，阶段 N 的任务自动拼入阶段 N-1 的产出，逐级精炼，返回各阶段结果 + 最终产出。
 *      适用：分阶段加工（先抽取 → 再归类 → 再总结；先分析 → 再生成修复方案）。
 *
 *  复用 agent/subagent.ts 的 runSubagent 内核（与 spawn_agent 同源：深度熔断 / manifest / 工具收权 / 审批透传），
 *  故叶子工具的安全（SAFE 免审、MUTATION/DANGER 审批）仍由各子 agent 内部 runAgent 执行层强制。
 *
 *  关键工程护城河：
 *  - 并发节流（createSemaphore）：防模型一次性派生十几个子 agent 打爆 API 速率 / 计费；
 *  - 审批串行化（approvalMutex）：并行子 agent 共享一把互斥锁包裹 requestApproval，确保同一时刻只有一个
 *    审批弹窗（CLI 单弹窗模型），并发高危请求排队而非竞态；
 *  - 单步结果截断 + 整体 maxOutputCharacters：防单个巨型结果挤占聚合输出 / 撑爆上下文；
 *  - abort 响应：每步派生前检测 abortSignal；中止时已派生步骤各自经 runSubagent 内部中止通道收尾。
 */
import { CustomTool, MAX_AGENT_DEPTH, ToolContext, ToolSafetyLevel } from "../type.ts";
import { runSubagent, SubagentResult } from "@/agent/subagent.ts";
import { createSemaphore } from "@/common/index.ts";
import { truncateToolResult } from "@/agent/truncate.ts";
import { appConfig } from "@/config/index.ts";
import type { RequestApprovalFn } from "@/host/type.ts";
// 纯逻辑层（校验 / 标签 / 流水线拼接 / 聚合）独立成模块：零 agent 依赖，不进 tool/index 循环，可被单测直接 import。
import {
    validateWorkflowArgs,
    stepLabel,
    buildPipelineTask,
    formatWorkflowResult,
    type WorkflowStep,
    type StepOutcome,
} from "./workflowHelpers.ts";

// 透传纯逻辑层的导出，便于上层 / 单测从 workflow.ts 统一入口取用。
export { validateWorkflowArgs, stepLabel, buildPipelineTask, formatWorkflowResult };
export type { WorkflowStep, StepOutcome };

/**
 * 创建「多 subagent 并行编排」工具集（当前仅 run_workflow）。
 * 与 createAgentTools 同源：通过 getGlobalTools 闭包在运行时拿完整工具表，规避定义期循环依赖。
 */
export const createWorkflowTools = (getGlobalTools: () => CustomTool[]): CustomTool[] => [
    {
        type: "function",
        function: {
            name: "run_workflow",
            description: [
                "多子 agent 并行编排（P0-3）：把一个可分解的大任务一次性派给多个独立子 agent 并发执行，或串成数据流水线逐级精炼。突破 spawn_agent 只能串行单派生的上限，适用于大规模代码审查、迁移分析、多方案并行调研等。",
                "两种模式：",
                "• parallel（默认）：各步骤互不依赖、并发执行，结果按序聚合。适合互相独立的只读/分析任务（如审查 5 个模块、对 3 个技术方案各派一个调研 agent）。强烈建议 parallel 用于读/分析类任务（并行改同一批文件易冲突）。",
                "• pipeline：步骤串行，阶段 N 自动接收阶段 N-1 的产出作为输入上下文，逐级精炼。适合分阶段加工（如：阶段1 抽取要点 → 阶段2 归类 → 阶段3 汇总结论）。",
                "每个步骤可指定 name 套用声明式子 Agent（见【可用子 Agent 目录】）、role 补充角色、key 作为结果标签。",
                "与 spawn_agent 的关系：spawn_agent = 串行派生单个；run_workflow = 并行/流水线编排多个。任务可分解、彼此独立或呈流水线时用本工具，否则用 spawn_agent。",
            ].join("\n"),
            parameters: {
                type: "object",
                properties: {
                    mode: {
                        type: "string",
                        enum: ["parallel", "pipeline"],
                        description: "编排模式：parallel=并发扇出（默认，互不依赖的任务）；pipeline=串行流水线（阶段间有数据依赖，逐级精炼）。",
                    },
                    steps: {
                        type: "array",
                        description: "编排步骤列表（parallel：每个是一个独立子 agent 任务；pipeline：按顺序为各阶段，前阶段产出自动作为后阶段输入）。",
                        items: {
                            type: "object",
                            properties: {
                                task: { type: "string", description: "交给该子 agent 的具体任务描述（parallel 必须自包含、不依赖其它步骤；pipeline 只写本阶段职责，前阶段产出会自动拼入）" },
                                name: { type: "string", description: "声明式子 Agent 名称（可选，套用其专长系统词/工具白名单/model）" },
                                role: { type: "string", description: "角色/专长补充（可选）" },
                                key: { type: "string", description: "结果标签（可选，默认用任务首句；parallel 结果按此标识各子 agent 产出）" },
                            },
                            required: ["task"],
                        },
                        minItems: 1,
                    },
                    concurrency: {
                        type: "number",
                        description: "parallel 模式最大并发子 agent 数（可选，默认 4，上限受全局配置约束）。任务彼此独立时调大可加速；为 1 则退化为串行。",
                    },
                },
                required: ["steps"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            // 聚合输出整体兜底截断（各子 agent 结果已按 workflowPerStepChars 单独截断）。
            maxOutputCharacters: 18000,
            async execute(args: any, ctx?: ToolContext): Promise<string> {
                if (!ctx) return "❌ [工作流]：run_workflow 缺少必须的智能体运行上下文。";

                const maxSteps = appConfig.workflowMaxSteps;
                const validationError = validateWorkflowArgs(args, maxSteps);
                if (validationError) return validationError;

                // mode 归一化：非 "pipeline" 一律按 parallel（默认）
                const mode: "parallel" | "pipeline" = args.mode === "pipeline" ? "pipeline" : "parallel";
                const steps = (args.steps as WorkflowStep[]).map(s => ({
                    task: String(s.task),
                    name: s.name ? String(s.name) : undefined,
                    role: s.role ? String(s.role) : undefined,
                    key: s.key ? String(s.key) : undefined,
                }));

                // ★ 深度预检：当前 agent 已达 MAX_AGENT_DEPTH → 任何子 agent 都派不出去，一次性清晰报错
                if (ctx.depth >= MAX_AGENT_DEPTH) {
                    return `❌ [安全熔断]：已达到最大 Agent 嵌套深度（${MAX_AGENT_DEPTH}层），无法派生工作流子 agent。请在本层级自行消化任务。`;
                }

                // ★ 并发子 agent 共享审批互斥锁：包裹 requestApproval，确保并行高危请求排队审批（CLI 单弹窗），
                //   而非并发竞态。pipeline 模式天然串行无竞态，包裹亦无副作用（无争用）。
                const approvalMutex = createSemaphore(1);
                const serializedApproval: RequestApprovalFn | undefined = ctx.requestApproval
                    ? async (...raArgs: Parameters<RequestApprovalFn>) => {
                        await approvalMutex.acquire();
                        try { return await ctx.requestApproval!(...raArgs); }
                        finally { approvalMutex.release(); }
                    }
                    : undefined;

                // 并发上限：模型可调小（含 1=串行），但不超全局上限；非 parallel 模式忽略（pipeline 串行）
                const globalMax = appConfig.workflowConcurrency;
                let concurrency = Number(args.concurrency);
                if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = globalMax;
                concurrency = Math.min(concurrency, globalMax);

                const perStep = appConfig.workflowPerStepChars;
                const total = steps.length;
                let done = 0;
                /** 派生单步并归一化为 StepOutcome（截断 + 标签 + 进度）。 */
                const runStep = async (step: WorkflowStep, index: number, subCtx: ToolContext): Promise<StepOutcome> => {
                    const res: SubagentResult = await runSubagent(step, subCtx, getGlobalTools);
                    const outcome: StepOutcome = {
                        ok: res.ok,
                        output: truncateToolResult(res.output, perStep),
                        label: stepLabel(step, index),
                    };
                    done++;
                    ctx.emitProgress?.(`${mode === "pipeline" ? "流水线" : "并行"}编排：${done}/${total} 完成（${outcome.label}）`);
                    return outcome;
                };

                let outcomes: StepOutcome[];
                try {
                    if (mode === "pipeline") {
                        // ★ 流水线：串行，阶段 N 任务拼入阶段 N-1 产出
                        outcomes = [];
                        let prior: StepOutcome | null = null;
                        for (let i = 0; i < steps.length; i++) {
                            if (ctx.abortSignal?.aborted) {
                                outcomes.push({ ok: false, output: "（已中止，未执行）", label: stepLabel(steps[i], i) });
                                break;
                            }
                            const step = steps[i];
                            const fullTask = prior ? buildPipelineTask(step, prior) : step.task;
                            const subCtx: ToolContext = { ...ctx, requestApproval: serializedApproval ?? ctx.requestApproval };
                            prior = await runStep({ ...step, task: fullTask }, i, subCtx);
                            outcomes.push(prior);
                        }
                    } else {
                        // ★ 并行：受信号量节流并发，结果按原序（map 保序）聚合；单步失败不阻断其余（屏障语义）
                        const sem = createSemaphore(concurrency);
                        const subCtx: ToolContext = { ...ctx, requestApproval: serializedApproval ?? ctx.requestApproval };
                        const running = steps.map(async (step, i) => {
                            await sem.acquire();
                            try {
                                if (ctx.abortSignal?.aborted) {
                                    return { ok: false, output: "（已中止，未执行）", label: stepLabel(step, i) } as StepOutcome;
                                }
                                return await runStep(step, i, subCtx);
                            } finally {
                                sem.release();
                            }
                        });
                        // 派生前再次校验中止（信号量等待期间可能已被用户中断）
                        if (ctx.abortSignal?.aborted) {
                            ctx.emitProgress?.(`并行编排：检测到中止，已派生的子 agent 各自收尾`);
                        }
                        outcomes = await Promise.all(running);
                    }
                } catch (err: any) {
                    return `❌ [工作流编排异常]：${err?.message ?? err}`;
                }

                return formatWorkflowResult(mode, outcomes);
            },
        },
    },
];
