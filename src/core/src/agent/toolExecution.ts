/**
 * @file agent/toolExecution.ts
 * @description 单个 tool_call 的完整处理（纯函数）：解析→终结/abort 判定→匹配→权限→保护路径→
 *  灾难命令→锁→分类器审批→pre-hook→undo 备份→execute→verify→post-hook→脱敏→截断→outputFilter。
 *
 *  从 runAgent 抽出（原内联闭包），把运行期状态显式打包成 ToolCallContext，使本函数可被
 *  toolScheduling 的 Promise.all 并发调用，且不依赖任何 agent 主循环闭包。
 *  纯数据契约：不 yield / 不 message.push / 不 appendMessage——副作用（yield tool.end / message.push /
 *  appendMessage）由调度层（toolScheduling）统一 flush。
 */
import { truncateToolResult } from "./truncate.ts";
import { collectToolResult } from "./toolResultCollect.ts";
import { ToolContext, ToolSafetyLevel, ToolExecutionResultStatus, ToolExecuteResult } from "@/tool/index.ts";
import { validateToolArgs } from "@/tool/argsValidator.ts";
import { requestApproval, isProtectedWrite, getActiveWorkspaceRoot } from "@/tool/guard.ts";
import { checkPermission } from "@/tool/permissions.ts";
import { runPreHooks, runPostHooks } from "@/tool/hooks.ts";
import { computeLockKey, isLockHeld } from "@/tool/lockManager.ts";
import { runBackgroundTool } from "./backgroundTool.ts";
import { beforeMutationBackup } from "@/tool/undo/backup.ts";
import { runAutoCheck, matchCommandDeny, isReadOnlyCommand, isScriptRunnerCommand } from "@/tool/autoPermission.ts";
import { resolveMcpPermissionName } from "@/tool/mcp/loader.ts";
import { appConfig } from "@/config/index.ts";
import path from "path";
import { writeSidecarArchive } from "@/session/sidecar.ts";
import { RunAgentEvents, PermissionMode, AuxUsageReporter } from "./type.ts";
import { UIEvent, TraceDecisionSource } from "@/observability/type.ts";
import { RequestApprovalFn, RequestQuestionFn, RequestIdeActionFn } from "@/host/type.ts";

// ★ #8b（2026-09-16）：成败前缀嗅探通道（FAILED_PREFIXES + explicitOk）结构性退役——
//   ok 判定唯一来源是本函数内 resultStatus 结构化跟踪：execute 返回的 ToolExecuteResult.status /
//   verifyResult 的 FAILED / 各拒绝路径显式置 failed。文案不再承载成败语义，动态透传的命令 stdout
//   恰以 "❌" 等前缀开头不再被误判失败（路线 #8 痛点修正）。防漂移断言见
//   tests/tool-failure-consistency.test.ts（C 规则：本文件不得再出现嗅探设施）。

/**
 * 应用工具声明的隐私脱敏规则（防云端模型读到 .env / 密钥等机密）：
 *  - RegExp[]：逐条全局替换为 [MASKED_SECRET]；
 *  - 函数：交由工具自定义脱敏（可结合 args 动态决策）。
 * 容错优先：脱敏异常返回原文，绝不阻断工具结果回灌。
 */
export const applyPrivacyMasking = (
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
 * 单个 tool_call 的处理结果（processToolCall 返回）。纯数据——副作用（yield tool.end / message.push /
 * appendMessage）由分波调度层统一 flush，使 processToolCall 可被 Promise.all 并发调用。
 */
export type ToolCallOutcome = {
    toolCallId: string;
    calledName: string;
    calledArgs: any;
    resultForModel: string;
    resultForUser: string;
    ok: boolean;
    aborted?: boolean;
    /** ★ P1-6 声明化终结：kind 随工具声明 terminal 分流（plan_exit→exit_plan_mode 语义 / plan_enter→enter_plan_mode
     *  语义 / generic=通用终结：结果只给用户、不再回喂模型续推）。 */
    terminal?: { kind: 'exit_plan_mode' | 'enter_plan_mode' | 'generic'; plan?: string; reason?: string };
    /** ★ read_image 附带图像（base64 只在此中转，不进 resultForModel 文本）——调度层注入 user 附件消息 */
    imageAttachments?: ToolExecuteResult['images'];
};

/**
 * processToolCall 运行期依赖的上下文（原 runAgent 闭包变量的显式打包）。
 * 每轮推理后由主循环/调度层构造一次，透传给本函数。逐字段比对 ToolContext，避免漏传
 * onUIEvent/requestApproval/requestQuestion/permissionMode（subagent 透传这些给子 agent toolCtx，漏传则审批死锁）。
 */
/**
 * ★ P2-11（内核审查报告第三批，2026-10-20，轻量落地）：宿主通道/运行期可选字段全部 required
 * （类型含 undefined）。原「逐字段比对避免漏传」是手工纪律（toolScheduling 注释自承）——可选字段
 * 下 runAgent 构造处漏写属性名编译器不报错，字段一多漂移必现（planWriteRejections/budgetCheck
 * 两批各加一个即是信号）。required 化后：新增字段忘在构造处对齐 → TS「missing property」编译错，
 * 手工纪律退役为编译期穷尽。值语义不变（`field: T | undefined`，消费点 `?.()` 照旧）。
 */
export type ToolCallContext = {
    sessionId: string;
    cwd: string;
    depth: number;
    round: number;
    startTime: number;
    llmDecisionSource: TraceDecisionSource;
    signal: AbortSignal | undefined;
    rawTools: any[];
    events: RunAgentEvents;
    permissionMode: PermissionMode | undefined;
    /** ★ P0-A 计划模式（runtime 档执行层门禁用）：计划期写工具在 processToolCall 拒绝，工具表不裁剪（保前缀缓存）。 */
    planMode: boolean | undefined;
    onUIEvent: ((evt: UIEvent) => void) | undefined;
    requestApproval: RequestApprovalFn | undefined;
    requestQuestion: RequestQuestionFn | undefined;
    ideAction: RequestIdeActionFn | undefined;
    keepRecentUnits: number;
    compactRatio: number;
    modelWindow: number;
    parentSystemPrompt: string;
    /** ★ P2-1 本时刻上下文用量估算（token，estReal 口径）：截断预算随窗口余量自适应收缩。
     *  每轮构造 toolCallCtx 时算一次（已含本轮 assistant，常数近似足够，不逐工具更新）；
     *  undefined → 不缩放，截断行为逐字节不变（向后兼容）。 */
    contextTokensEst: number | undefined;
    /** ★ P3-8 run 级 read_file 读取追踪（runAgent 每 run 建一个 Map、逐轮传同一引用），见 ToolContext.readTracker。 */
    readTracker: Map<string, { mtimeMs: number; count: number }> | undefined;
    /** ★ 子 run 成本回灌父累计器（成本信任链第二环 E1），见 ToolContext.reportCost。 */
    reportCost: ((yuan: number) => void) | undefined;
    /** ★ 按次计费工具成本上报（DeepSeek Search/Fetch），见 ToolContext.toolCostSink。 */
    toolCostSink: ((yuan: number) => void) | undefined;
    /** ★ 辅助模型用量上报（成本信任链 P0-2），见 ToolContext.onAuxUsage。 */
    onAuxUsage: AuxUsageReporter | undefined;
    /** ★ P1-7 计划拒绝熔断：计划期非 SAFE 工具被拒时增量回调（每次 +1）；计数器与熔断判定在 runAgent。 */
    planWriteRejections: ((delta: number) => void) | undefined;
    /** ★ P1-5 子任务预算熔断探测，见 ToolContext.budgetCheck（经此透传给 runSubagent → 子 runAgent）。 */
    budgetCheck: (() => boolean) | undefined;
};

/**
 * P2-1 截断预算随窗口余量自适应（纯函数，供单测）：
 *  - fill≤0.5 原值（半满以下不干预——小结果不缩，省下的没几个 token，白添截断噪声）；
 *  - 0.5<fill≤0.85 线性降到 0.4×base；
 *  - fill>0.85 取 0.35×base（已近满窗，最坏组合「最满时来最大输出」正是高发压缩诱因）；
 *  - 下限 2000 字符（且绝不高于 base——极小自定义预算不被「下限」反向抬高）。
 * fill 缺省/非有限 → 原值（缺省路径逐字节不变）。
 */
export const scaleTruncBudget = (base: number, fill: number | undefined): number => {
    if (!Number.isFinite(base) || base <= 0) return base;
    if (fill === undefined || !Number.isFinite(fill) || fill <= 0.5) return base;
    const floor = Math.min(base, 2000);
    if (fill > 0.85) return Math.max(floor, Math.floor(base * 0.35));
    const factor = 1 - ((fill - 0.5) / 0.35) * 0.6; // (0.5,1.0] → (0.85,0.4] 线性内插
    return Math.max(floor, Math.floor(base * factor));
};

/**
 * ★ P2-10（内核审查报告第四批，2026-10-21）：processToolCall 的可变中间态——原闭包局部变量
 *   （calledName/calledArgs/result/denied/…）显式打包，供各阶段函数共享。字段随阶段推进填充：
 *   pre-hook argsOverride 改写 calledArgs、各拒绝路径置 denied/result、execute 填 result/images。
 */
type ToolCallState = {
    calledName: string;
    calledArgs: any;
    parseFailed: boolean;
    matchedTool: any | undefined;
    result: string;
    // ★ #8b 结构化成败跟踪（替代 FAILED_PREFIXES 前缀嗅探 + explicitOk 手工短路）：
    //   默认 success；拒绝/熔断/解析失败/verifyResult FAILED 显式置 failed。文案只是呈现，成败看状态。
    resultStatus: ToolExecuteResult['status'];
    errorCategory: ToolExecuteResult['errorCategory'];
    denied: boolean;
    /** PostToolUse hook 改写的模型视图结果（在 outputFilter 之后套用；用户视图 resultForUser 不动） */
    postHookOverride: string | undefined;
    /** 视觉读取：工具结果附带的 images（read_image）——不在 result 文本里（base64 三不进），
     *  由调度层在本波工具 flush 完后组装成独立 user 附件消息（tool role 携带 image part 会被端点 400）。 */
    imageAttachments: ToolExecuteResult['images'];
    /** isSync:false 后台工具标记 + 互斥锁 key（安全链中段判定，execute 阶段消费）。 */
    isBgTool: boolean;
    lockKey: string | null;
};

/** 置失败文案 + 状态（errorCategory 缺省 runtime；syntax 收模型调用形态错）。 */
const failResult = (state: ToolCallState, text: string, cat: ToolExecuteResult['errorCategory'] = 'runtime'): void => {
    state.result = text;
    state.resultStatus = 'failed';
    state.errorCategory = cat;
};

/** tool.validation.failed 事件统一发射（原五处逐字重复的 metadata/payload 形状）。 */
const emitValidationFailed = (ctx: ToolCallContext, toolCall: any, state: ToolCallState): void => {
    ctx.events({ sessionId: ctx.sessionId, eventType: 'tool.validation.failed', metadata: { depth: ctx.depth, decisionSource: ctx.llmDecisionSource, durationMs: performance.now() - ctx.startTime, round: ctx.round, tools_id: toolCall.id, toolName: state.calledName, toolSource: 'builtin', ok: false, attempt: ctx.round }, payload: { output: state.result } });
};

/**
 * 阶段一：终结/abort/计划模式门禁（P2-10 自 processToolCall 前段原样移出）。
 *   ★ P1-6 终结类声明化：流程形态（调用即终结本轮、结果不再回喂模型）随工具声明 terminal 走——
 *   原 exit/enter_plan_mode 按名特判退役为未声明者兜底（两者已带声明；兜底防第三方注册表未同步时计划流程断裂）。
 *   优先于 abort：模型已提交的方案/进入请求应呈现给用户，不被中止吞掉——「计划先于执行」。
 * @returns 命中即返回 outcome（调度层据此短路）；未命中返回 null 继续安全链
 */
const resolveEarlyOutcome = (ctx: ToolCallContext, toolCall: any, state: ToolCallState): ToolCallOutcome | null => {
    const { signal, planMode, planWriteRejections } = ctx;
    const { calledName, calledArgs, matchedTool, parseFailed } = state;
    const declaredTerminal = matchedTool?.function?.terminal;
    if (declaredTerminal === 'plan_exit' || (!declaredTerminal && calledName === "exit_plan_mode")) {
        const plan = typeof calledArgs?.plan === "string" ? calledArgs.plan : "";
        const note = "✅ [计划模式] 实现方案已提交，等待用户审批后进入实现阶段。";
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: true, terminal: { kind: 'exit_plan_mode', plan } };
    }
    if (declaredTerminal === 'plan_enter' || (!declaredTerminal && calledName === "enter_plan_mode")) {
        // ★ P0-A runtime 档：工具表恒定后计划模式也暴露 enter_plan_mode——已在计划模式时不再作为终结信号
        //   （防「重复进入 → 上层翻转重跑」循环），以普通结果引导模型继续调研/提交方案。
        if (planMode) {
            const note = "（已在计划模式中，无需重复进入。请继续只读调研，完成后调 exit_plan_mode 提交方案。）";
            return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: true };
        }
        const reason = typeof calledArgs?.reason === "string" ? calledArgs.reason : "";
        const note = "📋 [进入计划模式] 模型请求先以只读方式调研并规划方案，已切换至计划模式。";
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: true, terminal: { kind: 'enter_plan_mode', reason } };
    }
    // abort 占位（调度层据此设 abortedDuringTools 并为剩余 tool_call 补占位）
    if (signal?.aborted) {
        const placeholder = "（已中止，未执行）";
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: placeholder, resultForUser: placeholder, ok: false, aborted: true };
    }
    // ★ P0-A 计划模式执行层门禁（runtime 档，默认）：工具表全会话恒定（systemInjections 两态统一
    //   appendPlanControlTools），计划期改由此处拒绝未声明 planAllowed 的工具——不发审批、不加锁、
    //   不进 hook 流水线，直接以结果文案引导模型转只读/提交方案（计划先于执行的语义不变）。
    //   ★ #8a：原 PLAN_ALLOWED_TOOLS 工具名名单退役，白名单改读工具声明 planAllowed（缺省 = 拒绝，
    //   fail-closed）——matchedTool 匹配相应前移至本门禁之前。计划控制终结类（含声明式 plan_enter/plan_exit）
    //   已在上方拦截返回，此处保留显式豁免（双保险）。schema 档（DEEP_SEEK_PLAN_ENFORCEMENT=schema）回退裁表路径时本 gate 不生效。
    if (!parseFailed && planMode && appConfig.planEnforcement === 'runtime'
        && calledName !== 'enter_plan_mode' && calledName !== 'exit_plan_mode'
        && declaredTerminal !== 'plan_enter' && declaredTerminal !== 'plan_exit'
        && matchedTool?.function?.planAllowed !== true) {
        // ★ P1-7 计划拒绝熔断：只计「真写工具」的拒绝——matchedTool 存在且非 SAFE（ask_question 等SAFE 交互类
        //   被拒属正常流程，不计；幻觉工具名 matchedTool 缺失，同样不计）。增量回传 runAgent 熔断。
        if (matchedTool && matchedTool.function.safetyLevel !== ToolSafetyLevel.SAFE) planWriteRejections?.(1);
        const note = `❌ [计划模式] 当前为只读调研阶段，禁止 ${calledName}。完成方案请调 exit_plan_mode 提交，经用户审批后进入实现阶段。`;
        state.result = note;
        emitValidationFailed(ctx, toolCall, state);
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: false };
    }
    return null;
};

/**
 * 阶段二：安全链（P2-10 自 processToolCall 中段原样移出；顺序敏感——
 *   pre-hook 改写 → 参数校验 → 保护路径 → 权限规则 → 命令语义/只读免审 → 灾难命令 → 互斥锁 →
 *   分类器 → 人工审批 → 旧位 pre-hook → undo 备份）。任一环节拒绝即置 state.denied + result 文案，
 *   后续环节按 !denied 短路（与原逐行等价）。
 */
const runSecurityGates = async (ctx: ToolCallContext, toolCall: any, state: ToolCallState, toolCtx: ToolContext): Promise<void> => {
    const { sessionId, permissionMode } = ctx;
    const { calledName, calledArgs, matchedTool } = state;
    // ★ 安全分级审批：SAFE 免审；MUTATION/DANGER 执行前请求用户审批
    const level = matchedTool.function.safetyLevel;
    let needApproval = level === ToolSafetyLevel.MUTATION || level === ToolSafetyLevel.DANGER;
    let autoGateAsked = false; // ★ I-5：auto 分类器未放行（'ask'）→ 审批 detail 补来由说明
    // ★ 改写型 PreToolUse（第二梯队 #3，开关开时的正确位置）：位于全部安全门禁之前——
    //   改写后的 args 才是被保护路径/权限规则/灾难命令/互斥锁/审批/undo 备份评估的对象
    //   （否则 hook 改写会绕过门禁，或用户批了 X 而 hook 已改成 Y）。deny 亦前置（省无谓审批
    //   弹窗，对齐 Claude Code 顺序）。开关关（DEEP_SEEK_HOOK_REWRITE=0）→ 跳过此处，
    //   回退下方旧位（审批后、仅 deny），行为与改造前一致。
    let preHooksAdvanced = false;
    if (appConfig.hookRewrite) {
        preHooksAdvanced = true;
        let veto: { deny: boolean; reason?: string; argsOverride?: any };
        // ★ P1-MCP 对称性：hook 匹配与权限层同用合成名（mcp_call → mcp__<server>__<tool>），
        //   声明式 PreToolUse 规则才能按 mcp__server__tool（或尾部 * 通配）精准拦截单个 MCP 工具，
        //   而非只能拦 mcp_call 整体。其余工具 resolveMcpPermissionName 原样返回，行为不变。
        try { veto = await runPreHooks(resolveMcpPermissionName(calledName, calledArgs), calledArgs, toolCtx); }
        catch (e: any) { veto = { deny: true, reason: `❌ [Pre-hook 异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。` }; }
        if (veto.deny) {
            state.denied = true;
            failResult(state, veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`, 'permission');
        } else if (veto.argsOverride !== undefined && veto.argsOverride !== null && typeof veto.argsOverride === 'object' && !Array.isArray(veto.argsOverride)) {
            console.log(`✏️ [Pre-hook] [${calledName}] args 已被 hook 改写`);
            state.calledArgs = veto.argsOverride;
        }
    }
    // ★ #8c 运行时参数校验（后续路线 #8c，2026-09-16）：位置在 pre-hook argsOverride 之后
    //   （改写后的 args 才是被校验对象），保护路径检查之前——与 parseFailed 同类：模型产出
    //   畸形调用早退，不发审批弹窗、不进锁/undo 备份/hook 后续，也不执行工具。
    //   schema 缺省的工具、MCP wrapped 的宽松回退、schema 编译失败（fail-open）天然零影响。
    //   coerceTypes 就地修正的 args 直接供后续门禁/execute 使用（修正后的值才是被执行对象）。
    {
        const paramsSchema = matchedTool.function.parameters;
        if (paramsSchema && typeof paramsSchema === 'object' && !Array.isArray(paramsSchema)) {
            const verdict = validateToolArgs(paramsSchema as Record<string, unknown>, state.calledArgs);
            if (!verdict.ok) {
                state.denied = true;
                failResult(state, `❌ 参数校验失败：${verdict.message}；请修正参数后重试（schema 要求见工具 parameters）。`, 'syntax');
                emitValidationFailed(ctx, toolCall, state);
            }
        }
    }
    // ★ P1-7 / P0-3 保护路径硬规则：写工具碰受保护目录（.git/.ssh/.aws/.deepseeker-code 等）→ 无论授权都拒。
    //   优先级最高（先于 checkPermission 用户规则）：即使用户 allow 了，也禁改 VCS/凭证/项目配置目录。
    //   ★ #8a 声明化：取参按工具声明 pathArgs（缺省：triggersUndo 工具 ['path']，否则不检查）——
    //   原 move_file 按名特判（P0-3：双路径不进 Undo 名单但同样必须拦，否则可 move 进 .git/hooks/ 实现
    //   持久化 RCE）退役，move_file 以 pathArgs:['source','destination'] 声明携带，新工具漏声明不再静默豁免。
    const pathArgs: string[] = matchedTool.function.pathArgs ?? (matchedTool.function.triggersUndo ? ['path'] : []);
    const protectedPaths = pathArgs.map(k => state.calledArgs?.[k]);
    const hitProtected = protectedPaths.find(p => typeof p === 'string' && isProtectedWrite(p, toolCtx.cwd));
    if (hitProtected) {
        state.denied = true;
        failResult(state, `❌ [保护路径] 禁止修改受保护目录（.git/.ssh/.aws/.deepseeker-code 等 VCS/凭证/配置）：${hitProtected}。`, 'permission');
    }
    // ★ G1 细粒度权限规则（deny>ask>allow）：allow 免审、deny 直拒、ask 强制审批；未匹配走默认 safetyLevel
    let perm: ReturnType<typeof checkPermission> = null;
    try {
        // ★ P1-MCP dispatcher 兼容：mcp_call 在权限层用合成名 mcp__<server>__<tool> 匹配规则
        //   （用户既有 permissions 规则含 mcp__server__* 通配，语义不变）；其余工具名原样。
        //   ★ I-4 第四批：尾参传 sessionId——allow-session 会话桶与本会话裁决挂钩（多会话进程隔离）。
        perm = checkPermission(resolveMcpPermissionName(calledName, state.calledArgs), state.calledArgs, matchedTool.function.primaryArg, sessionId);
        if (perm === 'deny') { state.denied = true; failResult(state, `❌ [权限规则]：[${calledName}] 被权限规则 deny 拒绝。`, 'permission'); }
        else if (perm === 'allow') { needApproval = false; }
        else if (perm === 'ask') { needApproval = true; }
    } catch { perm = null; /* fail-safe：权限裁决异常 → 走默认 safetyLevel 行为 */ }
    // ★ 命令语义判定（P1-6 声明化）：「命令执行器」改读工具声明 argKind==='command'，
    //   原 run_command / run_in_background 按名特判退役（两者已带声明）。前台性看 isSync：
    //   argKind='command' 且 isSync !== false 才是前台命令（run_in_background 后台工具不享受只读免审）。
    const isCommandTool = matchedTool.function.argKind === 'command';
    const isForegroundCommand = isCommandTool && matchedTool.function.isSync !== false;
    // ★ 默认模式只读命令免审（P1-8）：仅前台命令工具、且用户未设显式权限规则（perm===null）时，
    //   对只读命令（git 只读子命令 / ls / tsc --noEmit 等无 shell 元字符的纯查看+验证类）直接免审，消除审批疲劳。
    //   安全：COMMAND_DENY 硬闸门（下方紧接判定）+ hasShellMetachars（isReadOnlyCommand 内）双闸兜底；
    //         收紧：permissions.ask/deny 优先级始终更高（perm!==null 时本判定不生效，用户可 opt-out）；
    //         不含后台命令工具（isSync:false，任务持续运行，免审风险更高）；
    //         npm/pnpm/npx/yarn「跑脚本」类被 scriptRunnerBlocked 单独拦下（供应链面，见下），不再免审。
    // ★ 供应链免审防绕过（P0 修复）：scriptRunnerBlocked 命令同时关闭只读免审（本判定）与 auto 分类器
    //   （下方 runAutoCheck）——package.json scripts 与 npx 未装包拉取是仓库作者的任意代码，
    //   hasShellMetachars 只验证命令串本身、拦不到脚本内容，分类器同样看不见脚本内容。
    //   perm 为 null（无用户显式规则）时强制转人工审批一次；用户选 allow-always 后由 buildScopedAllowRule
    //   落【精确命令串】allow 规则，之后 perm==='allow' 自然免审——即「首次确认，记住」语义。
    //   ★ cwd 漂移重审（收口）：allow 规则只记命令串、不含 cwd——若模型事后带 cwd 指到 monorepo 子包，
    //     同串命令会免审执行【另一个】package.json 的脚本（npm/pnpm 脚本解析以 cwd 下的 package.json 为准，
    //     投毒面与首次审批时看到的不是同一份）。故 script-runner 类命令显式 cwd ≠ 工作区根时视同未确认，
    //     重新审批一次（fail-closed；审批 detail 会带目录，用户知情）。非包管理器命令不受影响。
    const cmdIsScriptRunner = isCommandTool
        && isScriptRunnerCommand(typeof state.calledArgs?.command === 'string' ? state.calledArgs.command : '');
    const argCwd = typeof state.calledArgs?.cwd === 'string' ? state.calledArgs.cwd.trim() : '';
    const samePath = (a: string, b: string): boolean => {
        try { const ra = path.resolve(a), rb = path.resolve(b); return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb; }
        catch { return false; }
    };
    const scriptRunnerCwdDrift = cmdIsScriptRunner && argCwd !== '' && !samePath(argCwd, toolCtx.cwd ?? process.cwd());
    const scriptRunnerBlocked = cmdIsScriptRunner && (perm === null || scriptRunnerCwdDrift);
    if (scriptRunnerCwdDrift) needApproval = true; // perm='allow' 已置 false → 漂移时强制拉回审批
    if (perm === null && needApproval && !state.denied && !scriptRunnerBlocked && isForegroundCommand
        && isReadOnlyCommand(typeof state.calledArgs?.command === 'string' ? state.calledArgs.command : '')) {
        needApproval = false;
    }
    // ★ P0-2 灾难命令硬闸门：与 needApproval / allow 规则解耦——堵住「裸 allow 规则让
    //   checkPermission='allow' 跳过 runAutoCheck（含 COMMAND_DENY）」的审批绕过路径。
    //   即使用户 allow 了命令工具，rm -rf /、curl|sh、外传密钥等灾难命令仍硬拒。
    if (isCommandTool
        && matchCommandDeny(typeof state.calledArgs?.command === 'string' ? state.calledArgs.command : '')) {
        state.denied = true;
        failResult(state, `❌ [安全] 灾难命令清单拦截（不可被 allow 规则绕过）：[${calledName}] ${String(state.calledArgs?.command ?? '').slice(0, 100)}`, 'permission');
    }
    // ★ isSync:false 后台工具的互斥锁（快查）：锁被持有则直接拒绝，省去一次无谓审批弹窗。
    //   真正的获锁在 runBackgroundTool 启动时执行、其 finalize 必定释放——
    //   check-then-act 形态为有意设计（单人本地工具，并发窗口无害），勿改预占式。
    state.isBgTool = matchedTool.function.isSync === false;
    state.lockKey = state.isBgTool ? computeLockKey(matchedTool.function.exclusiveLock, state.calledArgs, toolCtx) : null;
    if (state.lockKey && isLockHeld(state.lockKey)) {
        state.denied = true;
        failResult(state, `🔒 [互斥锁阻塞]：已有后台任务持有锁 [${state.lockKey}]，[${calledName}] 调用被跳过。`);
    }
    // ★ 分类器审批（P1-6，2026-08-06 两档）：
    //   default（permissionMode!=='auto'）：文件增删改 + 命令执行（run_command/run_in_background）跑分类器——高频。
    //     文件类有 undo 备份兜底；命令类有「只读免审 + COMMAND_DENY 硬闸」在前，分类器只兜非只读的安全命令（build/lint…），
    //     safe 免审、risky 转人工，减少审批疲劳。
    //   /auto（permissionMode==='auto'）：相对 default 再覆盖 web_fetch/web_search、git_commit、MCP——显式 opt-in 的激进档；
    //     外向/不可 undo/黑盒，prompt injection 重灾区。COMMAND_DENY 清单（rm -rf /、curl|sh、外传敏感…）硬拒始终生效。
    //   两档共用：safe→免审放行、risky/异常/超时→转人工、敏感文件/高危命令 deny 清单→硬拒（fail-closed，绝不静默放行）。
    //   想对某项目/工具强制人工：配 permissions.ask（优先级高于分类器）。
    //   优先级：保护路径 > checkPermission 显式规则（上方已判）> deny 清单 > 分类器 > requestApproval 人工。
    if (needApproval && !state.denied && !scriptRunnerBlocked) {
        // ★ P1-MCP：同上，auto 分类器亦按合成名参与（isMcpTool / aggressive 档判定与旧逐工具名路径一致）
        //   scriptRunnerBlocked 命令跳过分类器：分类器只见命令串、看不见 scripts 内容，无法负责任地判 safe
        //   （含 /auto 档——供应链面不因 opt-in 激进档而豁免人工首验；用户可预配 allow 规则跳过）。
        const auto = await runAutoCheck(resolveMcpPermissionName(calledName, state.calledArgs), state.calledArgs, toolCtx, permissionMode === 'auto',
            // ★ P0-3（裁定 B 方案）：decl 补齐 safetyLevel/triggersUndo——快路径三条件缺一不可，
            //   两者都来自工具声明（勿在此处按名特判，名单已 #8a 声明化退役）。
            { autoApproval: matchedTool.function.autoApproval, pathArgs: matchedTool.function.pathArgs, primaryArg: matchedTool.function.primaryArg, safetyLevel: matchedTool.function.safetyLevel, triggersUndo: matchedTool.function.triggersUndo });
        if (auto === 'allow') { needApproval = false; }
        else if (auto === 'deny') { state.denied = true; failResult(state, `❌ [auto] 内置高危清单拦截：[${calledName}] ${state.calledArgs?.path ?? ''}。`, 'permission'); }
        else { autoGateAsked = true; } // ★ I-5：'ask'（risky/不确定/超时/异常/未声明 autoApproval/工作区外）→ 落人工，审批 detail 补说明
    }
    if (needApproval && !state.denied) {
        const ra = matchedTool.function.requireApproval;
        let detail = `申请执行高危工具 [${calledName}]`;
        try { if (ra) detail = typeof ra === 'function' ? await ra(state.calledArgs, toolCtx) : ra; }
        catch (e: any) { state.denied = true; failResult(state, `❌ [审批描述生成异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`, 'permission'); }
        // ★ I-5 分类器可见性（内核审查报告第三批，2026-10-20）：安全闸未自动放行的调用转人工时，
        //   审批弹窗补一句来由说明——用户面对的不再是无解释的弹窗；配合 runAutoCheck 的
        //   「安全判定中…」进度（分类器 10s 静默期间可见），静默停顿 → 有进度 → 有说明闭环。
        if (autoGateAsked) detail += `\n（ℹ️ 说明：本调用未获自动放行——不在自动放行范围 / 安全分类器判 risky / 判定超时（分类器上限 10s）或异常，按 fail-closed 转人工审批。）`;
        if (!state.denied) {
            let approved = false;
            try { approved = await requestApproval(calledName, toolCall.id, detail, toolCtx, level, state.calledArgs, matchedTool.function.primaryArg); }
            catch (e: any) { state.denied = true; failResult(state, `❌ [审批流程异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`, 'permission'); }
            if (!approved && !state.denied) { state.denied = true; failResult(state, `❌ [安全熔断]：用户拒绝了 [${calledName}] 的执行申请。`, 'permission'); }
        }
    }
    // ★ pre-hooks（旧位兜底）：开关关时保持改造前行为（审批后、仅 deny，改写字段已被 dispatch 忽略）；
    //   开关开时已在分支顶部前置执行（deny+改写），此处跳过防重复执行。
    if (!state.denied && !preHooksAdvanced) {
        let veto: { deny: boolean; reason?: string };
        // ★ P1-MCP 对称性：同上方改写位，hook 匹配用合成名（见 runPreHooks 首个调用点注释）
        try { veto = await runPreHooks(resolveMcpPermissionName(calledName, state.calledArgs), state.calledArgs, toolCtx); }
        catch (e: any) { veto = { deny: true, reason: `❌ [Pre-hook 异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。` }; }
        if (veto.deny) { state.denied = true; failResult(state, veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`, 'permission'); }
    }
    // ★ Undo 写前备份：审批+pre-hook 放行后、execute 写盘前快照原文件/目录（凡改必可回退，失败则阻断写入）。
    //   （denied 取门禁推进至此的快照——审批拒绝已置位，快路径 allow 不影响该值）
    //   ★ #8a 声明化：是否备份/备份策略改读工具声明 triggersUndo（原 MUTATION_TOOLS 名单退役）。
    const denied = state.denied;
    if (!denied && matchedTool.function.triggersUndo) {
        try { await beforeMutationBackup(matchedTool.function.triggersUndo, calledName, state.calledArgs, toolCall.id, sessionId); }
        catch (e: any) { state.denied = true; failResult(state, `❌ [Undo 备份失败·安全熔断]：${e?.message ?? e}。写入已阻止（凡改必可回退原则）。`); }
    }
};

/**
 * 阶段三：执行（P2-10 自 processToolCall 原样移出）——execute → 收集 → verifyResult →
 *   成败分流事件 → post-hooks（观察 + 收集 resultOverride）。仅 denied=false 时被调用
 *   （与原 if (!denied) 门控等价）。
 */
const executeTool = async (ctx: ToolCallContext, toolCall: any, state: ToolCallState, toolCtx: ToolContext): Promise<void> => {
    const { sessionId, depth, round, startTime, llmDecisionSource, signal, events } = ctx;
    const { calledName, calledArgs, matchedTool } = state;
    try {
        events({ sessionId, eventType: 'tool.execute.start', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin' }, payload: { output: JSON.stringify(calledArgs) } });
        // 执行工具（取消由 ctx.abortSignal 驱动；长任务走 isSync:false 后台模式，不挂固定 timeout）
        const execRet = matchedTool.function.execute(calledArgs, toolCtx);
        // ★ #8b：两条收集路径均已结构化——string 自动归一 success，toolFailure() 返回体携带 failed
        const collected: ToolExecuteResult = state.isBgTool
            ? await runBackgroundTool(execRet as any, state.lockKey, calledName, signal)
            : await collectToolResult(execRet, (chunk) => toolCtx.emitProgress?.(chunk), signal);
        state.result = collected.content;
        state.resultStatus = collected.status;
        state.imageAttachments = collected.images;
        if (collected.status === 'failed') state.errorCategory = collected.errorCategory ?? 'runtime';
        // verifyResult 判定：FAILED 时置结构化失败并前置警告（防模型对报错产生"成功"幻觉）。
        //   ★ #8b：ok 不再依赖「【系统判定」文案前缀——状态由 verdict 直接驱动，文案仅保留提示职责。
        if (matchedTool.function.verifyResult) {
            const verdict = matchedTool.function.verifyResult(state.result, toolCtx);
            if (verdict.status === ToolExecutionResultStatus.FAILED) {
                state.result = `【系统判定：执行失败】${verdict.summary ?? ''}\n请正视下方输出，不要乐观假设成功。\n\n${state.result}`;
                state.resultStatus = 'failed';
                state.errorCategory = verdict.errorCategory ?? 'unknown';
            }
        }
        // ★ #8b：end 事件按结构化成败分流（原硬编码 ok:true——toolFailure 字符串返回时误报成功）
        if (state.resultStatus === 'success') {
            events({ sessionId, eventType: 'tool.execute.end', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: true }, payload: { output: state.result } });
        } else {
            events({ sessionId, eventType: 'tool.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round, errorCategory: state.errorCategory ?? 'unknown' }, payload: { output: state.result } });
        }
    } catch (err) {
        console.error(`❌ 执行工具 ${calledName} 时发生错误:`, err);
        failResult(state, `工具执行失败: ${err instanceof Error ? err.message : String(err)}`);
        events({ sessionId, eventType: 'tool.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round, errorCategory: state.errorCategory ?? 'runtime' }, payload: { output: state.result } });
    }
    // ★ post-hooks：执行后观察（不拦截，自身异常仅告警）+ 开关开时收集 resultOverride
    //   （改写模型视图；hook 观察到的 result 是 4K 截断视图，其自写回的 override 不受该截断）
    try {
        // ★ P1-MCP 对称性：hook 匹配用合成名（见 runPreHooks 首个调用点注释）
        const post = await runPostHooks(resolveMcpPermissionName(calledName, calledArgs), calledArgs, state.result, toolCtx);
        state.postHookOverride = post?.resultOverride;
    } catch (e: any) {
        console.warn(`⚠️ post-hook [${calledName}] 异常（已忽略）:`, e?.message ?? e);
    }
};

/**
 * 阶段四：收尾（P2-10 自 processToolCall 尾段原样移出）——脱敏 → 自适应截断预算 → 侧车存档 →
 *   截断 → outputFilter → post-hook override 套用 → 通用终结声明 → 组装 outcome。
 */
const finalizeOutcome = async (ctx: ToolCallContext, toolCall: any, state: ToolCallState): Promise<ToolCallOutcome> => {
    const { sessionId, modelWindow, contextTokensEst } = ctx;
    const { calledName, calledArgs, matchedTool } = state;
    // 脱敏（verifyResult 之后、truncate 之前；只影响发往云端模型的视图）
    state.result = applyPrivacyMasking(matchedTool?.function?.privacyMaskingRules, calledArgs, state.result);
    // ★ P2-1 截断预算随窗口余量自适应：fill=上下文已填充比（contextTokensEst/modelWindow）。
    //   ★ 顺序红线：先算 scaled truncBudget，再做 result.length > truncBudget 的侧车落盘判定——预算变小后
    //   判定条件仍是「截断条件」的超集（microcompact 只缩不涨），『截断必命中侧车』不变量保持；若顺序颠倒
    //   （先按旧预算判侧车、再按新预算截断）会出现「截了却没存档」的信息丢失。
    const fill = contextTokensEst !== undefined && modelWindow > 0 ? contextTokensEst / modelWindow : undefined;
    const truncBudget = scaleTruncBudget(matchedTool?.function?.maxOutputCharacters ?? appConfig.MAX_TOOL_RESULT_CHARS, fill);
    // ★ 侧车原文存档（recall 配套）：此处 result 已脱敏、尚未截断——transcript 落盘的是截断后视图，
    //   被去中间的原文若不另存将无处可寻。仅在确会触发截断时落盘（缓存定位、非真相源；recall 的
    //   with_full 按需取回）。判定条件是“原始长度超预算”的超集（microcompact 只缩不涨，故截断必命中
    //   本条件；反之可能白存一份无人引用的缓存，无害）。失败仅降级为普通截断提示，绝不阻断回灌。
    //   路径/标记文案/总量闸经 session/sidecar.ts 共享契约（写读两侧单一出处，防隐式字符串契约漂移）。
    const sidecarNote = state.result.length > truncBudget
        ? await writeSidecarArchive(sessionId, String(toolCall.id), state.result)
        : undefined;
    state.result = truncateToolResult(state.result, truncBudget, sidecarNote);
    // ★ #8b：ok 判定唯一来源 = 结构化状态（前缀嗅探/explicitOk 已退役）
    const resultStatus = state.resultStatus;
    const ok = resultStatus === 'success';
    // outputFilter：分流 toModel（精简，喂模型）/ toUser（完整，给用户看）；未声明则两者均原 result
    let resultForModel = state.result;
    let resultForUser = state.result;
    if (matchedTool?.function?.outputFilter) {
        try {
            const split = matchedTool.function.outputFilter(state.result);
            resultForModel = split.toModel;
            resultForUser = split.toUser;
        } catch { /* 容错：outputFilter 异常则两者均用原 result */ }
    }
    // ★ PostToolUse hook 改写（第二梯队 #3）：仅替换模型视图，用户视图保持工具真实输出；
    //   套用工具自身 maxOutputCharacters 同上限（override 由用户 hook 产生，同样需有界）。
    //   transcript 落盘的是 resultForModel → 模型实际所见，回放/压缩/fork 天然一致。
    //   ★ 改写视图同样接侧车（2026-09-16 顺手登记项收口）：此前 override 超预算截断后无存档无提示，
    //   被截去的改写内容无处可寻。覆盖写同 id 侧车——模型视图已被 hook 改写，with_full 的「取回该
    //   结果全文」语义跟随改写后视图；override 未超预算时不写不提示（原工具结果侧车若已存在则保留，
    //   recall 语义不变）。
    if (state.postHookOverride !== undefined) {
        console.log(`✏️ [Post-hook] [${calledName}] 模型视图结果已被 hook 改写`);
        // ★ P2-1：override 与主截断同尺度（同一 fill），先算 scaled 预算再判侧车（顺序红线同上）
        const overrideBudget = scaleTruncBudget(matchedTool?.function?.maxOutputCharacters ?? appConfig.MAX_TOOL_RESULT_CHARS, fill);
        const overrideNote = state.postHookOverride.length > overrideBudget
            ? await writeSidecarArchive(sessionId, String(toolCall.id), state.postHookOverride)
            : undefined;
        resultForModel = truncateToolResult(state.postHookOverride, overrideBudget, overrideNote);
    }
    // ★ P1-6 通用终结声明（terminal:true）：照常走完全部门禁与 execute 后终结本轮——结果只给用户
    //  （terminalText=resultForUser），调度层不再回喂模型续推。成败不改变终结性（提交即终结）。
    const declaredTerminal = matchedTool?.function?.terminal;
    if (declaredTerminal === true) {
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel, resultForUser, ok, imageAttachments: state.imageAttachments, terminal: { kind: 'generic' } };
    }
    return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel, resultForUser, ok, imageAttachments: state.imageAttachments };
};

/**
 * P2-10（内核审查报告第四批，2026-10-21）拆分后主入口：单个 tool_call 的完整处理
 *   （解析→终结/abort 判定→匹配→权限→锁→审批→pre-hook→undo 备份→execute→verify→post-hook→
 *   脱敏→截断→outputFilter）。
 *   纯函数——不 yield / 不 message.push / 不 appendMessage（副作用统一由调度层 flush），便于并发 Promise.all。
 *   ★ 纯移动重构：安全链各阶段抽为本文件内的阶段函数（resolveEarlyOutcome / runSecurityGates /
 *   executeTool / finalizeOutcome），共享 ToolCallState 可变中间态——阶段顺序即原执行顺序，
 *   permission→lock→approval→hook→undo→execute 的顺序敏感性不变，本函数只保留阶段编排。
 * @param toolCall 模型产出的单个 tool_call 对象
 * @param ctx     运行期上下文（见 ToolCallContext）
 * @returns 处理结果（纯数据），调度层据此 flush
 */
export const processToolCall = async (toolCall: any, ctx: ToolCallContext): Promise<ToolCallOutcome> => {
    const state: ToolCallState = {
        calledName: "", calledArgs: {}, parseFailed: false, matchedTool: undefined,
        result: "", resultStatus: "success", errorCategory: undefined, denied: false,
        postHookOverride: undefined, imageAttachments: undefined, isBgTool: false, lockKey: null,
    };
    if (toolCall.type === 'function') {
        state.calledName = toolCall.function.name;
        try { state.calledArgs = JSON.parse(toolCall.function.arguments || "{}"); }
        catch { state.parseFailed = true; }
        console.log(`🤖 模型请求调用工具: ${state.calledName}，参数:`, state.calledArgs);
    }
    state.matchedTool = ctx.rawTools.find((t: any) => t.function.name === state.calledName);
    // 终结类（plan_enter/plan_exit）/ abort / 计划模式门禁：任一命中即提前返回 outcome
    const early = resolveEarlyOutcome(ctx, toolCall, state);
    if (early) return early;
    // ★ toolCtx.cwd 与工具内部根同源：所有工具（fs/glob/search/command）内部 spawn/读取/搜索根都走 ALS 的
    //   getActiveWorkspaceRoot()。原先 cwd: getActiveCwd(cwd) 回退 process.cwd()，与 getActiveWorkspaceRoot()
    //   的回退（process.env.WORKSPACE_ROOT || process.cwd()）不同源——在 VSCode 多根重定向未 chdir / run_workflow
    //   worktree 子 agent 下，审批网关 isProtectedWrite(path, toolCtx.cwd) 与工具实际操作的根会指向不同目录。
    //   统一到 getActiveWorkspaceRoot() 消除错位（ToolCallContext.cwd 字段仍保留，供 subagent/runAgent 透传）。
    const { sessionId, depth, signal, events, permissionMode, onUIEvent, requestApproval: hostRequestApproval, requestQuestion: hostRequestQuestion, ideAction,
        keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt, readTracker, reportCost, toolCostSink, onAuxUsage, budgetCheck } = ctx;
    const toolCtx: ToolContext = { sessionId, cwd: getActiveWorkspaceRoot(), abortSignal: signal, depth, keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt, events, onUIEvent, requestApproval: hostRequestApproval, requestQuestion: hostRequestQuestion, ideAction, emitProgress: (m: string) => onUIEvent?.({ type: 'tool.progress', toolsId: toolCall.id, toolName: state.calledName, message: m }), permissionMode, readTracker, reportCost, toolCostSink, onAuxUsage, budgetCheck };
    if (state.parseFailed) {
        failResult(state, `参数解析失败：模型返回的 arguments 不是合法 JSON${JSON.stringify(toolCall).slice(0, 300)}`, 'syntax');
        emitValidationFailed(ctx, toolCall, state);
    } else if (state.matchedTool && typeof state.matchedTool.function.execute === 'function') {
        // 安全链（顺序敏感）：pre-hook→参数校验→保护路径→权限规则→命令语义→灾难命令→锁→分类器→人工审批→旧位 pre-hook→undo 备份
        await runSecurityGates(ctx, toolCall, state, toolCtx);
        if (!state.denied) await executeTool(ctx, toolCall, state, toolCtx);
    } else {
        failResult(state, `错误：未知工具 "${state.calledName}" 或该工具无可执行函数`, 'syntax');
        emitValidationFailed(ctx, toolCall, state);
    }
    return await finalizeOutcome(ctx, toolCall, state);
};
