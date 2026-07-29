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
import { MAX_STDIN_FIELD } from "./shellExecutor.ts";

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
 * 按事件分发：
 *  - 可拦截事件（PreToolUse/UserPromptSubmit）：串行 + 短路（首个 deny 即拦）。handler 抛错按 rule.onError 决策
 *    （默认 'allow' 放行防误拦；安全类 hook 可设 'deny' fail-closed）。
 *  - 观察事件（其余）：Promise.all 并发执行（累积延迟不再线性叠加），单个失败仅告警。
 * matcher 仅对 Pre/PostToolUse 生效（按 ctx.toolName 过滤）。
 */
export const dispatch = async (event: EventType, ctx: any): Promise<{ deny: boolean; reason?: string }> => {
    const interceptable = INTERCEPTABLE_EVENTS.has(event);
    const isToolEvent = TOOL_EVENTS.has(event);
    const matched = rules.filter(rule => {
        if (rule.event !== event) return false;
        if (isToolEvent && rule.matcher !== undefined) {
            const tn = ctx?.toolName;
            if (typeof tn !== 'string' || !matches(rule.matcher, tn)) return false;
        }
        return true;
    });

    // 观察事件：并发执行，单个异常仅告警（不击垮主流程、不相互阻塞）
    if (!interceptable) {
        await Promise.all(matched.map(rule =>
            Promise.resolve(rule.run(ctx)).catch((e: any) => console.warn(`⚠️ [hook:${event}] 执行异常，已忽略: ${e?.message ?? e}`))
        ));
        return { deny: false };
    }

    // 可拦截事件：串行 + 短路；handler 抛错时按 rule.onError 决策
    for (const rule of matched) {
        try {
            const res: HookResult = await rule.run(ctx);
            if (res && res.deny) {
                return { deny: true, reason: res.reason };
            }
        } catch (e: any) {
            const msg = e?.message ?? e;
            if (rule.onError === 'deny') {
                // ★ fail-closed 逃生阀：安全类 hook 自身崩溃即拒绝，避免缺陷 hook 放行高危操作
                console.warn(`⚠️ [hook:${event}] 执行异常，按 onError:'deny' 拒绝（fail-closed）: ${msg}`);
                return { deny: true, reason: `[hook:${event}] 执行异常（fail-closed）: ${msg}` };
            }
            console.warn(`⚠️ [hook:${event}] 执行异常，按放行处理: ${msg}`);
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

/** PostToolUse 透传给 hook 的 result 截断上限。
 *  声明式 hook 经 dispatch→shellExecutor，stdin 每个字段还会被 MAX_STDIN_FIELD 二次约束，
 *  故此处取与之同口径的值——此前独立设 8192，会被传输层 4096 静默覆盖，造成“名义 8K 实际到脚本只有 4K”的误导。
 *  （仅裁 hook 观察视图；模型侧完整工具结果不受影响。） */
const HOOK_RESULT_MAX = MAX_STDIN_FIELD;
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
