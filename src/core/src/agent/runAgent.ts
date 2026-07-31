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
import { requestApproval } from "@/tool/guard.ts";
import { checkPermission } from "@/tool/permissions.ts";
import { filterToolsForPlanMode, PLAN_MODE_SYSTEM_HINT, appendEnterPlanModeTool, PLAN_MODE_AUTO_ENTER_HINT } from "./planMode.ts";
import { runPreHooks, runPostHooks, dispatch } from "@/tool/hooks.ts";
import { computeLockKey, isLockHeld } from "@/tool/lockManager.ts";
import { runBackgroundTool } from "./backgroundTool.ts";
import { filterByEnvironment } from "./toolFilter.ts";
import { beforeMutationBackup, isUndoTrigger } from "@/tool/undo/backup.ts";
import { injectSkillCatalog } from "@/skills/inject.ts";
import { injectAgentCatalog } from "@/agents/inject.ts";
import { injectProjectGuide } from "@/projectGuide/inject.ts";

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
    // 计划模式：向系统提示词注入只读约束；非计划模式：注入自主进入计划模式的引导（均带唯一标记防重复追加）
    {
        const sys = message[0] as any;
        if (sys && sys.role === 'system' && typeof sys.content === 'string') {
            if (options.planMode) {
                if (!sys.content.includes("【计划模式】")) {
                    sys.content += `\n\n${PLAN_MODE_SYSTEM_HINT}`;
                }
            } else if (!sys.content.includes("【自主计划模式】")) {
                sys.content += `\n\n${PLAN_MODE_AUTO_ENTER_HINT}`;
            }
        }
    }
    // 回复语言：按 locale 注入「用中文/英文回复」引导（带【回复语言】标记防重复追加）
    if (options.locale) {
        const sys = message[0] as any;
        if (sys && sys.role === 'system' && typeof sys.content === 'string' && !sys.content.includes("【回复语言】")) {
            const hint = options.locale === "zh" ? "【回复语言】请始终用中文回复用户。" : "【回复语言】Always reply to the user in English.";
            sys.content += `\n\n${hint}`;
        }
    }
    // ★ Skills：把【可用技能目录】幂等注入系统提示词（复刻 planMode 追加模式，不动 message 下标）
    injectSkillCatalog(message);
    injectAgentCatalog(message);
    injectProjectGuide(message);
    let round = 0;
    let lastContent: string | undefined = "";
    let stopReason: 'normal' | 'aborted' | 'error' | 'repeat' | 'limit' = 'normal';
    const recentSignatures: string[] = [];
    // F-1：轮数治理——"让模型自决"为主，硬上限仅作极高兜底（零用户配置、零心智负担）。
    //  主机制：每 NUDGE_EVERY 轮向系统提示词注入一次自评提醒，由模型自己决定"收尾给答案"还是"继续推进"
    //         （对标 Claude Code：不在低轮数硬停，靠模型自收敛 + 用户中止）。
    //  兜底：MAX_AGENT_ROUNDS 极高（500），仅防失控烧 token 的病理死循环；正常任务不会触及，触及亦 graceful（可"继续"接续）。
    const NUDGE_EVERY = 40;
    const NUDGE_MARK = "【轮数自评】";
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
            // ★ 软提醒（让模型自决）：每 NUDGE_EVERY 轮注入自评提示，由模型决定"收尾给答案"还是"继续推进"。
            //   不硬停、零用户配置（对标 Claude Code：靠模型自收敛 + 用户中止）。NUDGE_MARK 标记幂等替换，不堆积、不污染。
            if (round > 1 && round % NUDGE_EVERY === 1) {
                const sys = message[0] as any;
                if (sys?.role === 'system' && typeof sys.content === 'string') {
                    sys.content = sys.content.split(NUDGE_MARK)[0].trimEnd();
                    sys.content += `\n\n${NUDGE_MARK}你已执行约 ${round} 轮工具调用。请自评：若任务已可完成，立即给出最终答案、不再调用工具；若确需更多步骤，继续，但确保每步都在实质推进任务、不重复检索。`;
                }
            }
            yield { type: 'round.start', round };
            // 前端用户主动停止运行
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
                        prompt_tokens: estimateTokens(message),
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
                for await (const chunk of chatWithModelWithTools(message, cleanedToolSchemas, { signal, model: options.model, thinkingLevel: options.thinkingLevel })) {
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
                        compress_tokens: lastUsage?.total_tokens,
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
                yield { type: 'final', text: lastContent || "" };
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
                    eventType: 'tool.denied',
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
            for (const toolCall of assistantMessage.tool_calls) {
                let calledName = "";
                let calledArgs: any = {};
                let parseFailed = false; // 判读是否解析失败
                if (toolCall.type === 'function') {
                    calledName = toolCall.function.name;
                    try { calledArgs = JSON.parse(toolCall.function.arguments || "{}"); }
                    catch { parseFailed = true; }
                    console.log(`🤖 模型请求调用工具: ${calledName}，参数:`, calledArgs);
                }
                // ★ 计划模式终结：模型提交实现方案 → yield plan.proposed 并结束循环（不走常规 execute）
                //   设计选择：exit_plan_mode 的拦截故意先于 abort 占位检查——模型已主动提交的方案应当呈现给
                //   用户审批；abort 主要约束后续「实现阶段」的工具执行，而非吞掉已提交的方案。
                //   （极端 edge case：提交与中止同拍时优先展示方案，符合「计划先于执行」语义。）
                if (calledName === "exit_plan_mode") {
                    const plan = typeof calledArgs?.plan === "string" ? calledArgs.plan : "";
                    const note = "✅ [计划模式] 实现方案已提交，等待用户审批后进入实现阶段。";
                    message.push({ role: 'tool', tool_call_id: toolCall.id, content: note });
                    await appendMessage({ sessionId, role: 'tool', tool_call_id: toolCall.id, content: note });
                    yield { type: 'plan.proposed', plan };
                    yield { type: 'final', text: plan || note };
                    return;
                }
                // ★ 自主进入计划模式：非计划模式下模型主动请求先规划 → 结束本轮，通知上层翻转 planMode 并以只读重跑。
                //   与 exit_plan_mode 对称：拦截先于 abort 占位检查，避免吞掉模型已发出的进入请求。
                //   约定：终结类工具（exit/enter_plan_mode）应单独调用，不与其它工具并行——否则本条 assistant
                //   消息中排在之后的 tool_call 不会补 result。与 exit_plan_mode 同假设。
                if (calledName === "enter_plan_mode") {
                    const reason = typeof calledArgs?.reason === "string" ? calledArgs.reason : "";
                    const note = "📋 [进入计划模式] 模型请求先以只读方式调研并规划方案，已切换至计划模式。";
                    message.push({ role: 'tool', tool_call_id: toolCall.id, content: note });
                    await appendMessage({ sessionId, role: 'tool', tool_call_id: toolCall.id, content: note });
                    yield { type: 'plan.enterRequested', reason };
                    yield { type: 'final', text: reason ? `📋 模型请求进入计划模式：${reason}` : note };
                    return;
                }
                // abort 占位：为未执行的 tool_call 补 result，保证下次读回配对完整
                if (signal?.aborted) {
                    abortedDuringTools = true;
                    const placeholder = "（已中止，未执行）";
                    message.push({ role: 'tool', tool_call_id: toolCall.id, content: placeholder });
                    await appendMessage({ sessionId, role: 'tool', tool_call_id: toolCall.id, content: placeholder });
                    continue;
                }
                const matchedTool = rawTools.find((t: any) => t.function.name === calledName);
                // ★ execute 传入 ctx（sessionId/abortSignal/depth），spawn_agent 用它创建子 agent
                // cc 风格：取消统一由用户主动中断（ctx.abortSignal）驱动，不在工具级挂固定定时器超时
                // （对标 Claude Code：长任务走 isSync:false 后台模式，而非固定 timeoutMs 杀进程，避免误杀合法长构建/测试）
                const toolCtx: ToolContext = { sessionId, cwd, abortSignal: signal, depth, keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt, events, onUIEvent: options.onUIEvent, requestApproval: options.requestApproval, emitProgress: (message: string) => options.onUIEvent?.({ type: 'tool.progress', toolsId: toolCall.id, toolName: calledName, message }) };
                let result = "";
                // ★ 显式成败标志：校验/工具层可显式声明 ok（如未知工具），优先于下方前缀嗅探。
                //   null=未显式声明 → 回退前缀嗅探；与"让 execute 返回显式 {status}"的演进方向一致。
                let explicitOk: boolean | null = null;
                yield { type: 'tool.start', toolCallId: toolCall.id, toolName: calledName, args: calledArgs };
                if (parseFailed) {
                    result = `参数解析失败：模型返回的 arguments 不是合法 JSON${JSON.stringify(toolCall).slice(0, 300)}`;
                    events({
                        sessionId: sessionId,
                        eventType: 'tool.validation.failed',
                        metadata: {
                            depth: depth,
                            decisionSource: llmDecisionSource,
                            durationMs: performance.now() - startTime,
                            round,
                            tools_id: toolCall.id,
                            toolName: calledName,
                            toolSource: 'builtin',
                            ok: false,
                            attempt: round
                        },
                        payload: {
                            output: result,
                        }
                    })
                } else if (matchedTool && typeof matchedTool.function.execute === 'function') {
                    // ★ 安全分级审批：SAFE 免审；MUTATION/DANGER 执行前由执行层统一请求用户审批
                    //   （MUTATION 将来接入 --yes / 免审目录配置后可自动放行，此处先默认需审）
                    const level = matchedTool.function.safetyLevel;
                    let needApproval = level === ToolSafetyLevel.MUTATION || level === ToolSafetyLevel.DANGER;
                    let denied = false;
                    // ★ G1 细粒度权限规则（deny>ask>allow）：命中 allow 免审批；deny 直接拒（作用于所有工具含 SAFE）；
                    //   ask 强制审批（即使 SAFE）；未匹配走默认 safetyLevel。异常一律降级默认（fail-safe）。
                    try {
                        const perm = checkPermission(calledName, calledArgs);
                        if (perm === 'deny') {
                            denied = true;
                            result = `❌ [权限规则]：[${calledName}] 被权限规则 deny 拒绝。`;
                        } else if (perm === 'allow') {
                            needApproval = false;   // 跳过整个审批块，免审批直放行
                        } else if (perm === 'ask') {
                            needApproval = true;    // 即使 SAFE 也强制审批
                        }
                    } catch { /* fail-safe：权限裁决异常 → 走默认 safetyLevel 行为 */ }
                    // ★ isSync:false 后台工具的互斥锁快速失败（审批前判断，避免无谓弹窗）
                    const isBgTool = matchedTool.function.isSync === false;
                    const lockKey = isBgTool ? computeLockKey(matchedTool.function.exclusiveLock, calledArgs, toolCtx) : null;
                    if (lockKey && isLockHeld(lockKey)) {
                        denied = true;
                        result = `🔒 [互斥锁阻塞]：已有后台任务持有锁 [${lockKey}]，[${calledName}] 调用被跳过。`;
                    }
                    if (needApproval && !denied) {
                        const ra = matchedTool.function.requireApproval;
                        let detail = `申请执行高危工具 [${calledName}]`;
                        // ★ requireApproval（用户自定义函数）异常一律按拒绝处理，不逃逸出工具循环
                        try {
                            if (ra) detail = typeof ra === 'function' ? await ra(calledArgs, toolCtx) : ra;
                        } catch (e: any) {
                            denied = true;
                            result = `❌ [审批描述生成异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`;
                        }
                        if (!denied) {
                            let approved = false;
                            // ★ 审批通道（宿主）异常一律按拒绝处理（fail-closed），不逃逸出工具循环
                            try {
                                approved = await requestApproval(calledName, toolCall.id, detail, toolCtx, level);
                            } catch (e: any) {
                                denied = true;
                                result = `❌ [审批流程异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`;
                            }
                            if (!approved && !denied) {
                                denied = true;
                                result = `❌ [安全熔断]：用户拒绝了 [${calledName}] 的执行申请。`;
                            }
                        }
                    }
                    // ★ pre-hooks：审批通过后、执行前注入用户自定义逻辑（可 deny 拦截）
                    if (!denied) {
                        // ★ pre-hook 自身异常按"安全失败"拒绝处理（fail-closed），不逃逸出工具循环
                        let veto: { deny: boolean; reason?: string };
                        try {
                            veto = await runPreHooks(calledName, calledArgs, toolCtx);
                        } catch (e: any) {
                            veto = { deny: true, reason: `❌ [Pre-hook 异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。` };
                        }
                        if (veto.deny) {
                            denied = true;
                            result = veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`;
                        }
                    }
                    // ★ Undo 写前备份：审批+pre-hook 放行后、execute 写盘前，对 fs 变更工具快照原文件/目录。
                    //   备份失败一律阻断写入（凡改必可回退）；仅 isSync:true 的四个 fs 工具触发，其余直通。
                    //   首期不覆盖 isSync:false 后台工具的写操作（其 lockKey 占用前已返回，备份时序复杂）。
                    if (!denied && isUndoTrigger(calledName)) {
                        try {
                            await beforeMutationBackup(calledName, calledArgs, toolCall.id, sessionId);
                        } catch (e: any) {
                            denied = true;
                            result = `❌ [Undo 备份失败·安全熔断]：${e?.message ?? e}。写入已阻止（凡改必可回退原则）。`;
                        }
                    }
                    if (!denied) {
                        try {
                            events({
                                sessionId: sessionId,
                                eventType: 'tool.execute.start',
                                metadata: {
                                    depth: depth,
                                    decisionSource: llmDecisionSource,
                                    durationMs: performance.now() - startTime,
                                    round,
                                    tools_id: toolCall.id,
                                    toolName: calledName,
                                    toolSource: 'builtin',
                                },
                                payload: {
                                    output: JSON.stringify(calledArgs),
                                }
                            })
                            // 执行工具（cc 风格：不设定时器超时；取消由用户主动中断 ctx.abortSignal 驱动，
                            //   command 等工具已把 abortSignal 接到 spawn，中断即真正终止底层任务）
                            const execRet = matchedTool.function.execute(calledArgs, toolCtx);
                            if (isBgTool) {
                                // ★ isSync:false 后台工具：取首个 yield 为即时结果（不阻塞循环），剩余后台排空，锁在任务结束时释放
                                //   signal 透传：用户停止时后台 generator 立即收尾 + 释放锁，避免孤儿后台任务
                                result = await runBackgroundTool(execRet as any, lockKey, calledName, signal);
                            } else {
                                // ★ 实时 stdout：流式工具（run_command 等）逐块 yield → onChunk → toolCtx.emitProgress
                                //   → tool.progress UIEvent，前端即可在命令运行期间看到逐行输出，而非结束后才整块到达。
                                result = await collectToolResult(execRet, (chunk) => toolCtx.emitProgress?.(chunk));
                            }
                            // verifyResult 判定：工具自报成败，FAILED 时前置警告（防模型对报错产生“成功”幻觉）
                            if (matchedTool.function.verifyResult) {
                                const verdict = matchedTool.function.verifyResult(result, toolCtx);
                                if (verdict.status === ToolExecutionResultStatus.FAILED) {
                                    result = `【系统判定：执行失败】${verdict.summary ?? ''}\n请正视下方输出，不要乐观假设成功。\n\n${result}`;
                                }
                            }
                            events({
                                sessionId: sessionId,
                                eventType: 'tool.execute.end',
                                metadata: {
                                    depth: depth,
                                    decisionSource: llmDecisionSource,
                                    durationMs: performance.now() - startTime,
                                    round,
                                    tools_id: toolCall.id,
                                    toolName: calledName,
                                    toolSource: 'builtin',
                                    ok: true,
                                },
                                payload: {
                                    output: result,
                                }
                            })
                        } catch (err) {
                            console.error(`❌ 执行工具 ${calledName} 时发生错误:`, err);
                            result = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
                            events({
                                sessionId: sessionId,
                                eventType: 'tool.failed',
                                metadata: {
                                    depth: depth,
                                    decisionSource: llmDecisionSource,
                                    durationMs: performance.now() - startTime,
                                    round,
                                    tools_id: toolCall.id,
                                    toolName: calledName,
                                    toolSource: 'builtin',
                                    ok: false,
                                    attempt: round
                                },
                                payload: {
                                    output: result,
                                }
                            })
                        }
                        // ★ post-hooks：执行后观察（成功或异常都触发，不拦截）
                        //   自身异常仅告警，绝不击垮主循环（observe-only，不应影响 result）
                        await runPostHooks(calledName, calledArgs, result, toolCtx).catch((e: any) => {
                            console.warn(`⚠️ post-hook [${calledName}] 异常（已忽略）:`, e?.message ?? e);
                        });
                    }
                } else {
                    result = `错误：未知工具 "${calledName}" 或该工具无可执行函数`;
                    explicitOk = false; // ★ 未知工具显式失败：透传到公共 tool.end，避免前缀嗅探（"错误："已移除）误判为成功
                    events({
                        sessionId: sessionId,
                        eventType: 'tool.validation.failed',
                        metadata: {
                            depth: depth,
                            decisionSource: llmDecisionSource,
                            durationMs: performance.now() - startTime,
                            round,
                            tools_id: toolCall.id,
                            toolName: calledName,
                            toolSource: 'builtin',
                            ok: false,
                            attempt: round
                        },
                        payload: {
                            output: result,
                        }
                    })
                }
                // ★ 敏感数据脱敏（privacyMaskingRules）：在 verifyResult 之后、truncate 之前，
                //   把工具返回中的密钥/凭证替换为 [MASKED_SECRET]，再回灌模型上下文。
                //   verifyResult 需原文判定成败，故脱敏只影响「发给云端模型的视图」，不影响本地校验。
                result = applyPrivacyMasking(matchedTool?.function?.privacyMaskingRules, calledArgs, result);
                // 获取工具返回的信息，如果超过最大值，则截取中间，留头尾
                // ★ 防御：未知工具名时 matchedTool 为 undefined（模型幻觉 / 被环境过滤的工具），
                //   用可选链避免 TypeError 击垮主循环（truncateToolResult 第二参数支持 undefined）
                result = truncateToolResult(result, matchedTool?.function?.maxOutputCharacters);
                // ok 判定：result 以任一已知失败前缀开头即判失败（覆盖 runAgent 内部失败 + 各工具 catch/verifyResult 失败），
                //   避免失败结果被判 ok=true 助长模型"已成功"幻觉。
                //   注：前缀列表是过渡方案——根本解法是让 execute 返回显式成败标志（后续工具协议演进），届时可移除此列表。
                // ★ ok 判定（仅作 UI/trace 提示，不进入模型上下文——模型看到的是完整 result 字符串）。
                //   优先级：explicitOk（校验/工具层显式声明，如未知工具=false）＞ 前缀嗅探。
                //   前缀嗅探收窄高碰撞通用词：已移除"错误："（文件内容首行可能是"错误：xxx"日志会误判），
                //   未知工具改由 explicitOk 兜底；保留项目内部专有失败标记（❌/操作失败:/读取文件失败 等），
                //   success 输出均以 [File:/[Workspace 等专有前缀开头，不会与失败标记碰撞。
                //   根本解法（让 execute 返回显式 {status}）是后续工具协议演进，此处保持过渡方案。
                const FAILED_PREFIXES = ["工具执行失败", "参数解析失败", "❌", "【系统判定", "🔒", "读取文件失败", "项目树扫描失败", "符号大纲分析失败", "操作失败:"];
                const ok = explicitOk ?? !FAILED_PREFIXES.some(p => result.startsWith(p));
                // F-2：outputFilter（可选）——工具可把结果分流为"喂模型的精简版（toModel）"与"给用户看的完整版（toUser）"。
                //   未声明时两者均为原 result，行为不变（additive，当前无工具声明则零影响）。
                //   典型场景：长构建日志给用户看全文、给模型只喂摘要，省 token 又保体验。
                let resultForModel = result;
                let resultForUser = result;
                if (matchedTool?.function?.outputFilter) {
                    try {
                        const split = matchedTool.function.outputFilter(result);
                        resultForModel = split.toModel;
                        resultForUser = split.toUser;
                    } catch { /* 容错：outputFilter 异常则两者均用原 result，不阻断 */ }
                }
                yield { type: 'tool.end', toolCallId: toolCall.id, toolName: calledName, result: resultForUser, ok };
                // 存储本次工具结果的消息到上下文中（模型看 toModel 精简版；transcript 与 context 一致）
                message.push({ role: 'tool', tool_call_id: toolCall.id, content: resultForModel });
                // 添加到本地上下文中
                await appendMessage({ sessionId, role: 'tool', tool_call_id: toolCall.id, content: resultForModel });
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
