/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-16 14:32:11
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-17 14:15:57
 * @FilePath: d:\code\自研\deepSeekCode\src\core\src\session\content.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koroFileHeader/wiki/%E9%85%8D%E7%BD%AE%E8%AE%BE%E7%BD%AE
 */
/**
 * @file session/content.ts
 * @description ★ 唯一跨 run LLM 上下文派生函数 buildContextMessages（正式化契约，事件日志化改造）：
 *  从 transcript 读取历史（消息行，事件行过滤）→ 恢复层（recovery.ts）诊断中断/校验压缩 →
 *  跳过已归档条数 → 修复孤儿 tool_call → 衰减旧 tool 结果 → 拼接 [system, 摘要槽, ...active, 本次user]。
 *  布局与 runAgent.ensureSummarySlot 保持一致。
 *
 *  契约（调用方必须遵守）：
 *  1. 必须在 appendMessage(本次user) 之前调用，否则本次 user 被重复读入；
 *  2. 全仓跨 run 的「transcript → LLM messages」派生只允许走本函数（现调用方：serve/chatProcessing、
 *     agent/subagent 子会话）；UI 回放（cli/replay、vscode/host）是另一类消费（渲染行，不进 LLM）；
 *  3. 函数内允许一次有界写（recoverSession 给崩溃 run 补 run.abandoned 闭墓标记），禁止改写既有行
 *     （transcript 永远 append-only）。
 */
import { cleanMsg, groupUnits, Msg } from "./contextCore.ts";
import { readTranscriptLines, isEventLine } from "./transcript.ts";
import { getRollingState } from "./store.ts";
import { appConfig } from "@/config/index.ts";
import { recoverSession, repairOrphanToolCalls, RecoveryReport } from "./recovery.ts";
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
    const lines = await readTranscriptLines(sessionId);
    const store = await getRollingState(sessionId);
    // ★ 恢复层接线（事件日志化）：开关开（或既存文件已含事件行——中途关开关的会话仍按事件恢复）→
    //   事件确认档（recoverSession 含 run.abandoned 幂等补写 = 契约允许的一次有界写）；
    //   开关关且无事件行 → 纯内存启发式（= 改造前行为，零碰盘副作用）。
    const eventAware = appConfig.transcriptEvents || lines.some(isEventLine);
    const recovery: Pick<RecoveryReport, 'interruption' | 'compaction'> = eventAware
        ? await recoverSession(sessionId)
        : {
            interruption: { kind: 'legacy' },
            compaction: { archivedMessageCount: store.archivedMessageCount, rollingSummary: store.rollingSummary, desync: 'legacy' },
        };
    const all = lines.filter((l) => !isEventLine(l)).map(cleanMsg); // 事件行不进 LLM 上下文
    const result: Msg[] = [
        { role: 'system', content: systemPrompt }, // 存储系统提示词
        { role: 'system', content: recovery.compaction.rollingSummary }, // 后续存储摘要使用
    ] // 压缩后最终消息组
    const archivedMessageCount = recovery.compaction.archivedMessageCount // reconcile 裁决后仍以 state 为准（slice 执行闸门）
    const messageAll = all.slice(archivedMessageCount)
    if (messageAll.length === 0) {
        result.push(currentUserMsg)
        return result
    }
    // ★ 先 slice 后 repair（顺序不可换）：孤儿占位行会插入消息流，若先修后切会移位归档计数基准。
    //   confirmedCrash 由事件判定升级档位：崩溃确认 → 占位文案精确；legacy/闭合 → 与改造前文案一致。
    //   repair 后再入 decayOldToolResults 衰减（assistant 文本/方案不衰减，仅旧 tool content 截断）。
    const repair = repairOrphanToolCalls(messageAll, recovery.interruption.kind === 'crashed')
    result.push(...decayOldToolResults(repair.msgs))
    result.push(currentUserMsg);
    return result;
}
