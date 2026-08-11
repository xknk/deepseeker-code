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
import { getOrCreateSessionId, listSessions, renameSession as persistRenameSession, deleteSession as persistDeleteSession, type SessionSummary } from "@/session/store.ts";
import { readMessages } from "@/session/transcript.ts";
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
  private proposedPlan: string | null = null;
  private enterPlanReason: string | null = null;
  private pendingQuestion: { resolve: (a: QuestionAnswer) => void } | null = null;
  private pendingPlan: { resolve: (r: PlanResolution) => void } | null = null;
  /** 重载恢复来的会话待回放（webview ready 后 replayIfRestored 消费一次即清）。 */
  private needsReplay = false;

  constructor(private callbacks: ChatHostCallbacks) {
    // ★ 重载恢复：从 workspaceState 取回上次活动会话 id，避免重载后新建碎片 session；
    //   needsReplay 标记「恢复来的会话，webview ready 后回放历史」实现无缝续接。
    const persisted = callbacks.getPersistedSessionId?.();
    if (persisted) { this.sessionId = persisted; this.needsReplay = true; }
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

  /** 事件 sink：先截获 plan 两阶段所需信号，再原样转发给 UI。 */
  private sink = (evt: Record<string, unknown>): void => {
    const type = evt?.type as string;
    if (type === "plan.proposed") this.proposedPlan = (evt.plan as string) ?? "";
    else if (type === "plan.enterRequested") this.enterPlanReason = (evt.reason as string) ?? "";
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
    if (!text || this.busy) return;
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

  /** 新会话：id 置空 + UI 清屏（下次 submit 生成新会话）。 */
  async newSession(): Promise<void> {
    if (this.busy) return;
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

  /** webview ready 后调用：若 sessionId 是重载恢复来的，回放历史实现无缝续接（仅一次）。 */
  async replayIfRestored(): Promise<void> {
    if (!this.needsReplay) return;
    this.needsReplay = false;
    if (this.sessionId) await this.loadSession(this.sessionId);
  }

  /** 枚举本工作区历史会话（供 UI 会话选择器）。 */
  async listSessions(): Promise<SessionSummary[]> {
    return listSessions();
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
    resolveUserApprovalLock(sessionId, toolsId, decision);
  }

  /** 方案决策回传（接受/编辑后接受/拒绝）。 */
  resolvePlan(r: PlanResolution): void {
    const p = this.pendingPlan;
    this.pendingPlan = null;
    p?.resolve(r);
  }

  /** 提问回传：前端选项 → resolve 挂起的 ask_question。 */
  resolveQuestion(answer: QuestionAnswer): void {
    const p = this.pendingQuestion;
    this.pendingQuestion = null;
    p?.resolve(answer);
  }

  // —— 提问（ask_question 工具 → UI 弹选项） ——

  private askQuestion(req: QuestionRequest): Promise<QuestionAnswer> {
    return new Promise<QuestionAnswer>((resolve) => {
      this.pendingQuestion = { resolve };
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
