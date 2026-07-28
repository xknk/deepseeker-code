/**
 * @file tool/hooks.ts
 * @description 兼容门面：保留旧导出名（runPreHooks / runPostHooks / registerHook...），
 *  实现已迁移至 @/hooks/ 的通用事件分发中心（registry.ts）。本文件仅做转发，
 *  使 runAgent.ts:33 的 `import { runPreHooks, runPostHooks }` 零改动。
 *
 *  - 新代码请直接 import @/hooks/registry.ts（dispatch 通用分发）或 @/hooks/loader.ts（声明式加载）。
 *  - 历史的 pre/post 工具级 hook 现由 registry 统一管理；新增事件（SessionStart/UserPromptSubmit/Stop/SessionEnd）
 *    见 @/hooks/types.ts。
 */
export {
    registerHook,
    registerHooks,
    clearHooks,
    dispatch,
    matches,
    runPreHooks,
    runPostHooks,
} from "@/hooks/registry.ts";

export type {
    EventType,
    HookMatcher,
    HookResult,
    HookRule,
    HookHandler,
    BaseHookCtx,
    SessionStartCtx,
    UserPromptSubmitCtx,
    PreToolUseCtx,
    PostToolUseCtx,
    StopCtx,
    SessionEndCtx,
    StopReason,
} from "@/hooks/types.ts";
