/**
 * @file agent/toolResultCollect.ts
 * @description 工具执行结果的归一收集（自 truncate.ts 拆出，2026-09-16 顺手登记项：truncate.ts 职责
 *  收敛为「上下文削进窗口」——微压缩/截断/滚动摘要；本收集属工具执行链路，与截断是两回事）。
 *  工具可返回 Promise<string | ToolExecuteResult> 或 AsyncGenerator<string>（流式），统一归一为
 *  结构化 ToolExecuteResult：流式逐块拼接（可选 onChunk 实时透出）+ idle 超时熔断；非流式安全网
 *  超时 + abort 打断；「[⏳」熔断分支置 failed（#8b：文案不承载成败语义，状态是唯一来源）。
 */
import type { ToolExecuteResult } from "@/tool/type.ts";

/** 类型守卫：判断工具返回值是否为异步生成器（流式工具）。 */
function isAsyncGenerator(x: any): x is AsyncGenerator<string> {
    return x != null && typeof x[Symbol.asyncIterator] === 'function';
}

/**
 * 归一化工具执行结果：工具可返回 Promise<string | ToolExecuteResult> 或 AsyncGenerator<string>（流式）。
 *  对流式结果逐块拼接（可选回调 onChunk 实时透出），对非字符串结果 JSON.stringify。
 *  ★ #8b：返回结构化 ToolExecuteResult——string 归一为 success；两类「[⏳」熔断分支置 failed/runtime
 *  （文案不变），执行层据此判 ok（原 FAILED_PREFIXES 前缀嗅探通道退役）。
 * @param ret 工具返回值
 * @param onChunk 流式分块回调（可选）
 * @param signal 主动中止信号（可选）：用户中止时即时打断 await，冒泡走工具 catch → 主循环 aborted 收尾
 * @return 归一化后的结构化结果
 */
export const collectToolResult = async (
    ret: Promise<string | ToolExecuteResult> | AsyncGenerator<string>,
    onChunk?: (s: string) => void,
    signal?: AbortSignal,
): Promise<ToolExecuteResult> => {
    if (isAsyncGenerator(ret)) {
        let full = '';
        // ★ R-2：idle 超时熔断——非后台流式工具两个 chunk 间超过阈值无产出，判定 generator 卡死
        //   （外部流 hang 等），返回已收集内容 + 超时提示，防 agent 循环永久阻塞。
        //   复用 DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS（与 model.ts 的 LLM 流式 idle 同 env：VSCode/CLI 的
        //   streamIdleTimeoutMs 配置统一控制 LLM 与工具两层流式 idle）。后台工具不走此路径（runBackgroundTool + MAX_BACKGROUND_TOOL_MS）。
        const idleMs = Number(process.env.DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS) || 120_000;
        while (true) {
            let timer: NodeJS.Timeout | undefined;
            const outcome = await Promise.race<
                { timedOut: true } | { timedOut: false; step: IteratorResult<string> }
            >([
                ret.next().then((step) => ({ timedOut: false as const, step })),
                new Promise<{ timedOut: true }>((resolve) => {
                    timer = setTimeout(() => resolve({ timedOut: true }), idleMs);
                }),
            ]);
            if (timer) clearTimeout(timer);
            if (outcome.timedOut) {
                full += `\n\n[⏳ 工具流式输出 idle 超时（${Math.round(idleMs / 1000)}s 无新块），已熔断返回已收集内容]`;
                try { await ret.return(undefined); } catch { /* 尽力释放 generator（触发其 finally 清理资源） */ }
                return { content: full, status: 'failed', errorCategory: 'runtime' };
            }
            if (outcome.step.done) break;
            // 块归一：协议允许 yield 结构化载荷（后台工具首 yield 的 toolFailure 对象由 runBackgroundTool
            // 消费，正常到不了这里；防御非字符串块，避免 '+=' 拼出 '[object Object]'）
            const chunk = typeof outcome.step.value === 'string' ? outcome.step.value : String((outcome.step.value as any)?.content ?? outcome.step.value ?? '');
            full += chunk;
            onChunk?.(chunk);
        }
        return { content: full, status: 'success' };
    }
    // ★ 非流式（Promise<string | ToolExecuteResult>）安全网超时（上线前 P0-1 修复）：
    //   流式分支有 idle 超时（见上）、后台工具有 30min 兜底（MAX_BACKGROUND_TOOL_MS），唯独本路径曾直接
    //   `await ret` 无任何熔断——若某工具（典型：网络型 MCP）hang 且不响应 abortSignal，会永久阻塞 agent
    //   主循环（await 不返回，连用户中止都难救）。此处复用 DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS（与 LLM/工具流式
    //   idle 同 env，统一可调）作安全网：到点未完成 → 返回超时提示（不抛错，模型据此自行决策下一步）；
    //   同时把 abortSignal race 进来，让用户中止能即时打断 await（abort → 抛错走工具 catch → 主循环 aborted 收尾）。
    //   取舍：超时返回后底层 promise 仍可能 pending（JS 无强制取消 Promise 之能力），属可接受孤儿，最终 GC。
    //   刻意不消费 CustomTool.timeoutMs（对标 Claude Code：取消由 abortSignal 驱动、长任务走后台 isSync:false），
    //   此处仅作「兜底熔断」，非 per-tool 业务超时。
    const timeoutMs = Number(process.env.DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS) || 120_000;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const raced = await Promise.race<{
        kind: 'ok'; value: string | ToolExecuteResult;
    } | {
        kind: 'timeout';
    } | {
        kind: 'abort';
    }>([
        Promise.resolve(ret).then((v) => ({ kind: 'ok' as const, value: v })),
        new Promise<{ kind: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs); }),
        ...(signal ? [new Promise<{ kind: 'abort' }>((resolve) => {
            onAbort = () => resolve({ kind: 'abort' });
            signal.addEventListener('abort', onAbort, { once: true });
        })] : []),
    ]);
    if (timer) clearTimeout(timer);
    // ★ 监听器清理：race 以 ok/timeout 收尾时监听器仍挂在 signal 上——每次工具调用漏挂一个，
    //   长会话缓慢累积（AbortSignal 是 EventTarget，超过阈值 Node 不告警）。对照 backgroundTool.ts
    //   finalize 的解绑写法；{once:true} 只保证 abort 时触发后移除，不触发就永久滞留。
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    if (raced.kind === 'timeout') {
        return { content: `[⏳ 工具执行超时（${Math.round(timeoutMs / 1000)}s 未返回），已熔断跳过。该工具可能 hang 或不响应中止信号。]`, status: 'failed', errorCategory: 'runtime' };
    }
    if (raced.kind === 'abort') {
        throw new Error('aborted');
    }
    // 结构化归一（#8b）：string → success；{content,status} 合法形态 → 原样；非法对象 → JSON.stringify 视为 success（保持现状）
    const v = raced.value;
    if (typeof v === 'string') return { content: v, status: 'success' };
    if (v && typeof v === 'object' && typeof (v as ToolExecuteResult).content === 'string'
        && ((v as ToolExecuteResult).status === 'success' || (v as ToolExecuteResult).status === 'failed')) return v;
    return { content: JSON.stringify(v), status: 'success' };
};
