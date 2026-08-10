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
import { sweepStaleAtomicTmp } from "@/tool/registry/fs.ts";
import { appConfig } from "@/config/index.ts";
import { getOrCreateSessionId } from "@/session/store.ts"
import { appendMessage } from "@/session/transcript.ts";
import { buildContextMessages } from "@/session/content.ts";
import { Msg } from "@/session/contextCore.ts";
import { emitTrace } from "@/observability/trace.ts";
import { TraceBase, UIEvent } from "@/observability/type.ts";
import { RunAgentOptions, ThinkingLevel, PermissionMode } from "@/agent/type.ts";
import type { Locale } from "@/common/index.ts";
import { createWebRequestApproval } from "@/host/webHost.ts";
import { RequestApprovalFn, RequestQuestionFn } from "@/host/type.ts";
import { dispatch } from "@/hooks/registry.ts";
import { expandSlashCommand } from "@/commands/expand.ts";
import { runWithSessionContext, getAllowedWorkspaceRoots, getActiveWorkspaceRoot } from "@/tool/guard.ts";
import path from "path";
import fs from "fs";
import { buildSystemPrompt } from "@/agent/systemPrompt.ts";
import { activeProvider } from "@/llm/model.ts";

/** 出站消息发送函数（非 SSE 渠道使用）。 */
type OutboundSender = (outbound: UnifiedOutboundMessage) => Promise<void>;
/** SSE 写入函数：把事件对象序列化为 SSE data 帧推给前端。 */
type SseWriter = (obj: Record<string, unknown>) => void;

/** 宿主注入项：CLI/VSCode 等可传自己的审批钩子与 UI 事件通道；缺省回退 Web 宿主（SSE + approvalGate）。 */
export interface HostOptions {
    /** 宿主审批钩子（决定 MUTATION/DANGER 工具放行）。缺省用 Web 宿主 createWebRequestApproval。 */
    requestApproval?: RequestApprovalFn;
    /** P2-12 宿主提问钩子（ask_question 工具经此向用户提问）。仅交互式 CLI 注入；缺省 undefined（工具优雅降级）。 */
    requestQuestion?: RequestQuestionFn;
    /** 面向前端的 UI 交互事件通道（approval_request / todo.update 等）。缺省走 sseWrite。 */
    onUIEvent?: (evt: UIEvent) => void;
    /** 计划模式（CLI 两阶段用）：true=只读调研，模型 exit_plan_mode 后 yield plan.proposed 并结束本轮。缺省 false。 */
    planMode?: boolean;
    /** 权限模式（CLI `/auto`/`--auto`）：auto=工作区内文件编辑分类器智能放行、高危转人工；缺省 default（常规人工审批）。 */
    permissionMode?: PermissionMode;
    /** per-agent 模型覆盖（CLI /model 用）。缺省回退全局 MODEL_NAME。 */
    model?: string;
    /** 思考等级（CLI /thinking 用）：off=关闭 / high=常规 / max=深度。缺省回退全局 env。 */
    thinkingLevel?: ThinkingLevel;
    /** 回复语言（CLI /lang 用）：runAgent 据此注入回复语言引导。 */
    locale?: Locale;
    /** 输出风格名（CLI /output-style 用，P2-16）：runAgent 据此注入对应风格 persona。未设/未命中=不注入。 */
    outputStyle?: string;
    /** trace 透传（观察用，不落盘重复）：CLI 等可据此读取 llm.response 的 usage（真实 token）。 */
    onTrace?: (base: TraceBase) => void;
}

/**
 * 处理一次统一对话请求：构建上下文 → 发起 runAgent → 分流事件（trace / SSE / outbound）。
 * @param inbound       入站统一消息（用户输入 + 可选 sessionId）
 * @param sendOutbound  非 SSE 渠道的最终回复回送函数（SSE 模式下不调用）
 * @param sseWrite      SSE 写入函数；存在时走流式（text.delta 等实时推），否则走 sendOutbound
 * @param abortSignal   中止信号，透传给 runAgent
 * @param opts          宿主注入项（CLI 等传自己的 requestApproval/onUIEvent；serve 不传=Web 宿主，行为不变）
 */
export const handleUnifiedChat = async (
    inbound: UnifiedInboundMessage,
    sendOutbound: OutboundSender,
    sseWrite?: SseWriter,
    abortSignal?: AbortSignal,
    opts?: HostOptions,
) => {
    // ★ 始终经 getOrCreateSessionId：复用已持久化会话；新会话（含 createServer 生成的 uuid）据此"创建即落盘"
    //   身份记录。旧实现 `inbound.sessionId || ...` 因 createServer 总回填 sessionId 而恒 truthy 短路，
    //   新会话从不落 createAt 等元信息，listSessions 只能回退目录 mtime 排序。
    const sessionId: string = await getOrCreateSessionId(inbound.sessionId);
    // ★ G4 斜杠命令展开：在 hook 派发与 buildContextMessages 之前，把 /<name> rest 展开为命令正文。
    //   展开在 dispatch 前 → hook / buildContextMessages / appendMessage 全部看到展开后文本，transcript 忠实记录模型所见。
    //   未注册的 /x（含文件路径）原样透传；异常一律原样（fail-safe）。
    try { inbound.content = expandSlashCommand(inbound.content); } catch { /* fail-safe：原样 */ }
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

    // ★ prompt-type hook 注入的附加上下文（UserPromptSubmit 专属）。
    //   必须在 buildContextMessages / appendMessage 之前拼入 inbound.content——这样 transcript 忠实记录模型所见
    //   （对齐上方斜杠展开的既有原则）；一个接缝同时覆盖 CLI（经 handleUnifiedChat）与 HTTP 宿主。
    if (promptVeto.contextAdditions && promptVeto.contextAdditions.length > 0) {
        const inject = promptVeto.contextAdditions.map(t => `📎 [Hook 注入]\n${t}`).join('\n\n');
        inbound.content = `${inbound.content}\n\n${inject}`;
    }

    // ★ SYSTEM_PROMPT 已抽取为共享模块（@/agent/systemPrompt.ts），Web/CLI 宿主复用，避免双处维护。
    //   身份段（agent 名 / 模型族）由 activeProvider 注入——厂商中立，换 provider 即换身份（Step 10）。
    //   多根工作区感知：注册了 >1 个项目根时（如前端+后端），把全部根注入系统提示，让 agent 开局就知道
    //   有多个项目、可用绝对路径或 ../<兄弟目录> 跨项目读写。单根（CLI/单文件夹）不注入，零回归。
    let sysPrompt = buildSystemPrompt(activeProvider);
    const roots = getAllowedWorkspaceRoots();
    if (roots.length > 1) {
        let activeReal = getActiveWorkspaceRoot();
        try { activeReal = fs.realpathSync(activeReal); } catch { /* 用原值 */ }
        const lines = roots.map(r => `- ${path.basename(r) || r}: ${r}${r === activeReal ? "（当前默认：相对路径与命令基准）" : ""}`);
        sysPrompt = sysPrompt + `\n\n【工作区（多项目）】\n你可在以下项目根中读写文件。跨项目访问用绝对路径，或相对当前默认根的 ../<兄弟目录>:\n${lines.join("\n")}`;
    }
    let replyText = "";
    try {
        // ★ R-1：setup（buildContextMessages / appendMessage 等）原在 runWithSessionContext 的 try 之外，
        //   磁盘 EACCES/EIO 等会逃逸到 createServer 外层 catch（发 eventType:'error' 而非 type:'final'），
        //   致前端永久卡 busy。现统一纳入 try，异常时补发 final。
        const fullMessages: Msg[] = await buildContextMessages(
            sessionId,
            { role: "user", content: inbound.content },
            sysPrompt,
        );
        await emitTrace({
            sessionId,
            eventType: 'session.start',
            metadata: { depth: 0, decisionSource: 'user', durationMs: performance.now() - startTime },
            payload: { input: inbound.content }
        })
        // ★ SessionStart hook（观察；不可拦截）。dispatch 内部已容错，外层 catch 双保险。
        await dispatch('SessionStart', { sessionId, cwd: process.cwd() }).catch(() => { });
        // ★ 清扫泄漏的原子写 .tmp（进程被杀 / 超时熔断残留在项目内的临时文件）。fire-and-forget，绝不阻塞会话启动。
        void sweepStaleAtomicTmp().catch(() => { });
        await appendMessage({ sessionId, role: 'user', content: inbound.content })

        // ★ 本轮是否已流式产出正文（text.delta）。若否，final.text 是压缩超窗/模型 400/中止等「首字符前终结」
        //   路径下唯一的用户可见消息载体——转发时不可清空，否则 CLI 静默无输出（"卡住后再次对话无任何输出"）。
        let streamedAnyText = false;
        // ★ 宿主注入：CLI 等可传自己的 requestApproval/onUIEvent；缺省回退 Web 宿主（SSE + approvalGate）。
        //   serve 调用点不传 opts → 走 Web 宿主，行为与重构前完全一致。
        const onUIEvent = opts?.onUIEvent ?? ((evt: UIEvent) => sseWrite?.(evt));
        const requestApproval = opts?.requestApproval
            ?? createWebRequestApproval((evt: UIEvent) => sseWrite?.(evt), abortSignal);
        const options: RunAgentOptions = {
            sessionId,
            cwd: process.cwd(),
            toolSchemas: agentTools,
            abortSignal,                        // ← 透传中止信号
            modelWindow: appConfig.MAX_HISTORY_TOKENS,
            keepRecentUnits: appConfig.KEEP_RECENT_UNITS,
            compactRatio: appConfig.COMPACT_RATIO,
            parentSystemPrompt: sysPrompt,
            events: async (base: TraceBase) => {
                await emitTrace(base);          // 纯 trace 落盘，不再推前端
                opts?.onTrace?.(base);          // 透传宿主（CLI 据此读 usage 等真实计量）
            },
            onUIEvent,
            requestApproval,
            requestQuestion: opts?.requestQuestion,
            // ★ CLI 宿主注入项：计划模式两阶段 / 模型覆盖 / 思考等级。serve 不传 → 均为 undefined，行为不变。
            planMode: opts?.planMode,
            permissionMode: opts?.permissionMode,
            model: opts?.model,
            thinkingLevel: opts?.thinkingLevel,
            locale: opts?.locale,
            outputStyle: opts?.outputStyle,
        }

        // ★ 外裹 session 上下文（携带 sessionId）：整个 turn 的 async 链（工具调用 / 路径解析 / hook 派发）
        //   据此经 per-session 注册表查「激活的 worktree」（enter_worktree 工具用）。ALS 跨 await 边界继承。
        //   无 session worktree 时 getActiveWorkspaceRoot/getActiveCwd 走原回退，行为零回归。
        await runWithSessionContext(sessionId, async () => {
            try {
                for await (const event of runAgent(fullMessages, options)) {
                    if (event.type === 'text.delta') streamedAnyText = true;
                    if (event.type === 'final') {
                        replyText = event.text;        // 非 SSE 渠道靠 final 拿全文
                        // SSE/CLI 模式：本轮已流式推送过正文 → final 仅作结束信号（text 置空，避免前端重复显示全文）；
                        //   本轮【未产出正文】（压缩超窗/模型 400/中止等首字符前终结）→ final.text 是唯一可见消息，必须原样转发。
                        sseWrite?.({ type: 'final', text: streamedAnyText ? '' : event.text });
                    } else {
                        sseWrite?.(event);             // text.delta / tool.start / tool.end 实时推
                    }
                }
            } catch (e) {
                // ★ P0 兜底（双保险）：runAgent 理论上已用外层 catch 必发 final（见 runAgent 末尾），
                //   但若 final 之前任何 setup/消费异常逃逸，此处确保也发一个 final，避免前端 busy 永不清。
                const msg = e instanceof Error ? e.message : String(e);
                sseWrite?.({ type: 'final', text: streamedAnyText ? '' : `（agent 异常退出：${msg}）` });
                replyText = msg;
            }
        });
    } catch (e) {
        // ★ R-1：setup 阶段异常（buildContextMessages / appendMessage 等，runWithSessionContext 内层 try 之外）
        //   补发 type:'final'，防磁盘 EACCES/EIO 等导致前端永久卡 busy（原走 createServer 外层 catch 发 eventType:'error'）。
        const msg = e instanceof Error ? e.message : String(e);
        sseWrite?.({ type: 'final', text: `（会话初始化失败：${msg}）` });
        replyText = msg;
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
