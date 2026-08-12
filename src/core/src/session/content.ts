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
import { cleanMsg, groupUnits, Msg } from "./contextCore.ts";
import { readMessages } from "./transcript.ts";
import { getRollingState } from "./store.ts";
import { appConfig } from "@/config/index.ts";
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
 * ★ 跨 run 历史工具结果衰减：保留最近 KEEP_RECENT_UNITS 个对话单元的 tool 结果全文，更早的（跨 run 旧 tool）
 *  content 截断到 BOUNDARY_TOOL_KEEP_CHARS + 折叠提示。旧 tool 的结论早已被后续 assistant 消化进文本/方案，
 *  原文无需跨 run 完整保留——砍掉跨 run 重复背负的只读检索体积（grep/read 输出），零 LLM 开销、不破坏配对。
 *  按对话单元边界切分，永不切断 tool_calls↔tool 配对；仅衰减 tool content 长度，assistant 文本/方案不动。
 *  只作用于重建的内存视图，不改写 transcript。
 */
const decayOldToolResults = (msgs: Msg[]): Msg[] => {
    const units = groupUnits(msgs); // assistant(tool_calls)+紧跟 tool = 不可分割单元
    const cutoffUnitIdx = Math.max(0, units.length - appConfig.KEEP_RECENT_UNITS);
    if (cutoffUnitIdx === 0) return msgs; // 全部落在保留区，无需衰减
    // 标记「保留区之前」单元里的 tool_call_id（按单元边界，配对完整）
    const decayIds = new Set<string>();
    for (let u = 0; u < cutoffUnitIdx; u++) {
        for (const m of units[u]) {
            const mm = m as any;
            if (mm.role === 'tool' && typeof mm.tool_call_id === 'string') decayIds.add(mm.tool_call_id);
        }
    }
    if (decayIds.size === 0) return msgs;
    const keep = appConfig.BOUNDARY_TOOL_KEEP_CHARS;
    return msgs.map((m) => {
        const mm = m as any;
        if (mm.role === 'tool' && decayIds.has(mm.tool_call_id) && typeof mm.content === 'string' && mm.content.length > keep) {
            const head = mm.content.slice(0, keep);
            return { ...mm, content: `${head}\n\n[… 该历史工具输出已折叠（共 ${mm.content.length} 字符），如需细节请重新调用工具 …]` } as Msg;
        }
        return m;
    });
};
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
    // ★ 跨 run tool 结果衰减：repair orphan 后、入上下文前，对「保留区之前」的旧 tool 结果截断，
    //   砍掉跨 run 重复背负的检索体积。assistant 文本/方案不衰减（结论需保留），仅衰减 tool content 长度。
    result.push(...decayOldToolResults(repairOrphanToolCalls(messageAll)))
    result.push(currentUserMsg);
    return result;
}