/**
 * @file agent/repeatBreaker.ts
 * @description 重复工具调用熔断（有状态工厂）。
 *  两道检测：
 *   1) 完整签名（name:arguments）连续 3 轮相同 → 精确重复，立即熔断；
 *   2) 仅工具名序列连续 8 轮相同 → 参数微变死循环兜底（完整签名随时间戳/游标等动态参数变化永不重复，
 *      补一条"仅工具名"序列；给分页读取等合理的连续同工具调用留 8 轮空间，不误杀）。
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
    const pollTarget = (tc: any): string | null => {
        const name = tc?.function?.name;
        const keys = name ? POLL_TARGET_KEYS[name] : undefined;
        if (!keys) return null;
        let args: any = {};
        try { args = JSON.parse(tc?.function?.arguments || "{}"); } catch { /* 非法 JSON 当空 */ }
        const picked: Record<string, unknown> = {};
        for (const k of keys) if (k in args) picked[k] = args[k];
        return `${name}:${JSON.stringify(picked)}`;
    };

    const check = (
        toolCalls: any[],
        round: number,
        lastContent: string | undefined,
    ): RepeatVerdict => {
        const sig = toolCalls.map((t: any) => `${t.function.name}:${t.function.arguments}`).join("|");
        const tooName = toolCalls.map((t: any) => `${t.function.name}`).join("|");

        // 1) 完整签名（含 arguments）连续 3 轮相同 → 精确重复，熔断
        recentSignatures.push(sig);
        if (recentSignatures.length > 6) recentSignatures.shift(); // F-8：定长裁剪，防长会话无限增长占内存
        const last3 = recentSignatures.slice(-3);
        if (last3.length === 3 && last3.every(s => s === last3[0])) {
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

        // 2) 轮询类工具"同目标反复查询"死循环兜底（替代原"纯工具名序列"——后者对连续 read 多文件 / edit 多位置
        //    等正常长任务一律误杀）：
        //    仅对已知轮询工具（get_background_output：agent 主动轮询后台任务输出）按"目标标识"（task_id）判等，
        //    忽略 tail_lines 等游标参数。连续 4 轮查同一后台任务 = 轮询死循环（agent 不该空轮询，应等用户或做别的）。
        //    其他工具（edit/read/grep…）的"完全相同调用"已由上方完整签名 3 次覆盖，"同名不同参数"属正常多步，不再拦。
        const pollTargets = toolCalls.map(pollTarget).filter(Boolean);
        if (pollTargets.length) {
            const pollSig = pollTargets.join("|");
            recentPollTargets.push(pollSig);
            if (recentPollTargets.length > 8) recentPollTargets.shift();
            const last4 = recentPollTargets.slice(-4);
            if (last4.length === 4 && last4.every((s) => s === last4[0])) {
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
