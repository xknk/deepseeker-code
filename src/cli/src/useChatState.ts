/**
 * @file cli/src/useChatState.ts
 * @description CLI 会话聚合 hook：把 runAgent 的事件流（经 handleUnifiedChat 的 sink）映射为 React 状态，
 *  并封装 submit 编排（sessionId 复用 / 模型覆盖 / 计划模式两阶段）、工具审批、方案审批、中止。
 *
 *  职责边界：
 *   - 事件 → 状态：pushEvent 消费 AgentEvent（text/thinking/tool/round/plan/final）+ UIEvent（todo/denied）。
 *   - 审批：askApproval/resolveApproval 经 Ink 模态闭环（cliHost 注入 RequestApprovalFn）。
 *   - 计划两阶段：计划轮 yield plan.proposed 后 return，submit 取出方案弹模态，接受则以 planMode:false 重跑实现。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { handleUnifiedChat, type HostOptions } from "@/serve/chatProcessing.ts";
import { getOrCreateSessionId, listSessions, type SessionSummary } from "@/session/store.ts";
import { readMessages } from "@/session/transcript.ts";
import { estimateTokens } from "@/session/contextCore.ts";
import type { TraceBase, Todo } from "@/observability/type.ts";
import type { ApprovalDecision } from "@/host/type.ts";
import { MODEL_THINKING_ENABLED, MODEL_REASONING_EFFORT } from "@/llm/createModel.ts";
import type { ThinkingLevel } from "@/agent/type.ts";
import { createCliRequestApproval } from "./cliHost.ts";
import { S, getLocale } from "./strings.ts";
import { truncateMiddle } from "./util.ts";
import { buildReplayRows, type ChatRow } from "./replay.ts";

/** 一行转录（线性消息流）。定义在纯模块 replay.ts（便于脱离 React/Ink 单测）。 */
export type { ChatRow } from "./replay.ts";

/** 待审批请求（模态驱动）。 */
export type PendingApproval = { detail: string; toolName: string; resolve: (v: ApprovalDecision) => void };
/** 待审批方案（计划模式两阶段）。 */
export type PendingPlan = { plan: string; resolve: (v: boolean) => void };
/** 待选择的历史会话（/sessions 选择器）。resolve(null)=取消。 */
export type PendingSessions = { sessions: SessionSummary[]; resolve: (id: string | null) => void };

/** 流式缓冲 flush 间隔：过小易闪屏，过大跟手略迟（约 20fps）。 */
const FLUSH_MS = 50;

/** 模型自主进入计划模式后，重跑计划阶段发给模型的引导语（用户原文已入 transcript，勿重复）。 */
const ENTER_PLAN_RESEARCH_PROMPT = "（已进入计划模式。请以只读方式完成调研，然后调用 exit_plan_mode 提交完整实现方案。）";

/** 思考行收尾：冻结耗时 + 估算 token（Static 渲染后不再变动，故必须在收尾时算好）。 */
const finalizeThinkingRow = (row: Extract<ChatRow, { kind: "thinking" }>): ChatRow => {
    const durationMs = row.startedAt ? Date.now() - row.startedAt : 0;
    const tokens = estimateTokens([{ role: "system", content: row.text }]);
    return { ...row, streaming: false, durationMs, tokens };
};

/**
 * CLI 会话 hook。
 * @param initialSessionId --resume 传入的会话 ID；缺省首轮由 getOrCreateSessionId 生成并复用。
 * @param initialPlanMode --plan 初始即进入计划模式。
 */
export const useChatState = (initialSessionId?: string, initialPlanMode?: boolean) => {
    const [rows, setRows] = useState<ChatRow[]>([]);
    const [todos, setTodos] = useState<Todo[]>([]);
    const [busy, setBusy] = useState(false);
    const [aborting, setAborting] = useState(false);
    /** 是否展开显示思考全文（Ctrl+T 切换；仅对 streaming 思考生效，已完成思考恒收起）。 */
    const [showThinkingText, setShowThinkingText] = useState(false);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
    const [pendingSessions, setPendingSessions] = useState<PendingSessions | null>(null);

    const nextId = useRef(1);
    const assistantStreamingId = useRef<number | null>(null);
    const thinkingStreamingId = useRef<number | null>(null);
    const toolRowByCallId = useRef<Map<string, number>>(new Map());
    const textBuffer = useRef("");
    const thinkingBuffer = useRef("");
    const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** 待 flush 的工具进度（运行中工具的最新片段，节流并入主 flush，避免逐行 stdout 渲染风暴）。 */
    const progressPending = useRef<{ id: number; msg: string } | null>(null);

    const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
    const currentAcRef = useRef<AbortController | null>(null);
    const proposedPlanRef = useRef<string | null>(null);
    /** 模型自主请求进入计划模式时的原因（plan.enterRequested 事件存入；submit 据此转入计划阶段）。 */
    const enterPlanReasonRef = useRef<string | null>(null);
    const modelRef = useRef<string>("");
    const planModeRef = useRef<boolean>(initialPlanMode ?? false);
    /** 思考等级（off/high/max），初始据全局 env 推导；/thinking 运行时覆盖，runOnce 透传给 model。 */
    const thinkingLevelRef = useRef<ThinkingLevel>(
        !MODEL_THINKING_ENABLED ? "off" : MODEL_REASONING_EFFORT === "max" ? "max" : "high",
    );
    /** 最近一次 llm.response 的真实 usage（经 onTrace 透传），收尾时附到 assistant 行。 */
    const lastUsageRef = useRef<TraceBase['usage'] | null>(null);

    // ★ --resume：挂载时回放历史转录（user/assistant/tool/thinking），让用户看到先前对话。
    //   模型上下文由 buildContextMessages 从同一 transcript 读取，二者一致。
    useEffect(() => {
        if (!initialSessionId) return;
        void (async () => {
            try {
                const msgs = await readMessages(initialSessionId);
                const seeded = buildReplayRows(msgs, newRowId);
                if (seeded.length) setRows(seeded);
            } catch { /* 无历史或读取失败 → 空回放，不阻塞 */ }
        })();
        // 仅挂载时执行一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const newRowId = () => nextId.current++;

    /** 把缓冲里的增量合并进当前流式行（assistant / thinking），并清空缓冲。 */
    const flush = useCallback(() => {
        if (flushTimer.current) {
            clearTimeout(flushTimer.current);
            flushTimer.current = null;
        }
        const tBuf = textBuffer.current;
        const thBuf = thinkingBuffer.current;
        const pp = progressPending.current;
        textBuffer.current = "";
        thinkingBuffer.current = "";
        progressPending.current = null;
        if (!tBuf && !thBuf && !pp) return;
        const aId = assistantStreamingId.current;
        const thId = thinkingStreamingId.current;
        setRows((prev) => prev.map((row) => {
            if (tBuf && row.id === aId && row.kind === "assistant") return { ...row, text: row.text + tBuf };
            if (thBuf && row.id === thId && row.kind === "thinking") return { ...row, text: row.text + thBuf };
            // 运行中工具进度：覆盖式更新最新片段（ToolCard 只在 running 时展示）
            if (pp && row.id === pp.id && row.kind === "tool") return { ...row, progress: pp.msg };
            return row;
        }));
    }, []);

    const scheduleFlush = useCallback(() => {
        if (flushTimer.current) return;
        flushTimer.current = setTimeout(() => {
            flushTimer.current = null;
            flush();
        }, FLUSH_MS);
    }, [flush]);

    /** 关闭当前流式行（assistant/thinking 标记完成、清引用），用于工具边界 / 轮次结束。 */
    const closeStreaming = useCallback(() => {
        flush();
        const aId = assistantStreamingId.current;
        const thId = thinkingStreamingId.current;
        if (aId != null || thId != null) {
            setRows((prev) => prev.map((row) => {
                if (row.id === aId && row.kind === "assistant") {
                    // 附上本轮真实 usage（收尾时 llm.response 已到）；中途收尾无 usage 则保留原值
                    const usage = lastUsageRef.current ?? row.usage;
                    return { ...row, streaming: false, usage };
                }
                if (row.id === thId && row.kind === "thinking") return finalizeThinkingRow(row);
                return row;
            }));
        }
        assistantStreamingId.current = null;
        thinkingStreamingId.current = null;
    }, [flush]);

    const ensureAssistantRow = () => {
        if (assistantStreamingId.current != null) return;
        // 首段正文开始 → 关闭本轮思考行（思考先于正文），冻结耗时/token
        const thId = thinkingStreamingId.current;
        if (thId != null) {
            thinkingStreamingId.current = null;
            setRows((prev) => prev.map((r) => r.id === thId && r.kind === "thinking" ? finalizeThinkingRow(r) : r));
        }
        const id = newRowId();
        setRows((prev) => [...prev, { id, kind: "assistant", text: "", streaming: true }]);
        assistantStreamingId.current = id;
    };
    const ensureThinkingRow = () => {
        if (thinkingStreamingId.current != null) return;
        const id = newRowId();
        setRows((prev) => [...prev, { id, kind: "thinking", text: "", expanded: false, streaming: true, startedAt: Date.now() }]);
        thinkingStreamingId.current = id;
    };

    const pushUser = useCallback((text: string) => {
        flush();
        const id = newRowId();
        setRows((prev) => [...prev, { id, kind: "user", text }]);
    }, [flush]);

    /** 追加一条中性信息行（本地斜杠命令回显等，非错误、非轮次）。 */
    const pushInfo = useCallback((text: string) => {
        flush();
        const id = newRowId();
        setRows((prev) => [...prev, { id, kind: "info", text }]);
    }, [flush]);

    /**
     * 事件派发（sink）：消费 handleUnifiedChat 转发的 AgentEvent + UIEvent。
     * 与 onUIEvent 共用同一入口（handleUnifiedChat 对二者都调 sseWrite/onUIEvent）。
     */
    const pushEvent = useCallback((obj: Record<string, unknown>) => {
        const type = obj?.type as string;
        switch (type) {
            case "text.delta": {
                ensureAssistantRow();
                textBuffer.current += (obj.text as string) ?? "";
                scheduleFlush();
                break;
            }
            case "thinking.delta": {
                ensureThinkingRow();
                thinkingBuffer.current += (obj.text as string) ?? "";
                scheduleFlush();
                break;
            }
            case "tool.start": {
                closeStreaming();
                const id = newRowId();
                const callId = obj.toolCallId as string;
                toolRowByCallId.current.set(callId, id);
                setRows((prev) => [...prev, {
                    id, kind: "tool", toolCallId: callId, toolName: obj.toolName as string,
                    args: obj.args, status: "running",
                }]);
                break;
            }
            case "tool.end": {
                flush();
                const id = toolRowByCallId.current.get(obj.toolCallId as string);
                if (id != null) {
                    setRows((prev) => prev.map((row) =>
                        row.id === id && row.kind === "tool"
                            ? { ...row, result: obj.result as string, ok: obj.ok as boolean, status: "done" }
                            : row));
                }
                break;
            }
            case "tool.progress": {
                // 实时 stdout 等：节流并入 flush（覆盖运行中工具的最新片段），避免逐块 setRows 渲染风暴。
                //   注意字段名是 toolsId（与 tool.start/end 的 toolCallId 同值不同名）。
                const pid = toolRowByCallId.current.get(obj.toolsId as string);
                if (pid != null) {
                    progressPending.current = { id: pid, msg: (obj.message as string) ?? "" };
                    scheduleFlush();
                }
                break;
            }
            case "round.start": {
                // 仅收尾当前流式行；不渲染轮次分割线（对齐 Claude Code：连续流，不暴露内部轮次）。
                closeStreaming();
                break;
            }
            case "plan.enterRequested": {
                flush();
                enterPlanReasonRef.current = (obj.reason as string) ?? "";
                break;
            }
            case "plan.proposed": {
                flush();
                proposedPlanRef.current = (obj.plan as string) ?? "";
                break;
            }
            case "final": {
                closeStreaming();
                break;
            }
            case "error": {
                closeStreaming();
                const id = newRowId();
                setRows((prev) => [...prev, { id, kind: "system", text: `❌ ${(obj.message as string) ?? "未知错误"}` }]);
                break;
            }
            case "todo.update": {
                setTodos((obj.todos as Todo[]) ?? []);
                break;
            }
            case "tool.denied": {
                flush();
                const id = newRowId();
                setRows((prev) => [...prev, { id, kind: "meta", text: `🚫 ${obj.toolName as string} 被拒绝` }]);
                break;
            }
            case "approval_request":
                // 阻塞式审批由 requestApproval(cliHost) 直接驱动模态，此处不重复处理
                break;
            default:
                break;
        }
    }, [closeStreaming, flush, scheduleFlush]);

    // —— 工具审批（RequestApprovalFn → Ink 模态） ——
    const askApproval = useCallback((detail: string, toolName: string): Promise<ApprovalDecision> =>
        new Promise<ApprovalDecision>((resolve) => setPendingApproval({ detail, toolName, resolve })), []);
    const resolveApproval = useCallback((v: ApprovalDecision) => {
        setPendingApproval((prev) => { prev?.resolve(v); return null; });
    }, []);

    // —— 方案审批（计划模式两阶段） ——
    /** 取出本轮 yield 的方案文本（若有），并清空。供 submit 在计划轮结束后判断是否弹模态。 */
    const takeProposedPlan = useCallback((): string | null => {
        const p = proposedPlanRef.current;
        proposedPlanRef.current = null;
        return p;
    }, []);
    /** 取出本轮模型发起的进入计划模式请求（若有），并清空。供 submit 在普通轮结束后判断是否转入计划阶段。 */
    const takeEnterPlanRequest = useCallback((): string | null => {
        const r = enterPlanReasonRef.current;
        enterPlanReasonRef.current = null;
        return r;
    }, []);
    const setPlan = useCallback((plan: string): Promise<boolean> =>
        new Promise<boolean>((resolve) => setPendingPlan({ plan, resolve })), []);
    const resolvePlan = useCallback((v: boolean) => {
        setPendingPlan((prev) => { prev?.resolve(v); return null; });
    }, []);

    /** trace 透传：捕获 llm.response 的真实 usage，供 assistant 行收尾时附上。 */
    const onTrace = useCallback((base: TraceBase) => {
        if (base.eventType === "llm.response" && base.usage) lastUsageRef.current = base.usage;
    }, []);

    /** 单次 runAgent 驱动（经 handleUnifiedChat）。planMode=true=只读调研。 */
    const runOnce = useCallback(async (sid: string, body: string, planMode: boolean) => {
        const ac = new AbortController();
        currentAcRef.current = ac;
        setBusy(true);
        setAborting(false);
        const opts: HostOptions = {
            requestApproval: createCliRequestApproval(askApproval),
            onUIEvent: pushEvent,
            onTrace,
            planMode,
            model: modelRef.current || undefined,
            thinkingLevel: thinkingLevelRef.current,
            locale: getLocale(),
        };
        try {
            await handleUnifiedChat(
                { sessionId: sid, content: body },
                async () => { /* CLI 走 sink(pushEvent)，非 SSE 回退不会触发 */ },
                pushEvent,
                ac.signal,
                opts,
            );
        } catch (e) {
            pushEvent({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
            // ★ 中止收尾（问题4）：信号链路已打通（ac.signal → runAgent → SDK），此处补 CLI 侧状态/反馈——
            //   复位 aborting（原仅在下一次 runOnce 开头复位 → 中止后状态条永远卡"中止中"），并追加可见确认行。
            if (ac.signal.aborted) {
                flush();
                setRows((prev) => [...prev, { id: nextId.current++, kind: "meta", text: "🛑 已中止生成" }]);
            }
            setAborting(false);
            currentAcRef.current = null;
        }
    }, [askApproval, flush, onTrace, pushEvent]);

    /** 计划模式一轮：只读调研 → 取方案 → 审批 → 接受则实现。researchPrompt 为发起新一轮的文本。 */
    const runPlanStage = useCallback(async (sid: string, researchPrompt: string) => {
        await runOnce(sid, researchPrompt, true);
        const plan = takeProposedPlan();
        if (plan != null) {
            const accepted = await setPlan(plan);
            if (accepted) {
                await runOnce(sid, "（用户已批准上述方案，请开始实现。）", false);
            }
        }
    }, [runOnce, setPlan, takeProposedPlan]);

    /** 提交一轮对话。计划模式下走两阶段（调研 → 方案审批 → 实现）；模型亦可在普通轮主动请求进入计划模式。 */
    const submit = useCallback(async (content: string) => {
        const text = content.trim();
        if (!text || busy) return;
        // 首轮解析并固化 sessionId（跨轮复用，使 transcript/上下文累积）
        if (sessionIdRef.current == null) {
            sessionIdRef.current = await getOrCreateSessionId(initialSessionId ?? undefined);
        }
        const sid = sessionIdRef.current;
        pushUser(text);

        if (planModeRef.current) {
            await runPlanStage(sid, text);
        } else {
            await runOnce(sid, text, false);
            // ★ 模型自主进入计划模式：普通轮内调用 enter_plan_mode → 翻转 planMode 并以只读重跑计划阶段。
            //   自动进入为「一次性」：计划阶段结束后自动退出，恢复普通模式（手动开启的计划模式不受影响）。
            const enterReason = takeEnterPlanRequest();
            if (enterReason != null) {
                pushInfo(`📋 模型请求进入计划模式${enterReason ? `：${enterReason}` : ""}，已切换…`);
                planModeRef.current = true;
                await runPlanStage(sid, ENTER_PLAN_RESEARCH_PROMPT);
                planModeRef.current = false;
            }
        }
        setBusy(false);
    }, [busy, initialSessionId, pushUser, pushInfo, runOnce, runPlanStage, takeEnterPlanRequest]);

    /** 中止当前轮（Esc / Ctrl+G）。 */
    const abortCurrent = useCallback(() => {
        const ac = currentAcRef.current;
        if (!ac) return;
        setAborting(true);
        ac.abort();
    }, []);

    /** Ctrl+T：切换思考全文显示（仅对 streaming 思考生效；已完成思考进 Static 冻结恒收起）。 */
    const toggleShowThinking = useCallback(() => setShowThinkingText((v) => !v), []);

    const clearRows = useCallback(() => {
        flush();
        setRows([]);
        setTodos([]);
        toolRowByCallId.current.clear();
    }, [flush]);

    // —— 历史会话载入（/sessions 选择器） ——
    /** 载入指定会话：切换 sessionId + 清屏 + 回放转录，后续 submit 即续接此会话。 */
    const loadSession = useCallback(async (id: string) => {
        sessionIdRef.current = id;
        clearRows();
        try {
            const msgs = await readMessages(id);
            const seeded = buildReplayRows(msgs, newRowId);
            if (seeded.length) setRows(seeded);
        } catch { /* 无历史或读取失败 → 空回放，不阻塞 */ }
        pushInfo(`📂 ${S.sessionLoaded(truncateMiddle(id, 12))}`);
    }, [clearRows, pushInfo]);
    /** 关闭选择器并回传结果（null=取消）。 */
    const resolveSession = useCallback((id: string | null) => {
        setPendingSessions((prev) => { prev?.resolve(id); return null; });
    }, []);
    /** 唤出 /sessions 选择器：枚举历史 → 模态选择 → 选定即载入。 */
    const openSessionPicker = useCallback(async () => {
        const sessions = await listSessions();
        if (sessions.length === 0) { pushInfo(S.noHistory); return; }
        const picked = await new Promise<string | null>((resolve) => setPendingSessions({ sessions, resolve }));
        if (picked) await loadSession(picked);
    }, [pushInfo, loadSession]);

    /** /model 设置模型覆盖（透传 RunAgentOptions.model）。 */
    const setModelOverride = useCallback((m: string) => { modelRef.current = m; }, []);
    /** /plan 切换计划模式（影响下一次 submit 是否走两阶段）。 */
    const setPlanMode = useCallback((on: boolean) => { planModeRef.current = on; }, []);
    const getPlanMode = useCallback(() => planModeRef.current, []);
    /** /thinking 切换思考等级（off/high/max），影响下一次 runOnce 透传给 model 的 thinking/reasoning_effort。 */
    const setThinkingLevel = useCallback((lvl: ThinkingLevel) => { thinkingLevelRef.current = lvl; }, []);
    const getThinkingLevel = useCallback((): ThinkingLevel => thinkingLevelRef.current, []);

    return {
        // 状态
        rows, todos, busy, aborting, showThinkingText, pendingApproval, pendingPlan, pendingSessions,
        sessionIdRef,
        // 动作
        submit, abortCurrent, pushUser, pushInfo, pushEvent,
        askApproval, resolveApproval, setPlan, resolvePlan,
        toggleShowThinking, clearRows, setModelOverride, setPlanMode, getPlanMode,
        setThinkingLevel, getThinkingLevel,
        openSessionPicker, resolveSession, loadSession,
    };
};

export type ChatState = ReturnType<typeof useChatState>;
