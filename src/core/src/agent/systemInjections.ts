/**
 * @file agent/systemInjections.ts
 * @description runAgent setup 期纯函数 prepareToolsAndInjections：
 *  工具过滤（planMode/env）+ schema 清洗 + 摘要槽预留 + 系统 prompt fence 注入（locale/outputStyle/
 *  skills/agents/projectGuide/memory）。
 *
 *  从 runAgent 抽出（原 setup 内联逻辑）。validationCtx 在此内部构造（其字段全来自 options + events wrapper，
 *  主循环不再需要为 setup 单独构造）。纯数据契约：无 yield；保留 fence 注入原地改 message 的副作用
 *  （幂等、不动 message 下标、不破坏 DeepSeek 隐式前缀缓存）。返回 { rawTools, cleanedToolSchemas }
 *  供主循环推理（cleanedToolSchemas）与工具执行（rawTools）复用。
 */
import type OpenAI from "openai";
import { RunAgentOptions, RunAgentEvents } from "./type.ts";
import { ToolContext } from "@/tool/index.ts";
import { appConfig } from "@/config/index.ts";
import { filterToolsForPlanMode, appendPlanControlTools } from "./planMode.ts";
import { filterByEnvironment } from "./toolFilter.ts";
import { ensureSummarySlot } from "./truncate.ts";
import { injectSkillCatalog } from "@/skills/inject.ts";
import { injectAgentCatalog } from "@/agents/inject.ts";
import { injectProjectGuide } from "@/projectGuide/inject.ts";
import { injectOutputStyle } from "@/outputStyles/inject.ts";
import { injectMemory } from "@/memory/inject.ts";
import { injectMarkedBlock } from "@/common/index.ts";

/**
 * setup 期：工具表裁剪 + schema 清洗 + 摘要槽 + fence 注入。
 * @param message  会话消息数组（原地修改：ensureSummarySlot 预留 message[1]、各 inject 追加到 message[0]）
 * @param options  runAgent 运行配置（取 toolSchemas/planMode/locale/outputStyle 及 validationCtx 所需字段）
 * @param events   安全包装后的埋点回调（主循环已 try/catch 包裹，透传给 validationCtx 供 filterByEnvironment 用）
 * @returns { rawTools, cleanedToolSchemas } —— rawTools 含内部字段（safetyLevel/审批/锁等）供工具执行；
 *          cleanedToolSchemas 仅留 OpenAI 协议所需字段供模型推理。
 */
export const prepareToolsAndInjections = async (
    message: OpenAI.Chat.ChatCompletionMessageParam[],
    options: RunAgentOptions,
    events: RunAgentEvents,
): Promise<{ rawTools: any[]; cleanedToolSchemas: any[] }> => {
    const { toolSchemas, planMode, locale, outputStyle } = options;
    // ★ P0-A 计划模式工具表策略：runtime 档（默认）两态统一走 appendPlanControlTools——工具表全会话
    //   恒定，保 DeepSeek 前缀缓存（tools 序列化在请求头部，裁表翻转 = 全历史 re-prefill 两次）；
    //   计划期写工具改由 processToolCall 执行层按 PLAN_ALLOWED_TOOLS 拒绝。
    //   schema 档（DEEP_SEEK_PLAN_ENFORCEMENT=schema）回退旧裁表路径（计划期 = 只读白名单 + exit_plan_mode）。
    //   非计划模式：注入 enter_plan_mode + exit_plan_mode 供模型自主进入计划/提交方案（见 agent/planMode.ts）。
    const rawToolsPreEnv = (planMode && appConfig.planEnforcement === 'schema')
        ? filterToolsForPlanMode(toolSchemas ?? [])
        : appendPlanControlTools(toolSchemas ?? []);
    // ★ validateEnvironment：喂给模型前剔除环境不满足的工具（如无 API key 的 web_search 自动隐藏）
    const validationCtx: ToolContext = {
        sessionId: options.sessionId,
        cwd: options.cwd ?? process.cwd(),
        abortSignal: options.abortSignal,
        depth: options.depth ?? 0,
        keepRecentUnits: options.keepRecentUnits,
        compactRatio: options.compactRatio,
        modelWindow: options.modelWindow,
        parentSystemPrompt: options.parentSystemPrompt,
        events,
        onUIEvent: options.onUIEvent,
        requestApproval: options.requestApproval,
        requestQuestion: options.requestQuestion,
    };
    const rawTools = await filterByEnvironment(rawToolsPreEnv, validationCtx);
    // 格式化工具消息（剔除 safetyLevel/审批/锁等内部字段，只留 OpenAI 协议所需：type/function{name,description,parameters}）
    const cleanedToolSchemas = rawTools.map((t: any) => ({
        type: t.type,
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
    }));
    // 预留系统提示词和摘要存放区域（message[1] 槽，被 ensureFitsWindow/ensureSummarySlot 强依赖——勿改前两个下标）
    ensureSummarySlot(message);
    // ★ P0-4 前缀稳定性：计划模式约束已静态化进 SYSTEM_PROMPT，不再随 planMode 状态改写 message[0]
    //   （改写会破坏 DeepSeek 隐式前缀缓存）。模式强制：runtime 档由 processToolCall 执行层按
    //   PLAN_ALLOWED_TOOLS 拒绝写工具（工具表恒定）；schema 档回退 filterToolsForPlanMode 裁表。
    // 回复语言：按 locale 幂等注入「用中文/英文回复」引导（fence 机制，会话内不变 → 不破坏前缀缓存）
    if (locale) {
        const hint = locale === "zh" ? "请始终用中文回复用户。" : "Always reply to the user in English.";
        injectMarkedBlock(message, "⟦DSC:LOCALE⟧", hint);
    }
    // ★ P2-16 输出风格：按 outputStyle 幂等注入 persona 正文（fence 机制，会话内不变 → 不破坏前缀缓存）
    injectOutputStyle(message, outputStyle);
    // ★ Skills：把【可用技能目录】幂等注入系统提示词（fence 机制，不动 message 下标）
    injectSkillCatalog(message);
    injectAgentCatalog(message);
    injectProjectGuide(message);
    // ★ 持久记忆：把【记忆索引】幂等注入系统提示词（仅一行/条，省 token；需要全文时模型调 memory_read）。fence 机制，不动 message 下标
    injectMemory(message);
    return { rawTools, cleanedToolSchemas };
};
