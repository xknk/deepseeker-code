/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-08-10 00:00:00
 * @FilePath: \deepSeekCode\src\core\src\agent\agentNudges.ts
 * @Description: agent 主循环的 ephemeral nudge 调度器 —— 三类「机制性提示」文案 + 触发/预算/调度集中于此，
 *   runAgent 主循环只保留薄调用（pickNudge / interceptFinal / noteToolCall），控制流与提示词解耦。
 *
 *   三类 nudge 均走 ephemeral 尾部副本（推理时附加，不进 message 数组/transcript/压缩 → 保 message[0] 前缀稳定，
 *   DeepSeek 隐式缓存跨轮命中）：
 *   - PHANTOM：空 content 守护（空包/纯崩溃）——既无实质文本又无 tool_calls 时注入重试（上限 PHANTOM_RETRY_MAX）。
 *   - EARLY_FINAL：早收尾守护——有实质文本、但轮次极少且无明确完成声明时推一轮让其自检（上限 EARLY_FINAL_MAX）。
 *   - NUDGE：长任务周期自评——每 NUDGE_EVERY 轮提醒模型自决收尾（对标 CC：靠模型自收敛 + 用户中止，不硬停）。
 *
 *   死循环保险：EARLY_FINAL 预算全局计次、不随工具调用重置，推满上限后无论如何收尾都放行；PHANTOM 只计连续空包，
 *   有 tool_calls 即重置。两者互斥（空 content 走 PHANTOM，非空走 EARLY_FINAL）。
 */

/** ephemeral nudge 消息（role=system，作为推理时尾部副本追加，不落盘）。 */
export type NudgeMsg = { role: 'system'; content: string };

// —— 阈值 / fence ——
const NUDGE_EVERY = 40;                  // 每 N 轮注入一次周期自评
const NUDGE_FENCE = "⟦DSC:NUDGE⟧";
const PHANTOM_FENCE = "⟦DSC:PHANTOM⟧";
const PHANTOM_RETRY_MAX = 2;             // 空响应最多重试次数
const EARLY_FINAL_FENCE = "⟦DSC:EARLY_FINAL⟧";
const EARLY_FINAL_TURN_THRESHOLD = 2;    // round ≤ 此值且无完成声明 → 视为过早收尾
const EARLY_FINAL_MAX = 1;               // 整个 run 最多推 1 次（硬死循环保险）

// —— 文案（集中于此，调措辞不动控制流）——
const PHANTOM_TEXT = "你的上一条回复没有任何内容、也没有调用任何工具，但任务尚未完成。请继续推进（调用工具或给出实质回答）；若确实受阻、需要用户决策，用 ask_question 说明具体阻塞点。不要返回空回复。";
const EARLY_FINAL_TEXT = (round: number): string =>
    `你仅进行了 ${round} 轮工具调用就准备收尾，且回答中没有明确的完成声明。请严格自检：用户的每一个子目标是否都已真正落地（所需信息已获取 / 该改的文件已改完 / 已验证通过）？若确实全部完成，请明确回复"已完成"并简述成果；若还有任何未落地的子目标，立即继续调用工具推进，不要用自然语言草率总结收尾。`;
const NUDGE_TEXT = (round: number): string =>
    `你已执行约 ${round} 轮工具调用。请自评：若任务已可完成，立即给出最终答案、不再调用工具；若确需更多步骤，继续，但确保每步都在实质推进任务、不重复检索。`;

/** finalText 含明确「完成/收尾」声明 → 视为真完成（命中即不推 EARLY_FINAL，放行收尾）。 */
const looksComplete = (text: string): boolean =>
    /已完成|已修改|已创建|已删除|已重构|已实现|已修复|已替换|已更新|已配置|已验证|已提交|已全部|全部完成|改造完成|修改完成|实现完成|测试通过|总结(一下)?|以上就是|done|finished|completed/i.test(text || "");

/**
 * 创建一个 nudge 调度器（持有跨轮可变状态）。runAgent 每次 run 创建一个实例。
 *
 * 三方法对应主循环三个决策点：
 * - pickNudge(round)：每轮推理前调用，返回本轮要注入的尾部 nudge（消费上轮设的 pending，或周期触发），无则 null。
 * - interceptFinal(finalText, round)：收尾分支（无 tool_calls）调用；返回 true 表示已注入 nudge、应 continue 推进，
 *   false 表示放行真实收尾（主循环 yield final）。
 * - noteToolCall()：本轮有 tool_calls（实质推进）时调用，重置空响应预算。
 */
export const createNudgeScheduler = (): {
    pickNudge: (round: number) => NudgeMsg | null;
    interceptFinal: (finalText: string, round: number) => boolean;
    noteToolCall: () => void;
} => {
    let phantomRetries = 0;
    let phantomPending: NudgeMsg | null = null;
    let earlyFinalNudges = 0;
    let earlyFinalPending: NudgeMsg | null = null;

    return {
        pickNudge(round) {
            // 优先级：phantom（空回复）> early_final（早收尾）> 周期 nudge；前两者一次性消费
            if (phantomPending) { const m = phantomPending; phantomPending = null; return m; }
            if (earlyFinalPending) { const m = earlyFinalPending; earlyFinalPending = null; return m; }
            if (round > 1 && round % NUDGE_EVERY === 1) {
                return { role: 'system', content: `${NUDGE_FENCE}\n${NUDGE_TEXT(round)}` };
            }
            return null;
        },
        interceptFinal(finalText, round) {
            const text = (finalText || "").trim();
            // PHANTOM：空 content（空包/纯崩溃）
            if (text === "" && phantomRetries < PHANTOM_RETRY_MAX) {
                phantomRetries++;
                phantomPending = { role: 'system', content: `${PHANTOM_FENCE}\n${PHANTOM_TEXT}` };
                return true;
            }
            // EARLY_FINAL：有 content 但轮次极少且无完成声明（疑似拿部分结果草率收尾）
            if (text !== "" && round <= EARLY_FINAL_TURN_THRESHOLD
                && earlyFinalNudges < EARLY_FINAL_MAX && !looksComplete(finalText)) {
                earlyFinalNudges++;
                earlyFinalPending = { role: 'system', content: `${EARLY_FINAL_FENCE}\n${EARLY_FINAL_TEXT(round)}` };
                return true;
            }
            return false;
        },
        noteToolCall() {
            // 有 tool_calls = 实质推进 → 重置空响应预算（只计连续空包，避免长任务被误熔断）
            phantomRetries = 0;
        },
    };
};
