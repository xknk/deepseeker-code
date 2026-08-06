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
import type { ApprovalDecision, QuestionRequest, QuestionAnswer } from "@/host/type.ts";
import { MODEL_THINKING_ENABLED, MODEL_REASONING_EFFORT } from "@/llm/createModel.ts";
import type { ThinkingLevel } from "@/agent/type.ts";
import { createCliRequestApproval, createCliRequestQuestion } from "./cliHost.ts";
import { S, getLocale } from "./strings.ts";
import { truncateMiddle } from "./util.ts";
import { buildReplayRows, type ChatRow } from "./replay.ts";

/** 一行转录（线性消息流）。定义在纯模块 replay.ts（便于脱离 React/Ink 单测）。 */
export type { ChatRow } from "./replay.ts";

/** 待审批请求（模态驱动）。 */
export type PendingApproval = { detail: string; toolName: string; resolve: (v: ApprovalDecision) => void };
/** P2-12 待答提问：ask_question 工具 → requestQuestion → 弹模态 → resolveQuestion 回传选择。 */
export type PendingQuestion = { req: QuestionRequest; resolve: (a: QuestionAnswer) => void };
/** 计划审批决策：accept=执行（plan 缺省=原方案，带 plan=编辑后方案；autoExecute=实现阶段免审批）；
 *  reject=终止回输入框。 */
export type PlanResolution =
    | { action: 'accept'; plan?: string; autoExecute?: boolean }
    | { action: 'reject' };
/** 待审批方案（计划模式两阶段）。 */
export type PendingPlan = { plan: string; resolve: (r: PlanResolution) => void };
/** 待选择的历史会话（/sessions 选择器）。resolve(null)=取消。 */
export type PendingSessions = { sessions: SessionSummary[]; resolve: (id: string | null) => void };

/** 流式缓冲 flush 间隔：过小易闪屏（动态区高频重绘），过大跟手略迟。
 *  120ms≈8fps：在 Windows Terminal 上进一步减闪（帧数较 80ms 再降约 33%），流式文本/打字延迟仍可接受。
 *  闪屏与动态区高度成正比（Ink log-update 全量擦写无行级 diff）——减帧率（此处）+ 减面积
 *  （App.tsx streamTail cap 14 / 模态打开隐藏尾巴）双管齐下；仍闪则继续调大此处或再降 streamTail。 */
const FLUSH_MS = 120;

/** 中止安全网宽限期（ms）：用户 Esc/Ctrl+G 后，底层 run 若在此期间仍未结束（忽略 abort 信号、真挂起），
 *  强制复位 busy/aborting，避免 CLI 被永久卡死（表现：卡住后再次对话无任何输出——busy 恒 true，submit 被 `if(busy) return` 静默吞掉）。
 *  正常中止在 <1s 内完成（stream 经 signal 立即 break）→ 宽限期内清表，不触发强制复位。 */
const ABORT_GRACE_MS = 8000;

/** 自动执行审批钩子：全部 allow-once 放行（不持久化），用于计划「接受并自动执行」。
 *  安全边界仍生效：checkPermission 的 deny 规则、环境断言、verifyResult 均先于/独立于此，不被绕过。 */
const autoRequestApproval = async (): Promise<ApprovalDecision> => 'allow-once';

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
export const useChatState = (initialSessionId?: string, initialPlanMode?: boolean, initialAutoMode?: boolean) => {
    const [rows, setRows] = useState<ChatRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [aborting, setAborting] = useState(false);
    /** 是否展开显示思考全文（Ctrl+T 切换；仅对 streaming 思考生效，已完成思考恒收起）。 */
    const [showThinkingText, setShowThinkingText] = useState(false);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
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
    /** 轮次代际：每轮 submit 自增；submit/runOnce 的 finally 据此判断「是否仍是本轮」，
     *  被中止安全网强制复位或新一轮接管时，旧轮 finally 不再改动状态（防串扰：旧轮复位 busy/aborting 会误伤新轮）。 */
    const turnGenRef = useRef(0);
    /** 中止安全网定时器句柄（abortCurrent 设、runOnce 正常结束时清）。 */
    const abortGuardRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const proposedPlanRef = useRef<string | null>(null);
    /** 模型自主请求进入计划模式时的原因（plan.enterRequested 事件存入；submit 据此转入计划阶段）。 */
    const enterPlanReasonRef = useRef<string | null>(null);
    const modelRef = useRef<string>("");
    const planModeRef = useRef<boolean>(initialPlanMode ?? false);
    const autoModeRef = useRef<boolean>(initialAutoMode ?? false);
    /** 思考等级（off/high/max），初始据全局 env 推导；/thinking 运行时覆盖，runOnce 透传给 model。 */
    const thinkingLevelRef = useRef<ThinkingLevel>(
        !MODEL_THINKING_ENABLED ? "off" : MODEL_REASONING_EFFORT === "max" ? "max" : "high",
    );
    /** 输出风格名（P2-16）；/output-style 运行时覆盖，runOnce 透传注入 system prompt 的 persona。undefined=中性默认。 */
    const outputStyleRef = useRef<string | undefined>(undefined);
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
        // ★ 先关闭上一轮流式行（assistant/thinking 进 Static），再 append 新 user——否则新 user（Static）
        //   会渲染在上一轮仍 streaming 的 assistant 尾巴（动态区）上方，造成新旧对话交叉。
        //   closeStreaming 内含 flush 且幂等（final 已关则 no-op），作边界时序的兜底。
        closeStreaming();
        const id = newRowId();
        setRows((prev) => {
            // ★ 新轮开始：把上一轮的活动 todos 行冻结（active=false → 移入 Static），使其留在原位（新 user 消息上方），
            //   而非继续挂在动态区底部、落到新消息下方（"已办完的任务内容在新输入的信息下方"的根因）。
            const frozen = prev.map((r) => (r.kind === "todos" && r.active) ? { ...r, active: false } : r);
            return [...frozen, { id, kind: "user" as const, text }];
        });
    }, [closeStreaming]);

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
                // ★ 方案作为 Static 消息行渲染（写一次、不参与动态区擦写）→ 治审批切换闪屏。
                //   assistant kind 享 RichText（代码块/列表）；不带 streaming → 进 Static。proposedPlanRef 仍供编辑预填。
                closeStreaming();
                const planText = (obj.plan as string) ?? "";
                proposedPlanRef.current = planText;
                const id = newRowId();
                setRows((prev) => [...prev, { id, kind: "assistant", text: planText }]);
                break;
            }
            case "final": {
                closeStreaming();
                // ★ 兜底渲染：若本轮未流式产出正文，final.text 承载的是压缩超窗/模型错误/中止等终结消息
                //   （handleUnifiedChat 已据此决定是否转发；正常完成时 text 为空，不触发）。显示出来避免静默无输出。
                const ft = (obj.text as string) ?? "";
                if (ft) {
                    const id = newRowId();
                    setRows((prev) => [...prev, { id, kind: "system", text: ft }]);
                }
                break;
            }
            case "error": {
                closeStreaming();
                const id = newRowId();
                setRows((prev) => [...prev, { id, kind: "system", text: `❌ ${(obj.message as string) ?? "未知错误"}` }]);
                break;
            }
            case "todo.update": {
                // ★ 任务清单作为内联行渲染（同 tool 行）：更新当前活动 todos 行；无则追加一行。
                //   active=true 留动态区随状态刷新；pushUser 时冻结为 Static，留在原位（新消息上方）。
                const todos = (obj.todos as Todo[]) ?? [];
                const id = newRowId();
                setRows((prev) => {
                    const idx = prev.findIndex((r) => r.kind === "todos" && r.active);
                    if (idx >= 0) {
                        const copy = prev.slice();
                        const cur = copy[idx] as Extract<ChatRow, { kind: "todos" }>;
                        copy[idx] = { ...cur, todos };
                        return copy;
                    }
                    return [...prev, { id, kind: "todos" as const, todos, active: true }];
                });
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

    // —— 结构化提问（RequestQuestionFn → Ink 提问模态） ——
    const askQuestion = useCallback((req: QuestionRequest): Promise<QuestionAnswer> =>
        new Promise<QuestionAnswer>((resolve) => setPendingQuestion({ req, resolve })), []);
    const resolveQuestion = useCallback((a: QuestionAnswer) => {
        setPendingQuestion((prev) => { prev?.resolve(a); return null; });
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
    const setPlan = useCallback((plan: string): Promise<PlanResolution> =>
        new Promise<PlanResolution>((resolve) => setPendingPlan({ plan, resolve })), []);
    const resolvePlan = useCallback((r: PlanResolution) => {
        setPendingPlan((prev) => { prev?.resolve(r); return null; });
    }, []);

    /** trace 透传：捕获 llm.response 的真实 usage，供 assistant 行收尾时附上。 */
    const onTrace = useCallback((base: TraceBase) => {
        if (base.eventType === "llm.response" && base.usage) lastUsageRef.current = base.usage;
    }, []);

    /** 单次 runAgent 驱动（经 handleUnifiedChat）。planMode=true=只读调研。
     *  autoApprove=true=本轮免审批（实现阶段自动执行：requestApproval 全 allow-once 放行）。 */
    const runOnce = useCallback(async (sid: string, body: string, planMode: boolean, autoApprove = false) => {
        const ac = new AbortController();
        currentAcRef.current = ac;
        setBusy(true);
        setAborting(false);
        const opts: HostOptions = {
            requestApproval: autoApprove ? autoRequestApproval : createCliRequestApproval(askApproval),
            requestQuestion: createCliRequestQuestion(askQuestion),
            onUIEvent: pushEvent,
            onTrace,
            planMode,
            permissionMode: (!autoApprove && autoModeRef.current) ? 'auto' : undefined,
            model: modelRef.current || undefined,
            thinkingLevel: thinkingLevelRef.current,
            locale: getLocale(),
            outputStyle: outputStyleRef.current,
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
            // ★ 仅当仍是本轮 ac 时清理：被中止安全网强制复位、或新一轮已接管时 currentAcRef 已不是本 ac，
            //   跳过清理避免串扰（旧轮的 aborting 复位 / ac 清空会误伤正在跑的新轮）。
            if (currentAcRef.current === ac) {
                // ★ 中止收尾（问题4）：信号链路已打通（ac.signal → runAgent → SDK），此处补 CLI 侧状态/反馈——
                //   复位 aborting（原仅在下一次 runOnce 开头复位 → 中止后状态条永远卡"中止中"），并追加可见确认行。
                if (ac.signal.aborted) {
                    flush();
                    setRows((prev) => [...prev, { id: nextId.current++, kind: "meta", text: "🛑 已中止生成" }]);
                }
                setAborting(false);
                currentAcRef.current = null;
                if (abortGuardRef.current) { clearTimeout(abortGuardRef.current); abortGuardRef.current = null; }
            }
        }
    }, [askApproval, flush, onTrace, pushEvent]);

    /** 方案审批 + 实现：弹出方案审批模态，接受则按方案实现（autoExecute=实现阶段免审批）。 */
    const approveAndImplement = useCallback(async (sid: string, plan: string) => {
        const res = await setPlan(plan);
        if (res.action === 'accept') {
            // ★ 编辑后方案不在 transcript，必须把最终方案全文塞进实现轮 prompt，否则模型按原方案执行。
            const finalPlan = res.plan ?? plan;
            if (res.autoExecute) pushInfo(S.planAutoExecute);
            await runOnce(sid, `（用户已批准以下方案，请严格按方案开始实现）：\n\n${finalPlan}`, false, res.autoExecute);
        } else {
            pushInfo(S.planRejected);
        }
    }, [runOnce, setPlan, pushInfo]);

    /** 计划模式一轮：只读调研 → 取方案 → 审批 → 接受则实现。researchPrompt 为发起新一轮的文本。 */
    const runPlanStage = useCallback(async (sid: string, researchPrompt: string) => {
        await runOnce(sid, researchPrompt, true);
        const plan = takeProposedPlan();
        if (plan != null) await approveAndImplement(sid, plan);
    }, [runOnce, takeProposedPlan, approveAndImplement]);

    /** 提交一轮对话。计划模式下走两阶段（调研 → 方案审批 → 实现）；模型亦可在普通轮主动请求进入计划模式。 */
    const submit = useCallback(async (content: string) => {
        const text = content.trim();
        if (!text || busy) return;
        // ★ busy 在此显式置 true 并以 try/finally 兜底复位：保证任何 await 抛错时 busy 不被遗留为 true
        //   （否则顶部 `if(busy) return` 会吞掉后续所有输入 → "卡住后再次对话无任何输出"）。
        setBusy(true);
        const myGen = ++turnGenRef.current;
        try {
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
                // ★ 模型在普通轮可能：(a) 调 exit_plan_mode 直接提交方案（自行只读调研后）；(b) 调 enter_plan_mode
                //   请求进入计划模式。两者都在 runOnce 返回后处理。先看方案（exit）——若已提交则直接走审批弹窗，
                //   否则看是否请求进入计划模式。这样无论模型走哪条路径都收敛到方案审批，不会退回纯文本方案。
                const proposedPlan = takeProposedPlan();
                if (proposedPlan != null) {
                    await approveAndImplement(sid, proposedPlan);
                } else {
                    const enterReason = takeEnterPlanRequest();
                    if (enterReason != null) {
                        pushInfo(`📋 模型请求进入计划模式${enterReason ? `：${enterReason}` : ""}，已切换…`);
                        planModeRef.current = true;
                        await runPlanStage(sid, ENTER_PLAN_RESEARCH_PROMPT);
                        planModeRef.current = false;
                    }
                }
            }
        } finally {
            // ★ 代际守卫：被中止安全网强制复位、或已被新一轮接管时（gen 变化）不再复位 busy，避免误伤新轮。
            if (turnGenRef.current === myGen) setBusy(false);
        }
    }, [busy, initialSessionId, pushUser, pushInfo, runOnce, runPlanStage, takeEnterPlanRequest, takeProposedPlan, approveAndImplement]);

    /** 中止当前轮（Esc / Ctrl+G）。
     *  ★ 安全网：abort 后若宽限期内本轮仍未结束（底层 run 忽略 abort 信号、真挂起——如卡在不查 signal 的
     *    工具/钩子里、或模型流 stall），强制复位 busy/aborting/currentAc，避免 CLI 被永久卡死。
     *    代际自增使挂起轮的 submit/runOnce finally 失效，不串扰后续轮。 */
    const abortCurrent = useCallback(() => {
        const ac = currentAcRef.current;
        if (!ac) return;
        setAborting(true);
        ac.abort();
        if (abortGuardRef.current) clearTimeout(abortGuardRef.current);
        abortGuardRef.current = setTimeout(() => {
            abortGuardRef.current = null;
            // 仍是这个 ac → 宽限期内未结束：底层真挂起，强制复位避免砖化
            if (currentAcRef.current === ac) {
                currentAcRef.current = null;
                turnGenRef.current++;            // 旧轮 finally 据此跳过状态改动，不误伤后续轮
                setBusy(false);
                setAborting(false);
                flush();
                setRows((prev) => [...prev, { id: nextId.current++, kind: "meta", text: "🛑 已强制中止（底层未响应中断，已复位，可继续对话）" }]);
            }
        }, ABORT_GRACE_MS);
    }, [flush]);

    /** Ctrl+T：切换思考全文显示（仅对 streaming 思考生效；已完成思考进 Static 冻结恒收起）。 */
    const toggleShowThinking = useCallback(() => setShowThinkingText((v) => !v), []);

    const clearRows = useCallback(() => {
        flush();
        setRows([]);
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
    /** /auto 切换自动权限模式（引擎层分类器：工作区内文件编辑自动放行，高危/异常转人工）。 */
    const setAutoMode = useCallback((on: boolean) => { autoModeRef.current = on; }, []);
    const getAutoMode = useCallback(() => autoModeRef.current, []);
    /** /thinking 切换思考等级（off/high/max），影响下一次 runOnce 透传给 model 的 thinking/reasoning_effort。 */
    const setThinkingLevel = useCallback((lvl: ThinkingLevel) => { thinkingLevelRef.current = lvl; }, []);
    const getThinkingLevel = useCallback((): ThinkingLevel => thinkingLevelRef.current, []);
    /** /output-style 切换输出风格（P2-16）：undefined=中性默认，否则注入对应风格 persona。 */
    const setOutputStyle = useCallback((name: string | undefined) => { outputStyleRef.current = name; }, []);
    const getOutputStyle = useCallback((): string | undefined => outputStyleRef.current, []);

    return {
        // 状态
        rows, busy, aborting, showThinkingText, pendingApproval, pendingQuestion, pendingPlan, pendingSessions,
        sessionIdRef,
        // 动作
        submit, abortCurrent, pushUser, pushInfo, pushEvent,
        askApproval, resolveApproval, resolveQuestion, setPlan, resolvePlan,
        toggleShowThinking, clearRows, setModelOverride, setPlanMode, getPlanMode, setAutoMode, getAutoMode,
        setThinkingLevel, getThinkingLevel, setOutputStyle, getOutputStyle,
        openSessionPicker, resolveSession, loadSession,
    };
};

export type ChatState = ReturnType<typeof useChatState>;
