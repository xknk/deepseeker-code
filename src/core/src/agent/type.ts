/**
 * @file agent/type.ts
 * @description Agent 运行模块的类型定义集合。
 *  包含三部分核心类型：
 *  1) RunAgentEvents —— 可观测性埋点回调（推理/工具/压缩各阶段回传数据，用于落盘）；
 *  2) RunAgentOptions / ensureOptions —— runAgent 主循环与上下文压缩的入参；
 *  3) AgentEvent —— runAgent 通过 AsyncGenerator 向外 yield 的结构化流程事件，供前端驱动 UI。
 *  注意：events(埋点) 与 AgentEvent(流程事件) 职责不同，前者给观测层，后者给 UI/上层。
 */
import { TraceBase, UIEvent } from "@/observability/type.ts";
import { Msg } from "@/session/contextCore.ts";
import { RequestApprovalFn } from "@/host/type.ts";

/**
 * 可观测性事件回调：runAgent 在推理、工具、压缩等各阶段，
 * 把埋点数据（token 用量、耗时、成败等）回传给调用方。调用方通常转发给
 * trace/observability 模块落盘，与面向用户的 AgentEvent 解耦。
 */
export type RunAgentEvents = (base: TraceBase) => Promise<void>

/**
 * runAgent 主循环的运行配置。
 *
 * 设计要点：
 * - toolSchemas 必传，runAgent 不再内置默认工具列表，避免与 tool/index.ts 产生循环依赖；
 * - events(埋点) 与 onUIEvent(面向前端 UI，如审批请求) 分离，职责不同；
 * - depth 表示 agent 嵌套深度，主 agent 为 0，spawn_agent 创建的子 agent 递增。
 */
export interface RunAgentOptions {
    /** 工具 schema 列表（必传）。不在 runAgent 内置默认，避免与 tool/index.ts 循环依赖。 */
    toolSchemas?: any[];
    /** 主动中止信号，前端可触发以停止当前推理 / 工具执行。 */
    abortSignal?: AbortSignal;
    /** （已废弃）文本增量回调，现由 AgentEvent.text.delta 承载，保留以兼容旧调用方。 */
    onAssistantTextDelta?: (delta: string) => void;
    /** 本次会话唯一 ID，用于持久化、埋点与会话隔离。 */
    sessionId: string;
    /** 当前 agent 实例 ID。 */
    agentId?: string;
    /** 可观测性事件回调，见 {@link RunAgentEvents}。 */
    events: RunAgentEvents;
    /** 面向前端的 UI 交互事件通道（审批请求等），与 events(trace) 解耦。 */
    onUIEvent?: (evt: UIEvent) => void;
    /** 宿主审批钩子（前端无关，见 host/type.ts）：决定 MUTATION/DANGER 工具是否放行。未注入时默认拒绝。
     *  Web 注入 HTTP/SSE 审批；CLI/VSCode（预留）注入终端/IDE 交互。 */
    requestApproval?: RequestApprovalFn;
    /** 模型上下文窗口大小（token），超出 modelWindow * compactRatio 时触发压缩。 */
    modelWindow: number;
    /** agent 嵌套深度，主 agent 为 0，spawn_agent 子 agent 递增。 */
    depth?: number;
    /** 压缩时保留的最近消息条数（按“对话单元”计，见 splitUntils）。 */
    keepRecentUnits: number,
    /** 触发压缩的阈值比例：上下文 token 超过 modelWindow * compactRatio 时开始压缩。 */
    compactRatio: number,
    /** 父级系统提示词，spawn_agent 时透传给子 agent，保持一致的人设 / 约束。 */
    parentSystemPrompt: string,
    /** 已归档（被压缩）的消息条数，用于统计与展示。 */
    archivedMessageCount?: number,
    /** 计划模式：仅允许只读/研究类工具 + exit_plan_mode，先调研产出方案、经用户审批后再实现（见 agent/planMode.ts）。 */
    planMode?: boolean,
}

/**
 * ensureFitsWindow（上下文窗口压缩）所需参数。
 */
export interface ensureOptions  {
    /** 会话 ID。 */
    sessionId: string,
    /** 待压缩的全量上下文消息数组（原地修改）。 */
    messageArr: Msg[],
    /** 触发压缩的阈值比例（见 RunAgentOptions.compactRatio）。 */
    compactRatio: number,
    /** 压缩时保留的最近条数。 */
    keepRecentUnits: number,
    /** 模型上下文窗口大小（token）。 */
    modelWindow: number,
    /** 可观测性事件回调。 */
    events: RunAgentEvents,
    /** agent 嵌套深度。 */
    depth: number,
    /** 主动中止信号。 */
    signal?: AbortSignal
}

/**
 * runAgent 通过 AsyncGenerator 向外 yield 的阶段事件，供前端 / 上层驱动 UI 与流程。
 * 与 events(埋点) 不同：这是面向“流程消费”的结构化事件流。
 */
export type AgentEvent =
    /** 一轮推理开始（round 从 1 递增）。 */
    | { type: 'round.start'; round: number }
    /** 流式正式回复文本增量（替代 onAssistantTextDelta）。 */
    | { type: 'text.delta'; text: string }
    /** 流式思考过程增量（DeepSeek reasoning_content，前端可折叠展示）。 */
    | { type: 'thinking.delta'; text: string }
    /** 单个工具调用开始（解析出名称与参数后）。 */
    | { type: 'tool.start'; toolCallId: string; toolName: string; args: any }
    /** 单个工具调用结束，携带结果与成败标记。 */
    | { type: 'tool.end'; toolCallId: string; toolName: string; result: string; ok: boolean }
    /** 计划模式：模型调用 exit_plan_mode 提交实现方案（供上层呈现给用户审批，审批通过后退出计划模式进入实现）。 */
    | { type: 'plan.proposed'; plan: string }
    /** 整个 agent 运行结束的最终文本（正常结束 / 中止 / 出错）。 */
    | { type: 'final'; text: string };
