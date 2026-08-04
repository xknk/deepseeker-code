/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 15:25:11
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-23 16:26:14
 * @FilePath: \deepSeekCode\src\core\src\agent\runAgent.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */

/**
 * @file agent/runAgent.ts
 * @description Agent 主循环：驱动「模型推理 ↔ 工具调用」的多轮循环，是整个 agent 的核心。
 *
 *  每轮 while(true) 的职责：
 *  1) 窗口治理 —— ensureFitsWindow 判断并触发上下文压缩 / 滚动摘要；
 *  2) 流式推理 —— chatWithModelWithTools 流式拉取，边收边 yield text.delta / thinking.delta，
 *     按 index 拼接 tool_calls 分片，末包收 usage；
 *  3) 工具执行 —— 解析 tool_calls，按 safetyLevel 做审批熔断，执行（含超时 / verifyResult 校验），
 *     截断结果后回写上下文与本地会话；
 *  4) 退出判定 —— 无工具调用则结束；连续 3 次相同调用则熔断；用户中止则立即结束。
 *
 *  产出：通过 AsyncGenerator<AgentEvent> 向上层 yield 流程事件；通过 options.events 回传埋点。
 */
import chatWithModelWithTools from "@/llm/model.ts";
import OpenAI from "openai";
import { appendMessage } from "@/session/transcript.ts";
import { collectToolResult, ensureFitsWindow, ensureSummarySlot, truncateToolResult } from "./truncate.ts";
import { AgentEvent, RunAgentOptions } from "./type.ts";
import { estimateTokens } from "@/session/contextCore.ts";
import { ToolContext, ToolSafetyLevel, ToolExecutionResultStatus } from "@/tool/index.ts";
import { requestApproval, isProtectedWrite } from "@/tool/guard.ts";
import { checkPermission } from "@/tool/permissions.ts";
import { filterToolsForPlanMode, appendEnterPlanModeTool } from "./planMode.ts";
import { runPreHooks, runPostHooks, dispatch } from "@/tool/hooks.ts";
import { computeLockKey, isLockHeld } from "@/tool/lockManager.ts";
import { runBackgroundTool } from "./backgroundTool.ts";
import { filterByEnvironment } from "./toolFilter.ts";
import { beforeMutationBackup, isUndoTrigger } from "@/tool/undo/backup.ts";
import { injectSkillCatalog } from "@/skills/inject.ts";
import { injectAgentCatalog } from "@/agents/inject.ts";
import { injectProjectGuide } from "@/projectGuide/inject.ts";
import { injectMarkedBlock } from "@/common/index.ts";
import { appConfig } from "@/config/index.ts";
import { runAutoCheck } from "@/tool/autoPermission.ts";

/**
 * 应用工具声明的隐私脱敏规则（防云端模型读到 .env / 密钥等机密）：
 *  - RegExp[]：逐条全局替换为 [MASKED_SECRET]；
 *  - 函数：交由工具自定义脱敏（可结合 args 动态决策）。
 * 容错优先：脱敏异常返回原文，绝不阻断工具结果回灌。
 */
const applyPrivacyMasking = (
    rules: RegExp[] | ((args: any, rawOutput: string) => string) | undefined,
    args: any,
    output: string,
): string => {
    if (!rules) return output;
    try {
        if (typeof rules === 'function') return rules(args, output);
        let masked = output;
        for (const re of rules) {
            const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
            masked = masked.replace(new RegExp(re.source, flags), '[MASKED_SECRET]');
        }
        return masked;
    } catch {
        return output;
    }
};

/**
 * P0-1 单个 tool_call 的处理结果（processToolCall 返回）。纯数据——副作用（yield tool.end / message.push /
 * appendMessage）由分波调度层统一 flush，使 processToolCall 可被 Promise.all 并发调用。
 */
type ToolCallOutcome = {
    toolCallId: string;
    calledName: string;
    calledArgs: any;
    resultForModel: string;
    resultForUser: string;
    ok: boolean;
    aborted?: boolean;
    terminal?: { kind: 'exit_plan_mode' | 'enter_plan_mode'; plan?: string; reason?: string };
};


// ============ 主流程 ============
/**
 * 运行 Agent 主循环（流式）。
 *
 * 持续进行「模型推理 → 工具调用」的多轮循环，直到模型不再请求工具、检测到重复调用熔断、
 * 或调用方中止（abortSignal）。过程中通过 yield 向外推送阶段事件（AgentEvent），
 * 通过 options.events 回传可观测性埋点。
 *
 * @param message  对话上下文（原地修改：追加 assistant / tool 消息）。约定 [0]=系统提示词、[1]=滚动摘要槽
 * @param options  运行配置，见 {@link RunAgentOptions}
 * @yields AgentEvent  round.start / text.delta / thinking.delta / tool.start / tool.end / final
 */
export async function* runAgent(message: OpenAI.Chat.ChatCompletionMessageParam[], options: RunAgentOptions): AsyncGenerator<AgentEvent> {
    const rawToolsAll = options.toolSchemas ?? [];   // ← 不再默认 agentTools，避免循环依赖
    // 计划模式：过滤为只读/研究工具 + 注入 exit_plan_mode；非计划模式：注入 enter_plan_mode 供模型自主进入（见 agent/planMode.ts）
    const rawToolsPreEnv = options.planMode ? filterToolsForPlanMode(rawToolsAll) : appendEnterPlanModeTool(rawToolsAll);
    const sessionId = options.sessionId; // 本次会话id
    // ★ 可观测性埋点安全包装：trace/落盘层异常（磁盘满、JSON 序列化失败、网络上报失败）一律 catch，
    //   绝不冒泡成 unhandled rejection 击垮 agent 主循环（旁路埋点不应拖垮主业务推理）。
    //   全部 11 处埋点点位自动获得该保护，无需逐个 await/.catch。
    const rawEvents = options.events; // 原始回调方法
    const events: typeof rawEvents = async (base) => {
        try { await rawEvents(base); } catch (e) { console.warn('⚠️ 埋点失败（不影响推理）:', e instanceof Error ? e.message : e); }
    };
    const modelWindow = options.modelWindow; // 最大上下文token
    const signal = options.abortSignal; // 主动停止
    const depth = options.depth ?? 0;
    // ★ 工作目录：hook 子进程 cwd / 工具相对路径基准；缺省取 process.cwd()，spawn_agent 透传以保持一致
    const cwd = options.cwd ?? process.cwd();
    const keepRecentUnits = options.keepRecentUnits
    const compactRatio = options.compactRatio
    const parentSystemPrompt = options.parentSystemPrompt
    // ★ validateEnvironment：喂给模型前剔除环境不满足的工具（如无 API key 的 web_search 自动隐藏）
    const validationCtx: ToolContext = { sessionId, cwd, abortSignal: signal, depth, keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt, events, onUIEvent: options.onUIEvent, requestApproval: options.requestApproval };
    const rawTools = await filterByEnvironment(rawToolsPreEnv, validationCtx);
    // 格式化工具消息
    const cleanedToolSchemas = rawTools.map((t: any) => ({
        type: t.type,
        function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
    }));
    // 预留系统提示词和摘要存放区域
    ensureSummarySlot(message);
    // ★ P0-4 前缀稳定性：计划模式约束已静态化进 SYSTEM_PROMPT，不再随 planMode 状态改写 message[0]
    //   （改写会破坏 DeepSeek 隐式前缀缓存）。真正的模式强制仍由 filterToolsForPlanMode（限制工具表）保证。
    // 回复语言：按 locale 幂等注入「用中文/英文回复」引导（fence 机制，会话内不变 → 不破坏前缀缓存）
    if (options.locale) {
        const hint = options.locale === "zh" ? "请始终用中文回复用户。" : "Always reply to the user in English.";
        injectMarkedBlock(message, "⟦DSC:LOCALE⟧", hint);
    }
    // ★ Skills：把【可用技能目录】幂等注入系统提示词（fence 机制，不动 message 下标）
    injectSkillCatalog(message);
    injectAgentCatalog(message);
    injectProjectGuide(message);
    let round = 0;
    let lastContent: string | undefined = "";
    let stopReason: 'normal' | 'aborted' | 'error' | 'repeat' | 'limit' = 'normal';
    const recentSignatures: string[] = [];
    // ★ 工具名序列兜底：完整签名（含 arguments）随参数微变永不重复，补一条"仅工具名"序列，
    //   连续较多轮相同 → 参数微变死循环熔断（给分页等合理连续同工具调用留 8 轮空间，不误杀）。
    const recentNameSignatures: string[] = [];
    // F-1：轮数治理——"让模型自决"为主，硬上限仅作极高兜底（零用户配置、零心智负担）。
    //  主机制：每 NUDGE_EVERY 轮向系统提示词注入一次自评提醒，由模型自己决定"收尾给答案"还是"继续推进"
    //         （对标 Claude Code：不在低轮数硬停，靠模型自收敛 + 用户中止）。
    //  兜底：MAX_AGENT_ROUNDS 极高（500），仅防失控烧 token 的病理死循环；正常任务不会触及，触及亦 graceful（可"继续"接续）。
    const NUDGE_EVERY = 40;
    const NUDGE_FENCE = "⟦DSC:NUDGE⟧";
    const MAX_AGENT_ROUNDS = 500;
    const userDecisionSource = depth > 0 ? 'spawn_agent' : 'user'
    const llmDecisionSource = depth > 0 ? 'llm_spawn_agent' : 'llm'

    const startTime = performance.now();
    try {
        while (true) {
            round++;
            if (round > MAX_AGENT_ROUNDS) {
                stopReason = 'limit';
                yield { type: 'final', text: (lastContent || "") + `\n（已达防失控兜底上限 ${MAX_AGENT_ROUNDS} 轮，非任务错误——任务未完成直接回复"继续"即可接续。）` };
                return;
            }
            // ★ P0-4 前缀稳定性：NUDGE 轮数自评已移至「推理时附加尾部副本」（见下方 inferenceMessages 构造），
            //   不再改写 message[0]——保 message[0] 前缀绝对稳定，DeepSeek 隐式缓存跨轮命中。
            //   机制不变：每 NUDGE_EVERY 轮由模型自决收尾（对标 CC：靠模型自收敛 + 用户中止，不硬停）。
            // ★ 前端用户主动停止运行：检测先于 round.start，避免中止后再多发一个 round.start 事件。
            if (signal?.aborted) {
                events({
                    sessionId,
                    eventType: 'user.aborted',
                    metadata: {
                        depth,
                        decisionSource: 'user',
                        ok: false,
                        attempt: round,
                        durationMs: performance.now() - startTime,
                    },
                    payload: {
                        output: lastContent,
                    }
                })
                yield { type: 'final', text: lastContent || "（已中止）" };
                return;

            }
            yield { type: 'round.start', round };
            try {
                // 判断是否需要压缩上下文并触发摘要
                await ensureFitsWindow(
                    {
                        sessionId,
                        messageArr: message,
                        keepRecentUnits,
                        compactRatio,
                        modelWindow,
                        events,
                        depth,
                        signal,
                    }

                );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error("❌ " + msg);
                stopReason = 'error';
                yield { type: 'final', text: (lastContent || "") + `\n（${msg}）` };
                return
            }

            // ★ P0-4 前缀稳定性：NUDGE 轮数自评改为「推理时附加尾部副本」——不进 message 数组/transcript/压缩，
            //   保 message[0] 前缀绝对稳定 → DeepSeek 隐式缓存跨轮命中。机制不变（每 NUDGE_EVERY 轮模型自决收尾）。
            const nudgeMsg = (round > 1 && round % NUDGE_EVERY === 1)
                ? { role: 'system' as const, content: `${NUDGE_FENCE}\n你已执行约 ${round} 轮工具调用。请自评：若任务已可完成，立即给出最终答案、不再调用工具；若确需更多步骤，继续，但确保每步都在实质推进任务、不重复检索。` }
                : null;
            const inferenceMessages = nudgeMsg ? [...message, nudgeMsg] : message;
            let assistantMessage: OpenAI.Chat.ChatCompletionMessage = { role: 'assistant', content: null } as OpenAI.Chat.ChatCompletionMessage;
            try {
                events({
                    sessionId: sessionId,
                    eventType: 'llm.request',
                    metadata: {
                        depth: depth,
                        decisionSource: userDecisionSource,
                        ok: true,
                        durationMs: performance.now() - startTime,
                        round
                    },
                    usage: {
                        prompt_tokens: estimateTokens(inferenceMessages),
                    },
                    payload: {
                        input: message[message.length - 1].content as string,
                    }
                })
                console.log(`🔄 代理推理第 ${round} 轮（流式）...`);

                // ★ 流式消费：累积 content（边收边 yield text.delta）+ 按 index 拼接 tool_calls 分片 + 收 usage
                let contentBuf = "";
                let reasoningBuf = ""; // DeepSeek reasoning_content 累积：工具调用轮后续必须回传给 API（见下方 assistantMessage）
                const toolCallsBuf = new Map<number, { id?: string; type?: string; function: { name: string; arguments: string } }>();
                let lastUsage: OpenAI.Chat.Completions.ChatCompletionChunk['usage'] | undefined;
                for await (const chunk of chatWithModelWithTools(inferenceMessages, cleanedToolSchemas, { signal, model: options.model, thinkingLevel: options.thinkingLevel })) {
                    if (signal?.aborted) break;
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta) {
                        if (delta.content) {
                            contentBuf += delta.content;
                            yield { type: 'text.delta', text: delta.content };
                        }
                        // DeepSeek reasoning 流式：reasoning_content 是 DeepSeek 对 OpenAI delta 的扩展（标准类型未定义），用窄化类型读取而非 any
                        const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
                        if (reasoning) { reasoningBuf += reasoning; yield { type: 'thinking.delta', text: reasoning }; }
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index ?? 0;
                                let buf = toolCallsBuf.get(idx);
                                if (!buf) { buf = { function: { name: "", arguments: "" } }; toolCallsBuf.set(idx, buf); }
                                if (tc.id) buf.id = tc.id;
                                if (tc.type) buf.type = tc.type;
                                if (tc.function?.name) buf.function.name += tc.function.name;
                                if (tc.function?.arguments) buf.function.arguments += tc.function.arguments;
                            }
                        }
                    }
                    if (chunk.usage) lastUsage = chunk.usage;
                }
                if (signal?.aborted) {
                    // ★ 中止落盘：仅有文本、无半截 tool_call 时，把用户已看到的 partial assistant 文本落盘，
                    //   恢复会话后仍可见；若有半截 tool_call（不可保留半工具），整体丢弃。
                    if (contentBuf && toolCallsBuf.size === 0) {
                        message.push({ role: 'assistant', content: contentBuf });
                        await appendMessage({ sessionId, role: 'assistant', content: contentBuf });
                    }
                    yield { type: 'final', text: contentBuf || lastContent || "（已中止）" };
                    return;
                }

                // 流式拼接出 assistantMessage
                // ★ 回传 reasoning_content：DeepSeek 思考模式下，进行了工具调用的轮次在后续所有请求中必须完整回传
                //   reasoning_content，否则 API 返回 400（官方 thinking_mode 文档）。非工具调用轮传了会被忽略，故一律附上即可。
                assistantMessage = {
                    role: 'assistant',
                    content: contentBuf || null,
                    ...(reasoningBuf ? { reasoning_content: reasoningBuf } : {}),
                    ...(toolCallsBuf.size > 0 ? {
                        tool_calls: Array.from(toolCallsBuf.entries())
                            .sort((a, b) => a[0] - b[0])
                            .map(([idx, tc]) => ({ id: tc.id ?? `call_${round}_${idx}`, type: tc.type || 'function', function: tc.function }))
                    } : {}),
                } as unknown as OpenAI.Chat.ChatCompletionMessage;

                events({
                    sessionId: sessionId,
                    eventType: 'llm.response',
                    metadata: {
                        depth: depth,
                        decisionSource: llmDecisionSource,
                        ok: true,
                        durationMs: performance.now() - startTime,
                        round
                    },
                    usage: {
                        prompt_tokens: lastUsage?.prompt_tokens,
                        completion_tokens: lastUsage?.completion_tokens,
                        total_tokens: lastUsage?.total_tokens,
                        prompt_cache_hit_tokens: lastUsage?.prompt_tokens_details?.cached_tokens,
                        prompt_cache_miss_tokens: (lastUsage?.prompt_tokens || 0) - (lastUsage?.prompt_tokens_details?.cached_tokens || 0)
                    },
                    payload: {
                        input: message[message.length - 1].content as string,
                    }
                })
            } catch (error) {
                if (signal?.aborted) {
                    yield { type: 'final', text: lastContent || "（已中止）" };
                    return;
                }
                const err = error instanceof Error ? error : new Error(String(error));
                stopReason = 'error';
                events({
                    sessionId: sessionId,
                    eventType: 'llm.error',
                    metadata: {
                        depth: depth,
                        decisionSource: llmDecisionSource,
                        ok: false,
                        durationMs: performance.now() - startTime,
                        attempt: round,
                    },
                    payload: {
                        input: message[message.length - 1].content as string,
                        output: err.message,
                    }
                })
                yield { type: 'final', text: lastContent || "（发生错误）" };
                return;
            }

            // assistantMessage 已在上方流式消费中拼接完成
            // 存入本次对话上下文中
            // ★ F-1 修复：回传 reasoning_content。DeepSeek 思考模式下，含工具调用的轮次必须在后续请求中
            //   完整回传 reasoning_content，否则 API 返回 400（见上方 L255 注释）。原 push 重建对象时漏掉了它，
            //   导致默认思考模式开启时第一次工具调用后即 400 崩溃。reasoning_content 为 DeepSeek 对 OpenAI
            //   消息的扩展字段，标准类型未定义，用窄化读取（reasoningBuf 作用域仅在内层 try，此处不可达）。
            const reasoningContent = (assistantMessage as any).reasoning_content as string | undefined;
            message.push({
                role: 'assistant',
                content: assistantMessage.content || null,
                tool_calls: assistantMessage.tool_calls as any,
                ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            } as any);
            // 存入本地上下文会话中（同步携带 reasoning_content：cleanMsg/appendMessage 均 ...rest 透传，
            //   保证会话恢复后 buildContextMessages 重建的上下文仍带该字段，回传链不中断）
            await appendMessage({
                sessionId,
                role: 'assistant',
                content: assistantMessage.content || null,
                tool_calls: assistantMessage.tool_calls as any,
                ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
            } as any);
            // 存储最后一条消息，以供后面返回使用
            if (assistantMessage.content) {
                lastContent = assistantMessage.content;
            }

            // 1、如果本次无调用工具或者工具调用完成后，则主动跳出循环
            if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                // 优先用当前轮 content，避免纯工具轮后 lastContent 陈旧导致终态回显旧文本
                yield { type: 'final', text: assistantMessage.content || lastContent || "" };
                return;
            }
            // 2、检测是否一直重复调用同一个工具，如果超过3次，则主动跳出循环
            const sig = assistantMessage.tool_calls.map((t: any) => `${t.function.name}:${t.function.arguments}`).join("|");
            const tooName = assistantMessage.tool_calls.map((t: any) => `${t.function.name}`).join("|");

            recentSignatures.push(sig);
            if (recentSignatures.length > 6) recentSignatures.shift(); // F-8：定长裁剪，防长会话无限增长占内存
            const last3 = recentSignatures.slice(-3);
            if (last3.length === 3 && last3.every(s => s === last3[0])) {
                stopReason = 'repeat';
                events({
                    sessionId: sessionId,
                    eventType: 'tool.repeat_break',
                    metadata: {
                        depth: depth,
                        decisionSource: llmDecisionSource,
                        durationMs: performance.now() - startTime,
                        round,
                        toolName: tooName,
                        toolSource: 'builtin',
                        ok: false,
                        attempt: round
                    },
                    payload: {
                        output: (lastContent || "") + "\n（检测到重复工具调用，已停止）",
                    }
                })
                yield { type: 'final', text: (lastContent || "") + "\n（检测到重复工具调用，已停止）" };
                return;
            }
            // ★ 参数微变死循环兜底：完整签名随时间戳/游标等动态参数变化永不重复，
            //   补"仅工具名"序列检测——连续 8 轮同一组工具名（参数可能每轮微变）即熔断，
            //   给分页读取等合理的连续同工具调用留出空间。
            recentNameSignatures.push(tooName);
            if (recentNameSignatures.length > 16) recentNameSignatures.shift();
            const last8 = recentNameSignatures.slice(-8);
            if (last8.length === 8 && last8.every(s => s === last8[0])) {
                stopReason = 'repeat';
                events({
                    sessionId: sessionId,
                    eventType: 'tool.repeat_break',
                    metadata: {
                        depth: depth,
                        decisionSource: llmDecisionSource,
                        durationMs: performance.now() - startTime,
                        round,
                        toolName: tooName,
                        toolSource: 'builtin',
                        ok: false,
                        attempt: round
                    },
                    payload: {
                        output: (lastContent || "") + "\n（检测到工具名序列持续重复（参数可能微变），已停止）",
                    }
                })
                yield { type: 'final', text: (lastContent || "") + "\n（检测到工具名序列持续重复（参数可能微变），已停止）" };
                return;
            }
            events({
                sessionId: sessionId,
                eventType: 'tool.resolve',
                metadata: {
                    depth: depth,
                    decisionSource: llmDecisionSource,
                    durationMs: performance.now() - startTime,
                    round,
                    toolName: tooName,
                    toolSource: 'builtin',
                },
                payload: {
                    output: sig,
                }
            })
            // 执行工具（abort 占位 + 截断 + 实时落盘 + 事件）
            let abortedDuringTools = false;
            // ★ 终结类工具（enter/exit_plan_mode）拦截返回前，为本条 assistant 消息中【其后】的并行 tool_call
            //   补占位 tool result，避免留下孤儿 tool_call_id——否则会话恢复重建上下文时 API 因配对缺失返回 400。
            //   （修复前依赖「终结工具必单独调用/排在末位」这一模型未保证的前提。）
            const fillRestPlaceholders = async (fromIdx: number) => {
                const tcs = assistantMessage.tool_calls!;
                for (let j = fromIdx + 1; j < tcs.length; j++) {
                    const ph = "（已跳过：终结类工具 enter/exit_plan_mode 之后的并行调用未执行）";
                    message.push({ role: 'tool', tool_call_id: tcs[j].id, content: ph });
                    await appendMessage({ sessionId, role: 'tool', tool_call_id: tcs[j].id, content: ph });
                }
            };
            // ★ P0-1 processToolCall：单个 tool_call 的完整处理（解析→终结/abort 判定→匹配→权限→锁→审批→
            //   pre-hook→undo 备份→execute→verify→post-hook→脱敏→截断→outputFilter）。
            //   纯函数——不 yield / 不 message.push / 不 appendMessage（副作用统一由调度层 flush），便于并发 Promise.all。
            //   逻辑与原串行循环体逐行等价，仅把 yield tool.start/tool.end、message.push、appendMessage、return
            //   换成「写入 outcome 后返回」；终结类与 abort 也以 outcome 表达。
            const processToolCall = async (toolCall: any): Promise<ToolCallOutcome> => {
                let calledName = "";
                let calledArgs: any = {};
                let parseFailed = false;
                if (toolCall.type === 'function') {
                    calledName = toolCall.function.name;
                    try { calledArgs = JSON.parse(toolCall.function.arguments || "{}"); }
                    catch { parseFailed = true; }
                    console.log(`🤖 模型请求调用工具: ${calledName}，参数:`, calledArgs);
                }
                // ★ 终结类（优先于 abort：模型已提交的方案/进入请求应呈现给用户，不被中止吞掉——「计划先于执行」）
                if (calledName === "exit_plan_mode") {
                    const plan = typeof calledArgs?.plan === "string" ? calledArgs.plan : "";
                    const note = "✅ [计划模式] 实现方案已提交，等待用户审批后进入实现阶段。";
                    return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: true, terminal: { kind: 'exit_plan_mode', plan } };
                }
                if (calledName === "enter_plan_mode") {
                    const reason = typeof calledArgs?.reason === "string" ? calledArgs.reason : "";
                    const note = "📋 [进入计划模式] 模型请求先以只读方式调研并规划方案，已切换至计划模式。";
                    return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: true, terminal: { kind: 'enter_plan_mode', reason } };
                }
                // abort 占位（调度层据此设 abortedDuringTools 并为剩余 tool_call 补占位）
                if (signal?.aborted) {
                    const placeholder = "（已中止，未执行）";
                    return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: placeholder, resultForUser: placeholder, ok: false, aborted: true };
                }
                const matchedTool = rawTools.find((t: any) => t.function.name === calledName);
                const toolCtx: ToolContext = { sessionId, cwd, abortSignal: signal, depth, keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt, events, onUIEvent: options.onUIEvent, requestApproval: options.requestApproval, emitProgress: (m: string) => options.onUIEvent?.({ type: 'tool.progress', toolsId: toolCall.id, toolName: calledName, message: m }), permissionMode: options.permissionMode };
                let result = "";
                let explicitOk: boolean | null = null;
                if (parseFailed) {
                    result = `参数解析失败：模型返回的 arguments 不是合法 JSON${JSON.stringify(toolCall).slice(0, 300)}`;
                    events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
                } else if (matchedTool && typeof matchedTool.function.execute === 'function') {
                    // ★ 安全分级审批：SAFE 免审；MUTATION/DANGER 执行前请求用户审批
                    const level = matchedTool.function.safetyLevel;
                    let needApproval = level === ToolSafetyLevel.MUTATION || level === ToolSafetyLevel.DANGER;
                    let denied = false;
                    // ★ P1-7 保护路径硬规则：写工具（isUndoTrigger）碰受保护目录（.git/.ssh/.aws/.deepSeekCode 等）→ 无论授权都拒
                    //   优先级最高（先于 checkPermission 用户规则）：即使用户 allow 了，也禁改 VCS/凭证/项目配置目录。
                    if (isUndoTrigger(calledName) && isProtectedWrite(calledArgs?.path, toolCtx.cwd)) {
                        denied = true;
                        result = `❌ [保护路径] 禁止修改受保护目录（.git/.ssh/.aws/.deepSeekCode 等 VCS/凭证/配置）：${calledArgs?.path ?? ''}。`;
                    }
                    // ★ G1 细粒度权限规则（deny>ask>allow）：allow 免审、deny 直拒、ask 强制审批；未匹配走默认 safetyLevel
                    try {
                        const perm = checkPermission(calledName, calledArgs);
                        if (perm === 'deny') { denied = true; result = `❌ [权限规则]：[${calledName}] 被权限规则 deny 拒绝。`; }
                        else if (perm === 'allow') { needApproval = false; }
                        else if (perm === 'ask') { needApproval = true; }
                    } catch { /* fail-safe：权限裁决异常 → 走默认 safetyLevel 行为 */ }
                    // ★ isSync:false 后台工具的互斥锁快速失败（审批前判断，避免无谓弹窗）
                    const isBgTool = matchedTool.function.isSync === false;
                    const lockKey = isBgTool ? computeLockKey(matchedTool.function.exclusiveLock, calledArgs, toolCtx) : null;
                    if (lockKey && isLockHeld(lockKey)) {
                        denied = true;
                        result = `🔒 [互斥锁阻塞]：已有后台任务持有锁 [${lockKey}]，[${calledName}] 调用被跳过。`;
                    }
                    // ★ P1-6 auto permission mode：分类器仅 permissionMode==='auto' 且 needApproval 且 !denied 时介入。
                    //   allow → 免审放行（allow-once 语义，不写持久规则）；deny → 内置高危清单硬拒；ask → 保持 needApproval 转人工（fail-closed）。
                    //   优先级：checkPermission 显式规则（上方已判）> auto deny 清单 > auto 分类器 > requestApproval 人工 > safetyLevel 默认。
                    if (options.permissionMode === 'auto' && needApproval && !denied) {
                        const auto = await runAutoCheck(calledName, calledArgs, toolCtx);
                        if (auto === 'allow') { needApproval = false; }
                        else if (auto === 'deny') { denied = true; result = `❌ [auto] 内置高危清单拦截：[${calledName}] ${calledArgs?.path ?? ''}。`; }
                        // 'ask'（risky/不确定/超时/异常/非文件编辑/工作区外）→ 不改 needApproval，落入下方 requestApproval 转人工
                    }
                    if (needApproval && !denied) {
                        const ra = matchedTool.function.requireApproval;
                        let detail = `申请执行高危工具 [${calledName}]`;
                        try { if (ra) detail = typeof ra === 'function' ? await ra(calledArgs, toolCtx) : ra; }
                        catch (e: any) { denied = true; result = `❌ [审批描述生成异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`; }
                        if (!denied) {
                            let approved = false;
                            try { approved = await requestApproval(calledName, toolCall.id, detail, toolCtx, level, calledArgs); }
                            catch (e: any) { denied = true; result = `❌ [审批流程异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`; }
                            if (!approved && !denied) { denied = true; result = `❌ [安全熔断]：用户拒绝了 [${calledName}] 的执行申请。`; }
                        }
                    }
                    // ★ pre-hooks：审批通过后、执行前注入用户自定义逻辑（可 deny 拦截，异常 fail-closed）
                    if (!denied) {
                        let veto: { deny: boolean; reason?: string };
                        try { veto = await runPreHooks(calledName, calledArgs, toolCtx); }
                        catch (e: any) { veto = { deny: true, reason: `❌ [Pre-hook 异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。` }; }
                        if (veto.deny) { denied = true; result = veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`; }
                    }
                    // ★ Undo 写前备份：审批+pre-hook 放行后、execute 写盘前快照原文件/目录（凡改必可回退，失败则阻断写入）
                    if (!denied && isUndoTrigger(calledName)) {
                        try { await beforeMutationBackup(calledName, calledArgs, toolCall.id, sessionId); }
                        catch (e: any) { denied = true; result = `❌ [Undo 备份失败·安全熔断]：${e?.message ?? e}。写入已阻止（凡改必可回退原则）。`; }
                    }
                    if (!denied) {
                        try {
                            events({ sessionId, eventType: 'tool.execute.start', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin' }, payload: { output: JSON.stringify(calledArgs) } });
                            // 执行工具（取消由 ctx.abortSignal 驱动；长任务走 isSync:false 后台模式，不挂固定 timeout）
                            const execRet = matchedTool.function.execute(calledArgs, toolCtx);
                            if (isBgTool) {
                                // 后台工具：取首个 yield 为即时结果，剩余后台排空，锁在任务结束时释放
                                result = await runBackgroundTool(execRet as any, lockKey, calledName, signal);
                            } else {
                                // 流式工具：逐块 yield → emitProgress → tool.progress UIEvent（运行期间逐行可见）
                                result = await collectToolResult(execRet, (chunk) => toolCtx.emitProgress?.(chunk));
                            }
                            // verifyResult 判定：FAILED 时前置警告（防模型对报错产生"成功"幻觉）
                            if (matchedTool.function.verifyResult) {
                                const verdict = matchedTool.function.verifyResult(result, toolCtx);
                                if (verdict.status === ToolExecutionResultStatus.FAILED) {
                                    result = `【系统判定：执行失败】${verdict.summary ?? ''}\n请正视下方输出，不要乐观假设成功。\n\n${result}`;
                                }
                            }
                            events({ sessionId, eventType: 'tool.execute.end', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: true }, payload: { output: result } });
                        } catch (err) {
                            console.error(`❌ 执行工具 ${calledName} 时发生错误:`, err);
                            result = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
                            events({ sessionId, eventType: 'tool.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
                        }
                        // post-hooks：执行后观察（不拦截，自身异常仅告警）
                        await runPostHooks(calledName, calledArgs, result, toolCtx).catch((e: any) => {
                            console.warn(`⚠️ post-hook [${calledName}] 异常（已忽略）:`, e?.message ?? e);
                        });
                    }
                } else {
                    result = `错误：未知工具 "${calledName}" 或该工具无可执行函数`;
                    explicitOk = false; // 未知工具显式失败，避免前缀嗅探误判为成功
                    events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
                }
                // 脱敏（verifyResult 之后、truncate 之前；只影响发往云端模型的视图）
                result = applyPrivacyMasking(matchedTool?.function?.privacyMaskingRules, calledArgs, result);
                result = truncateToolResult(result, matchedTool?.function?.maxOutputCharacters);
                const FAILED_PREFIXES = ["工具执行失败", "参数解析失败", "❌", "【系统判定", "🔒", "读取文件失败", "项目树扫描失败", "符号大纲分析失败", "操作失败:"];
                const ok = explicitOk ?? !FAILED_PREFIXES.some(p => result.startsWith(p));
                // outputFilter：分流 toModel（精简，喂模型）/ toUser（完整，给用户看）；未声明则两者均原 result
                let resultForModel = result;
                let resultForUser = result;
                if (matchedTool?.function?.outputFilter) {
                    try {
                        const split = matchedTool.function.outputFilter(result);
                        resultForModel = split.toModel;
                        resultForUser = split.toUser;
                    } catch { /* 容错：outputFilter 异常则两者均用原 result */ }
                }
                return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel, resultForUser, ok };
            };
            // ★ P0-1 分波调度：开启 parallelSafeTools 时，连续的 SAFE 只读工具并发执行（Promise.all）；
            //   写工具 / ask / deny / 后台 / 终结类 / parseFailed / unknown 一律串行（= 现状，零回归）。
            //   屏障：写工具走串行（其前并发批次已 await 完成 → undo 备份读到未改原文件）；appendMessage 始终
            //   串行 flush（JSONL append 非并发安全）；tool.end / message.push 按请求序，使模型行为确定。
            const parallelSafeToolsEnabled = appConfig.parallelSafeTools;
            const parseTc = (tc: any): { name: string; args: any; parseFailed: boolean } => {
                if (tc.type !== 'function') return { name: "", args: {}, parseFailed: true };
                let args: any = {}; let parseFailed = false;
                try { args = JSON.parse(tc.function.arguments || "{}"); } catch { parseFailed = true; }
                return { name: tc.function.name, args, parseFailed };
            };
            const canParallelize = (name: string, args: any, parseFailed: boolean): boolean => {
                if (!parallelSafeToolsEnabled || parseFailed || signal?.aborted) return false;
                if (name === 'exit_plan_mode' || name === 'enter_plan_mode') return false;
                if (isUndoTrigger(name)) return false;
                const matched = rawTools.find((t: any) => t.function.name === name);
                if (!matched) return false;
                if (matched.function.safetyLevel !== ToolSafetyLevel.SAFE) return false;
                if (matched.function.isSync === false) return false;
                try {
                    const perm = checkPermission(name, args);
                    if (perm === 'ask' || perm === 'deny') return false;
                } catch { return false; }
                return true;
            };
            const tcs = assistantMessage.tool_calls!;
            let idx = 0;
            while (idx < tcs.length) {
                // 上一工具已中止 → 剩余全部补占位并退出（终结类不受影响：其 processToolCall 终结判定先于 abort）
                if (abortedDuringTools) {
                    for (let j = idx; j < tcs.length; j++) {
                        const ph = "（已中止，未执行）";
                        message.push({ role: 'tool', tool_call_id: tcs[j].id, content: ph });
                        await appendMessage({ sessionId, role: 'tool', tool_call_id: tcs[j].id, content: ph });
                    }
                    break;
                }
                const tc = tcs[idx];
                const { name: pname, args: pargs, parseFailed: pparseFailed } = parseTc(tc);
                if (canParallelize(pname, pargs, pparseFailed)) {
                    // 收集连续可并发段
                    const batch: any[] = [];
                    while (idx < tcs.length) {
                        const btc = tcs[idx];
                        const bp = parseTc(btc);
                        if (!canParallelize(bp.name, bp.args, bp.parseFailed)) break;
                        batch.push(btc);
                        idx++;
                    }
                    // 先发所有 tool.start（请求序）
                    for (const btc of batch) {
                        const bp = parseTc(btc);
                        yield { type: 'tool.start', toolCallId: btc.id, toolName: bp.name, args: bp.args };
                    }
                    // 并发执行
                    const outcomes = await Promise.all(batch.map((btc) => processToolCall(btc)));
                    // 串行 flush（请求序）
                    for (const oc of outcomes) {
                        yield { type: 'tool.end', toolCallId: oc.toolCallId, toolName: oc.calledName, result: oc.resultForUser, ok: oc.ok };
                        message.push({ role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                        await appendMessage({ sessionId, role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                        if (oc.aborted) abortedDuringTools = true;
                    }
                } else {
                    // 串行分支（屏障工具 / 开关关 / 终结类 / 后台 / parseFailed / unknown / ask / deny）
                    yield { type: 'tool.start', toolCallId: tc.id, toolName: pname, args: pargs };
                    const oc = await processToolCall(tc);
                    if (oc.terminal) {
                        // 终结类：push 本条 result + 补其后占位 + yield plan.* + yield final + 结束 runAgent
                        message.push({ role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                        await appendMessage({ sessionId, role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                        await fillRestPlaceholders(idx);
                        if (oc.terminal.kind === 'exit_plan_mode') {
                            yield { type: 'plan.proposed', plan: oc.terminal.plan || '' };
                            yield { type: 'final', text: oc.terminal.plan || oc.resultForUser };
                        } else {
                            yield { type: 'plan.enterRequested', reason: oc.terminal.reason || '' };
                            yield { type: 'final', text: oc.terminal.reason ? `📋 模型请求进入计划模式：${oc.terminal.reason}` : oc.resultForUser };
                        }
                        return;
                    }
                    yield { type: 'tool.end', toolCallId: oc.toolCallId, toolName: oc.calledName, result: oc.resultForUser, ok: oc.ok };
                    message.push({ role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                    await appendMessage({ sessionId, role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                    if (oc.aborted) abortedDuringTools = true;
                    idx++;
                }
            }
            // 主动停止返回最终消息
            if (abortedDuringTools) {
                yield { type: 'final', text: lastContent || "（已中止）" };
                return;
            }
        }
    } finally {
        // ★ Stop hook（观察）：agent 主循环退出时触发；reason 由各出口标记 + signal.aborted 推断。
        //   dispatch 内部已容错，外层再包 try/catch，绝不击垮主流程。
        try {
            const reason = signal?.aborted ? 'aborted' : stopReason;
            // 与 SessionStart/SessionEnd 对齐：补 cwd，使声明式 Stop hook 的 shell 命令落在项目目录而非 process.cwd() 默认值
            await dispatch('Stop', { sessionId, cwd, lastText: lastContent || '', reason });
        } catch { /* ignore */ }
    }
}
