
/**
 * @file agent/runAgent.ts
 * @description Agent 主循环：驱动「模型推理 ↔ 工具调用」的多轮循环，是整个 agent 的核心。
 *
 *  每轮 while(true) 的职责：
 *  1) 窗口治理 —— ensureFitsWindow 判断并触发上下文压缩 / 滚动摘要；
 *  2) 流式推理 —— chatWithModelWithTools 流式拉取，边收边 yield text.delta / thinking.delta，
 *     按 index 拼接 tool_calls 分片，末包收 usage；
 *  3) 工具执行 —— 解析 tool_calls，按 safetyLevel 做审批熔断，执行（含超时 / verifyResult 校验），
 *     截断结果后回写上下文与本地会话；
 *  4) 退出判定 —— 无工具调用则结束；连续 3 次相同调用则熔断；用户中止则立即结束。
 *
 *  产出：通过 AsyncGenerator<AgentEvent> 向上层 yield 流程事件；通过 options.events 回传埋点。
 */
import OpenAI from "openai";
import { appendMessage, appendMessages, appendEvent } from "@/session/transcript.ts";
import { claimSessionInbox, flushLeftoverToTranscript } from "./inbox.ts";
import { clearQueuedWake } from "./agentWake.ts";
import { createUUID } from "@/common/index.ts";
import { estimateTokens } from "@/session/contextCore.ts";
import { msgText } from "@/session/contentParts.ts";
import { getCalibration, updateCalibration } from "@/session/store.ts";
import { ensureFitsWindow } from "./truncate.ts";
import { AgentEvent, RunAgentOptions, WindowCheckInfo } from "./type.ts";
import { dispatch } from "@/tool/hooks.ts";
import { ToolCallContext } from "./toolExecution.ts";
import { createRepeatBreaker } from "./repeatBreaker.ts";
import { prepareToolsAndInjections } from "./systemInjections.ts";
import { scheduleToolCalls, ScheduleResult } from "./toolScheduling.ts";
import { streamInference, InferenceResult } from "./streamInference.ts";
import { createNudgeScheduler, PLAN_REJECT_FORCE_AT, PLAN_REJECT_FORCE_FINAL_TEXT } from "./agentNudges.ts";
import { createRunLedger } from "./runLedger.ts";
import { recordUsageRun } from "@/observability/usageLog.ts";
import { flushTraceBuffer } from "@/observability/trace.ts";
import { MODEL_NAME } from "@/llm/createModel.ts";

// ★ 估算校准 EMA 权重（打磨计划 C 项提为常量）：历史 0.6 / 新观测 0.4——平滑单轮抖动（消费点见主循环校准处）。
const CALIB_EMA_KEEP = 0.6;
const CALIB_EMA_NEW = 0.4;

// ============ 主流程 ============
/**
 * P0-1（内核审查报告，2026-10-20）：firstPrompt 解析抽成纯函数——供 PLAN_FIRST / EARLY_FINAL 的
 * looksComplex 判定取「当前轮」用户输入。取值顺序：
 *  1) 显式 `options.currentUserText`（宿主在 slash 展开后、hook 注入前定型的本轮输入原文）；
 *  2) 回退扫消息数组**末尾**最近一条非空 user 文本（多轮对话下等价本轮输入；多模态 parts 取纯文本视图，
 *     纯贴图轮空文本继续向前找）。
 * 旧实现 `find` 从头取**首条** user 消息——「首条复杂 prompt + 第 2 轮寒暄」会被误判成复杂轮，
 * 在寒暄轮误注入 PLAN_FIRST 引导 / 误拦 EARLY_FINAL。修复只动取值方向，判定逻辑（agentNudges）不动。
 * depth 门保留在这里而非调用方：subagent 工具表含 enter_plan_mode，firstPrompt 泄漏给子 run 会诱导
 * 其提前进入计划模式（PLAN_FIRST 对子 agent 是病理），抽函数后仍不许绕过。
 */
export const resolveFirstPrompt = (
    message: OpenAI.Chat.ChatCompletionMessageParam[],
    options: { currentUserText?: string; depth?: number },
): string => {
    if ((options.depth ?? 0) !== 0) return "";
    const explicit = options.currentUserText?.trim();
    if (explicit) return explicit;
    const arr = message as any[];
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.role !== "user") continue;
        const t = msgText(arr[i]?.content);
        if (t.trim()) return t;
    }
    return "";
};

/**
 * 运行 Agent 主循环（流式）。
 *
 * 持续进行「模型推理 → 工具调用」的多轮循环，直到模型不再请求工具、检测到重复调用熔断、
 * 或调用方中止（abortSignal）。过程中通过 yield 向外推送阶段事件（AgentEvent），
 * 通过 options.events 回传可观测性埋点。
 *
 * @param message  对话上下文（原地修改：追加 assistant / tool 消息）。约定 [0]=系统提示词、[1]=滚动摘要槽
 * @param options  运行配置，见 {@link RunAgentOptions}
 * @yields AgentEvent  round.start / text.delta / thinking.delta / tool.start / tool.end / final
 */
export async function* runAgent(message: OpenAI.Chat.ChatCompletionMessageParam[], options: RunAgentOptions): AsyncGenerator<AgentEvent> {
    const sessionId = options.sessionId; // 本次会话id
    const runId = createUUID(); // 本次 run（一次用户输入的回合）唯一 ID：事件行 + 埋点 metadata.runId 同源
    // ★ 可观测性埋点安全包装：trace/落盘层异常（磁盘满、JSON 序列化失败、网络上报失败）一律 catch，
    //   绝不冒泡成 unhandled rejection 击垮 agent 主循环（旁路埋点不应拖垮主业务推理）。
    //   全部埋点点位自动获得该保护，无需逐个 await/.catch。
    // ★ runId 自动注入（P2）：主/子/压缩/工具各埋点统一带 metadata.runId——trace 可按 run 聚合切片
    //   （单 run token/耗时/工具序列），与 transcript 的 run.start/run.end 事件行同 ID 互查。
    //   子 agent 传入的 ctx.events 已含父级包装，此处再包一层以本 run runId 覆盖（spread 序：内层胜出）。
    const rawEvents = options.events; // 原始回调方法
    const events: typeof rawEvents = async (base) => {
        try { await rawEvents({ ...base, metadata: { ...base.metadata, runId } }); } catch (e) { console.warn('⚠️ 埋点失败（不影响推理）:', e instanceof Error ? e.message : e); }
    };
    const modelWindow = options.modelWindow; // 最大上下文token
    const signal = options.abortSignal; // 主动停止
    const depth = options.depth ?? 0;
    // ★ 工作目录：hook 子进程 cwd / 工具相对路径基准；缺省取 process.cwd()，spawn_agent 透传以保持一致
    const cwd = options.cwd ?? process.cwd();
    const keepRecentUnits = options.keepRecentUnits
    const compactRatio = options.compactRatio
    const parentSystemPrompt = options.parentSystemPrompt
    // ★ 生效模型（P1-4 上移至此）：校准按模型维度分键读取/写回需要它，成本折价与 usageLog 同源共用
    const effectiveModel = options.model?.trim() || MODEL_NAME;
    // ★ setup：工具表裁剪（planMode/env）+ schema 清洗 + 摘要槽 + fence 注入（locale/outputStyle/skills/
    //   agents/projectGuide/memory）。抽出到 systemInjections.ts；validationCtx 在其内部构造。
    //   fence 注入幂等、不动 message 下标——保 DeepSeek 隐式前缀缓存（P0-4）。
    const { rawTools, cleanedToolSchemas, toolsTokens } = await prepareToolsAndInjections(message, options, events);
    let round = 0;
    let lastContent: string | undefined = "";
    let stopReason: 'normal' | 'aborted' | 'error' | 'repeat' | 'limit' = 'normal';
    // ★ 预算硬截断标记（成本信任链第二环 E2）：true 时 final 提示 /budget 可调，结算单行同步标注
    let budgetTruncated = false;
    // F-1：轮数治理——"让模型自决"为主，硬上限仅作极高兜底（零用户配置、零心智负担）。
    //  主机制：周期性 ephemeral nudge（NUDGE 周期自评 / PHANTOM 空 content / EARLY_FINAL 早收尾）由模型自决
    //         "收尾给答案"还是"继续推进"（对标 CC：不在低轮数硬停，靠模型自收敛 + 用户中止）。
    //         文案/阈值/触发/预算/死循环保险统一抽到 agentNudges.ts；此处仅持实例 + 薄调用，控制流与提示词解耦。
    //  兜底：MAX_AGENT_ROUNDS 极高（500），仅防失控烧 token 的病理死循环；正常任务不会触及，触及亦 graceful（可"继续"接续）。
    const MAX_AGENT_ROUNDS = 500;
    // ★ 首轮 PLAN_FIRST nudge 入参：「当前轮」user prompt（仅顶层 agent；subagent 不引导自主进计划模式）+ 当前 planMode。
    //   looksComplex 命中即在首轮注入「先调 enter_plan_mode 规划」引导，配合 systemPrompt 强提示扭转从不进计划模式的问题。
    const firstPrompt = resolveFirstPrompt(message, options);
    // ★ 成本账本（成本信任链 D2/E1/E2/P0-2/P1-5/Q12 全部账目）：五本账 + 预算圈 + 子 run 成本中继收拢于
    //   runLedger.ts（分账/并账关系、flush 基数=子树完整口径、精度红线论证见其文件头）。预算仅主 run 且
    //   >0 时武装——工厂拿不到 depth，调用处收窄（保留 != null 链，NaN/undefined 边界与改前逐字节同判）。
    const ledger = createRunLedger({
        model: effectiveModel,
        budgetYuan: depth === 0 && options.budgetYuan != null && options.budgetYuan > 0 ? options.budgetYuan : undefined,
        costSink: options.costSink,
        onAuxUsage: options.onAuxUsage,
    });
    // 别名锚点：ensureFitsWindow / streamInference / toolCallCtx 三注入点 + 守门断言（kernel-audit-firstbatch:199）共用，勿删
    const reportAuxUsage = ledger.reportAuxUsage;
    // ★ 按次计费工具成本 sink（DeepSeek Search/Fetch）：DEEP_SEEK_TOOL_COST=0 回退开关留在编排层（环境开关不入账本）。
    const toolCostSink = process.env.DEEP_SEEK_TOOL_COST === "0" ? undefined : ledger.addToolCost;
    // ★ 本 run 压缩计数（成本信任链第三环 H1，context.usage.compactCount 用）：经 ensureFitsWindow 的
    //   onUIEvent 旁路数 compact.done（不改 truncate 本体）；会话级累计由前端在 compact.done 消费处自加。
    let runCompactCount = 0;
    // ★ P1-2：给 nudge 调度器传上下文用量闭包（惰性——闭包仅在调度器真正要发 NUDGE/REPEAT nudge 的轮内
    //   被调用，pickNudge 每轮都调、不能每轮全量扫描 estimateTokens）。口径与 ensureFitsWindow 的 estReal
    //   同公式（estimateTokens × calibRatio + toolsTokens），nudge 文案里标「估算」；calibRatio 是跨轮 EMA，
    //   闭包捕获绑定、首次调用在主循环内（晚于下方声明），无 TDZ 问题。
    // ★ 预算状态闭包（E2）：仅主 run 且已设预算时武装；spent 为 O(1) 读数。soft 文案投递见 agentNudges。
    const nudges = createNudgeScheduler({
        firstPrompt,
        planMode: !!options.planMode,
        noEarlyFinal: !!options.noEarlyFinal,
        getContextUsage: () => ({ usedTokens: Math.round(estimateTokens(message) * calibRatio + toolsTokens), windowTokens: modelWindow }),
        getBudgetStatus: ledger.getBudgetStatus, // ★ E2 预算 soft 读数（闭包在账本内 O(1) 读数；未武装返回 null，管线自判）
    });
    // ★ P3-8 run 级 read_file 读取追踪（path → mtime + 次数）：本 run 内重复读同一文件时结果头标
    //   「第 N 次读取 · 内容未变更/已变更」，让模型自决是否还需重读。每 run 一个 Map、逐轮传同一引用；
    //   ★ 刻意不做结果缓存——压缩后旧读取可能已出上下文，硬缓存会饿死模型（只标注，不截断）。
    const readTracker = new Map<string, { mtimeMs: number; count: number }>();
    const userDecisionSource = depth > 0 ? 'spawn_agent' : 'user'
    const llmDecisionSource = depth > 0 ? 'llm_spawn_agent' : 'llm'
    // ★ 上下文水位透出（成本信任链第三环 H1）：每轮 round.end 发一次（门禁仅主 agent 且有出口）。
    //   口径与 nudge 的 getContextUsage 同公式（estimateTokens×calibRatio+toolsTokens）——勿在此再发明
    //   第二套估算；fillRate 除数防御 0。零改动 message 数组，纯旁路 UIEvent（前缀缓存纪律）。
    const emitContextUsage = (): void => {
        if (depth !== 0 || !options.onUIEvent) return;
        const usedTokens = Math.round(estimateTokens(message) * calibRatio + toolsTokens);
        options.onUIEvent({
            type: 'context.usage',
            usedTokens,
            windowTokens: modelWindow,
            fillRate: modelWindow > 0 ? usedTokens / modelWindow : 0,
            compactCount: runCompactCount,
        });
    };

    const startTime = performance.now();
    // ★ 估算校准 + 缓存感知压缩状态（跨轮维护）：
    //   calibRatio 用「真实 prompt_tokens / 本地估算」的 EMA 修正 estimateTokens 的系统性低估（实测约 31%），
    //   让 ensureFitsWindow 按「真实 token 口径」判定压缩时机，避免长任务真实逼近窗口而估算仍以为安全 → 靠 API 400 兜底。
    //   lastReal/lastCached 取自上一轮 API 真实 usage：算缓存命中率，驱动「缓存感知」的压缩阈值——
    //   DS 前缀缓存命中时压缩会击穿 message[1]+ 的缓存（message[0] 系统提示词段保住），故命中率越高越推迟、
    //   越低越早压（详见 truncate.ts 的 effectiveRatio）。message[0] 前缀稳定性（P0-4）不受影响。
    // ★ 跨 run 持久化：复用前一 run 攒的真实校准与缓存数据，避免每 run 从 1.4 重零
    //   （实测致实现 run 压缩判定滞后、更晚压缩）。详见 store.ts updateCalibration。
    //   ★ P1-4 按模型维度：会话切模型后各模型校准互不污染（getCalibration per-model 命中优先，
    //   旧扁平字段兜底——P1-4 之前会话的盘上形状直接沿用）。
    const persistedCalib = await getCalibration(sessionId, effectiveModel);
    let calibRatio = persistedCalib.calibRatio ?? 1.4;  // 回落 1.4（保守偏高，偏早压缩，安全侧）
    let lastRealPromptTokens = persistedCalib.lastRealPromptTokens;
    let lastCachedTokens = persistedCalib.lastCachedTokens;
    // ★ 重复工具调用熔断器（完整签名连续 3 次 / 后台忙轮询同任务连续 4 轮，带 wait_seconds 的等待查询豁免）：
    //   跨轮有状态，每轮推理后 check()。从 runAgent 抽出到 repeatBreaker.ts；
    //   breaker 持有安全 events 自行发 tool.resolve / tool.repeat_break 埋点。
    const breaker = createRepeatBreaker({ sessionId, depth, llmDecisionSource, startTime, events });
    // ★ 事件日志化：run 边界事件行直接落盘（不经 AgentEvent 通道——subagent abort 时 break 出 for-await，
    //   generator return 的 finally 不能 yield，AgentEvent 送不出去；直接落盘同时自动覆盖主/子会话，
    //   且不污染 SSE/UI 事件流）。appendEvent 内部查开关，关闭时 no-op。
    // ★ P1-5 子任务预算熔断探测：父级经 options.budgetCheck 注入（子 run 链式透传）；主 run 且设预算时
    //   自我武装（闭包= ledger.overHardLimit，与轮边界硬截断同阈值同读数）——子任务（spawn_agent/
    //   run_workflow）经 toolCtx.budgetCheck 每轮边界探测，父预算耗尽即收尾，不再等子任务全额烧完。
    const inheritedBudgetCheck = options.budgetCheck
        ?? (depth === 0 ? ledger.overHardLimit : undefined);
    // ★ P1-7 计划拒绝熔断计数器：计划期非 SAFE 写类工具被拒时由 processToolCall 增量回传（每次 +1）。
    //   NUDGE_AT（2）次经 nudge 管线转向；FORCE_AT（4）次在轮边界强制收尾（见 completed 分支末尾）。
    let planWriteRej = 0;
    // ★ 使用日志（路线 #6 真实使用数据回路）：本 run 工具分布，按模型请求的 tool_calls 按名计数
    //   （请求口径而非执行口径：含被拒/校验失败——工具分布反映模型行为；随 finally 的 run 记录一并落盘）
    const toolCounts: Record<string, number> = {};
    // ★ D5 三轮（8bdb712 遗留项工单 2026-11-03）：degraded/markDegraded 上提到函数体顶部——主循环里
    //   的调用点（round.end 事件行 / assistant/user 消息落盘）同样要上报降级，定义在 finally 内则
    //   主循环作用域不可达。finally 收尾段沿用同一份列表（去重语义不变）。
    const degraded: string[] = [];
    const markDegraded = (name: string): void => { if (!degraded.includes(name)) degraded.push(name); };
    // run.start 事件行：appendEvent 契约是吞错回 false，此处消费返回值上报降级；仍包 try/catch——
    //   防「永不抛错」契约被未来改动破坏（D1 教训：别假设内层永远可靠）。本处在主 try 之外，异常若
    //   冲出 generator → final 永不发 → 前端 busy 永不清（见下方 catch 注释点名要防的事故）。
    try {
        const ok = await appendEvent(sessionId, { dscEvent: 'run.start', runId, depth });
        if (!ok) markDegraded('appendEvent(run.start)');
    } catch { markDegraded('appendEvent(run.start)'); /* 兜底：违反吞错契约的异常信号 */ }
    try {
        while (true) {
            round++;
            if (round > MAX_AGENT_ROUNDS) {
                stopReason = 'limit';
                yield { type: 'final', text: (lastContent || "") + `\n（已达防失控兜底上限 ${MAX_AGENT_ROUNDS} 轮，非任务错误——任务未完成直接回复"继续"即可接续。）` };
                return;
            }
            // ★ P0-4 前缀稳定性：NUDGE 轮数自评已移至「推理时附加尾部副本」（见下方 inferenceMessages 构造），
            //   不再改写 message[0]——保 message[0] 前缀绝对稳定，DeepSeek 隐式缓存跨轮命中。
            //   机制不变：每 NUDGE_EVERY 轮由模型自决收尾（对标 CC：靠模型自收敛 + 用户中止，不硬停）。
            // ★ 前端用户主动停止运行：检测先于 round.start，避免中止后再多发一个 round.start 事件。
            if (signal?.aborted) {
                events({
                    sessionId,
                    eventType: 'user.aborted',
                    metadata: {
                        depth,
                        decisionSource: 'user',
                        ok: false,
                        attempt: round,
                        durationMs: performance.now() - startTime,
                    },
                    payload: {
                        output: lastContent,
                    }
                })
                yield { type: 'final', text: lastContent || "（已中止）" };
                return;

            }
            // ★ 预算硬截断（成本信任链第二环 E2）：soft 提醒（nudge 管线）后仍超 120% → 轮边界干净截断。
            //   stopReason 复用 'limit'（usageLog 已有枚举）；仅主 run（子 run 花费经 reportCost 计入父累计器，
            //   由父统一执行）。soft 与 hard 间隔一整轮：触顶轮先收到 soft 文案，下一轮边界仍超 120% 才截——
            //   极端场景（soft 槽位被更高优 pending 占用而花费一轮穿顶）直接截断也是预算语义内的正确行为。
            if (depth === 0 && ledger.overHardLimit()) {
                const snap = ledger.budgetSnapshot()!; // 硬线命中蕴含已武装（depth=0 且 budget>0），必非 null
                stopReason = 'limit';
                budgetTruncated = true;
                yield { type: 'final', text: (lastContent || "") + `\n（💰 预算截断：本 run 已花费 ¥${snap.spent.toFixed(3)} / 预算 ¥${snap.budget.toFixed(3)}。/budget 调整预算后回复"继续"即可接续。）` };
                return;
            }
            // ★ P1-5 子任务预算熔断消费点（第五轮复核收尾，2026-10-20）：budgetCheck 闭包此前只被链式
            //   透传（runAgent 自武装 → toolCallCtx → subOptions）、从未被调用——子 run 仍会全额烧完，
            //   父级只能在自己下一轮边界才发现超支。此处每轮边界探测：命中即 stopReason='limit' 干净收尾，
            //   final 文案随 spawn_agent 的工具结果回传父模型（父级可据此停止继续派生）。置于 depth=0 硬截断
            //   块之后且显式 depth>0 门禁：主 run 预算截断走上方专属文案不受影响（即便宿主误传 budgetCheck
            //   也不会被本分支截断）；inheritedBudgetCheck（含主 run 自武装闭包）仍经 toolCallCtx 下传孙代，链路不变。
            if (depth > 0 && options.budgetCheck?.()) {
                stopReason = 'limit';
                yield { type: 'final', text: (lastContent || "") + `\n（💰 预算中止：父级预算已耗尽，本子任务在轮边界被熔断收尾，任务未完成。已完成进展如上；请勿重试或继续派生子任务。）` };
                return;
            }
            // ★ inbox steering：回合边界认领运行中排队的补充输入。位于防失控上限/中止检查之后、round.start 之前——
            //   认领即 push + 落盘并广播（本轮推理随即消费）；撞上收尾出口（final/limit/aborted）则不认领，
            //   由 finally flushLeftoverToTranscript 落盘，下轮 buildContextMessages 自然带入。
            const inboxTexts = claimSessionInbox(sessionId);
            if (inboxTexts.length > 0) {
                // ★ 子代理完成唤醒（agentWake）：非空 claim = 完成汇报已由本 run 在跑消化，
                //   撤销挂起的唤醒标记——否则 run 结束时 pumpWake 会再泵一次「纯确认」空唤醒轮。
                clearQueuedWake(sessionId);
                for (const t of inboxTexts) {
                    message.push({ role: 'user', content: t });
                    // ★ D5 三轮：消费内层返回值——补充输入落盘失败（内存有/磁盘无，重启后缺行）可观测；
                    //   单条失败不断循环（try/catch 在 for 内，逐条独立）。
                    try {
                        const ok = await appendMessage({ sessionId, role: 'user', content: t } as any);
                        if (!ok) markDegraded('appendMessage(user)');
                    } catch { markDegraded('appendMessage(user)'); /* 兜底：违反吞错契约的异常信号 */ }
                }
                yield { type: 'inbox.claimed', texts: inboxTexts };
            }
            yield { type: 'round.start', round };
            // ★ M1（缓存塌方治理，2026-11-04）：本轮窗口治理判定快照——ensureFitsWindow 每轮必经
            //   onWindowCheck 产出（含 noop，全路径覆盖），随下方 streamInference 的 llm.request 落 trace 三值。
            let lastWindowCheck: WindowCheckInfo | undefined;
            try {
                // 判断是否需要压缩上下文并触发摘要
                await ensureFitsWindow(
                    {
                        sessionId,
                        messageArr: message,
                        keepRecentUnits,
                        compactRatio,
                        modelWindow,
                        events,
                        depth,
                        signal,
                        correctionRatio: calibRatio,
                        lastRealPromptTokens,
                        lastCachedTokens,
                        toolsTokens,
                        // ★ P0-2：压缩摘要（summarize）的 aux usage 回传计价（见 reportAuxUsage 声明处）
                        onAuxUsage: reportAuxUsage,
                        // ★ H1：旁路数 compact.done 供 context.usage.compactCount（透传不拦截）
                        onUIEvent: (evt) => { if (evt.type === 'compact.done') runCompactCount++; options.onUIEvent?.(evt); },
                        // ★ M1：判定快照出口（含 noop；抛异常路径不回调——那轮推理本就不发生）
                        onWindowCheck: (check) => { lastWindowCheck = check; },
                    }

                );
            } catch (e) {
                // ★ 用户主动中止（点清空 / 停止）恰好打断压缩摘要请求：summarize 的 API 请求会抛
                //   "Request was aborted"。此处优先判 signal.aborted 走安静收尾，避免污染错误日志
                //   + 向用户显示"（Request was aborted）"误导性文案。
                if (signal?.aborted) {
                    yield { type: 'final', text: lastContent || "（已中止）" };
                    return;
                }
                const msg = e instanceof Error ? e.message : String(e);
                console.error("❌ " + msg);
                stopReason = 'error';
                yield { type: 'final', text: (lastContent || "") + `\n（${msg}）` };
                return
            }

            // ★ ephemeral nudge（NUDGE/PHANTOM/EARLY_FINAL 三类）：走「推理时附加尾部副本」，不进 message 数组/
            //   transcript/压缩 → 保 message[0] 前缀绝对稳定，DeepSeek 隐式缓存跨轮命中。优先级与文案见 agentNudges.ts。
            const nudgeMsg = nudges.pickNudge(round);
            // ★ 流式推理抽出到 streamInference.ts：yield text.delta/thinking.delta/text.reset，return InferenceResult。
            //   yield* 委托透传流式事件并取 return value（内含 idle/API/context_length 三道有限重试、abort partial 落盘、
            //   llm.request/response/error 埋点、assistantMessage 拼装）。final 永远在此处 yield，streamInference 不 yield final。
            const infResult: InferenceResult = yield* streamInference({
                message, nudgeMsg, sessionId, depth, round, startTime,
                userDecisionSource, llmDecisionSource, signal,
                cleanedToolSchemas, model: options.model, thinkingLevel: options.thinkingLevel,
                events, keepRecentUnits, compactRatio, modelWindow, toolsTokens,
                onUIEvent: options.onUIEvent,
                onAuxUsage: reportAuxUsage,
                windowCheck: lastWindowCheck,
            });
            if (infResult.kind === 'aborted') {
                // partialText 由 streamInference 在仅文本无半截 tool_call 时落盘后带回；异常路径中止则空，回落 lastContent
                yield { type: 'final', text: infResult.partialText || lastContent || "（已中止）" };
                return;
            }
            if (infResult.kind === 'error') {
                stopReason = 'error';
                yield { type: 'final', text: lastContent || "（发生错误）" };
                return;
            }
            // ★ 用本轮真实 usage 校准估算系数 + 记录缓存数据（供下一轮 ensureFitsWindow 缓存感知判定）。
            //   message 此时正是推理时的上下文（push assistant 在下文），与真实 prompt_tokens 时序对齐；
            //   EMA（历史 0.6 / 新观测 0.4）平滑单轮抖动，estAtInfer>1000 过滤极小上下文的噪声。
            //   ★ P2 口径修正：分母加上工具 schema 常数项（toolsTokens）——真实 prompt_tokens 含这段而
            //   estimateTokens(message) 不含（实测 44 工具 ≈9-10K，首轮曾致观测比 3.9x）。常数显式计入后
            //   EMA 只修正角色折算误差（收敛 ≈1.0-1.5），不再把常数吸收成漂移乘数。
            //   过渡期：旧会话持久化的 calibRatio（旧口径含常数）会短暂双重计入 → 偏早压缩（安全侧），
            //   按 0.4/轮的观测权重数轮内收敛到新口径，随后 updateCalibration 持久化新口径值。
            if (infResult.usage?.prompt_tokens) {
                const estAtInfer = estimateTokens(message) + toolsTokens;
                if (estAtInfer > 1000) {
                    const observed = infResult.usage.prompt_tokens / estAtInfer;
                    calibRatio = calibRatio * CALIB_EMA_KEEP + observed * CALIB_EMA_NEW;
                }
                lastRealPromptTokens = infResult.usage.prompt_tokens;
                lastCachedTokens = infResult.usage.cached_tokens;
            }
            ledger.addUsage(infResult.usage); // completed 轮用量累计进 run.end（事件日志化）
            // assistantMessage 已由 streamInference 委托 provider.buildAssistantMessage 构造完成（含厂商扩展字段，
            //   如 DeepSeek 的 reasoning_content）。此处整体落盘 + ...spread 透传，杜绝手工列举字段名漏挂——
            //   落盘保留 reasoning_content（UI 思考展示 / recall 依赖）；API 回传侧由 provider 出口的
            //   stripHistoricalReasoning 统一剥离（2026-09-10 探针证实不强制回传，剥历史省 ~25%）；
            //   cleanMsg / appendMessage 均 ...rest 透传，保证会话恢复后 buildContextMessages 重建的上下文
            //   仍带该字段，UI 链路不中断。
            // as any：Msg(ChatCompletionMessageParam) 是联合类型，.content/.tool_calls 不在所有成员上，
            //   直接访问触发「不存在属性」；此处一律按 any 窄化访问（与原 .tool_calls as any 同惯法）。
            const assistantMessage = infResult.assistantMessage as any;
            // ★ 空响应防御（2026-11-03 生产 0d245bd0 实证，DS 服务故障期）：content 空(null)且无
            //   tool_calls 的 assistant 消息【不 push 不落盘】——DS API 校验 assistant 必须有 content
            //   或 tool_calls，带上即 400；且一旦落盘，本会话每个后续 run 重建上下文都带它，服务恢复
            //   也救不回（当轮 400 三连实锤）。跳过后走下方既有无工具分支 interceptFinal → PHANTOM
            //   nudge 重试，控制流不变；该轮 reasoning_content 一并丢弃（UI 已实时见过思考增量；
            //   落盘即毒化，两害取其轻）。出口侧另有 stripHistoricalReasoning 兜底清洗历史存量。
            const emptyAssistant = !(typeof assistantMessage.content === 'string' && assistantMessage.content.length > 0)
                && !(Array.isArray(assistantMessage.tool_calls) && assistantMessage.tool_calls.length > 0);
            if (emptyAssistant) {
                markDegraded('emptyAssistantSkip');   // D5 可观测：receipt 可见空响应曾发生且被跳过
            } else {
                message.push(assistantMessage);
                // ★ D5 三轮：消费内层返回值——assistant 落盘失败（每轮必经；丢的是对话本体而非边界标记，
                //   内存有/磁盘无，重启后历史缺行）可观测，GUI 宿主下内层 warn 用户不可见。
                try {
                    const ok = await appendMessage({ ...assistantMessage, sessionId } as any);
                    if (!ok) markDegraded('appendMessage(assistant)');
                } catch { markDegraded('appendMessage(assistant)'); /* 兜底：违反吞错契约的异常信号 */ }
                // 存储最后一条消息，以供后面返回使用
                // ★ 多模态防御：assistant content 按协议恒 string（数组会污染后续字符串拼接/回显），非 string 不入
                if (typeof assistantMessage.content === 'string' && assistantMessage.content) {
                    lastContent = assistantMessage.content;
                }
            }

            // 1、如果本次无调用工具或者工具调用完成后，则主动跳出循环
            if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
                // ★ 事件日志化：本轮 assistant 已落盘、无工具调用（无待 flush 项）→ round 完整闭合。
                //   放 interceptFinal 之前：被拦截续跑的轮同样已完整落盘，事件不缺记。
                //   ★ D5 三轮：round.end 缺失即异常收尾取证信号 → 写失败同样可观测（消费内层返回值）。
                try {
                    const ok = await appendEvent(sessionId, { dscEvent: 'round.end', runId, round, usage: infResult.usage });
                    if (!ok) markDegraded('appendEvent(round.end)');
                } catch { markDegraded('appendEvent(round.end)'); /* 兜底：违反吞错契约的异常信号 */ }
                emitContextUsage();
                // ★ P1-5：本 run 若为子 run，逐轮把增量报给父累计器（基数=预算圈子树完整口径，论证统一见 runLedger.ts 文件头）。主 run 无 sink，flush 为 no-op。
                ledger.flushRelay();
                const finalText = (typeof assistantMessage.content === 'string' ? assistantMessage.content : "") || "";
                // ★ 收尾拦截（PHANTOM 空 content / EARLY_FINAL 早收尾）：命中即注入 nudge 并 continue 推进，
                //   否则放行真实收尾。判定 / 文案 / 预算 / 死循环保险全在 agentNudges.interceptFinal。
                const intercepted = nudges.interceptFinal(finalText, round);
                if (intercepted) continue;
                // 优先用当前轮 content，避免纯工具轮后 lastContent 陈旧导致终态回显旧文本
                yield { type: 'final', text: finalText || lastContent || "" };
                return;
            }
            // 有 tool_calls = 实质推进 → 通知 nudge 调度器重置空响应预算（只计连续空包）
            //   + 透传 tool_calls 供重复检索检测（read_file 路径 / search_grep·glob 检索词计数，命中阈值 → 下一轮 nudge）
            nudges.noteToolCall(round, assistantMessage.tool_calls);
            for (const tc of assistantMessage.tool_calls) {
                const name = tc?.function?.name || "unknown";
                toolCounts[name] = (toolCounts[name] ?? 0) + 1;
            }
            // 2、重复工具调用熔断（完整签名连续 3 次 / 后台忙轮询同任务连续 4 轮，等待查询豁免）：委托 repeatBreaker。
            //    breaker 内部发 tool.repeat_break / tool.resolve 埋点；tripped 则 yield final + return。
            const repeatVerdict = breaker.check(assistantMessage.tool_calls, round, lastContent);
            if (repeatVerdict.tripped) {
                stopReason = 'repeat';
                // ★ 熔断硬化（事件日志化配套）：assistant 已于上方落盘，若直接 return 会留下孤儿 tool_calls，
                //   续接时只能靠孤儿修复启发式兜底。镜像 toolScheduling 中止占位写法逐条补齐（push + 落盘），
                //   使「闭合 run 无孤儿」成为不变式。本路径不写 round.end——缺失即「异常收尾」取证信号。
                //   P2-2：占位落盘合批一次写（顺序 = tool_calls 序，与逐条一致）。
                for (const tc of assistantMessage.tool_calls) {
                    const ph = "（重复调用熔断，未执行）";
                    message.push({ role: 'tool', tool_call_id: tc.id, content: ph });
                }
                // ★ D5 四轮：占位落盘失败可观测（与下方 round.end 同理）——占位行缺失会使恢复侧
                //   repairOrphanToolCalls 下次启动补写，但会丢失“熔断而非真实结果”的语义。
                try {
                    const phWrite = await appendMessages(sessionId, assistantMessage.tool_calls.map((tc: any) =>
                        ({ sessionId, role: 'tool', tool_call_id: tc.id, content: "（重复调用熔断，未执行）" })));
                    if (phWrite.failed > 0) markDegraded('appendMessages(repeat-placeholder)');
                } catch { markDegraded('appendMessages(repeat-placeholder)'); /* 兜底：违反吞错契约的异常信号 */ }
                yield { type: 'final', text: repeatVerdict.text };
                return;
            }
            // ★ 工具执行上下文：每轮推理后构造一次，透传给 scheduleToolCalls→processToolCall。
            //   round 取当前轮值（每轮递增）；逐字段比对 ToolCallContext，避免漏传 onUIEvent/requestApproval/
            //   requestQuestion/permissionMode（subagent 透传给子 agent toolCtx，漏传则审批死锁）。
            const toolCallCtx: ToolCallContext = {
                sessionId, cwd, depth, round, startTime, llmDecisionSource,
                signal, rawTools, events,
                permissionMode: options.permissionMode,
                planMode: !!options.planMode, // ★ P0-A runtime 档：计划期写工具在 processToolCall 执行层拒绝（工具表恒定不裁剪）
                onUIEvent: options.onUIEvent,
                requestApproval: options.requestApproval,
                requestQuestion: options.requestQuestion,
                ideAction: options.ideAction,
                keepRecentUnits, compactRatio, modelWindow, parentSystemPrompt,
                // ★ P2-1：本时刻上下文用量估算（此时已含本轮 assistant，常数近似足够，不逐工具更新）——
                //   processToolCall 据此收缩截断预算：最坏组合「上下文已 75% 满时跑大输出命令 → 16K 字符
                //   进上下文 → 下一轮立刻压缩」被釜底抽薪；口径与 ensureFitsWindow/nudge 闭包同公式。
                contextTokensEst: Math.round(estimateTokens(message) * calibRatio + toolsTokens),
                readTracker, // ★ P3-8：run 级读取追踪（同一引用透传，跨轮累计）
                // ★ 子 run 成本回灌（成本信任链第二环 E1）：runSubagent 经 toolCtx.reportCost 把子 run 花费
                //   记进账本预算圈 + 展示账——父预算自动继承约束（守卫与分账语义在 runLedger.reportSubCost）。
                reportCost: ledger.reportSubCost,
                // ★ 按次计费工具成本上报（DeepSeek Search/Fetch）：web 工具经 toolCtx.toolCostSink 拿到闭包，
                //   成功调用后按次上报进本 run 累计器。
                toolCostSink,
                // ★ P0-2：auto 档风险分类器（classifyToolRisk）的 aux usage 回传计价（见 reportAuxUsage 声明处）
                onAuxUsage: reportAuxUsage,
                // ★ P1-7 计划拒绝熔断：计划期非 SAFE 工具被拒增量回传（计数 + 通知 nudge 调度器发转向文案）
                planWriteRejections: (delta: number) => { planWriteRej += delta; nudges.notePlanWriteRejected(planWriteRej); },
                // ★ P1-5 子任务预算熔断：runSubagent 经 toolCtx.budgetCheck 拿到探测闭包，子 runAgent 每轮边界自检
                budgetCheck: inheritedBudgetCheck,
                // ★ A 批批级预算：主循环不设（undefined）；仅并行批 ≥2 时由调度层浅拷贝下发（R4/R5：
                //   required 字段，构造处显式对齐，漏写即 tsc 打红）
                batchBudgetChars: undefined,
            };
            // ★ 分波调度抽出到 toolScheduling.ts：yield tool.start/tool.end/plan.*，return ScheduleResult。
            //   yield* 委托透传工具事件并取 return value；aborted/terminal yield final + return，completed 继续下一轮。
            //   调度内部异常不自理，上抛至此处外层 catch(toolErr) 兜底 yield final（与原内联实现一致）。
            const scheduleResult: ScheduleResult = yield* scheduleToolCalls(assistantMessage, message, toolCallCtx);
            // ★ D5 四轮：调度层落盘降级并入 run 级 degraded。工具结果丢失 = 上下文永久残缺（恢复时补
            //   占位，原始结果不可逆），是比边界事件更重的信号；aborted/terminal 提前 return 也要带上。
            if (scheduleResult.degraded) for (const name of scheduleResult.degraded) markDegraded(name);
            if (scheduleResult.kind === 'aborted') {
                yield { type: 'final', text: lastContent || "（已中止）" };
                return;
            }
            if (scheduleResult.kind === 'terminal') {
                yield { type: 'final', text: scheduleResult.terminalText };
                return;
            }
            // completed：继续下一轮推理
            // ★ 事件日志化：本轮 assistant + 全部 tool 结果已完整 flush → round 闭合（两条正常路径都写：
            //   此处与无工具收尾处；abort/error/repeat/terminal 不写，缺失即取证信号）。
            //   ★ D5 三轮：写失败可观测（消费内层返回值，理由同无工具收尾处）。
            try {
                const ok = await appendEvent(sessionId, { dscEvent: 'round.end', runId, round, usage: infResult.usage });
                if (!ok) markDegraded('appendEvent(round.end)');
            } catch { markDegraded('appendEvent(round.end)'); /* 兜底：违反吞错契约的异常信号 */ }
            emitContextUsage();
            // ★ P1-5：本 run 若为子 run，逐轮把增量报给父累计器（父轮边界预算检查即时生效；基数口径见 runLedger.ts 文件头）。
            ledger.flushRelay();
            // ★ P1-7 计划拒绝熔断：连续 FORCE_AT（4）次计划期写工具被拒 → 强制收尾（模型未能产出方案，
            //   不陪空转烧轮数）。round.end 已写（本轮完整闭合），stopReason='limit' 与预算截断同枚举。
            //   转向 nudge 在 NUDGE_AT（2）次时已注入过一次（pickNudge 消费），给过机会仍不转向才熔断。
            if (options.planMode && planWriteRej >= PLAN_REJECT_FORCE_AT) {
                stopReason = 'limit';
                yield { type: 'final', text: PLAN_REJECT_FORCE_FINAL_TEXT(planWriteRej) };
                return;
            }
        }
    } catch (toolErr) {
        // ★ 工具执行段兜底（P0）：assistantMessage 落盘 / processToolCall / appendMessage / Promise.all
        //   等若抛出未守护异常（磁盘 IO 失败、锁/截断边界异常等），原先会逃出 generator → 消费层 for-await
        //   无 catch → final 永不发 → 前端 busy 永不清（永久卡死）。此处兜住，必定 yield final 收尾。
        //   流式推理段的异常已被上方内层 catch 处理（yield final + return），不会到达此处。
        if (signal?.aborted) {
            yield { type: 'final', text: lastContent || "（已中止）" };
            return;
        }
        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        console.error('❌ agent 工具执行段异常（兜底收尾）:', errMsg);
        stopReason = 'error';
        yield { type: 'final', text: (lastContent || "") + `\n（工具执行异常：${errMsg}）` };
        return;
    } finally {
        // ★ D5 聚合健康信号（审查报告 2026-11-03）：收尾段 8 个旁路逐个容错（单点判断正确、任何依赖
        //   都不该击垮收尾），但组合效应是异常环境下（如磁盘满）trace/用量/结算单/校准可能集体静默
        //   失效且无任何汇总线索。degraded[] 收集本 run 全程失败的组件名，末尾一句聚合 warn（开发者
        //   可见兜底通道）+ run.receipt 可选字段（用户可见通道）——旁路降级从「无声」变「可观测」。
        // ★ D5 二轮（4f15287 复核）：首轮把 push 接在外层 catch 上，但 D5 立案点名的组件（事件行/trace/
        //   用量/inbox）全部在函数内层就吞了错误只 warn——外层 catch 永不触发（死信号，与 D1 病根同源；
        //   recordUsageRun 还叠加 void fire-and-forget，异步拒绝连同步 catch 都进不了，双重死）。
        //   二轮改为：内层如实回报成败（返回值/失败计数），按返回值 push；外层 catch 保留作兜底
        //   （防内层容错被未来改动破坏），markDegraded 去重使两路不重复报。禁用开关（transcriptEvents
        //   关 / USAGE_LOG=0）内层返回成功——有意 no-op ≠ 降级，误报即狼来了。
        // ★ D5 三轮（8bdb712 遗留项工单 2026-11-03）：信号采集范围扩到主循环——round.end 事件行与
        //   assistant/user 消息落盘同样消费内层返回值（degraded/markDegraded 已上提至函数体顶部，
        //   run.start 一并消费并包 try 兜底）。
        // ★ receipt 快照边界（工单 P2-1，方案 A 已执行）：updateCalibration 前移至结算单之前（纯本地
        //   文件写，前置零风险），Stop hook 保持在后（dispatch 会跑用户配置的 shell 命令，可能数秒，
        //   不能拖结算单 UI）——故快照含 8 项旁路中的 6 项；进不去的两项：Stop-hook（在结算单之后）、
        //   run.receipt（无法报自身）。主循环段（round.end / 消息落盘）降级发生在 receipt 前，天然入快照。
        // ★ inbox 收尾：未认领的补充输入落盘成 user 消息。置于 run.end 事件行之前——
        //   fork 缺省锚点（最后一个 run.end）的前缀包含它们，分叉语义完整。
        try {
            const flushResult = await flushLeftoverToTranscript(sessionId);
            if (flushResult.failed > 0) markDegraded('flushLeftoverToTranscript'); // 内层按条聚合失败数（D5 二轮）
        } catch { markDegraded('flushLeftoverToTranscript'); /* 兜底：内层容错失效属异常信号 */ }
        // ★ 事件日志化：run 闭合事件行——必须在 finally 直接落盘（generator return 路径不能 yield，
        //   AgentEvent 通道送不出去）；stopReason 与 Stop hook 同口径（signal.aborted 覆盖推断）。
        //   放 Stop hook / updateCalibration 之前：run 边界元数据先于旁路持久化。
        try {
            const ok = await appendEvent(sessionId, { dscEvent: 'run.end', runId, stopReason: signal?.aborted ? 'aborted' : stopReason, rounds: round, usage: ledger.usageSummary() });
            if (!ok) markDegraded('appendEvent(run.end)'); // 内层吞错只回 false（D5 二轮）
        } catch { markDegraded('appendEvent(run.end)'); /* 兜底：appendEvent 契约是吞错回 false，抛错即异常信号 */ }
        // ★ D 批（§4.2-3）显式 drain：trace 批量缓冲收尾不丢尾——200ms 窗口内的普通事件尾巴在此落盘
        //   （错误类事件已即时落盘，§4.2-5；无参 flush 全部会话，子 run 共文件一并收尾）。与 appendEvent 同级容错。
        try {
            const failedSessions = await flushTraceBuffer();
            if (failedSessions > 0) markDegraded('flushTraceBuffer'); // 内层逐会话吞错只回失败计数（D5 二轮）
        } catch { markDegraded('flushTraceBuffer'); /* 兜底：flushTraceBuffer 契约是吞错回计数，抛错即异常信号 */ }
        // ★ 使用日志落盘（路线 #6 真实使用数据回路）：每 run 一行（轮数/token/工具分布/停止原因），
        //   按月分片纯本地留存、绝不上报。★ D5 二轮：void 改 await——原 void fire-and-forget 连同
        //   内层吞错构成双重死（异步拒绝进不了同步 catch、内层吞错进不了外 catch），await 拿返回值
        //   是观测闭环的必要条件；旁路计量仍不击垮收尾链路（本段自有 try/catch）。
        try {
            const us = ledger.usageSummary();
            const ok = await recordUsageRun({
                v: 1,
                ts: new Date().toISOString(),
                sessionId, runId, depth,
                model: options.model?.trim() || MODEL_NAME,
                stopReason: signal?.aborted ? 'aborted' : stopReason,
                rounds: round,
                durationMs: Math.round(performance.now() - startTime),
                promptTokens: us?.prompt_tokens,
                completionTokens: us?.completion_tokens,
                totalTokens: us?.total_tokens,
                cachedTokens: us?.cached_tokens,
                ...ledger.usageLogFields(), // costYuan/toolCostYuan/auxCostYuan（口径与舍入在 runLedger）
                tools: toolCounts,
            });
            if (!ok) markDegraded('recordUsageRun'); // 内层吞错只回 false（D5 二轮）
        } catch { markDegraded('recordUsageRun'); /* 兜底：recordUsageRun 契约是吞错回 false，抛错即异常信号 */ }
        // ★ 子 run 成本回灌（E1 + P1-5）：本 runAgent 为子 run 时（options.costSink 已注入），收尾补报余量
        //   给父累计器——各 round.end 已增量上报过，此处 flush 只补差额（中继幂等）。基数=预算圈子树完整
        //   口径（含下级 relay 回灌），论证统一见 runLedger.ts 文件头。旁路，绝不击垮收尾。
        try {
            ledger.flushRelay();
        } catch { markDegraded('ledger.flushRelay'); /* 成本回灌失败不影响收尾（父预算检查按已有读数执行） */ }
        // ★ 持久化压缩校准状态：让下一 run（同会话续接/实现阶段）复用本 run 攒的真实校准与缓存命中率。
        //   ★ P1-4 按 effectiveModel 分键写回（旧扁平字段镜像同步），切模型后各模型校准互不污染。
        //   旁路操作，失败绝不阻塞主流程（与 Stop hook 同级容错）。
        //   ★ D5 三轮（工单 P2-1 方案 A）：自 Stop hook 之后前移到结算单之前——纯本地文件写，前置零风险，
        //   使其降级能进 receipt 快照（8 项旁路中 6 项可进用户可见通道）。
        try {
            await updateCalibration(sessionId, effectiveModel, { calibRatio, lastRealPromptTokens, lastCachedTokens });
        } catch (e) { markDegraded('updateCalibration'); console.warn('⚠️ 压缩校准状态落盘失败（下 run 校准重零，缓存感知压缩退化回缺省 1.4）:', e instanceof Error ? e.message : e); }
        // ★ 任务结算单（成本信任链第一环 D2）：run 收尾向用户展示本次花费。门禁照 compact.done——仅主 agent
        //   且 onUIEvent 出口存在；ledger.usageSummary() 缺失（未产生推理的空 run）不发零单。finally 内不能 yield（同 run.end
        //   事件行先例），经 onUIEvent 直发；旁路 UI 绝不击垮收尾链路。
        try {
            const us = ledger.usageSummary();
            if (depth === 0 && options.onUIEvent && us) {
                const prompt = us.prompt_tokens ?? 0;
                options.onUIEvent({
                    type: 'run.receipt',
                    rounds: round,
                    promptTokens: prompt,
                    completionTokens: us.completion_tokens ?? 0,
                    cachedTokens: us.cached_tokens ?? 0,
                    cacheHitRate: prompt > 0 ? (us.cached_tokens ?? 0) / prompt : 0,
                    ...ledger.receiptFields(), // costYuan(null=无价)/toolCostYuan/auxCostYuan/subCostYuan（口径与舍入在 runLedger）
                    durationMs: Math.round(performance.now() - startTime),
                    budgetTruncated: budgetTruncated || undefined, // 预算截断标注（E2；undefined 自动省略）
                    degraded: degraded.length > 0 ? [...degraded] : undefined, // D5：结算单发出前已降级的旁路快照（边界=updateCalibration 之后、Stop hook 之前；undefined 自动省略）
                });
            }
        } catch { markDegraded('run.receipt'); /* 结算单是旁路 UI，失败不影响收尾 */ }
        // ★ Stop hook（观察）：agent 主循环退出时触发；reason 由各出口标记 + signal.aborted 推断。
        //   dispatch 内部已容错，外层再包 try/catch，绝不击垮主流程。
        try {
            const reason = signal?.aborted ? 'aborted' : stopReason;
            // 与 SessionStart/SessionEnd 对齐：补 cwd，使声明式 Stop hook 的 shell 命令落在项目目录而非 process.cwd() 默认值
            await dispatch('Stop', { sessionId, cwd, lastText: lastContent || '', reason });
        } catch (e) { markDegraded('Stop-hook'); console.warn('⚠️ Stop hook 外层兜底（dispatch 内部容错失效，属异常信号）:', e instanceof Error ? e.message : e); }
        // ★ D5 聚合兜底（末尾一句，不依赖 receipt 通道存在）：本 run 有旁路降级时聚合告警一次。
        //   限制：VSCode 宿主 console.warn 未必进用户面板（全库既有现状），此通道是开发者可见；
        //   用户可见通道 = run.receipt 的 degraded 字段。组件名可 grep 定位实现。
        //   ★ 措辞限定为「降级组件」而不具体枚举后果：degraded 现已包含三类不同性质的信号——
        //   收尾旁路（计量/校准/结算）、消息落盘（对话本体）、emptyAssistantSkip（模型空响应，
        //   不是故障而是被跳过的异常输入）。旧措辞「计量/校准/结算可能不完整」只描述第一类，
        //   拿它统摄后两类会误导读数（D5 四轮修正）。
        if (degraded.length > 0) {
            console.warn(`⚠️ [run 降级] ${degraded.length} 项（不影响主流程；具体后果见组件名）: ${degraded.join(', ')}`);
        }
    }
}
