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
import { cleanMsg, estimateTokens, groupUnits, Msg } from "./contextCore.ts";
import { readMessages } from "./transcript.ts";
import { getRollingState } from "./store.ts";
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
    result.push(...messageAll)
    result.push(currentUserMsg);
    return result;
}