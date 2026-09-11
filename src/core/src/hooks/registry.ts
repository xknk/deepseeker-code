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
import { appConfig } from "@/config/index.ts";

/** 全局规则表（程序化注册 + 声明式配置共同写入） */
const rules: HookRule[] = [];

/** 匹配判定（沿用旧 tool/hooks.ts 语义）：string 支持精确名、'*' 全匹配与尾部 '*' 前缀通配。
 *  尾部通配（如 mcp__server__*）与 permissions 规则的通配习惯对齐——dispatcher 模式下 MCP 工具
 *  经 resolveMcpPermissionName 合成名参与 Pre/PostToolUse 匹配，可按 server 维度精准拦截。
 *  工具名不含字面 '*'，尾部通配与精确匹配无歧义。 */
export const matches = (matcher: HookMatcher, toolName: string): boolean => {
    if (typeof matcher === 'string') {
        if (matcher === '*') return true;
        if (matcher.endsWith('*')) return toolName.startsWith(matcher.slice(0, -1));
        return matcher === toolName;
    }
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

/** 声明式规则标记（loader 热重载用）：loadHooks 重载只替换带此标记的规则，程序化注册的规则原样保留。 */
export const DECLARATIVE_RULE = Symbol('dsc.hook.declarative');

/**
 * 声明式规则整体替换（热重载幂等）：先摘除上一轮带 DECLARATIVE_RULE 标记的规则，再挂入新一批。
 *  ★ 修复叠加 bug：原 loadHooks 直接 registerHooks 追加，重复调用（进程内 serve 重启 / /hooks reload）
 *    规则翻倍、同一事件跑两遍。程序化注册（registerHook/registerHooks 直调）不带标记，重载不受影响。
 */
export const replaceDeclarativeHooks = (rs: HookRule[]): void => {
    for (let i = rules.length - 1; i >= 0; i--) {
        if ((rules[i] as any)[DECLARATIVE_RULE]) rules.splice(i, 1);
    }
    for (const r of rs) {
        (r as any)[DECLARATIVE_RULE] = true;
        rules.push(r);
    }
};

/**
 * 列出当前已注册的 hook 规则（供 /hooks 可观测命令展示）。
 * matcher 序列化：string 原样 / RegExp → /source/flags / 函数 → [fn]。
 * 不含 run 句柄（不可序列化）。
 */
export const listHooks = (): { event: string; matcher: string; source: string; onError?: string }[] => {
    const strMatcher = (m: HookMatcher | undefined): string => {
        if (m === undefined) return '*';
        if (typeof m === 'string') return m;
        if (m instanceof RegExp) return `${m.toString()}`;
        return '[fn]';
    };
    return rules.map(r => ({ event: r.event, matcher: strMatcher(r.matcher), source: r.source, onError: r.onError }));
};

/** dispatch 返回：deny/reason（拦截语义）+ contextAdditions（prompt-type hook 注入文本，仅 UserPromptSubmit 消费）
 *  + argsOverride（PreToolUse 改写后的最终 args，瀑布终点值）/ resultOverride（PostToolUse last-wins 改写值）。
 *  开关 DEEP_SEEK_HOOK_REWRITE=0 时两改写字段恒 undefined（单点门禁在此，调用方无需判开关）。 */
export type DispatchResult = { deny: boolean; reason?: string; contextAdditions?: string[]; argsOverride?: any; resultOverride?: string };

/** argsOverride 合法性：普通对象（非数组/null——args 本就是 JSON 对象，替换值同型）。 */
const isPlainObject = (v: any): v is Record<string, any> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 按事件分发：
 *  - 可拦截事件（PreToolUse/UserPromptSubmit）：串行 + 短路（首个 deny 即拦）。handler 抛错按 rule.onError 决策
 *    （默认 'allow' 放行防误拦；安全类 hook 可设 'deny' fail-closed）。
 *  - 观察事件（其余）：Promise.all 并发执行（累积延迟不再线性叠加），单个失败仅告警。
 *  - contextAdditions 全程累积（即便后续 rule deny，已累积的注入仍随返回带出）；仅 UserPromptSubmit 接缝消费。
 * matcher 仅对 Pre/PostToolUse 生效（按 ctx.toolName 过滤）。
 */
export const dispatch = async (event: EventType, ctx: any): Promise<DispatchResult> => {
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

    const pack = (additions: string[]): DispatchResult => ({
        deny: false,
        contextAdditions: additions.length > 0 ? additions : undefined,
    });

    // 观察事件：并发执行，单个异常仅告警（不击垮主流程、不相互阻塞）；顺带收集 contextAdditions（仅 UserPromptSubmit 消费）
    if (!interceptable) {
        const results = await Promise.all(matched.map(rule =>
            // ★ Promise.resolve().then(...) 而非 Promise.resolve(rule.run(ctx))：后者对【同步抛错】的 handler
            //   会在 .catch 挂上前就抛出（参数先求值），逃逸出 catch。延到 then 里执行才能捕获同步异常。
            Promise.resolve().then(() => rule.run(ctx)).catch((e: any) => {
                console.warn(`⚠️ [hook:${event}] 执行异常，已忽略: ${e?.message ?? e}`);
                return undefined as HookResult;
            })
        ));
        const additions: string[] = [];
        // ★ PostToolUse resultOverride 收集：Promise.all 结果数组按 matched（注册）序——并发执行但覆盖
        //   顺序确定（last-wins，非瀑布；观察事件保并发，不为改写串行化）。开关关时恒 undefined。
        let resultOverride: string | undefined;
        for (const r of results) {
            if (r?.contextAdditions) additions.push(...r.contextAdditions);
            if (event === 'PostToolUse' && appConfig.hookRewrite
                && typeof r?.resultOverride === 'string' && r.resultOverride) {
                resultOverride = r.resultOverride;
            }
        }
        return { ...pack(additions), resultOverride };
    }

    // 可拦截事件：串行 + 短路；handler 抛错时按 rule.onError 决策。累积 contextAdditions。
    // ★ PreToolUse argsOverride 瀑布：hook 返回即原地更新 ctx.args——后续 hook 与安全门禁均见改写后
    //   参数；最终改写值随返回带出（deny 短路时丢弃——被拒的调用不会执行，改写无意义）。
    const additions: string[] = [];
    let argsOverride: any = undefined;
    for (const rule of matched) {
        try {
            const res: HookResult = await rule.run(ctx);
            if (res?.contextAdditions) additions.push(...res.contextAdditions);
            if (event === 'PreToolUse' && appConfig.hookRewrite && res?.argsOverride !== undefined) {
                if (isPlainObject(res.argsOverride)) {
                    ctx.args = res.argsOverride;
                    argsOverride = res.argsOverride;
                } else {
                    console.warn(`⚠️ [hook:PreToolUse] argsOverride 须为普通对象，已忽略`);
                }
            }
            if (res && res.deny) {
                return { deny: true, reason: res.reason, contextAdditions: additions.length > 0 ? additions : undefined };
            }
        } catch (e: any) {
            const msg = e?.message ?? e;
            if (rule.onError === 'deny') {
                // ★ fail-closed 逃生阀：安全类 hook 自身崩溃即拒绝，避免缺陷 hook 放行高危操作
                console.warn(`⚠️ [hook:${event}] 执行异常，按 onError:'deny' 拒绝（fail-closed）: ${msg}`);
                return { deny: true, reason: `[hook:${event}] 执行异常（fail-closed）: ${msg}`, contextAdditions: additions.length > 0 ? additions : undefined };
            }
            console.warn(`⚠️ [hook:${event}] 执行异常，按放行处理: ${msg}`);
        }
    }
    return { ...pack(additions), argsOverride };
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
): Promise<DispatchResult> => {
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
 * 执行 PostToolUse hook（execute 后，观察 + 开关开时可改写 resultForModel）。
 * 返回 DispatchResult：resultOverride 供调用方替换模型视图（用户视图不动）。
 * result 在此截断后再分发——hook 观察无需完整大输出；hook 自己写回的 resultOverride 不受此截断
 * （调用方按工具自身 maxOutputCharacters 上限约束）。向后兼容：旧调用忽略返回值即可。
 */
export const runPostHooks = async (
    toolName: string,
    args: any,
    result: string,
    ctx: ToolContext,
): Promise<DispatchResult> => {
    return dispatch('PostToolUse', {
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        env: ctx.env,
        toolName,
        args,
        result: truncateForHook(result),
        toolContext: ctx,
    });
};
