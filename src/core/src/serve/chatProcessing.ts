/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-11 15:41:07
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-15 17:12:20
 * @FilePath: \deepSeekCode\src\core\src\serve\chatPorcessing.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file serve/chatProcessing.ts
 * @description 对话处理主入口：把入站统一消息（UnifiedInboundMessage）装配成 runAgent 所需的
 *  上下文与 RunAgentOptions，驱动 agent 主循环，并把产出的事件分流——
 *  trace 落盘走 emitTrace，UI 交互（审批）/ 流式文本走 sseWrite 实时推前端。
 *  同时兼容非 SSE 渠道（无 sseWrite 时通过 sendOutbound 回送最终回复）。
 */
import { UnifiedInboundMessage, UnifiedOutboundMessage } from "@/channels/unifiedMessage.ts"
import { runAgent } from "@/agent/runAgent.ts";
import { agentTools } from "@/tool/index.ts";
import { appConfig } from "@/config/index.ts";
import { getOrCreateSessionId } from "@/session/store.ts"
import { appendMessage } from "@/session/transcript.ts";
import { buildContextMessages } from "@/session/content.ts";
import { Msg } from "@/session/contextCore.ts";
import { emitTrace } from "@/observability/trace.ts";
import { TraceBase } from "@/observability/type.ts";
import { RunAgentOptions } from "@/agent/type.ts";
import { createWebRequestApproval } from "@/host/webHost.ts";
import { dispatch } from "@/hooks/registry.ts";

/** 出站消息发送函数（非 SSE 渠道使用）。 */
type OutboundSender = (outbound: UnifiedOutboundMessage) => Promise<void>;
/** SSE 写入函数：把事件对象序列化为 SSE data 帧推给前端。 */
type SseWriter = (obj: Record<string, unknown>) => void;

/**
 * 处理一次统一对话请求：构建上下文 → 发起 runAgent → 分流事件（trace / SSE / outbound）。
 * @param inbound       入站统一消息（用户输入 + 可选 sessionId）
 * @param sendOutbound  非 SSE 渠道的最终回复回送函数（SSE 模式下不调用）
 * @param sseWrite      SSE 写入函数；存在时走流式（text.delta 等实时推），否则走 sendOutbound
 * @param abortSignal   中止信号，透传给 runAgent
 */
export const handleUnifiedChat = async (
    inbound: UnifiedInboundMessage,
    sendOutbound: OutboundSender,
    sseWrite?: SseWriter,
    abortSignal?: AbortSignal,
) => {
    const sessionId: string = inbound.sessionId || await getOrCreateSessionId(inbound.sessionId);
    const startTime = performance.now();

    // ★ UserPromptSubmit hook（serve 层；可拦截整轮）
    //   必须在 serve 层而非 agent 层——agent 层会被 spawn_agent 子任务误触发（子 task 非用户原始输入）。
    const promptVeto = await dispatch('UserPromptSubmit', { sessionId, prompt: inbound.content, cwd: process.cwd() });
    if (promptVeto.deny) {
        const denyMsg = `🚫 [Hook 拦截] 本次输入被拒绝：${promptVeto.reason ?? '未提供原因'}`;
        if (sseWrite) {
            sseWrite({ type: 'final', text: denyMsg });
        } else {
            await sendOutbound({ content: denyMsg, metadata: { sessionId } });
        }
        await emitTrace({
            sessionId,
            eventType: 'session.end',
            metadata: { depth: 0, decisionSource: 'user', durationMs: performance.now() - startTime },
            payload: { output: denyMsg }
        });
        return;
    }

    const SYSTEM_PROMPT = `你是一个能调用工具的助手。任务完成后直接用自然语言给出最终答案，不要再调用工具。`
    const fullMessages: Msg[] = await buildContextMessages(
        sessionId,
        { role: "user", content: inbound.content },
        SYSTEM_PROMPT,
    );
    await emitTrace({
        sessionId,
        eventType: 'session.start',
        metadata: { depth: 0, decisionSource: 'user', durationMs: performance.now() - startTime },
        payload: { input: inbound.content }
    })
    // ★ SessionStart hook（观察；不可拦截）。dispatch 内部已容错，外层 catch 双保险。
    await dispatch('SessionStart', { sessionId, cwd: process.cwd() }).catch(() => { });
    await appendMessage({ sessionId, role: 'user', content: inbound.content })

    let replyText = "";
    const options: RunAgentOptions = {
        sessionId,
        cwd: process.cwd(),
        toolSchemas: agentTools,
        abortSignal,                        // ← 透传中止信号
        modelWindow: appConfig.MAX_HISTORY_TOKENS,
        keepRecentUnits: appConfig.KEEP_RECENT_UNITS,
        compactRatio: appConfig.COMPACT_RATIO,
        parentSystemPrompt: SYSTEM_PROMPT,
        events: async (base: TraceBase) => {
            await emitTrace(base);          // 纯 trace 落盘，不再推前端
        },
        onUIEvent: (evt) => sseWrite?.(evt),   // UI 交互事件（审批）直推前端
        // ★ Web 宿主审批：推 approval_request 到 SSE + 经 /api/approve 回传（核心已与 HTTP 解耦）
        requestApproval: createWebRequestApproval((evt) => sseWrite?.(evt), abortSignal),
    }

    for await (const event of runAgent(fullMessages, options)) {
        if (event.type === 'final') {
            replyText = event.text;        // 非 SSE 渠道靠 final 拿全文
            // SSE 模式：流式文本已由 text.delta 实时推送，final 仅作结束信号（text 置空，避免前端重复显示全文）
            sseWrite?.({ type: 'final', text: '' });
        } else {
            sseWrite?.(event);             // text.delta / tool.start / tool.end 实时推
        }
    }

    // ★ SessionEnd hook（观察）。store 与 transcript 已物理隔离（<id>.state.json / <id>.jsonl），
    //   hook 现在可安全持久化到 state.json；transcript 永远只追加、不被覆盖。
    await dispatch('SessionEnd', { sessionId, cwd: process.cwd() }).catch(() => { });

    await emitTrace({
        sessionId,
        eventType: 'session.end',
        metadata: { depth: 0, decisionSource: 'user', durationMs: performance.now() - startTime },
        payload: { output: replyText }
    })

    // SSE 模式下最终回复已随 final 事件推出；非 SSE 渠道才走 sendOutbound
    if (!sseWrite) {
        const outboundMeta = { sessionId };
        await sendOutbound({ content: replyText || '', metadata: outboundMeta });
    }
}
