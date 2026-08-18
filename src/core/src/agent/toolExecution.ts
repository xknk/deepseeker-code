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
import { ToolContext, ToolSafetyLevel, ToolExecutionResultStatus } from "@/tool/index.ts";
import { requestApproval, isProtectedWrite, getActiveWorkspaceRoot } from "@/tool/guard.ts";
import { checkPermission } from "@/tool/permissions.ts";
import { runPreHooks, runPostHooks } from "@/tool/hooks.ts";
import { computeLockKey, isLockHeld } from "@/tool/lockManager.ts";
import { runBackgroundTool } from "./backgroundTool.ts";
import { beforeMutationBackup, isUndoTrigger } from "@/tool/undo/backup.ts";
import { runAutoCheck, matchCommandDeny, isReadOnlyCommand } from "@/tool/autoPermission.ts";
import { resolveMcpPermissionName } from "@/tool/mcp/loader.ts";
import { appConfig } from "@/config/index.ts";
import { PLAN_ALLOWED_TOOLS } from "./planMode.ts";
import { RunAgentEvents, PermissionMode } from "./type.ts";
import { UIEvent, TraceDecisionSource } from "@/observability/type.ts";
import { RequestApprovalFn, RequestQuestionFn } from "@/host/type.ts";

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
    // ★ P0-A 计划模式执行层门禁（runtime 档，默认）：工具表全会话恒定（systemInjections 两态统一
    //   appendPlanControlTools），计划期改由此处按 PLAN_ALLOWED_TOOLS 拒绝写工具——不发审批、不加锁、
    //   不进 hook 流水线，直接以结果文案引导模型转只读/提交方案（计划先于执行的语义不变）。
    //   schema 档（DEEP_SEEK_PLAN_ENFORCEMENT=schema）回退裁表路径时本 gate 不生效。
    if (!parseFailed && planMode && appConfig.planEnforcement === 'runtime'
        && calledName !== 'enter_plan_mode' && calledName !== 'exit_plan_mode'
        && !PLAN_ALLOWED_TOOLS.has(calledName)) {
        const note = `❌ [计划模式] 当前为只读调研阶段，禁止 ${calledName}。完成方案请调 exit_plan_mode 提交，经用户审批后进入实现阶段。`;
        events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: note } });
        return { toolCallId: toolCall.id, calledName, calledArgs, resultForModel: note, resultForUser: note, ok: false };
    }
    const matchedTool = rawTools.find((t: any) => t.function.name === calledName);
    // ★ toolCtx.cwd 与工具内部根同源：所有工具（fs/glob/search/command）内部 spawn/读取/搜索根都走 ALS 的
    //   getActiveWorkspaceRoot()。原先 cwd: getActiveCwd(cwd) 回退 process.cwd()，与 getActiveWorkspaceRoot()
    //   的回退（process.env.WORKSPACE_ROOT || process.cwd()）不同源——在 VSCode 多根重定向未 chdir / run_workflow
    //   worktree 子 agent 下，审批网关 isProtectedWrite(path, toolCtx.cwd) 与工具实际操作的根会指向不同目录。
    //   统一到 getActiveWorkspaceRoot() 消除错位（ToolCallContext.cwd 字段仍保留，供 subagent/runAgent 透传）。
    const toolCtx: ToolContext = { sessionId, cwd: getActiveWorkspaceRoot(), abortSignal: signal, depth, keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt, events, onUIEvent, requestApproval: hostRequestApproval, requestQuestion: hostRequestQuestion, emitProgress: (m: string) => onUIEvent?.({ type: 'tool.progress', toolsId: toolCall.id, toolName: calledName, message: m }), permissionMode };
    let result = "";
    let explicitOk: boolean | null = null;
    // ★ PostToolUse hook 改写的模型视图结果（在 outputFilter 之后套用；用户视图 resultForUser 不动）
    let postHookOverride: string | undefined;
    if (parseFailed) {
        result = `参数解析失败：模型返回的 arguments 不是合法 JSON${JSON.stringify(toolCall).slice(0, 300)}`;
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
            try { veto = await runPreHooks(calledName, calledArgs, toolCtx); }
            catch (e: any) { veto = { deny: true, reason: `❌ [Pre-hook 异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。` }; }
            if (veto.deny) {
                denied = true;
                result = veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`;
            } else if (veto.argsOverride !== undefined && veto.argsOverride !== null && typeof veto.argsOverride === 'object' && !Array.isArray(veto.argsOverride)) {
                console.log(`✏️ [Pre-hook] [${calledName}] args 已被 hook 改写`);
                calledArgs = veto.argsOverride;
            }
        }
        // ★ P1-7 / P0-3 保护路径硬规则：写工具碰受保护目录（.git/.ssh/.aws/.deepseeker-code 等）→ 无论授权都拒。
        //   优先级最高（先于 checkPermission 用户规则）：即使用户 allow 了，也禁改 VCS/凭证/项目配置目录。
        //   P0-3：与 isUndoTrigger 解耦——move_file 不在 Undo 名单（双路径超 schema），但同样必须拦截，
        //     否则可 move 进 .git/hooks/、.deepseeker-code/settings.json 实现持久化 RCE / 配置注入。
        const protectedPaths = calledName === 'move_file'
            ? [calledArgs?.source, calledArgs?.destination]
            : (isUndoTrigger(calledName) ? [calledArgs?.path] : []);
        const hitProtected = protectedPaths.find(p => typeof p === 'string' && isProtectedWrite(p, toolCtx.cwd));
        if (hitProtected) {
            denied = true;
            result = `❌ [保护路径] 禁止修改受保护目录（.git/.ssh/.aws/.deepseeker-code 等 VCS/凭证/配置）：${hitProtected}。`;
        }
        // ★ G1 细粒度权限规则（deny>ask>allow）：allow 免审、deny 直拒、ask 强制审批；未匹配走默认 safetyLevel
        let perm: ReturnType<typeof checkPermission> = null;
        try {
            // ★ P1-MCP dispatcher 兼容：mcp_call 在权限层用合成名 mcp__<server>__<tool> 匹配规则
            //   （用户既有 permissions 规则含 mcp__server__* 通配，语义不变）；其余工具名原样。
            perm = checkPermission(resolveMcpPermissionName(calledName, calledArgs), calledArgs);
            if (perm === 'deny') { denied = true; result = `❌ [权限规则]：[${calledName}] 被权限规则 deny 拒绝。`; }
            else if (perm === 'allow') { needApproval = false; }
            else if (perm === 'ask') { needApproval = true; }
        } catch { perm = null; /* fail-safe：权限裁决异常 → 走默认 safetyLevel 行为 */ }
        // ★ 默认模式只读命令免审（P1-8）：仅 run_command、且用户未设显式权限规则（perm===null）时，
        //   对只读命令（git 只读子命令 / ls / npm test 等无 shell 元字符的纯查看+验证类）直接免审，消除审批疲劳。
        //   安全：COMMAND_DENY 硬闸门（下方紧接判定）+ hasShellMetachars（isReadOnlyCommand 内）双闸兜底；
        //         收紧：permissions.ask/deny 优先级始终更高（perm!==null 时本判定不生效，用户可 opt-out）；
        //         不含 run_in_background（后台任务持续运行，免审风险更高）。
        if (perm === null && needApproval && !denied && calledName === 'run_command'
            && isReadOnlyCommand(typeof calledArgs?.command === 'string' ? calledArgs.command : '')) {
            needApproval = false;
        }
        // ★ P0-2 灾难命令硬闸门：与 needApproval / allow 规则解耦——堵住「裸 allow 规则让
        //   checkPermission='allow' 跳过 runAutoCheck（含 COMMAND_DENY）」的审批绕过路径。
        //   即使用户 allow 了 run_command，rm -rf /、curl|sh、外传密钥等灾难命令仍硬拒。
        if ((calledName === 'run_command' || calledName === 'run_in_background')
            && matchCommandDeny(typeof calledArgs?.command === 'string' ? calledArgs.command : '')) {
            denied = true;
            result = `❌ [安全] 灾难命令清单拦截（不可被 allow 规则绕过）：[${calledName}] ${String(calledArgs?.command ?? '').slice(0, 100)}`;
        }
        // ★ isSync:false 后台工具的互斥锁快速失败（审批前判断，避免无谓弹窗）
        const isBgTool = matchedTool.function.isSync === false;
        const lockKey = isBgTool ? computeLockKey(matchedTool.function.exclusiveLock, calledArgs, toolCtx) : null;
        if (lockKey && isLockHeld(lockKey)) {
            denied = true;
            result = `🔒 [互斥锁阻塞]：已有后台任务持有锁 [${lockKey}]，[${calledName}] 调用被跳过。`;
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
        if (needApproval && !denied) {
            // ★ P1-MCP：同上，auto 分类器亦按合成名参与（isMcpTool / aggressive 档判定与旧逐工具名路径一致）
            const auto = await runAutoCheck(resolveMcpPermissionName(calledName, calledArgs), calledArgs, toolCtx, permissionMode === 'auto');
            if (auto === 'allow') { needApproval = false; }
            else if (auto === 'deny') { denied = true; result = `❌ [auto] 内置高危清单拦截：[${calledName}] ${calledArgs?.path ?? ''}。`; }
            // 'ask'（risky/不确定/超时/异常/非 AUTO_SCOPE/工作区外）→ 不改 needApproval，落入下方 requestApproval 转人工
        }
        if (needApproval && !denied) {
            const ra = matchedTool.function.requireApproval;
            let detail = `申请执行高危工具 [${calledName}]`;
            try { if (ra) detail = typeof ra === 'function' ? await ra(calledArgs, toolCtx) : ra; }
            catch (e: any) { denied = true; result = `❌ [审批描述生成异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`; }
            if (!denied) {
                let approved = false;
                try { approved = await requestApproval(calledName, toolCall.id, detail, toolCtx, level, calledArgs); }
                catch (e: any) { denied = true; result = `❌ [审批流程异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。`; }
                if (!approved && !denied) { denied = true; result = `❌ [安全熔断]：用户拒绝了 [${calledName}] 的执行申请。`; }
            }
        }
        // ★ pre-hooks（旧位兜底）：开关关时保持改造前行为（审批后、仅 deny，改写字段已被 dispatch 忽略）；
        //   开关开时已在分支顶部前置执行（deny+改写），此处跳过防重复执行。
        if (!denied && !preHooksAdvanced) {
            let veto: { deny: boolean; reason?: string };
            try { veto = await runPreHooks(calledName, calledArgs, toolCtx); }
            catch (e: any) { veto = { deny: true, reason: `❌ [Pre-hook 异常]：${e?.message ?? e}。出于安全默认拒绝 [${calledName}] 的执行。` }; }
            if (veto.deny) { denied = true; result = veto.reason || `❌ [Hook 拦截]：pre-hook 拒绝了 [${calledName}] 的执行。`; }
        }
        // ★ Undo 写前备份：审批+pre-hook 放行后、execute 写盘前快照原文件/目录（凡改必可回退，失败则阻断写入）
        if (!denied && isUndoTrigger(calledName)) {
            try { await beforeMutationBackup(calledName, calledArgs, toolCall.id, sessionId); }
            catch (e: any) { denied = true; result = `❌ [Undo 备份失败·安全熔断]：${e?.message ?? e}。写入已阻止（凡改必可回退原则）。`; }
        }
        if (!denied) {
            try {
                events({ sessionId, eventType: 'tool.execute.start', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin' }, payload: { output: JSON.stringify(calledArgs) } });
                // 执行工具（取消由 ctx.abortSignal 驱动；长任务走 isSync:false 后台模式，不挂固定 timeout）
                const execRet = matchedTool.function.execute(calledArgs, toolCtx);
                if (isBgTool) {
                    // 后台工具：取首个 yield 为即时结果，剩余后台排空，锁在任务结束时释放
                    result = await runBackgroundTool(execRet as any, lockKey, calledName, signal);
                } else {
                    // 流式工具：逐块 yield → emitProgress → tool.progress UIEvent（运行期间逐行可见）
                    result = await collectToolResult(execRet, (chunk) => toolCtx.emitProgress?.(chunk), signal);
                }
                // verifyResult 判定：FAILED 时前置警告（防模型对报错产生"成功"幻觉）
                if (matchedTool.function.verifyResult) {
                    const verdict = matchedTool.function.verifyResult(result, toolCtx);
                    if (verdict.status === ToolExecutionResultStatus.FAILED) {
                        result = `【系统判定：执行失败】${verdict.summary ?? ''}\n请正视下方输出，不要乐观假设成功。\n\n${result}`;
                    }
                }
                events({ sessionId, eventType: 'tool.execute.end', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: true }, payload: { output: result } });
            } catch (err) {
                console.error(`❌ 执行工具 ${calledName} 时发生错误:`, err);
                result = `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
                events({ sessionId, eventType: 'tool.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
            }
            // ★ post-hooks：执行后观察（不拦截，自身异常仅告警）+ 开关开时收集 resultOverride
            //   （改写模型视图；hook 观察到的 result 是 4K 截断视图，其自写回的 override 不受该截断）
            try {
                const post = await runPostHooks(calledName, calledArgs, result, toolCtx);
                postHookOverride = post?.resultOverride;
            } catch (e: any) {
                console.warn(`⚠️ post-hook [${calledName}] 异常（已忽略）:`, e?.message ?? e);
            }
        }
    } else {
        result = `错误：未知工具 "${calledName}" 或该工具无可执行函数`;
        explicitOk = false; // 未知工具显式失败，避免前缀嗅探误判为成功
        events({ sessionId, eventType: 'tool.validation.failed', metadata: { depth, decisionSource: llmDecisionSource, durationMs: performance.now() - startTime, round, tools_id: toolCall.id, toolName: calledName, toolSource: 'builtin', ok: false, attempt: round }, payload: { output: result } });
    }
    // 脱敏（verifyResult 之后、truncate 之前；只影响发往云端模型的视图）
    result = applyPrivacyMasking(matchedTool?.function?.privacyMaskingRules, calledArgs, result);
    result = truncateToolResult(result, matchedTool?.function?.maxOutputCharacters);
    const FAILED_PREFIXES = ["工具执行失败", "参数解析失败", "❌", "【系统判定", "🔒", "读取文件失败", "项目树扫描失败", "符号大纲分析失败", "操作失败:"];
    const ok = explicitOk ?? !FAILED_PREFIXES.some(p => result.startsWith(p));
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
