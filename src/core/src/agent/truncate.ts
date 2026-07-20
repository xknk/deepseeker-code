/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-16 15:09:46
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-10 11:38:59
 * @FilePath: \lims-frontd:\code\自研\roundSeekCode\src\core\src\agent\truncate.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file agent/truncate.ts
 * @description 上下文（窗口）治理模块：负责把过长的工具返回与对话历史“削”进模型窗口。
 *
 *  三类能力：
 *  1) 文本微压缩 —— stripAnsi / microcompactTextContent / relativizeWorkspacePathsInText：
 *     去掉 ANSI 转义、HTML 注释、把绝对路径相对化为 ./...，缩短 system/tool 消息 token；
 *  2) 文本头尾截断 —— truncateToolResult（工具返回，回灌模型窗口）/ truncateApprovalDetail（审批详情，推前端 UI）：超过上限时去中间、留头尾；
 *  3) 滚动摘要 —— ensureFitsWindow / compactToLine / compactBatch：
 *     当上下文 token 超过阈值时，把旧消息分批压缩成摘要，写入 messageArr[1] 的“滚动摘要槽”，
 *     并把快照落盘（含连续失败熔断，防止天价账单死循环）。
 *
 *  与 runAgent 的约定：messageArr[0] 为系统提示词、messageArr[1] 为滚动摘要槽、其余为活动消息。
 */
import { appConfig } from "@/config/index.ts";
import { chatWithModelWithSummary } from "@/llm/model.ts";
import { estimateTokens, Msg, splitUntils } from "@/session/contextCore.ts";
import path from "path";
import { getRollingState, setRollingState } from "@/session/store.ts";
import { ensureOptions, RunAgentEvents } from "./type.ts";

/** ANSI / OSC 转义序列（终端着色等） */
const ANSI_ESCAPE = /\u001b\[[\d;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
/**
 * @description: 获取除主目录外，所有允许/可能被访问的代码库根目录（自愈整形版）
 * @return {string[]} 根目录列表（当前为空数组，预留扩展位）
 */
export const getFileAccessRoots = (): string[] => {
    const roots: string[] = [];
    // 工业级标准整形：确保所有加进来的外部路径格式与 userWorkspaceDir 字节级对齐
    return roots.map(r => {
        let norm = r.replace(/\\/g, '/');
        if (/^[a-z]:/i.test(norm)) {
            norm = norm.charAt(0).toUpperCase() + norm.slice(1);
        }
        return norm;
    });
}

/**
 * 将常见绝对路径替换为相对 workspace 的写法，缩短 system/tool 消息 token（optimize §3）
 * @param text 原始文本
 * @return 路径相对化后的文本；若 workspace 根解析失败则仅做 ANSI 剥离
 */
export const relativizeWorkspacePathsInText = (text: string): string => {
    if (!text) return text;
    const roots = new Set<string>();
    try {
        roots.add(path.resolve(appConfig.userWorkspaceDir));
        for (const r of getFileAccessRoots()) {
            try {
                roots.add(path.resolve(r));
            } catch {
                /* ignore */
            }
        }
    } catch {
        return text.replace(ANSI_ESCAPE, "");
    }
    let out = text;
    for (const root of roots) {
        const norm = root.replace(/\\/g, "/");
        if (norm.length < 3) continue;
        const re = new RegExp(
            norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\/|\\\\|$)",
            "gi",
        );
        out = out.replace(re, "./$1");
    }
    return out;
}

/** 剥离文本中的 ANSI / OSC 转义序列。 */
export function stripAnsi(text: string): string {
    return text.replace(ANSI_ESCAPE, "");
}
/**
 * 单条消息内容微压缩：ANSI、多余空白、HTML 注释；路径相对化
 * @param raw 原始内容
 * @return 压缩后的干净文本
 */
export function microcompactTextContent(raw: string): string {
    let s = stripAnsi(raw || "");
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    s = relativizeWorkspacePathsInText(s);
    s = s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{3,}/g, " ").trim();
    return s;
}
/**
 * @description: 工具返回消息超过最大值时，去除中间留头尾信息（自适应预算分配版）
 * @param {string} result 原始工具返回内容
 * @param {number} maxChars 最大允许字符数（选填，缺省时按 MAX_HISTORY_TOKENS 动态推算）
 * @return {string} 整形后的文本内容
 */
export const truncateToolResult = (result: string, maxChars?: number): string => {
    // 👈 核心安全修改：在函数内部动态读取总配置，如果调用者没传 maxChars，再在运行时现场推算
    const finalMaxChars = maxChars ?? Math.floor((appConfig.MAX_HISTORY_TOKENS * 0.06) * 4.5);
    const newResult = microcompactTextContent(result)
    if (!newResult || newResult.length <= finalMaxChars) return newResult;

    const half = Math.floor(finalMaxChars / 2);
    const head = newResult.slice(0, half);
    const tail = newResult.slice(-half);
    const totalLines = newResult.split("\n").length;
    const omitted = Math.max(0, totalLines - head.split("\n").length - tail.split("\n").length);

    return [head, "", `…(已省略中间约 ${omitted} 行，共 ${totalLines} 行)…`, "", tail].join("\n");
}


/**
 * @description: 审批详情（requireApproval 返回的 detail）超长时去中间、留头尾，
 *  防止上千行 old_str/new_str 全量经 SSE 推给前端导致单帧过大、渲染卡顿。
 *  与 truncateToolResult 的差异：不做 ANSI/路径微压缩（detail 是给人看的 diff，
 *  微压缩会篡改原文、干扰用户判断），仅按字符阈值头尾截断并标注折叠信息。
 * @param {string} detail 工具 requireApproval 生成的审批说明原文
 * @param {number} maxChars 最大允许字符数（默认 2000）
 * @return {string} 截断后的 detail；未超长则原样返回
 */
export const truncateApprovalDetail = (detail: string, maxChars = 2000): string => {
    if (!detail || detail.length <= maxChars) return detail;

    const half = Math.floor(maxChars / 2);
    const head = detail.slice(0, half);
    const tail = detail.slice(-half);
    const omitted = detail.length - maxChars;
    return `${head}\n\n[… 已折叠 ${omitted} 字符，完整改动请用 read_file 或核对工具参数 …]\n\n${tail}`;
}


/**
 * @description: 获取摘要
 * @param {Msg} batch // 需要形成摘要的上下文
 * @param {AbortSignal} signal // 是否停止
 * @return {*}
 */
export const compactBatch = async (batch: Msg[], signal?: AbortSignal): Promise<string> => {
    const resp = await chatWithModelWithSummary(
        [...batch, { role: 'user', content: '用一行话概括以上对话与工具调用：任务目标、关键决策、动过的文件、当前进度。不要调用工具。' }],
        [],
        { signal }
    );
    return `- ${resp.choices[0].message.content || ''}`;
}

/**
 * @description: 根据上下文的token数量，来计算是否生成摘要
 * @param {Msg} toCompact
 * @param {number} modelWindow
 * @param {AbortSignal} signal
 * @return {*}
 */
export const compactToLine = async (toCompact: Msg[], modelWindow: number, signal?: AbortSignal): Promise<string> => {
    const MAX_BATCH_TOKENS = Math.floor(modelWindow * 0.25);
    const lines: string[] = [];
    let batch: Msg[] = []; // 需要压缩的上下文
    let batchTokens = 0;
    for (const msg of toCompact) {
        const size = estimateTokens([msg]) // 获取token数量
        if (batchTokens + size > MAX_BATCH_TOKENS && batch.length > 0) {
            lines.push(await compactBatch(batch, signal)); // 生成本次区间的摘要
            batch = [];
            batchTokens = 0;
        }
        batch.push(msg);
        batchTokens += size;
    }
    if (batch.length > 0) lines.push(await compactBatch(batch, signal));
    return lines.join("\n"); // 返回最后的摘要信息
}
/**
 * @description: 预留系统提示词和摘要区域
 *  约定：messageArr[0] = 系统提示词、messageArr[1] = 滚动摘要槽。
 *  若对应位置不是 system 消息，则原地插入占位，保证后续压缩逻辑的下标稳定。
 * @param {Msg} messageArr
 * @return {*}
 */
export const ensureSummarySlot = (messageArr: Msg[]): void => {
    if (messageArr.length === 0 || (messageArr[0] as any)?.role !== 'system') {
        messageArr.unshift({ role: 'system', content: 'SYSTEM_META_CONTEXT_START' } as any); // 向上下文中添加系统提示词
    }
    if (messageArr.length < 2 || (messageArr[1] as any)?.role !== 'system') {
        messageArr.splice(1, 0, { role: 'system', content: 'SYSTEM_ROLLING_SUMMARY_SLOT' } as any);
    }
}

/**
 * @description: 压缩全量上下文
 *  当 token 超过 modelWindow * compactRatio 时，循环把“可压缩区”分批压成摘要，
 *  写入 messageArr[1] 的滚动摘要槽，仅保留最近 keepRecentUnits 条活动消息。
 *  每轮压缩后落盘（rollingSummary 快照）；连续失败 3 次触发物理熔断，保护账单。
 * @param {ensureOptions} event // 含全量上下文、阈值与回调的压缩入参（messageArr 原地修改）
 * @return {*}
 */
export const ensureFitsWindow = async (event: ensureOptions): Promise<void> => {
    if (estimateTokens(event.messageArr) <= event.modelWindow * event.compactRatio) return;
    const systemMsg = event.messageArr[0]; // 获取系统提示词
    const summaryMsg: any = event.messageArr[1]; // 获取摘要信息
    let keep = event.keepRecentUnits;
    let lastSize = estimateTokens(event.messageArr); // 获取当前上下文token总量
    const startTime = performance.now();
    let round = 0
    while (estimateTokens(event.messageArr) > event.modelWindow * event.compactRatio) {
        if (event.signal?.aborted) {
            return
        }; // 是否停止
        const active = event.messageArr.slice(2); // 截取系统提示词和摘要
        const { toCompact, keepRecent } = splitUntils(active, keep);   // ← 用共享的 splitUnits
        try {
            if (toCompact.length > 0) {
                const line = await compactToLine(toCompact, event.modelWindow, event.signal); // 获取全量的摘要
                const old: string = summaryMsg?.content || ''; // 旧的消息摘要
                summaryMsg.content = old ? `${old}\n${line}` : line; // 拼接新的消息摘要
                const endTime = performance.now();

                event.messageArr.length = 0;
                event.messageArr.push(systemMsg, summaryMsg, ...keepRecent); // 重构整个上下文
                event.events({
                    sessionId: event.sessionId,
                    eventType: 'session.summary',
                    meteData: {
                        depth: event.depth,
                        decisionSource: 'summary',
                        ok: true,
                        durationMs: endTime - startTime,
                        round: round++
                    },
                    usage: {
                        prompt_tokens: lastSize,
                        compress_tokens: estimateTokens(event.messageArr),
                    }
                })
                // 【核心大厂级落盘动作】：强行把这个最新滚好的快照，作为一个新节点，写入本地数据库/JSONL中
                // 注意：此时我们要捕获这批被压缩的废料中，最后一条消息的真实持久化唯一 ID (如 uuid)
                const store = await getRollingState(`${event.sessionId}__rollingSummary`);
                store.archivedMessageCount = (store.archivedMessageCount || 0) + toCompact.length;
                await setRollingState(`${event.sessionId}__rollingSummary`, {
                    archivedMessageCount: store.archivedMessageCount,
                    rollingSummary: summaryMsg.content,
                    consecutiveFailures: 0,
                    updatedAt: new Date().toISOString()
                })
            } else if (keep > 1) { // 如果保留的条数还是大于最大token，则继续减少保留数据
                keep--;
                continue;
            } else if (summaryMsg?.content) { // 如果只剩下摘要信息还是大于最大值token，那么继续使用摘要生成摘要
                summaryMsg.content = await compactToLine([summaryMsg], event.modelWindow, event.signal);
                event.messageArr.length = 0;
                event.messageArr.push(systemMsg, summaryMsg, ...keepRecent);
                const store = await getRollingState(`${event.sessionId}__rollingSummary`);
                store.archivedMessageCount = (store.archivedMessageCount || 0) + toCompact.length;
                await setRollingState(`${event.sessionId}__rollingSummary`, {
                    archivedMessageCount: store.archivedMessageCount,
                    rollingSummary: summaryMsg.content,
                    consecutiveFailures: 0,
                    updatedAt: new Date().toISOString()
                })
            } else {
                break
            }

        } catch (error) {
            if (event.signal?.aborted) return;
            const err = error instanceof Error ? error : new Error(String(error));
            console.warn('⚠️ 本轮压缩失败，跳过:', err.message);
            // ==================== 🛠️ 核心熔断安全升级区 ====================
            // 1. 去硬盘里捞出上一次的状态
            const store = await getRollingState(`${event.sessionId}__rollingSummary`);
            // 2. 失败计数默默加 1
            const nextFailures = (store.consecutiveFailures || 0) + 1;
            // 3. 一脚强行回写落盘，锁死连续失败的物理记忆
            await setRollingState(`${event.sessionId}__rollingSummary`, {
                archivedMessageCount: store.archivedMessageCount || 0,
                rollingSummary: summaryMsg?.content || "",
                consecutiveFailures: nextFailures // 👈 同步落盘
            });
            const endTime = performance.now();
            event.events({
                sessionId: event.sessionId,
                parentId: event.depth > 0 ? event.sessionId : '',
                eventType: 'session.summary',
                meteData: {
                    depth: event.depth,
                    messageId: summaryMsg.id,
                    decisionSource: 'summary',
                    ok: false,
                    durationMs: endTime - startTime,
                    attempt: nextFailures
                },
                usage: {
                    prompt_tokens: lastSize,
                    compress_tokens: estimateTokens(event.messageArr),
                },
                payload: {
                    output: err.message,
                }
            })
            // 4. 【终极物理断流闸门】：触线报警，保护钱包！
            if (nextFailures >= 3) {
                throw new Error(`❌ [物理熔断] 上下文压缩已连续遭遇 ${nextFailures} 次失败。为防止天价账单死循环，系统已强行拦截。请排查网络或大模型提供商是否崩溃。`);
            }
            // =============================================================
            break;
        }
        const newSize = estimateTokens(event.messageArr);
        if (newSize >= lastSize) break;
        lastSize = newSize;
    }

    if (estimateTokens(event.messageArr) > event.modelWindow * 0.9) {
        throw new Error(`上下文超出模型窗口上限（估算约 ${estimateTokens(event.messageArr)} / ${event.modelWindow} token），即使全量压缩仍无法容纳。任务过大，请拆分任务、减小单次读取量，或增大 modelWindow。`);
    }
}

/** 类型守卫：判断工具返回值是否为异步生成器（流式工具）。 */
function isAsyncGenerator(x: any): x is AsyncGenerator<string> {
    return x != null && typeof x[Symbol.asyncIterator] === 'function';
}

/**
 * 归一化工具执行结果：工具可返回 Promise<string> 或 AsyncGenerator<string>（流式）。
 *  对流式结果逐块拼接（可选回调 onChunk 实时透出），对非字符串结果 JSON.stringify。
 * @param ret 工具返回值
 * @param onChunk 流式分块回调（可选）
 * @return 归一化后的字符串结果
 */
export const collectToolResult = async (
    ret: Promise<string> | AsyncGenerator<string>,
    onChunk?: (s: string) => void,
): Promise<string> => {
    if (isAsyncGenerator(ret)) {
        let full = '';
        for await (const chunk of ret) { full += chunk; onChunk?.(chunk); }
        return full;
    }
    const v = await ret;
    return typeof v === 'string' ? v : JSON.stringify(v);
}
