/**
 * @file agent/repeatBreaker.ts
 * @description 重复工具调用熔断（有状态工厂）。
 *  两道检测：
 *   1) 完整签名（name:arguments）连续 3 轮相同 → 精确重复，立即熔断；
 *   2) 轮询工具（get_background_output）同目标（task_id，忽略游标参数）连续 4 个轮询轮 → 忙轮询死循环兜底。
 *      ★「连续」为真连续：非轮询轮 / 阻塞等待轮 push 空哨兵打断链条（原实现只在轮询轮 push、
 *      其余轮既不 push 也不重置，实际语义是"累计 4 次无论间隔都熔断"，长任务穿插干活后再查一次即误杀）。
 *   阻塞等待类查询（get_background_output 带 wait_seconds>0）豁免两道检测——它是"用等待替代轮询"的正解，
 *   拦它等于逼模型退回忙轮询（与 background.ts 的 wait_seconds 配套）。
 *
 *  从 runAgent 主循环抽出（原内联闭包，跨轮累积 recentSignatures/recentNameSignatures）。
 *  事件发射（tool.repeat_break / tool.resolve）由本模块自行发起——它已持有安全包装后的 events，
 *  埋点为 fire-and-forget（events 包装层已 try/catch，绝不冒泡击垮主循环），与原内联实现语义一致。
 *  纯数据契约：check() 不 yield / 不决定 final——只回 RepeatVerdict，由主循环据此 yield final + return。
 */
import { RunAgentEvents } from "./type.ts";
import { TraceDecisionSource } from "@/observability/type.ts";

/** check() 返回的熔断判定（判别联合）：
 *  - tripped:false —— 未触发，附带本轮完整签名与工具名序列（供主循环/调试）；
 *  - tripped:true  —— 已触发，附带文案（含 lastContent 前缀）与触发工具名，主循环据此 yield final。 */
export type RepeatVerdict =
    | { tripped: false; signature: string; nameSignature: string }
    | { tripped: true; kind: 'full' | 'names'; text: string; toolName: string };

/** createRepeatBreaker 运行期依赖（原 runAgent 闭包变量的显式打包）。逐字段比对，避免漏传
 *  llmDecisionSource（trace 决策来源）/ startTime（durationMs 基准）/ events（埋点回调）。 */
export type RepeatBreakerContext = {
    sessionId: string;
    depth: number;
    llmDecisionSource: TraceDecisionSource;
    startTime: number;
    events: RunAgentEvents;
};

/**
 * 创建一个跨轮有状态的重复调用熔断器。
 * 主循环每轮推理后调 `breaker.check(assistantMessage.tool_calls, round, lastContent)`：
 *  - 触发 → 返回 tripped 判定（已发 tool.repeat_break 埋点），主循环 yield final + return；
 *  - 未触发 → 返回非 tripped 判定（已发 tool.resolve 埋点），主循环继续执行工具。
 * recentSignatures/recentNameSignatures 定长裁剪（>6 / >16 即 shift），防长会话无限增长占内存（F-8）。
 */
export const createRepeatBreaker = (ctx: RepeatBreakerContext) => {
    const { sessionId, depth, llmDecisionSource, startTime, events } = ctx;
    const recentSignatures: string[] = [];
    // 轮询类工具"同目标反复查询"序列（仅 get_background_output 等轮询工具的目标指纹，见 pollTarget）
    const recentPollTargets: string[] = [];
    // ★ 轮询目标提取：忽略 tail_lines 等游标参数，只按目标标识（task_id）判等。
    //   死循环特征是"反复查/改同一目标"，正常多步特征是"每次目标不同"——
    //   按工具名是否相同判定注定误杀长任务（连读 N 个文件、连改 N 处都是同名不同目标）。
    //   故序列熔断只对已知轮询工具按"目标标识"判等；其余工具的"完全相同调用"由完整签名 3 次覆盖。
    const POLL_TARGET_KEYS: Record<string, string[]> = { get_background_output: ["task_id"] };
    /** 安全解析一个 tool_call 的 arguments JSON（非法 JSON 当空对象）。 */
    const parseArgs = (tc: any): Record<string, unknown> => {
        try { return JSON.parse(tc?.function?.arguments || "{}") ?? {}; } catch { return {}; }
    };
    const pollTarget = (tc: any): string | null => {
        const name = tc?.function?.name;
        const keys = name ? POLL_TARGET_KEYS[name] : undefined;
        if (!keys) return null;
        const args = parseArgs(tc);
        const picked: Record<string, unknown> = {};
        for (const k of keys) if (k in args) picked[k] = args[k];
        return `${name}:${JSON.stringify(picked)}`;
    };
    /** ★ 阻塞等待类查询（get_background_output 带 wait_seconds>0）豁免两道重复检测：
     *  它是「用等待替代轮询」的正解（等长任务跑完），拦它等于逼模型退回忙轮询。 */
    const isWaitPoll = (tc: any): boolean =>
        tc?.function?.name === "get_background_output" && Number(parseArgs(tc).wait_seconds ?? 0) > 0;

    const check = (
        toolCalls: any[],
        round: number,
        lastContent: string | undefined,
    ): RepeatVerdict => {
        // ★ 等待类调用（isWaitPoll）剔除后再算签名：等待轮 sig 为空串（空哨兵），非空才可能触发熔断——
        //   既有豁免语义（等待不计数），又用空哨兵打断精确重复链（等待意味着模型做了别的事，不该续链）。
        const effCalls = toolCalls.filter((t: any) => !isWaitPoll(t));
        const sig = effCalls.map((t: any) => `${t.function.name}:${t.function.arguments}`).join("|");
        const tooName = toolCalls.map((t: any) => `${t.function.name}`).join("|");

        // 1) 完整签名（含 arguments）连续 3 轮相同 → 精确重复，熔断
        recentSignatures.push(sig);
        if (recentSignatures.length > 6) recentSignatures.shift(); // F-8：定长裁剪，防长会话无限增长占内存
        const last3 = recentSignatures.slice(-3);
        if (sig && last3.length === 3 && last3.every(s => s === sig)) {
            const text = (lastContent || "") + "\n（检测到重复工具调用，已停止）";
            events({
                sessionId,
                eventType: 'tool.repeat_break',
                metadata: {
                    depth,
                    decisionSource: llmDecisionSource,
                    durationMs: performance.now() - startTime,
                    round,
                    toolName: tooName,
                    toolSource: 'builtin',
                    ok: false,
                    attempt: round,
                },
                payload: { output: text },
            });
            return { tripped: true, kind: 'full', text, toolName: tooName };
        }

        // 2) 轮询工具"同目标"忙轮询死循环兜底（替代原"纯工具名序列"——后者对连续 read 多文件 / edit 多位置
        //    等正常长任务一律误杀）：
        //    仅对已知轮询工具（get_background_output）按"目标标识"（task_id）判等，忽略 tail_lines 等游标参数。
        //    ★「连续 4 个轮询轮」为真连续：非轮询轮/等待轮 push 空哨兵打断链条——原实现只在轮询轮 push、
        //      其余轮既不 push 也不重置，实际语义是"累计 4 次无论间隔都熔断"，长任务穿插干活后再查一次即误杀。
        //    连续 4 个轮询轮查同一后台任务 = 忙轮询死循环（agent 不该空轮询，应带 wait_seconds 等待/汇报/做别的）。
        //    其他工具（edit/read/grep…）的"完全相同调用"已由上方完整签名 3 次覆盖，"同名不同参数"属正常多步，不再拦。
        const pollSig = effCalls.map(pollTarget).filter(Boolean).join("|");
        recentPollTargets.push(pollSig);
        if (recentPollTargets.length > 8) recentPollTargets.shift();
        const last4 = recentPollTargets.slice(-4);
        if (pollSig && last4.length === 4 && last4.every((s) => s === pollSig)) {
            const text = (lastContent || "") + "\n（检测到后台任务轮询死循环（反复查询同一任务），已停止）";
            events({
                sessionId,
                eventType: 'tool.repeat_break',
                metadata: {
                    depth,
                    decisionSource: llmDecisionSource,
                    durationMs: performance.now() - startTime,
                    round,
                    toolName: tooName,
                    toolSource: 'builtin',
                    ok: false,
                    attempt: round,
                },
                payload: { output: text },
            });
            return { tripped: true, kind: 'names', text, toolName: tooName };
        }

        // 未触发：发 tool.resolve 埋点（本轮工具调用的解析归档），主循环继续

        events({
            sessionId,
            eventType: 'tool.resolve',
            metadata: {
                depth,
                decisionSource: llmDecisionSource,
                durationMs: performance.now() - startTime,
                round,
                toolName: tooName,
                toolSource: 'builtin',
            },
            payload: { output: sig },
        });
        return { tripped: false, signature: sig, nameSignature: tooName };
    };

    return { check };
};
