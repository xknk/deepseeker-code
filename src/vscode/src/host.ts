/**
 * @file vscode/src/host.ts
 * @description VS Code 插件侧宿主：复用 core 的 handleUnifiedChat 驱动 runAgent，
 *  把事件流转发给 webview（sink），并把 webview 的审批/提问/方案决策接回 core。
 *
 *  编排逻辑与 cli/src/useChatState.ts 一一对应（非 React 版）：
 *  - 审批：走 core 为异步 UI 宿主设计的 createWebRequestApproval（发 approval_request 事件
 *    给前端）→ 前端点按钮 → resolveUserApprovalLock 解锁（approvalGate 模块级锁表，同实例生效）。
 *  - 提问（ask_question）：host 用 promise-map 挂起，前端回传选项后 resolve。
 *  - 计划两阶段：plan.proposed 存方案 → runOnce 返回后弹方案条 → accept 后带最终方案重跑实现轮。
 */
import { handleUnifiedChat, type HostOptions } from "@/serve/chatProcessing.ts";
import { pushSessionInbox } from "@/agent/inbox.ts";
import { getOrCreateSessionId, listSessions, renameSession as persistRenameSession, deleteSession as persistDeleteSession, type SessionSummary } from "@/session/store.ts";
import { readMessages, readTranscriptLines } from "@/session/transcript.ts";
import { forkSession, listForkAnchors as deriveForkAnchors, type ForkAnchor } from "@/session/fork.ts";
import { createWebRequestApproval } from "@/host/webHost.ts";
import { resolveUserApprovalLock } from "@/tool/approvalGate.ts";
import type { ApprovalDecision, QuestionRequest, QuestionAnswer } from "@/host/type.ts";
import { MODEL_THINKING_ENABLED, MODEL_REASONING_EFFORT } from "@/llm/createModel.ts";
import type { ThinkingLevel } from "@/agent/type.ts";

/** UI 回调（由 panel 实现：转发到 webview）。 */
export interface ChatHostCallbacks {
  /** 事件转发：AgentEvent + UIEvent（text.delta / tool.start / plan.proposed / approval_request …）。 */
  sink: (evt: Record<string, unknown>) => void;
  /** busy 变化（生成中/空闲），驱动状态条与发送按钮。 */
  onBusy: (busy: boolean) => void;
  /** 结构化提问（ask_question 工具）→ UI 弹选项。 */
  onQuestion: (req: QuestionRequest) => void;
  /** 计划方案待审批 → UI 弹方案条。 */
  onPlan: (plan: string) => void;
  /** 会话重置（新会话/切换历史）→ UI 清屏。 */
  onSessionReset: () => void;
  /** 持久化活动会话 id（workspaceState）：重载后恢复，杜绝重载新建碎片 session。 */
  getPersistedSessionId?: () => string | undefined;
  setPersistedSessionId?: (id: string | null) => void;
}

/** 计划审批决策（与 CLI PlanResolution 同构）。 */
export type PlanResolution =
  | { action: "accept"; plan?: string; autoExecute?: boolean }
  | { action: "reject" };

/** 自动执行审批钩子：全部 allow-once 放行（安全边界仍由 core 的 deny 规则/环境断言兜底）。 */
const autoRequestApproval = async (): Promise<ApprovalDecision> => "allow-once";

/** 模型自主进入计划模式后，重跑计划阶段发给模型的引导语（用户原文已入 transcript）。 */
const ENTER_PLAN_RESEARCH_PROMPT = "（已进入计划模式。请以只读方式完成调研，然后调用 exit_plan_mode 提交完整实现方案。）";

const tryParseArgs = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * 轻量历史回放：把 transcript messages 转成 UI 行事件（type:"row" / type:"rowUpdate"）。
 * 与 cli/src/replay.ts 的 buildReplayRows 语义一致，但直接以事件流形式送出。
 */
function emitReplay(msgs: Array<Record<string, unknown>>, sink: (evt: Record<string, unknown>) => void): void {
  const pending = new Map<string, string>(); // toolCallId -> row key
  let seq = 0;
  const nextKey = () => `replay-${++seq}`;
  for (const m of msgs) {
    const role = m?.role;
    if (role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.trim()) sink({ type: "row", kind: "user", text, key: nextKey() });
    } else if (role === "assistant") {
      if (typeof m.reasoning_content === "string" && m.reasoning_content.trim()) {
        sink({ type: "row", kind: "thinking", text: m.reasoning_content, expanded: false, key: nextKey() });
      }
      if (typeof m.content === "string" && m.content.trim()) {
        sink({ type: "row", kind: "assistant", text: m.content, key: nextKey() });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
          const tcId = typeof tc?.id === "string" ? tc.id : "";
          const key = nextKey();
          sink({
            type: "row",
            kind: "tool",
            toolName: (tc?.function as Record<string, unknown>)?.name ?? "(tool)",
            args: tryParseArgs((tc?.function as Record<string, unknown>)?.arguments),
            status: "running",
            key,
          });
          if (tcId) pending.set(tcId, key);
        }
      }
    } else if (role === "tool") {
      const tcId = typeof m?.tool_call_id === "string" ? m.tool_call_id : "";
      const key = tcId ? pending.get(tcId) : undefined;
      if (key) {
        sink({
          type: "rowUpdate",
          key,
          patch: { result: typeof m?.content === "string" ? m.content : "", ok: true, status: "done" },
        });
        pending.delete(tcId);
      }
    }
  }
  for (const key of pending.values()) {
    sink({ type: "rowUpdate", key, patch: { result: "", ok: false, status: "done" } });
  }
}

/** VS Code 插件宿主：一次会话（可续接/切换历史），复用 core 引擎。 */
export class ChatHost {
  sessionId: string | null = null;

  private planMode = false;
  private autoMode = false;
  private model = "";
  private thinkingLevel: ThinkingLevel =
    !MODEL_THINKING_ENABLED ? "off" : MODEL_REASONING_EFFORT === "max" ? "max" : "high";
  private locale: "zh" | "en" = "zh";
  private outputStyle: string | undefined = undefined;

  private currentAc: AbortController | null = null;
  private busy = false;
  // ★ inbox steering：busy 期间已排队、尚未在回合边界送达的补充输入条数（送达/收尾时递减，驱动提示）。
  private queuedUnclaimed = 0;
  private proposedPlan: string | null = null;
  private enterPlanReason: string | null = null;
  private pendingQuestion: { resolve: (a: QuestionAnswer) => void } | null = null;
  private pendingPlan: { resolve: (r: PlanResolution) => void } | null = null;
  // ★ 挂起交互暂存（panel 重建后重广播，杜绝关 tab 后审批/提问/方案死锁与丢失）：
  //   「挂起」= 对应 pending resolve 仍存在（用户尚未决策）；resolve 时清空，避免重播已解决的历史交互。
  private lastApprovalEvt: Record<string, unknown> | null = null;
  private lastQuestionReq: QuestionRequest | null = null;
  private lastPlanText: string | null = null;

  constructor(private callbacks: ChatHostCallbacks) {
    // ★ 重载恢复：从 workspaceState 取回上次活动会话 id，避免重载后新建碎片 session；
    //   会话回放改由 replayCurrentSession 在 webview ready 时统一驱动（sessionId 非空即重放）。
    const persisted = callbacks.getPersistedSessionId?.();
    if (persisted) this.sessionId = persisted;
  }

  get isBusy(): boolean {
    return this.busy;
  }
  get currentPlanMode(): boolean {
    return this.planMode;
  }
  get currentAutoMode(): boolean {
    return this.autoMode;
  }

  /** 事件 sink：先截获 plan 两阶段所需信号 + 挂起交互（approval/question/plan）暂存，再原样转发给 UI。
   *  暂存的挂起交互供 collectPendingUI 在 panel 重建后重广播，杜绝关 tab 后审批死锁。 */
  private sink = (evt: Record<string, unknown>): void => {
    const type = evt?.type as string;
    if (type === "plan.proposed") {
      this.proposedPlan = (evt.plan as string) ?? "";
      this.lastPlanText = this.proposedPlan;
    } else if (type === "plan.enterRequested") {
      this.enterPlanReason = (evt.reason as string) ?? "";
    } else if (type === "approval_request") {
      this.lastApprovalEvt = { ...evt };
    } else if (type === "inbox.claimed") {
      // ★ inbox steering：排队文本已在 submit 时渲染过 user 行，此处仅转成 info 提示送达
      //   （勿重复渲染文本；webview 无此事件 case，转换后转发保持零新协议感知）。
      const n = Array.isArray(evt.texts) ? (evt.texts as string[]).length : 0;
      if (n > 0) {
        this.queuedUnclaimed = Math.max(0, this.queuedUnclaimed - n);
        this.callbacks.sink({ type: "info", text: `📬 已送达模型（${n} 条补充输入）` });
      }
      return;
    }
    this.callbacks.sink(evt);
  };

  private takeProposedPlan(): string | null {
    const p = this.proposedPlan;
    this.proposedPlan = null;
    return p;
  }

  private takeEnterPlanRequest(): string | null {
    const r = this.enterPlanReason;
    this.enterPlanReason = null;
    return r;
  }

  /** 单轮 runAgent（经 handleUnifiedChat）。planMode=true=只读调研；autoApprove=true=本轮免审批。 */
  private async runOnce(body: string, planMode: boolean, autoApprove = false): Promise<void> {
    const ac = new AbortController();
    this.currentAc = ac;
    this.setBusy(true);
    const opts: HostOptions = {
      // ★ 异步宿主审批：core 发 approval_request 事件给前端，前端按钮 → resolveApproval() 解锁
      // （onUIEvent 形参为 core 具体事件类型，显式标注 any 以兼容宽松 sink）
      requestApproval: autoApprove ? autoRequestApproval : createWebRequestApproval((evt: any) => this.sink(evt), ac.signal),
      requestQuestion: (req) => this.askQuestion(req),
      onUIEvent: (evt: any) => this.sink(evt),
      planMode,
      permissionMode: !autoApprove && this.autoMode ? "auto" : undefined,
      model: this.model || undefined,
      thinkingLevel: this.thinkingLevel,
      locale: this.locale,
      outputStyle: this.outputStyle,
    };
    try {
      await handleUnifiedChat(
        { sessionId: this.sessionId ?? "", content: body },
        async () => {
          /* 走 sink，非 SSE 回退不触发 */
        },
        (evt: any) => this.sink(evt),
        ac.signal,
        opts,
      );
    } catch (e) {
      this.sink({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.currentAc = null;
      this.setBusy(false);
      // ★ inbox steering 收尾：run 结束仍未在回合边界送达的补充输入已被 runAgent finally
      //   flush 落盘（此刻已完成），如实提示下轮自动带入。
      if (this.queuedUnclaimed > 0) {
        this.sink({ type: "info", text: `📬 本轮结束时 ${this.queuedUnclaimed} 条补充输入未在回合边界送达，已写入会话历史，下轮对话自动带入。` });
        this.queuedUnclaimed = 0;
      }
    }
  }

  /** 取已捕获方案 → 弹方案条 → accept 则带最终方案重跑实现轮（planMode=false）。
   *  runPlanStage（计划模式调研后）与普通轮模型直接 exit_plan_mode（系统提示词鼓励）共用本尾段。 */
  private async presentPlanAndImplement(plan: string): Promise<void> {
    const res = await new Promise<PlanResolution>((resolve) => {
      this.pendingPlan = { resolve };
      this.callbacks.onPlan(plan);
    });
    if (res.action === "accept") {
      // 编辑后方案不在 transcript，必须把最终方案全文塞进实现轮 prompt。
      const finalPlan = res.plan ?? plan;
      if (res.autoExecute) this.sink({ type: "info", text: "⚡ 已进入自动执行：实现阶段工具将免审批直接运行。" });
      await this.runOnce(`（用户已批准以下方案，请严格按方案开始实现）：\n\n${finalPlan}`, false, res.autoExecute);
    } else {
      this.sink({ type: "info", text: "👋 已拒绝方案，本轮未执行。" });
    }
  }

  /** 计划模式一轮：只读调研 → 取方案 → 弹方案条 → accept 则带最终方案重跑实现轮。 */
  private async runPlanStage(researchPrompt: string): Promise<void> {
    await this.runOnce(researchPrompt, true);
    const plan = this.takeProposedPlan();
    if (plan == null) return;
    await this.presentPlanAndImplement(plan);
  }

  /** 提交一轮对话（UI 输入框 Enter 触发）。 */
  async submit(content: string): Promise<void> {
    const text = content.trim();
    if (!text) return;
    // ★ inbox steering：busy 期间排队补充输入，runAgent 回合边界送达模型。替代旧「静默 return」
    //   ——webview 在调用前已清空输入框，静默等于丢字。排队失败（开关关/队满）至少提示用户未发送。
    if (this.busy) {
      const sid = this.sessionId;
      if (sid && pushSessionInbox(sid, text)) {
        this.sink({ type: "row", kind: "user", text, key: `u-${Date.now()}` });
        this.sink({ type: "info", text: "📮 已排队，将在回合边界送达模型（停止按钮仍可中止）。" });
        this.queuedUnclaimed++;
      } else {
        this.sink({ type: "info", text: "⏳ 生成中，输入未发送。" });
      }
      return;
    }
    if (this.sessionId == null) {
      this.setSessionId(await getOrCreateSessionId(undefined));
    }
    this.sink({ type: "row", kind: "user", text, key: `u-${Date.now()}` });
    if (this.planMode) {
      await this.runPlanStage(text);
    } else {
      await this.runOnce(text, false);
      // ★ 模型在普通轮可能：(a) 调 exit_plan_mode 直接提交方案（系统提示词鼓励，自行只读调研后）；
      //   (b) 调 enter_plan_mode 请求进入计划模式。先看方案（exit）——若已提交则直接走方案审批弹窗，
      //   否则看是否请求进入计划模式。与 CLI useChatState 一致，避免退回纯文本方案而无按钮可点。
      const proposed = this.takeProposedPlan();
      if (proposed != null) {
        await this.presentPlanAndImplement(proposed);
      } else {
        const enterReason = this.takeEnterPlanRequest();
        if (enterReason != null) {
          this.sink({
            type: "info",
            text: `📋 模型请求进入计划模式${enterReason ? `：${enterReason}` : ""}，已切换…`,
          });
          this.planMode = true;
          await this.runPlanStage(ENTER_PLAN_RESEARCH_PROMPT);
          this.planMode = false;
        }
      }
    }
  }

  /** 中止当前轮。 */
  abort(): void {
    this.currentAc?.abort();
  }

  /** 新会话：id 置空 + UI 清屏（下次 submit 生成新会话）。
   *  ★ busy 时也允许：死循环/卡死时这是用户唯一的出路——先 abort 中止当前轮，再开新会话。
   *    abort 触发 runAgent 走 aborted 出口收尾；final 事件仅 closeStreaming 不 appendRow，不污染新屏。 */
  async newSession(): Promise<void> {
    if (this.busy) this.abort();
    this.setSessionId(null);
    this.callbacks.onSessionReset();
  }

  /** 载入历史会话续接：切换 id + 回放 transcript。 */
  async loadSession(id: string): Promise<void> {
    this.setSessionId(id);
    this.callbacks.onSessionReset();
    try {
      const msgs = (await readMessages(id)) as unknown as Array<Record<string, unknown>>;
      emitReplay(msgs, this.callbacks.sink);
    } catch {
      /* 无历史或读取失败 → 空回放，不阻塞 */
    }
    this.sink({ type: "info", text: "📂 已载入会话（继续对话将续接此会话）" });
    // ★ 回放结束信号：所有 row 已送出，通知前端强制滚到底（展示最新对话，而非回放起点的顶部）。
    //   回放行经 appendRow 追加、滚动受 nearBottom() 门控——长会话下永远停在顶部；此信号绕开门控强制落底。
    this.callbacks.sink({ type: "replayDone" });
  }

  /** 更新活动会话 id 并持久化（重载后可恢复，杜绝碎片化新会话）。 */
  private setSessionId(id: string | null): void {
    this.sessionId = id;
    this.callbacks.setPersistedSessionId?.(id);
  }

  /** webview ready 后调用：若存在活动会话则回放历史（panel 重建 / 重载恢复都走此路径，无缝续接）。
   *  去除原 needsReplay 一次性限制——ready 仅在 webview 首次加载触发一次，不会重复重放。 */
  async replayCurrentSession(): Promise<void> {
    if (this.sessionId) await this.loadSession(this.sessionId);
  }

  /** 收集当前挂起、需在 panel 重建后重广播的交互消息（approval/question/plan）。
   *  仅当对应 pending resolve 仍存在（用户尚未决策）时才返回，避免重播已解决的历史交互。 */
  collectPendingUI(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    if (this.lastApprovalEvt) out.push({ type: "evt", evt: this.lastApprovalEvt });
    if (this.pendingQuestion && this.lastQuestionReq) out.push({ type: "question", req: this.lastQuestionReq });
    if (this.pendingPlan && this.lastPlanText != null) out.push({ type: "plan", plan: this.lastPlanText });
    return out;
  }

  /** 枚举本工作区历史会话（供 UI 会话选择器）。 */
  async listSessions(): Promise<SessionSummary[]> {
    return listSessions();
  }

  /** 枚举当前会话可分叉锚点（各轮 assistant 检查点；无活动会话/读失败 → 空表）。 */
  async listForkAnchors(): Promise<ForkAnchor[]> {
    const sid = this.sessionId;
    if (!sid) return [];
    try {
      return deriveForkAnchors(await readTranscriptLines(sid));
    } catch {
      return [];
    }
  }

  /** 从锚点分叉当前会话：forkSession 派生新会话（源不动）→ 载入续接。 */
  async forkFrom(lineId: string): Promise<void> {
    const sid = this.sessionId;
    if (!sid) throw new Error("当前无活动会话，无可分叉");
    const r = await forkSession(sid, lineId);
    await this.loadSession(r.sessionId);
    this.sink({ type: "info", text: `🌿 已分叉为新会话（源会话不变），继续对话将写入新会话。` });
  }

  /** 重命名会话：写 state.title（不动 sessionId/文件夹，transcript 路径稳定）。 */
  async renameSession(id: string, title: string): Promise<void> {
    await persistRenameSession(id, title);
  }

  /** 删除会话：递归删文件夹；若删的正是当前活动会话则置空 + 清屏，避免下次 submit 复活同 id 空会话。 */
  async deleteSession(id: string): Promise<void> {
    await persistDeleteSession(id);
    if (this.sessionId === id) {
      this.setSessionId(null);
      this.callbacks.onSessionReset();
    }
  }

  // —— 决策回传（panel → host） ——

  /** 审批决策：core approvalGate 按 toolsId 定位挂起的审批锁并解锁。 */
  resolveApproval(sessionId: string, toolsId: string, decision: ApprovalDecision): void {
    this.lastApprovalEvt = null; // 已决策，不再重广播
    resolveUserApprovalLock(sessionId, toolsId, decision);
  }

  /** 方案决策回传（接受/编辑后接受/拒绝）。 */
  resolvePlan(r: PlanResolution): void {
    const p = this.pendingPlan;
    this.pendingPlan = null;
    this.lastPlanText = null; // 已决策，不再重广播
    p?.resolve(r);
  }

  /** 提问回传：前端选项 → resolve 挂起的 ask_question。 */
  resolveQuestion(answer: QuestionAnswer): void {
    const p = this.pendingQuestion;
    this.pendingQuestion = null;
    this.lastQuestionReq = null; // 已决策，不再重广播
    p?.resolve(answer);
  }

  // —— 提问（ask_question 工具 → UI 弹选项） ——

  private askQuestion(req: QuestionRequest): Promise<QuestionAnswer> {
    return new Promise<QuestionAnswer>((resolve) => {
      this.pendingQuestion = { resolve };
      this.lastQuestionReq = req; // 暂存供 panel 重建后重广播
      this.callbacks.onQuestion(req);
    });
  }

  // —— 模式/模型开关（工具栏 → host） ——

  setModel(m: string): void {
    this.model = m;
  }
  setPlanMode(on: boolean): void {
    this.planMode = on;
  }
  setAutoMode(on: boolean): void {
    this.autoMode = on;
  }
  setThinkingLevel(lvl: ThinkingLevel): void {
    this.thinkingLevel = lvl;
  }
  setLocale(l: "zh" | "en"): void {
    this.locale = l;
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.callbacks.onBusy(b);
  }
}
