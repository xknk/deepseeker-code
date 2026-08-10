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
    const recentNameSignatures: string[] = [];

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

        // 2) 参数微变死循环兜底：完整签名随时间戳/游标等动态参数变化永不重复，
        //    补"仅工具名"序列检测——连续 8 轮同一组工具名（参数可能每轮微变）即熔断，
        //    给分页读取等合理的连续同工具调用留出空间。
        recentNameSignatures.push(tooName);
        if (recentNameSignatures.length > 16) recentNameSignatures.shift();
        const last8 = recentNameSignatures.slice(-8);
        if (last8.length === 8 && last8.every(s => s === last8[0])) {
            const text = (lastContent || "") + "\n（检测到工具名序列持续重复（参数可能微变），已停止）";
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
