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
import OpenAI from "openai";
import { appendMessage } from "@/session/transcript.ts";
import { ensureFitsWindow } from "./truncate.ts";
import { AgentEvent, RunAgentOptions } from "./type.ts";
import { dispatch } from "@/tool/hooks.ts";
import { ToolCallContext } from "./toolExecution.ts";
import { createRepeatBreaker } from "./repeatBreaker.ts";
import { prepareToolsAndInjections } from "./systemInjections.ts";
import { scheduleToolCalls, ScheduleResult } from "./toolScheduling.ts";
import { streamInference, InferenceResult } from "./streamInference.ts";
import { createNudgeScheduler } from "./agentNudges.ts";

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
    const sessionId = options.sessionId; // 本次会话id
    // ★ 可观测性埋点安全包装：trace/落盘层异常（磁盘满、JSON 序列化失败、网络上报失败）一律 catch，
    //   绝不冒泡成 unhandled rejection 击垮 agent 主循环（旁路埋点不应拖垮主业务推理）。
    //   全部埋点点位自动获得该保护，无需逐个 await/.catch。
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
    // ★ setup：工具表裁剪（planMode/env）+ schema 清洗 + 摘要槽 + fence 注入（locale/outputStyle/skills/
    //   agents/projectGuide/memory）。抽出到 systemInjections.ts；validationCtx 在其内部构造。
    //   fence 注入幂等、不动 message 下标——保 DeepSeek 隐式前缀缓存（P0-4）。
    const { rawTools, cleanedToolSchemas } = await prepareToolsAndInjections(message, options, events);
    let round = 0;
    let lastContent: string | undefined = "";
    let stopReason: 'normal' | 'aborted' | 'error' | 'repeat' | 'limit' = 'normal';
    // F-1：轮数治理——"让模型自决"为主，硬上限仅作极高兜底（零用户配置、零心智负担）。
    //  主机制：周期性 ephemeral nudge（NUDGE 周期自评 / PHANTOM 空 content / EARLY_FINAL 早收尾）由模型自决
    //         "收尾给答案"还是"继续推进"（对标 CC：不在低轮数硬停，靠模型自收敛 + 用户中止）。
    //         文案/阈值/触发/预算/死循环保险统一抽到 agentNudges.ts；此处仅持实例 + 薄调用，控制流与提示词解耦。
    //  兜底：MAX_AGENT_ROUNDS 极高（500），仅防失控烧 token 的病理死循环；正常任务不会触及，触及亦 graceful（可"继续"接续）。
    const MAX_AGENT_ROUNDS = 500;
    // ★ 首轮 PLAN_FIRST nudge 入参：首条 user prompt（仅顶层 agent；subagent 不引导自主进计划模式）+ 当前 planMode。
    //   looksComplex 命中即在首轮注入「先调 enter_plan_mode 规划」引导，配合 systemPrompt 强提示扭转从不进计划模式的问题。
    const firstPrompt = (() => {
        if (depth !== 0) return "";
        const m = (message as any[]).find((x) => x?.role === "user");
        return typeof m?.content === "string" ? m.content : "";
    })();
    const nudges = createNudgeScheduler({ firstPrompt, planMode: !!options.planMode });
    const userDecisionSource = depth > 0 ? 'spawn_agent' : 'user'
    const llmDecisionSource = depth > 0 ? 'llm_spawn_agent' : 'llm'

    const startTime = performance.now();
    // ★ 重复工具调用熔断器（完整签名 3 次 / 后台轮询同任务 4 次）：跨轮有状态，每轮推理后 check()。
    //   从 runAgent 抽出到 repeatBreaker.ts；breaker 持有安全 events 自行发 tool.resolve / tool.repeat_break 埋点。
    const breaker = createRepeatBreaker({ sessionId, depth, llmDecisionSource, startTime, events });
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
                // ★ 用户主动中止（点清空 / 停止）恰好打断压缩摘要请求：summarize 的 API 请求会抛
                //   "Request was aborted"。此处优先判 signal.aborted 走安静收尾，避免污染错误日志
                //   + 向用户显示"（Request was aborted）"误导性文案。
                if (signal?.aborted) {
                    yield { type: 'final', text: lastContent || "（已中止）" };
                    return;
                }
                const msg = e instanceof Error ? e.message : String(e);
                console.error("❌ " + msg);
                stopReason = 'error';
                yield { type: 'final', text: (lastContent || "") + `\n（${msg}）` };
                return
            }

            // ★ ephemeral nudge（NUDGE/PHANTOM/EARLY_FINAL 三类）：走「推理时附加尾部副本」，不进 message 数组/
            //   transcript/压缩 → 保 message[0] 前缀绝对稳定，DeepSeek 隐式缓存跨轮命中。优先级与文案见 agentNudges.ts。
            const nudgeMsg = nudges.pickNudge(round);
            // ★ 流式推理抽出到 streamInference.ts：yield text.delta/thinking.delta/text.reset，return InferenceResult。
            //   yield* 委托透传流式事件并取 return value（内含 idle/API/context_length 三道有限重试、abort partial 落盘、
            //   llm.request/response/error 埋点、assistantMessage 拼装）。final 永远在此处 yield，streamInference 不 yield final。
            const infResult: InferenceResult = yield* streamInference({
                message, nudgeMsg, sessionId, depth, round, startTime,
                userDecisionSource, llmDecisionSource, signal,
                cleanedToolSchemas, model: options.model, thinkingLevel: options.thinkingLevel,
                events, keepRecentUnits, compactRatio, modelWindow,
            });
            if (infResult.kind === 'aborted') {
                // partialText 由 streamInference 在仅文本无半截 tool_call 时落盘后带回；异常路径中止则空，回落 lastContent
                yield { type: 'final', text: infResult.partialText || lastContent || "（已中止）" };
                return;
            }
            if (infResult.kind === 'error') {
                stopReason = 'error';
                yield { type: 'final', text: lastContent || "（发生错误）" };
                return;
            }
            // assistantMessage 已由 streamInference 委托 provider.buildAssistantMessage 构造完成（含厂商扩展字段，
            //   如 DeepSeek 的 reasoning_content）。此处整体落盘 + ...spread 透传，杜绝手工列举字段名漏挂——
            //   DeepSeek 思考模式下含工具调用的轮次必须回传 reasoning_content，否则 API 返回 400；
            //   cleanMsg / appendMessage 均 ...rest 透传，保证会话恢复后 buildContextMessages 重建的上下文
            //   仍带该字段，回传链不中断。
            // as any：Msg(ChatCompletionMessageParam) 是联合类型，.content/.tool_calls 不在所有成员上，
            //   直接访问触发「不存在属性」；此处一律按 any 窄化访问（与原 .tool_calls as any 同惯法）。
            const assistantMessage = infResult.assistantMessage as any;
            message.push(assistantMessage);
            await appendMessage({ ...assistantMessage, sessionId } as any);
            // 存储最后一条消息，以供后面返回使用
            if (assistantMessage.content) {
                lastContent = assistantMessage.content;
            }

            // 1、如果本次无调用工具或者工具调用完成后，则主动跳出循环
            const tcCount = assistantMessage.tool_calls?.length ?? 0;
            if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                const finalText = (typeof assistantMessage.content === 'string' ? assistantMessage.content : "") || "";
                // ★ 收尾拦截（PHANTOM 空 content / EARLY_FINAL 早收尾）：命中即注入 nudge 并 continue 推进，
                //   否则放行真实收尾。判定 / 文案 / 预算 / 死循环保险全在 agentNudges.interceptFinal。
                const intercepted = nudges.interceptFinal(finalText, round);
                if (intercepted) continue;
                // 优先用当前轮 content，避免纯工具轮后 lastContent 陈旧导致终态回显旧文本
                yield { type: 'final', text: finalText || lastContent || "" };
                return;
            }
            // 有 tool_calls = 实质推进 → 通知 nudge 调度器重置空响应预算（只计连续空包）
            nudges.noteToolCall(round);
            // 2、重复工具调用熔断（完整签名 3 次 / 后台轮询同任务 4 次）：委托 repeatBreaker。
            //    breaker 内部发 tool.repeat_break / tool.resolve 埋点；tripped 则 yield final + return。
            const repeatVerdict = breaker.check(assistantMessage.tool_calls, round, lastContent);
            if (repeatVerdict.tripped) {
                stopReason = 'repeat';
                yield { type: 'final', text: repeatVerdict.text };
                return;
            }
            // ★ 工具执行上下文：每轮推理后构造一次，透传给 scheduleToolCalls→processToolCall。
            //   round 取当前轮值（每轮递增）；逐字段比对 ToolCallContext，避免漏传 onUIEvent/requestApproval/
            //   requestQuestion/permissionMode（subagent 透传给子 agent toolCtx，漏传则审批死锁）。
            const toolCallCtx: ToolCallContext = {
                sessionId, cwd, depth, round, startTime, llmDecisionSource,
                signal, rawTools, events,
                permissionMode: options.permissionMode,
                onUIEvent: options.onUIEvent,
                requestApproval: options.requestApproval,
                requestQuestion: options.requestQuestion,
                keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt,
            };
            // ★ 分波调度抽出到 toolScheduling.ts：yield tool.start/tool.end/plan.*，return ScheduleResult。
            //   yield* 委托透传工具事件并取 return value；aborted/terminal yield final + return，completed 继续下一轮。
            //   调度内部异常不自理，上抛至此处外层 catch(toolErr) 兜底 yield final（与原内联实现一致）。
            const scheduleResult: ScheduleResult = yield* scheduleToolCalls(assistantMessage, message, toolCallCtx);
            if (scheduleResult.kind === 'aborted') {
                yield { type: 'final', text: lastContent || "（已中止）" };
                return;
            }
            if (scheduleResult.kind === 'terminal') {
                yield { type: 'final', text: scheduleResult.terminalText };
                return;
            }
            // completed：继续下一轮推理
        }
    } catch (toolErr) {
        // ★ 工具执行段兜底（P0）：assistantMessage 落盘 / processToolCall / appendMessage / Promise.all
        //   等若抛出未守护异常（磁盘 IO 失败、锁/截断边界异常等），原先会逃出 generator → 消费层 for-await
        //   无 catch → final 永不发 → 前端 busy 永不清（永久卡死）。此处兜住，必定 yield final 收尾。
        //   流式推理段的异常已被上方内层 catch 处理（yield final + return），不会到达此处。
        if (signal?.aborted) {
            yield { type: 'final', text: lastContent || "（已中止）" };
            return;
        }
        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        console.error('❌ agent 工具执行段异常（兜底收尾）:', errMsg);
        stopReason = 'error';
        yield { type: 'final', text: (lastContent || "") + `\n（工具执行异常：${errMsg}）` };
        return;
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
