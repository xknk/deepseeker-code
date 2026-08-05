/**
 * @file hooks/types.ts
 * @description Hooks 系统的类型定义：生命周期事件枚举、各类事件上下文、规则与返回值。
 *
 *  设计要点：
 *  - 8 类事件覆盖 agent 全生命周期：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SessionEnd
 *    + SubagentStart / SubagentStop（P1-8 子 agent 生命周期，spawn_agent / run_workflow 派生时触发）。
 *  - 仅 PreToolUse / UserPromptSubmit 可拦截（deny）；其余（含 SubagentStart/Stop）为观察型。
 *  - matcher（工具名匹配）仅 Pre/PostToolUse 消费，沿用旧 tool/hooks.ts 语义（精确串 / '*' / RegExp / 谓词）。
 *  - 与 @/tool/type.ts 的 ToolContext 解耦：工具事件额外携带 toolContext 供 handler 访问完整运行时。
 */
import { ToolContext } from "@/tool/type.ts";

/** 生命周期事件类型 */
export type EventType =
    | 'SessionStart'        // 会话启动（取到 sessionId 后，紧邻 session.start trace）
    | 'UserPromptSubmit'    // 用户原始输入进入、未进 agent 前（serve 层；可拦截整轮）
    | 'PreToolUse'          // 工具审批通过后、execute 前（可拦截）
    | 'PostToolUse'         // 工具 execute 后（含异常；仅观察）
    | 'Stop'                // agent 主循环退出（正常/中止/熔断/错误；仅观察）
    | 'SessionEnd'          // 请求结束、SSE 关闭前（紧邻 session.end trace；仅观察）
    | 'SubagentStart'       // P1-8 子 agent 实际启动（spawn_agent / run_workflow 派生后；仅观察）
    | 'SubagentStop';       // P1-8 子 agent 收尾（正常/中止/崩溃；仅观察，含 ok/产出）

/** 各事件上下文共享的基座 */
export interface BaseHookCtx {
    sessionId: string;
    /** hook 命令执行的工作目录（shellExecutor 用） */
    cwd?: string;
    /** 额外环境变量（shellExecutor 会与白名单合并） */
    env?: Record<string, string>;
}

export interface SessionStartCtx extends BaseHookCtx { }

export interface UserPromptSubmitCtx extends BaseHookCtx {
    /** 用户原始输入文本 */
    prompt: string;
}

export interface PreToolUseCtx extends BaseHookCtx {
    toolName: string;
    args: any;
    /** 完整工具运行时上下文（含 abortSignal / requestApproval 等） */
    toolContext: ToolContext;
}

export interface PostToolUseCtx extends BaseHookCtx {
    toolName: string;
    args: any;
    /** 工具执行结果字符串（已截断） */
    result: string;
    toolContext: ToolContext;
}

/** Stop 退出原因 */
export type StopReason = 'normal' | 'aborted' | 'error' | 'repeat';

export interface StopCtx extends BaseHookCtx {
    /** 最后一轮模型产出的文本 */
    lastText: string;
    reason: StopReason;
}

export interface SessionEndCtx extends BaseHookCtx { }

// —— P1-8 子 agent 生命周期（观察事件；不可拦截）——
export interface SubagentStartCtx extends BaseHookCtx {
    /** 父会话 id（派生该子 agent 的主/父会话）。 */
    parentSessionId: string;
    /** 交给子 agent 的任务。 */
    task: string;
    /** 嵌套深度（主 agent=0，子 agent=1+）。 */
    depth: number;
    /** 命中的声明式子 Agent 名（未用声明式则 undefined）。 */
    name?: string;
}

export interface SubagentStopCtx extends BaseHookCtx {
    parentSessionId: string;
    task: string;
    depth: number;
    name?: string;
    /** 是否成功拿到 final 文本（中止/崩溃/异常均为 false）。 */
    ok: boolean;
    /** 子 agent 最终产出（已截断，仅观察/记录用）。 */
    output: string;
}

/** 可拦截事件返回 deny 即阻断；观察事件忽略 deny。 */
export type HookResult = void | { deny: boolean; reason?: string };

/**
 * 工具名匹配器（沿用旧 tool/hooks.ts 语义）：
 *  - string：精确名或通配 '*'
 *  - RegExp：正则匹配
 *  - 谓词：(toolName) => boolean
 * 仅 PreToolUse / PostToolUse 消费。
 */
export type HookMatcher = string | RegExp | ((toolName: string) => boolean);

/** hook 处理器。ctx 类型按事件不同（注册时可窄化，分发时按 event 传入对应 ctx）。 */
export type HookHandler<C = any> = (ctx: C) => HookResult | Promise<HookResult>;

/** 一条 hook 规则 */
export interface HookRule {
    event: EventType;
    /** 仅 Pre/PostToolUse 生效；其余事件出现 matcher 将被忽略并告警 */
    matcher?: HookMatcher;
    run: HookHandler;
    /** 来源：内置程序化注册 / 声明式配置文件 */
    source: 'builtin' | 'config';
    /**
     * 可拦截事件下 handler 抛错（hook 自身崩溃，区别于 denyOnNonZero 的"正常退出非零"）时的处置：
     *  - 'allow'（默认）：放行，防有缺陷的 hook 误拦阻断 agent；
     *  - 'deny'：fail-closed，安全类 hook（高危命令检测等）显式声明，自身异常即拒绝。
     */
    onError?: 'deny' | 'allow';
}

/** 可拦截事件集合（deny 语义仅对这些事件生效） */
export const INTERCEPTABLE_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['PreToolUse', 'UserPromptSubmit']);

/** 工具事件集合（matcher 仅对这些事件消费） */
export const TOOL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(['PreToolUse', 'PostToolUse']);

/** 全部合法事件（供 loader 校验用） */
export const ALL_EVENTS: EventType[] = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop'];

/**
 * 各生命周期事件的【默认超时】梯度（ms）：编译期由 loader.compileRule 在用户未显式配置 timeoutMs 时采用。
 *
 * 分档依据——事件对用户感知延迟的敏感度：
 *  - 快档（10s）：SessionStart / UserPromptSubmit —— 阻塞请求启动与首字节，必须快；
 *  - 中档（30s）：PreToolUse / PostToolUse / Stop —— 单工具级检查（lint/format/安全扫描）、退出通知；
 *  - 慢档（60s）：SessionEnd —— 请求结束后的后台清理/上报，用户已在等响应收尾，最宽容。
 *
 * 用户在 settings.json 显式配置的 timeoutMs 优先于此默认；最终仍受 shellExecutor 的 HARD_TIMEOUT_CAP_MS 绝对上限约束。
 */
export const DEFAULT_TIMEOUT_BY_EVENT: Readonly<Record<EventType, number>> = {
    SessionStart: 10_000,
    UserPromptSubmit: 10_000,
    PreToolUse: 30_000,
    PostToolUse: 30_000,
    Stop: 30_000,
    SessionEnd: 60_000,
    SubagentStart: 10_000,
    SubagentStop: 30_000,
};
