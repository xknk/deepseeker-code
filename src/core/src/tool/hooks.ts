/**
 * @file tool/hooks.ts
 * @description Hooks 系统：在工具执行前后注入用户自定义逻辑。
 *  - pre hook：审批通过后、execute 前运行，可返回 { deny: true } 拦截（阻断执行）；
 *  - post hook：execute 后运行，仅观察（记录/通知/自动 lint），不可拦截。
 *
 *  匹配器 match：string（精确名或 '*'）/ RegExp / (toolName)=>boolean。
 *  鲁棒原则（核心）：hook 失败不得击垮主流程——
 *    pre hook 抛错按【放行】处理（避免有缺陷的 hook 误拦阻断 agent）；
 *    post hook 抛错静默吞掉（仅告警）。
 *
 *  v1 为程序化注册 API（registerHook）；声明式配置文件（类 Claude Code settings.json hooks）留作后续扩展。
 */
import { ToolContext } from "./type.ts";

/** 工具名匹配器：精确串 / '*' / 正则 / 谓词 */
export type HookMatcher = string | RegExp | ((toolName: string) => boolean);

export interface PreHookContext {
    toolName: string;
    args: any;
    ctx: ToolContext;
}
export interface PostHookContext {
    toolName: string;
    args: any;
    result: string;
    ctx: ToolContext;
}

/** pre hook 返回值：可 deny 拦截执行 */
export type PreHookResult = void | { deny: boolean; reason?: string };
export type PreHookHandler = (c: PreHookContext) => PreHookResult | Promise<PreHookResult>;
export type PostHookHandler = (c: PostHookContext) => void | Promise<void>;

export interface PreHook {
    event: 'pre';
    match: HookMatcher;
    run: PreHookHandler;
}
export interface PostHook {
    event: 'post';
    match: HookMatcher;
    run: PostHookHandler;
}
export type Hook = PreHook | PostHook;

const preHooks: PreHook[] = [];
const postHooks: PostHook[] = [];

/** 匹配判定：string 支持精确名与通配 '*' */
function matches(match: HookMatcher, toolName: string): boolean {
    if (typeof match === 'string') return match === '*' || match === toolName;
    if (match instanceof RegExp) return match.test(toolName);
    try { return match(toolName); } catch { return false; }
}

/** 注册单个 hook */
export function registerHook(hook: Hook): void {
    (hook.event === 'pre' ? preHooks : postHooks).push(hook as any);
}

/** 批量注册 */
export function registerHooks(hooks: Hook[]): void {
    hooks.forEach(registerHook);
}

/** 清空全部 hook（测试 / 热重载用） */
export function clearHooks(): void {
    preHooks.length = 0;
    postHooks.length = 0;
}

/**
 * 执行所有匹配的 pre hook；首个返回 deny 即拦截。
 * hook 抛错按【放行】处理（防误拦）。
 */
export async function runPreHooks(toolName: string, args: any, ctx: ToolContext): Promise<{ deny: boolean; reason?: string }> {
    for (const h of preHooks) {
        if (!matches(h.match, toolName)) continue;
        try {
            const r = await h.run({ toolName, args, ctx });
            if (r && r.deny) return { deny: true, reason: r.reason };
        } catch (e: any) {
            console.warn(`⚠️ [pre-hook:${toolName}] 执行异常，按放行处理: ${e?.message ?? e}`);
        }
    }
    return { deny: false };
}

/**
 * 执行所有匹配的 post hook（仅观察，不拦截）。异常静默吞掉（仅告警）。
 */
export async function runPostHooks(toolName: string, args: any, result: string, ctx: ToolContext): Promise<void> {
    for (const h of postHooks) {
        if (!matches(h.match, toolName)) continue;
        try {
            await h.run({ toolName, args, result, ctx });
        } catch (e: any) {
            console.warn(`⚠️ [post-hook:${toolName}] 执行异常，已忽略: ${e?.message ?? e}`);
        }
    }
}
