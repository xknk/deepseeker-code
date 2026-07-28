/**
 * @file hooks/registry.ts
 * @description Hooks 通用注册/分发中心：维护全局规则表，按事件类型分发，统一容错。
 *
 *  容错原则（沿用旧 tool/hooks.ts，核心铁律——hook 失败不得击垮主流程）：
 *   - 可拦截事件（PreToolUse/UserPromptSubmit）handler 抛错按【放行】处理（防有缺陷的 hook 误拦阻断 agent）；
 *   - 观察事件 handler 抛错静默吞掉（仅告警）。
 *
 *  对外兼容：runPreHooks/runPostHooks 保持旧签名，使 runAgent 现有调用零改动；
 *  tool/hooks.ts 降级为对本模块的薄转发。
 */
import { ToolContext } from "@/tool/type.ts";
import {
    EventType,
    HookRule,
    HookMatcher,
    HookResult,
    INTERCEPTABLE_EVENTS,
    TOOL_EVENTS,
} from "./types.ts";

/** 全局规则表（程序化注册 + 声明式配置共同写入） */
const rules: HookRule[] = [];

/** 匹配判定（沿用旧 tool/hooks.ts 语义）：string 支持精确名与通配 '*' */
export const matches = (matcher: HookMatcher, toolName: string): boolean => {
    if (typeof matcher === 'string') return matcher === '*' || matcher === toolName;
    if (matcher instanceof RegExp) return matcher.test(toolName);
    try { return matcher(toolName); } catch { return false; }
};

/** 注册单条规则 */
export const registerHook = (rule: HookRule): void => {
    rules.push(rule);
};

/** 批量注册 */
export const registerHooks = (rs: HookRule[]): void => {
    for (const r of rs) rules.push(r);
};

/** 清空全部规则（测试 / 热重载用） */
export const clearHooks = (): void => {
    rules.length = 0;
};

/**
 * 按事件分发：依次执行所有匹配的 handler。
 * @returns 首个返回 deny 的可拦截 handler 即拦截；否则放行。
 *  - matcher 仅对 Pre/PostToolUse 生效（按 ctx.toolName 过滤）。
 *  - handler 抛错：可拦截事件按放行、观察事件静默吞掉。
 */
export const dispatch = async (event: EventType, ctx: any): Promise<{ deny: boolean; reason?: string }> => {
    const interceptable = INTERCEPTABLE_EVENTS.has(event);
    const isToolEvent = TOOL_EVENTS.has(event);
    for (const rule of rules) {
        if (rule.event !== event) continue;
        // 工具事件按 matcher 过滤
        if (isToolEvent && rule.matcher !== undefined) {
            const tn = ctx?.toolName;
            if (typeof tn !== 'string' || !matches(rule.matcher, tn)) continue;
        }
        try {
            const res: HookResult = await rule.run(ctx);
            if (interceptable && res && res.deny) {
                return { deny: true, reason: res.reason };
            }
        } catch (e: any) {
            const msg = e?.message ?? e;
            if (interceptable) {
                // 可拦截事件抛错按放行处理（防误拦阻断 agent）
                console.warn(`⚠️ [hook:${event}] 执行异常，按放行处理: ${msg}`);
            } else {
                console.warn(`⚠️ [hook:${event}] 执行异常，已忽略: ${msg}`);
            }
        }
    }
    return { deny: false };
};

// ============ 兼容门面：保持 runAgent 现有调用签名不变 ============

/**
 * 执行 PreToolUse hook（审批通过后、execute 前）。
 * @returns 首个 deny 即拦截。签名与旧 tool/hooks.ts 一致，runAgent 现有调用零改动。
 */
export const runPreHooks = async (
    toolName: string,
    args: any,
    ctx: ToolContext,
): Promise<{ deny: boolean; reason?: string }> => {
    return dispatch('PreToolUse', {
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        env: ctx.env,
        toolName,
        args,
        toolContext: ctx,
    });
};

/** PostToolUse 透传给 hook 的 result 截断上限（保护声明式 hook 的 stdin/上下文；模型侧完整结果不受影响） */
const HOOK_RESULT_MAX = 8192;
const truncateForHook = (s: string): string =>
    s.length <= HOOK_RESULT_MAX ? s : s.slice(0, HOOK_RESULT_MAX) + `\n…[hook 视图截断，共 ${s.length} 字符]`;

/**
 * 执行 PostToolUse hook（execute 后，仅观察）。签名与旧 tool/hooks.ts 一致，runAgent 现有调用零改动。
 * result 在此截断后再分发——hook 仅作观察，无需完整大输出（模型侧的完整工具结果不受影响）。
 */
export const runPostHooks = async (
    toolName: string,
    args: any,
    result: string,
    ctx: ToolContext,
): Promise<void> => {
    await dispatch('PostToolUse', {
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        env: ctx.env,
        toolName,
        args,
        result: truncateForHook(result),
        toolContext: ctx,
    });
};
