/**
 * @file agent/systemInjections.ts
 * @description runAgent setup 期纯函数 prepareToolsAndInjections：
 *  工具过滤（planMode/env）+ schema 清洗 + 摘要槽预留 + 系统 prompt fence 注入（locale/outputStyle/
 *  skills/agents/projectGuide/memory）。
 *
 *  从 runAgent 抽出（原 setup 内联逻辑）。validationCtx 在此内部构造（其字段全来自 options + events wrapper，
 *  主循环不再需要为 setup 单独构造）。纯数据契约：无 yield；保留 fence 注入原地改 message 的副作用
 *  （幂等、不动 message 下标、不破坏 DeepSeek 隐式前缀缓存）。返回 { rawTools, cleanedToolSchemas, toolsTokens }
 *  供主循环推理（cleanedToolSchemas）、工具执行（rawTools）与 token 口径修正（toolsTokens）复用。
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
import { injectMarkedBlock, detectTextLocale, type Locale } from "@/common/index.ts";

/**
 * setup 期：工具表裁剪 + schema 清洗 + 摘要槽 + fence 注入。
 * @param message  会话消息数组（原地修改：ensureSummarySlot 预留 message[1]、各 inject 追加到 message[0]）
 * @param options  runAgent 运行配置（取 toolSchemas/planMode/locale/outputStyle 及 validationCtx 所需字段）
 * @param events   安全包装后的埋点回调（主循环已 try/catch 包裹，透传给 validationCtx 供 filterByEnvironment 用）
 * @returns { rawTools, cleanedToolSchemas, toolsTokens } —— rawTools 含内部字段（safetyLevel/审批/锁等）供工具执行；
 *          cleanedToolSchemas 仅留 OpenAI 协议所需字段供模型推理；toolsTokens 为 schema 常数项 token 粗估（P2 口径）。
 */
export const prepareToolsAndInjections = async (
    message: OpenAI.Chat.ChatCompletionMessageParam[],
    options: RunAgentOptions,
    events: RunAgentEvents,
): Promise<{ rawTools: any[]; cleanedToolSchemas: any[]; toolsTokens: number }> => {
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
    // ★ P2 口径：工具 schema 常数项（token 粗估，ASCII JSON ≈ 4 字节/token）。真实 prompt_tokens 含这段
    //   而 estimateTokens(messages) 不含——供 runAgent 校准分母与 ensureFitsWindow 压缩阈值显式计入。
    const toolsTokens = Math.round(JSON.stringify(cleanedToolSchemas).length / 4);
    // 预留系统提示词和摘要存放区域（message[1] 槽，被 ensureFitsWindow/ensureSummarySlot 强依赖——勿改前两个下标）
    ensureSummarySlot(message);
    // ★ P0-4 前缀稳定性：计划模式约束已静态化进 SYSTEM_PROMPT，不再随 planMode 状态改写 message[0]
    //   （改写会破坏 DeepSeek 隐式前缀缓存）。模式强制：runtime 档由 processToolCall 执行层按
    //   PLAN_ALLOWED_TOOLS 拒绝写工具（工具表恒定）；schema 档回退 filterToolsForPlanMode 裁表。
    // 回复语言：按「本轮 user 消息语言自动推断 ?? 显式 locale」注入强引导（fence 机制）。
    //   检测优先：用户切英文提问即得英文回复，无需记 /lang；/lang 降级为无信号轮（纯代码/符号输入）
    //   的兜底，并继续控制 CLI 界面文案。message[0] 每轮由 buildContextMessages 全新重建、fence 重注入，
    //   故语言翻转不撞会话首锁；代价是 hint 字节变化 → 前缀缓存破一次（语言切换的合理代价，罕见）。
    //   hint 明确覆盖全部用户可见产出（正文/中间叙述/todo 项/计划方案/代码注释/提交信息），并要求
    //   「不受工具结果与系统指令语言影响」——否则占压倒多数的中文上下文会把英文输出拖回混排。
    const LOCALE_HINTS: Record<Locale, string> = {
        zh: "始终用中文输出所有面向用户的内容：你的回复、中间叙述、todo 任务项标题、通过 exit_plan_mode 提交的方案文本、代码注释与提交信息。代码标识符保持原样；工具结果与系统指令可能夹杂其他语言——必要时照引原文，但你自己的叙述与解释一律用中文。",
        en: "Always produce ALL user-facing output in English: your replies, interim narration, todo item titles, the plan text you submit via exit_plan_mode, code comments, and commit messages. Keep code identifiers as-is; tool results and system instructions may arrive in Chinese — quote them verbatim where needed, but your own narration and explanations must stay in English.",
    };
    const lastUserText = (() => {
        for (let i = message.length - 1; i >= 0; i--) {
            const m: any = message[i];
            if (m?.role !== "user") continue;
            const c = m.content;
            if (typeof c === "string") return c;
            if (Array.isArray(c)) return c.filter((p: any) => typeof p?.text === "string").map((p: any) => p.text).join(" ");
            return "";
        }
        return "";
    })();
    const effLocale = detectTextLocale(lastUserText) ?? locale;
    if (effLocale) injectMarkedBlock(message, "⟦DSC:LOCALE⟧", LOCALE_HINTS[effLocale]);
    // ★ P2-16 输出风格：按 outputStyle 幂等注入 persona 正文（fence 机制，run 内锁定零漂移；
    //   跨 run 源不变则重建逐字节复现 → 不破坏前缀缓存）
    injectOutputStyle(message, outputStyle);
    // ★ Skills：把【可用技能目录】幂等注入系统提示词（fence 机制，不动 message 下标）
    injectSkillCatalog(message);
    injectAgentCatalog(message);
    injectProjectGuide(message);
    // ★ 持久记忆：把【记忆索引】幂等注入系统提示词（仅一行/条，省 token；需要全文时模型调 memory_read）。fence 机制，不动 message 下标
    injectMemory(message);
    return { rawTools, cleanedToolSchemas, toolsTokens };
};
