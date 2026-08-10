/**
 * @file agent/toolScheduling.ts
 * @description 分波工具调度（async generator）。
 *  开启 parallelSafeTools 时，连续的 SAFE 只读工具并发执行（Promise.all）；写工具/ask/deny/后台/终结类/
 *  parseFailed/unknown 一律串行（= 现状，零回归）。
 *
 *  从 runAgent 工具执行段抽出。yield tool.start/tool.end/plan.proposed/plan.enterRequested；
 *  return ScheduleResult（completed/aborted/terminal）——final 永远由主循环 yield，本模块绝不 yield final。
 *  消费方（主循环）须手动 .next() 迭代以获取 return value（for-await 取不到 generator return value），
 *  并对 ScheduleResult.kind 做穷尽 switch（漏 kind 即行为缺失）。
 *  异常不在此处理：上抛到主循环外层 catch(toolErr) 兜底 yield final（与原内联实现一致）。
 */
import type OpenAI from "openai";
import { AgentEvent } from "./type.ts";
import { processToolCall, ToolCallContext } from "./toolExecution.ts";
import { appendMessage } from "@/session/transcript.ts";
import { appConfig } from "@/config/index.ts";
import { ToolSafetyLevel } from "@/tool/index.ts";
import { checkPermission } from "@/tool/permissions.ts";
import { isUndoTrigger } from "@/tool/undo/backup.ts";

/** 调度结果（判别联合）：
 *  - completed —— 本轮工具全部执行完，主循环继续下一轮推理；
 *  - aborted   —— 中途有工具被中止（signal.aborted），剩余已补占位，主循环 yield final(已中止) + return；
 *  - terminal  —— 命中终结类工具（exit/enter_plan_mode），主循环 yield final(terminalText) + return。 */
export type ScheduleResult =
    | { kind: 'completed' }
    | { kind: 'aborted' }
    | { kind: 'terminal'; terminalText: string };

/**
 * 分波调度工具调用。yield 工具流程事件，return ScheduleResult。
 * @param assistantMessage 本轮推理产出的 assistant 消息（含 tool_calls）
 * @param message          会话消息数组（原地 push tool result，供下一轮推理）
 * @param ctx              工具调用上下文（复用 ToolCallContext：既是调度依赖也是 processToolCall 入参；
 *                         逐字段比对避免漏传 onUIEvent/requestApproval/requestQuestion/permissionMode，
 *                         subagent 透传给子 agent toolCtx，漏传则审批死锁）
 */
export const scheduleToolCalls = async function* (
    assistantMessage: any,
    message: OpenAI.Chat.ChatCompletionMessageParam[],
    ctx: ToolCallContext,
): AsyncGenerator<AgentEvent, ScheduleResult> {
    const { sessionId, signal, rawTools } = ctx;
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
        if (name === 'exit_plan_mode' || name === 'enter_plan_mode' || name === 'ask_question') return false;
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
            const outcomes = await Promise.all(batch.map((btc) => processToolCall(btc, ctx)));
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
            const oc = await processToolCall(tc, ctx);
            if (oc.terminal) {
                // 终结类：push 本条 result + 补其后占位 + yield tool.end + yield plan.* + return terminal
                message.push({ role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                await appendMessage({ sessionId, role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                await fillRestPlaceholders(idx);
                // ★ 补 tool.end：终结类上方已 yield tool.start，但原逻辑直接跳 plan.*/final 未 yield tool.end，
                //   导致 CLI 的 ToolCard 永远停在「运行中…」（status 恒 running、滞留动态区），表现为 enter_plan_mode 卡死。
                //   工具实际已成功完成（用户已看到方案/进入请求），补发 tool.end 让前端把卡片标记 done 并移出动态区。
                yield { type: 'tool.end', toolCallId: oc.toolCallId, toolName: oc.calledName, result: oc.resultForUser, ok: oc.ok };
                if (oc.terminal.kind === 'exit_plan_mode') {
                    yield { type: 'plan.proposed', plan: oc.terminal.plan || '' };
                    return { kind: 'terminal', terminalText: oc.terminal.plan || oc.resultForUser };
                } else {
                    yield { type: 'plan.enterRequested', reason: oc.terminal.reason || '' };
                    return { kind: 'terminal', terminalText: oc.terminal.reason ? `📋 模型请求进入计划模式：${oc.terminal.reason}` : oc.resultForUser };
                }
            }
            yield { type: 'tool.end', toolCallId: oc.toolCallId, toolName: oc.calledName, result: oc.resultForUser, ok: oc.ok };
            message.push({ role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
            await appendMessage({ sessionId, role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
            if (oc.aborted) abortedDuringTools = true;
            idx++;
        }
    }
    // 主动停止：剩余已补占位，主循环据此 yield final(已中止)；否则本轮完成，继续下一轮推理
    if (abortedDuringTools) return { kind: 'aborted' };
    return { kind: 'completed' };
};
