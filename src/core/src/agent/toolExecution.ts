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
import { collectToolResult, truncateToolResult } from "./truncate.ts";
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
import fs from "fs/promises";
import path from "path";
import { getSessionsDirPath } from "@/session/store.ts";
import { RunAgentEvents, PermissionMode } from "./type.ts";
import { UIEvent, TraceDecisionSource } from "@/observability/type.ts";
import { RequestApprovalFn, RequestQuestionFn } from "@/host/type.ts";

// ★ sidecar 目录 ensure 缓存：原实现每次写侧车（超预算工具结果）都 fs.mkdir(recursive)——目录首次
//   建立后进程内不会再消失（deleteSession 删的是整个会话目录，该会话此后不再写侧车），重复 mkdir
//   是纯浪费系统调用。与 store.ts ensuredSessionDirs / observability ensuredTraceDirs 同款模式。
const ensuredSidecarDirs = new Set<string>();

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
    terminal?: { kind: 'exit_plan_mode' | 'enter_plan_mode'; plan?: string; reason?: string };
};

/**
 * processToolCall 运行期依赖的上下文（原 runAgent 闭包变量的显式打包）。
 * 每轮推理后由主循环/调度层构造一次，透传给本函数。逐字段比对 ToolContext，避免漏传
 * onUIEvent/requestApproval/requestQuestion/permissionMode（subagent 透传这些给子 agent toolCtx，漏传则审批死锁）。
 */
export type ToolCallContext = {
    sessionId: string;
    cwd: string;
    depth: number;
    round: number;
    startTime: number;
    llmDecisionSource: TraceDecisionSource;
    signal?: AbortSignal;
    rawTools: any[];
    events: RunAgentEvents;
    permissionMode?: PermissionMode;
    /** ★ P0-A 计划模式（runtime 档执行层门禁用）：计划期写工具在 processToolCall 拒绝，工具表不裁剪（保前缀缓存）。 */
    planMode?: boolean;
    onUIEvent?: (evt: UIEvent) => void;
    requestApproval?: RequestApprovalFn;
    requestQuestion?: RequestQuestionFn;
    keepRecentUnits: number;
    compactRatio: number;
    modelWindow: number;
    parentSystemPrompt: string;
};

/**
 * P0-1 processToolCall：单个 tool_call 的完整处理（解析→终结/abort 判定→匹配→权限→锁→审批→
 *   pre-hook→undo 备份→execute→verify→post-hook→脱敏→截断→outputFilter）。
 *   纯函数——不 yield / 不 message.push / 不 appendMessage（副作用统一由调度层 flush），便于并发 Promise.all。
 *   逻辑与原串行循环体逐行等价，仅把 yield tool.start/tool.end、message.push、appendMessage、return
 *   换成「写入 outcome 后返回」；终结类与 abort 也以 outcome 表达。
 * @param toolCall 模型产出的单个 tool_call 对象
 * @param ctx     运行期上下文（见 ToolCallContext）
 * @returns 处理结果（纯数据），调度层据此 flush
 */
export const processToolCall = async (toolCall: any, ctx: ToolCallContext): Promise<ToolCallOutcome> => {
    const { sessionId, depth, round, startTime, llmDecisionSource, signal, rawTools, events,
        permissionMode, planMode, onUIEvent, requestApproval: hostRequestApproval, requestQuestion: hostRequestQuestion,
        keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt } = ctx;
    let calledName = "";
    let calledArgs: any = {};
    let parseFailed = false;
    if (toolCall.type === 'function') {
        calledName = toolCall.function.name;
        try { calledArgs = JSON.parse(toolCall.function.arguments || "{}"); }
        catch { parseFailed = true; }
        console.log(`🤖 模型请求调用工具: ${calledName}，参数:`, calledArgs);
    }
    // ★ 终结类（优先于 abort：模型已提交的方案/进入请求应呈现给用户，不被中止吞掉——「计划先于执行」）
    if (calledName === "exit_plan_mode") {
        const plan = typeof calledArgs?.plan === "string" ? calledArgs.plan : "";
        const note = "✅ [计划模式] 实现方案已提交，等待用户审批后进入实现阶段。";
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: true, terminal: { kind: 'exit_plan_mode', plan } };
    }
    if (calledName === "enter_plan_mode") {
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
    const matchedTool = rawTools.find((t: any) => t.function.name === calledName);
    // ★ P0-A 计划模式执行层门禁（runtime 档，默认）：工具表全会话恒定（systemInjections 两态统一
    //   appendPlanControlTools），计划期改由此处拒绝未声明 planAllowed 的工具——不发审批、不加锁、
    //   不进 hook 流水线，直接以结果文案引导模型转只读/提交方案（计划先于执行的语义不变）。
    //   ★ #8a：原 PLAN_ALLOWED_TOOLS 工具名名单退役，白名单改读工具声明 planAllowed（缺省 = 拒绝，
    //   fail-closed）——matchedTool 匹配相应前移至本门禁之前。enter/exit_plan_mode 为终结类已在上方
    //   拦截返回，此处保留显式豁免（双保险）。schema 档（DEEP_SEEK_PLAN_ENFORCEMENT=schema）回退裁表路径时本 gate 不生效。
    if (!parseFailed && planMode && appConfig.planEnforcement === 'runtime'
        && calledName !== 'enter_plan_mode' && calledName !== 'exit_plan_mode'
        && matchedTool?.function?.planAllowed !== true) {
        const note = `❌ [计划模式] 当前为只读调研阶段，禁止 ${calledName}。完成方案请调 exit_plan_mode 提交，经用户审批后进入实现阶段。`;
        events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: note } });
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: false };
    }
    // ★ toolCtx.cwd 与工具内部根同源：所有工具（fs/glob/search/command）内部 spawn/读取/搜索根都走 ALS 的
    //   getActiveWorkspaceRoot()。原先 cwd: getActiveCwd(cwd) 回退 process.cwd()，与 getActiveWorkspaceRoot()
    //   的回退（process.env.WORKSPACE_ROOT || process.cwd()）不同源——在 VSCode 多根重定向未 chdir / run_workflow
    //   worktree 子 agent 下，审批网关 isProtectedWrite(path, toolCtx.cwd) 与工具实际操作的根会指向不同目录。
    //   统一到 getActiveWorkspaceRoot() 消除错位（ToolCallContext.cwd 字段仍保留，供 subagent/runAgent 透传）。
    const toolCtx: ToolContext = { sessionId, cwd: getActiveWorkspaceRoot(), abortSignal: signal, depth, keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt, events, onUIEvent, requestApproval: hostRequestApproval, requestQuestion: hostRequestQuestion, emitProgress: (m: string) => onUIEvent?.({ type: 'tool.progress', toolsId: toolCall.id, toolName: calledName, message: m }), permissionMode };
    let result = "";
    // ★ #8b 结构化成败跟踪（替代 FAILED_PREFIXES 前缀嗅探 + explicitOk 手工短路）：
    //   默认 success；拒绝/熔断/解析失败/verifyResult FAILED 显式置 failed。文案只是呈现，成败看状态。
    let resultStatus: ToolExecuteResult['status'] = 'success';
    let errorCategory: ToolExecuteResult['errorCategory'];
    /** 置失败文案 + 状态（errorCategory 缺省 runtime；syntax 收模型调用形态错） */
    const failResult = (text: string, cat: ToolExecuteResult['errorCategory'] = 'runtime'): void => {
        result = text;
        resultStatus = 'failed';
        errorCategory = cat;
    };
    // ★ PostToolUse hook 改写的模型视图结果（在 outputFilter 之后套用；用户视图 resultForUser 不动）
    let postHookOverride: string | undefined;
    if (parseFailed) {
        failResult(`参数解析失败：模型返回的 arguments 不是合法 JSON${JSON.stringify(toolCall).slice(0, 300)}`, 'syntax');
        events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
    } else if (matchedTool && typeof matchedTool.function.execute === 'function') {
        // ★ 安全分级审批：SAFE 免审；MUTATION/DANGER 执行前请求用户审批
        const level = matchedTool.function.safetyLevel;
        let needApproval = level === ToolSafetyLevel.MUTATION || level === ToolSafetyLevel.DANGER;
        let denied = false;
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
                denied = true;
                failResult(veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`, 'permission');
            } else if (veto.argsOverride !== undefined && veto.argsOverride !== null && typeof veto.argsOverride === 'object' && !Array.isArray(veto.argsOverride)) {
                console.log(`✏️ [Pre-hook] [${calledName}] args 已被 hook 改写`);
                calledArgs = veto.argsOverride;
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
                const verdict = validateToolArgs(paramsSchema as Record<string, unknown>, calledArgs);
                if (!verdict.ok) {
                    denied = true;
                    failResult(`❌ 参数校验失败：${verdict.message}；请修正参数后重试（schema 要求见工具 parameters）。`, 'syntax');
                    events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
                }
            }
        }
        // ★ P1-7 / P0-3 保护路径硬规则：写工具碰受保护目录（.git/.ssh/.aws/.deepseeker-code 等）→ 无论授权都拒。
        //   优先级最高（先于 checkPermission 用户规则）：即使用户 allow 了，也禁改 VCS/凭证/项目配置目录。
        //   ★ #8a 声明化：取参按工具声明 pathArgs（缺省：triggersUndo 工具 ['path']，否则不检查）——
        //   原 move_file 按名特判（P0-3：双路径不进 Undo 名单但同样必须拦，否则可 move 进 .git/hooks/ 实现
        //   持久化 RCE）退役，move_file 以 pathArgs:['source','destination'] 声明携带，新工具漏声明不再静默豁免。
        const pathArgs: string[] = matchedTool.function.pathArgs ?? (matchedTool.function.triggersUndo ? ['path'] : []);
        const protectedPaths = pathArgs.map(k => calledArgs?.[k]);
        const hitProtected = protectedPaths.find(p => typeof p === 'string' && isProtectedWrite(p, toolCtx.cwd));
        if (hitProtected) {
            denied = true;
            failResult(`❌ [保护路径] 禁止修改受保护目录（.git/.ssh/.aws/.deepseeker-code 等 VCS/凭证/配置）：${hitProtected}。`, 'permission');
        }
        // ★ G1 细粒度权限规则（deny>ask>allow）：allow 免审、deny 直拒、ask 强制审批；未匹配走默认 safetyLevel
        let perm: ReturnType<typeof checkPermission> = null;
        try {
            // ★ P1-MCP dispatcher 兼容：mcp_call 在权限层用合成名 mcp__<server>__<tool> 匹配规则
            //   （用户既有 permissions 规则含 mcp__server__* 通配，语义不变）；其余工具名原样。
            perm = checkPermission(resolveMcpPermissionName(calledName, calledArgs), calledArgs, matchedTool.function.primaryArg);
            if (perm === 'deny') { denied = true; failResult(`❌ [权限规则]：[${calledName}] 被权限规则 deny 拒绝。`, 'permission'); }
            else if (perm === 'allow') { needApproval = false; }
            else if (perm === 'ask') { needApproval = true; }
        } catch { perm = null; /* fail-safe：权限裁决异常 → 走默认 safetyLevel 行为 */ }
        // ★ 默认模式只读命令免审（P1-8）：仅 run_command、且用户未设显式权限规则（perm===null）时，
        //   对只读命令（git 只读子命令 / ls / tsc --noEmit 等无 shell 元字符的纯查看+验证类）直接免审，消除审批疲劳。
        //   安全：COMMAND_DENY 硬闸门（下方紧接判定）+ hasShellMetachars（isReadOnlyCommand 内）双闸兜底；
        //         收紧：permissions.ask/deny 优先级始终更高（perm!==null 时本判定不生效，用户可 opt-out）；
        //         不含 run_in_background（后台任务持续运行，免审风险更高）；
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
        const cmdIsScriptRunner = (calledName === 'run_command' || calledName === 'run_in_background')
            && isScriptRunnerCommand(typeof calledArgs?.command === 'string' ? calledArgs.command : '');
        const argCwd = typeof calledArgs?.cwd === 'string' ? calledArgs.cwd.trim() : '';
        const samePath = (a: string, b: string): boolean => {
            try { const ra = path.resolve(a), rb = path.resolve(b); return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb; }
            catch { return false; }
        };
        const scriptRunnerCwdDrift = cmdIsScriptRunner && argCwd !== '' && !samePath(argCwd, toolCtx.cwd ?? process.cwd());
        const scriptRunnerBlocked = cmdIsScriptRunner && (perm === null || scriptRunnerCwdDrift);
        if (scriptRunnerCwdDrift) needApproval = true; // perm='allow' 已置 false → 漂移时强制拉回审批
        if (perm === null && needApproval && !denied && !scriptRunnerBlocked && calledName === 'run_command'
            && isReadOnlyCommand(typeof calledArgs?.command === 'string' ? calledArgs.command : '')) {
            needApproval = false;
        }
        // ★ P0-2 灾难命令硬闸门：与 needApproval / allow 规则解耦——堵住「裸 allow 规则让
        //   checkPermission='allow' 跳过 runAutoCheck（含 COMMAND_DENY）」的审批绕过路径。
        //   即使用户 allow 了 run_command，rm -rf /、curl|sh、外传密钥等灾难命令仍硬拒。
        if ((calledName === 'run_command' || calledName === 'run_in_background')
            && matchCommandDeny(typeof calledArgs?.command === 'string' ? calledArgs.command : '')) {
            denied = true;
            failResult(`❌ [安全] 灾难命令清单拦截（不可被 allow 规则绕过）：[${calledName}] ${String(calledArgs?.command ?? '').slice(0, 100)}`, 'permission');
        }
        // ★ isSync:false 后台工具的互斥锁（快查）：锁被持有则直接拒绝，省去一次无谓审批弹窗。
        //   真正的获锁在 runBackgroundTool 启动时执行、其 finalize 必定释放——
        //   check-then-act 形态为有意设计（单人本地工具，并发窗口无害），勿改预占式。
        const isBgTool = matchedTool.function.isSync === false;
        const lockKey = isBgTool ? computeLockKey(matchedTool.function.exclusiveLock, calledArgs, toolCtx) : null;
        if (lockKey && isLockHeld(lockKey)) {
            denied = true;
            failResult(`🔒 [互斥锁阻塞]：已有后台任务持有锁 [${lockKey}]，[${calledName}] 调用被跳过。`);
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
        if (needApproval && !denied && !scriptRunnerBlocked) {
            // ★ P1-MCP：同上，auto 分类器亦按合成名参与（isMcpTool / aggressive 档判定与旧逐工具名路径一致）
            //   scriptRunnerBlocked 命令跳过分类器：分类器只见命令串、看不见 scripts 内容，无法负责任地判 safe
            //   （含 /auto 档——供应链面不因 opt-in 激进档而豁免人工首验；用户可预配 allow 规则跳过）。
            const auto = await runAutoCheck(resolveMcpPermissionName(calledName, calledArgs), calledArgs, toolCtx, permissionMode === 'auto',
                { autoApproval: matchedTool.function.autoApproval, pathArgs: matchedTool.function.pathArgs, primaryArg: matchedTool.function.primaryArg });
            if (auto === 'allow') { needApproval = false; }
            else if (auto === 'deny') { denied = true; failResult(`❌ [auto] 内置高危清单拦截：[${calledName}] ${calledArgs?.path ?? ''}。`, 'permission'); }
            // 'ask'（risky/不确定/超时/异常/未声明 autoApproval/工作区外）→ 不改 needApproval，落入下方 requestApproval 转人工
        }
        if (needApproval && !denied) {
            const ra = matchedTool.function.requireApproval;
            let detail = `申请执行高危工具 [${calledName}]`;
            try { if (ra) detail = typeof ra === 'function' ? await ra(calledArgs, toolCtx) : ra; }
            catch (e: any) { denied = true; failResult(`❌ [审批描述生成异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`, 'permission'); }
            if (!denied) {
                let approved = false;
                try { approved = await requestApproval(calledName, toolCall.id, detail, toolCtx, level, calledArgs, matchedTool.function.primaryArg); }
                catch (e: any) { denied = true; failResult(`❌ [审批流程异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`, 'permission'); }
                if (!approved && !denied) { denied = true; failResult(`❌ [安全熔断]：用户拒绝了 [${calledName}] 的执行申请。`, 'permission'); }
            }
        }
        // ★ pre-hooks（旧位兜底）：开关关时保持改造前行为（审批后、仅 deny，改写字段已被 dispatch 忽略）；
        //   开关开时已在分支顶部前置执行（deny+改写），此处跳过防重复执行。
        if (!denied && !preHooksAdvanced) {
            let veto: { deny: boolean; reason?: string };
            // ★ P1-MCP 对称性：同上方改写位，hook 匹配用合成名（见 runPreHooks 首个调用点注释）
            try { veto = await runPreHooks(resolveMcpPermissionName(calledName, calledArgs), calledArgs, toolCtx); }
            catch (e: any) { veto = { deny: true, reason: `❌ [Pre-hook 异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。` }; }
            if (veto.deny) { denied = true; failResult(veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`, 'permission'); }
        }
        // ★ Undo 写前备份：审批+pre-hook 放行后、execute 写盘前快照原文件/目录（凡改必可回退，失败则阻断写入）。
        //   ★ #8a 声明化：是否备份/备份策略改读工具声明 triggersUndo（原 MUTATION_TOOLS 名单退役）。
        if (!denied && matchedTool.function.triggersUndo) {
            try { await beforeMutationBackup(matchedTool.function.triggersUndo, calledName, calledArgs, toolCall.id, sessionId); }
            catch (e: any) { denied = true; failResult(`❌ [Undo 备份失败·安全熔断]：${e?.message ?? e}。写入已阻止（凡改必可回退原则）。`); }
        }
        if (!denied) {
            try {
                events({ sessionId, eventType: 'tool.execute.start', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin' }, payload: { output: JSON.stringify(calledArgs) } });
                // 执行工具（取消由 ctx.abortSignal 驱动；长任务走 isSync:false 后台模式，不挂固定 timeout）
                const execRet = matchedTool.function.execute(calledArgs, toolCtx);
                // ★ #8b：两条收集路径均已结构化——string 自动归一 success，toolFailure() 返回体携带 failed
                const collected: ToolExecuteResult = isBgTool
                    ? await runBackgroundTool(execRet as any, lockKey, calledName, signal)
                    : await collectToolResult(execRet, (chunk) => toolCtx.emitProgress?.(chunk), signal);
                result = collected.content;
                resultStatus = collected.status;
                if (collected.status === 'failed') errorCategory = collected.errorCategory ?? 'runtime';
                // verifyResult 判定：FAILED 时置结构化失败并前置警告（防模型对报错产生"成功"幻觉）。
                //   ★ #8b：ok 不再依赖「【系统判定」文案前缀——状态由 verdict 直接驱动，文案仅保留提示职责。
                if (matchedTool.function.verifyResult) {
                    const verdict = matchedTool.function.verifyResult(result, toolCtx);
                    if (verdict.status === ToolExecutionResultStatus.FAILED) {
                        result = `【系统判定：执行失败】${verdict.summary ?? ''}\n请正视下方输出，不要乐观假设成功。\n\n${result}`;
                        resultStatus = 'failed';
                        errorCategory = verdict.errorCategory ?? 'unknown';
                    }
                }
                // ★ #8b：end 事件按结构化成败分流（原硬编码 ok:true——toolFailure 字符串返回时误报成功）
                if (resultStatus === 'success') {
                    events({ sessionId, eventType: 'tool.execute.end', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: true }, payload: { output: result } });
                } else {
                    events({ sessionId, eventType: 'tool.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round, errorCategory: errorCategory ?? 'unknown' }, payload: { output: result } });
                }
            } catch (err) {
                console.error(`❌ 执行工具 ${calledName} 时发生错误:`, err);
                failResult(`工具执行失败: ${err instanceof Error ? err.message : String(err)}`);
                events({ sessionId, eventType: 'tool.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round, errorCategory: errorCategory ?? 'runtime' }, payload: { output: result } });
            }
            // ★ post-hooks：执行后观察（不拦截，自身异常仅告警）+ 开关开时收集 resultOverride
            //   （改写模型视图；hook 观察到的 result 是 4K 截断视图，其自写回的 override 不受该截断）
            try {
                // ★ P1-MCP 对称性：hook 匹配用合成名（见 runPreHooks 首个调用点注释）
                const post = await runPostHooks(resolveMcpPermissionName(calledName, calledArgs), calledArgs, result, toolCtx);
                postHookOverride = post?.resultOverride;
            } catch (e: any) {
                console.warn(`⚠️ post-hook [${calledName}] 异常（已忽略）:`, e?.message ?? e);
            }
        }
    } else {
        failResult(`错误：未知工具 "${calledName}" 或该工具无可执行函数`, 'syntax');
        events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
    }
    // 脱敏（verifyResult 之后、truncate 之前；只影响发往云端模型的视图）
    result = applyPrivacyMasking(matchedTool?.function?.privacyMaskingRules, calledArgs, result);
    // ★ 侧车原文存档（recall 配套）：此处 result 已脱敏、尚未截断——transcript 落盘的是截断后视图，
    //   被去中间的原文若不另存将无处可寻。仅在确会触发截断时落盘（缓存定位、非真相源；recall 的
    //   with_full 按需取回）。判定条件是“原始长度超预算”的超集（microcompact 只缩不涨，故截断必命中
    //   本条件；反之可能白存一份无人引用的缓存，无害）。失败仅降级为普通截断提示，绝不阻断回灌。
    let sidecarNote: string | undefined;
    const truncBudget = matchedTool?.function?.maxOutputCharacters ?? appConfig.MAX_TOOL_RESULT_CHARS;
    if (result.length > truncBudget) {
        try {
            const sidecarDir = path.join(getSessionsDirPath(sessionId), 'tool-outputs');
            if (!ensuredSidecarDirs.has(sidecarDir)) {
                await fs.mkdir(sidecarDir, { recursive: true });
                ensuredSidecarDirs.add(sidecarDir);
            }
            // tool_call.id 来自模型（通常形如 call_0_xxx），白名单清洗防路径注入
            const safeId = String(toolCall.id).replace(/[^A-Za-z0-9_-]/g, '');
            await fs.writeFile(path.join(sidecarDir, `${safeId}.txt`), result, 'utf-8');
            sidecarNote = `完整原文已存档，recall 工具传 with_full="${toolCall.id}" 可取回`;
        } catch (e) {
            console.warn(`⚠️ [sidecar] 工具原文存档失败（已降级为普通截断提示）:`, e instanceof Error ? e.message : e);
        }
    }
    result = truncateToolResult(result, matchedTool?.function.maxOutputCharacters, sidecarNote);
    // ★ #8b：ok 判定唯一来源 = 结构化状态（前缀嗅探/explicitOk 已退役）
    const ok = resultStatus === 'success';
    // outputFilter：分流 toModel（精简，喂模型）/ toUser（完整，给用户看）；未声明则两者均原 result
    let resultForModel = result;
    let resultForUser = result;
    if (matchedTool?.function?.outputFilter) {
        try {
            const split = matchedTool.function.outputFilter(result);
            resultForModel = split.toModel;
            resultForUser = split.toUser;
        } catch { /* 容错：outputFilter 异常则两者均用原 result */ }
    }
    // ★ PostToolUse hook 改写（第二梯队 #3）：仅替换模型视图，用户视图保持工具真实输出；
    //   套用工具自身 maxOutputCharacters 同上限（override 由用户 hook 产生，同样需有界）。
    //   transcript 落盘的是 resultForModel → 模型实际所见，回放/压缩/fork 天然一致。
    if (postHookOverride !== undefined) {
        console.log(`✏️ [Post-hook] [${calledName}] 模型视图结果已被 hook 改写`);
        resultForModel = truncateToolResult(postHookOverride, matchedTool?.function?.maxOutputCharacters);
    }
    return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel, resultForUser, ok };
};
