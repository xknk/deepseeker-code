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
import { processToolCall, ToolCallContext, ToolCallOutcome } from "./toolExecution.ts";
import { appendMessage, appendMessages } from "@/session/transcript.ts";
import { buildImageFollowUpParts } from "@/session/contentParts.ts";
import { appConfig } from "@/config/index.ts";
import { ToolSafetyLevel } from "@/tool/index.ts";
import { checkPermission } from "@/tool/permissions.ts";

/** 调度结果（判别联合）：
 *  - completed —— 本轮工具全部执行完，主循环继续下一轮推理；
 *  - aborted   —— 中途有工具被中止（signal.aborted），剩余已补占位，主循环 yield final(已中止) + return；
 *  - terminal  —— 命中终结类工具（exit/enter_plan_mode），主循环 yield final(terminalText) + return。 */
export type ScheduleResult =
    | { kind: 'completed' }
    | { kind: 'aborted' }
    | { kind: 'terminal'; terminalText: string };

/**
 * P3-6 同轮重复 tool_call 去重（纯函数，供单测）：并行批内 name+arguments 完全一致（原始字符串逐字节
 * 相等，不做归一化——参数本就应由模型确定性生成）的调用只执行首个，其余复用首个的结果。
 * 同轮完全重复 = 模型抽风/循环前兆，重复执行纯浪费；SAFE 只读限定下复用无副作用歧义。
 * @returns plan 请求序全量（dupOf 指向首个同签名 tc，flush 时照发 start/end 防前端卡片滞留 running）；
 *          batch 去重后待执行的首个集合（保持请求序）。
 */
export const dedupeSameRoundCalls = (tcs: any[]): { batch: any[]; plan: Array<{ tc: any; dupOf?: any }> } => {
    const batch: any[] = [];
    const plan: Array<{ tc: any; dupOf?: any }> = [];
    const firstBySig = new Map<string, any>();
    for (const tc of tcs) {
        const sig = `${tc?.function?.name ?? ""}::${tc?.function?.arguments ?? ""}`;
        const first = firstBySig.get(sig);
        if (first) plan.push({ tc, dupOf: first });
        else { firstBySig.set(sig, tc); batch.push(tc); plan.push({ tc }); }
    }
    return { batch, plan };
};

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
    // ★ read_image 图像收集：本波全部工具 flush 完后统一注入一条 user 附件消息。不能在工具 result
    //   flush 时立刻插——OpenAI 兼容端点要求 tool 结果紧随 assistant(tool_calls)，中间夹 user 消息会 400；
    //   注入点必须在 while 循环外（所有 tool 消息落定之后）。
    const pendingImages: NonNullable<ToolCallOutcome['imageAttachments']> = [];
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
        const matched = rawTools.find((t: any) => t.function.name === name);
        if (!matched) return false;
        // ★ #8a 声明化：写工具（声明 triggersUndo）强制串行——屏障保证 undo 备份读到未改原文件
        //   （原 isUndoTrigger/MUTATION_TOOLS 名单退役，改读声明）
        if (matched.function.triggersUndo) return false;
        if (matched.function.safetyLevel !== ToolSafetyLevel.SAFE) return false;
        if (matched.function.isSync === false) return false;
        try {
            const perm = checkPermission(name, args, matched.function.primaryArg);
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
            // 收集连续可并发段 + P3-6 同轮重复去重（name+arguments 逐字节一致只执行首个，flush 仍按请求序）
            const seg: any[] = [];
            while (idx < tcs.length) {
                const btc = tcs[idx];
                const bp = parseTc(btc);
                if (!canParallelize(bp.name, bp.args, bp.parseFailed)) break;
                seg.push(btc);
                idx++;
            }
            const { batch, plan } = dedupeSameRoundCalls(seg);
            // 先发所有 tool.start（请求序，重复项照发——前端按 toolCallId 开卡片，缺 end 会滞留 running）
            for (const p of plan) {
                const bp = parseTc(p.tc);
                yield { type: 'tool.start', toolCallId: p.tc.id, toolName: bp.name, args: bp.args };
            }
            // 并发执行（仅去重后的首个集合）
            const outcomes = await Promise.all(batch.map((btc) => processToolCall(btc, ctx)));
            const outcomeByTc = new Map<any, ToolCallOutcome>();
            batch.forEach((btc, i) => outcomeByTc.set(btc, outcomes[i]));
            // 串行 flush（请求序；重复项复用首个结果并前缀标注，不重复执行）。P2-2：transcript 攒批一次落盘
            //   （open 一次多写，省 Windows/杀软下逐条 open 成本）；message.push 仍逐条按请求序，语义不变。
            const batchEntries: any[] = [];
            const dupSeq = new Map<any, number>(); // 首个 tc → 已复用次数（标注 #N 用）
            for (const p of plan) {
                let oc: ToolCallOutcome;
                if (p.dupOf) {
                    const firstOc = outcomeByTc.get(p.dupOf)!;
                    const n = (dupSeq.get(p.dupOf) ?? 1) + 1;
                    dupSeq.set(p.dupOf, n);
                    const note = `(同轮重复调用 #${n}，已复用 #1 的结果)\n`;
                    oc = { ...firstOc, toolCallId: p.tc.id, resultForModel: note + firstOc.resultForModel, resultForUser: note + firstOc.resultForUser, imageAttachments: undefined };
                } else {
                    oc = outcomeByTc.get(p.tc)!;
                }
                yield { type: 'tool.end', toolCallId: oc.toolCallId, toolName: oc.calledName, result: oc.resultForUser, ok: oc.ok };
                message.push({ role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                batchEntries.push({ sessionId, role: 'tool', tool_call_id: oc.toolCallId, content: oc.resultForModel });
                if (oc.imageAttachments?.length) pendingImages.push(...oc.imageAttachments);
                if (oc.aborted) abortedDuringTools = true;
            }
            await appendMessages(sessionId, batchEntries);
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
            if (oc.imageAttachments?.length) pendingImages.push(...oc.imageAttachments);
            if (oc.aborted) abortedDuringTools = true;
            idx++;
        }
    }
    // ★ read_image 跟随消息注入：本波工具全部落定后追加（含落盘 transcript，跨 run/压缩/重建视图全兼容——
    //   vision 关闸折叠、衰减折叠、按张计价等既有闸门按 parts 数组通用处理）。中止时跳过（主循环即将收尾）。
    if (!abortedDuringTools && pendingImages.length > 0) {
        const parts = buildImageFollowUpParts(pendingImages) as any;
        message.push({ role: 'user', content: parts });
        await appendMessage({ sessionId, role: 'user', content: parts });
    }
    // 主动停止：剩余已补占位，主循环据此 yield final(已中止)；否则本轮完成，继续下一轮推理
    if (abortedDuringTools) return { kind: 'aborted' };
    return { kind: 'completed' };
};
