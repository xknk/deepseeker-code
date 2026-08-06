/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-16 14:32:11
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-17 14:15:57
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\session\content.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file session/content.ts
 * @description 跨会话构建发给模型的上下文视图 buildContextMessages：
 *  从转录读取历史 → 跳过已归档条数 → 拼接 [system, 摘要槽, ...active, 本次user]。
 *  布局与 runAgent.ensureSummarySlot 保持一致；须在 appendMessage(本次user) 之前调用。
 */
import { cleanMsg, Msg } from "./contextCore.ts";
import { readMessages } from "./transcript.ts";
import { getRollingState } from "./store.ts";
/**
 * 修复孤儿 tool_call：assistant 的 tool_calls 必须每条都有紧随的 tool 结果消息，否则 API 返回 400
 * （"messages must contain tool responses"）。会话被中途杀掉（assistant 已 appendMessage 落盘、
 * tool 结果未落盘）时，重建的上下文会出现孤儿 tool_call_id，导致续接/恢复后每次对话都 400。
 * 此处为缺失项补占位 tool 结果，使被中断的会话仍可续接。
 */
const repairOrphanToolCalls = (msgs: Msg[]): Msg[] => {
    const out: Msg[] = [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i] as any;
        out.push(m);
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            // 收集紧跟其后的 tool 结果已应答的 tool_call_id
            const answered = new Set<string>();
            let j = i + 1;
            while (j < msgs.length && (msgs[j] as any).role === 'tool') {
                answered.add((msgs[j] as any).tool_call_id);
                j++;
            }
            // 为未应答的 tool_call 补占位（插在已有 tool 结果之后、下一非 tool 消息之前）
            for (const tc of m.tool_calls) {
                if (tc.id && !answered.has(tc.id)) {
                    out.push({ role: 'tool', tool_call_id: tc.id, content: '（该工具调用因上次会话异常中断未留下结果，已跳过。）' } as Msg);
                }
            }
        }
    }
    return out;
}
/**
 * 跨会话构建发给模型的上下文视图：
 * - 输出布局 [system, 摘要槽, ...active, user]，与 runAgent.ensureSummarySlot 一致
 * 必须在 appendMessage(本次user) 之前调用，否则本次 user 被重复读入。
 */
export const buildContextMessages = async (sessionId: string, currentUserMsg: Msg, systemPrompt: string) => {
    const all = (await readMessages(sessionId)).map(cleanMsg) //获取当前对话所有消息
    const store = await getRollingState(sessionId);
    const result: Msg[] = [
        { role: 'system', content: systemPrompt }, // 存储系统提示词
        { role: 'system', content: store.rollingSummary }, // 后续存储摘要使用
    ] // 压缩后最终消息组
    const archivedMessageCount = store.archivedMessageCount
    const messageAll = all.slice(archivedMessageCount)
    if (messageAll.length === 0) {
        result.push(currentUserMsg)
        return result
    }
    // ★ 修复孤儿 tool_call（会话被中断后恢复时，assistant 的 tool_calls 可能缺配对 tool 结果 → API 400）
    result.push(...repairOrphanToolCalls(messageAll))
    result.push(currentUserMsg);
    return result;
}