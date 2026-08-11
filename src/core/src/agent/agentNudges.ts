/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-08-10 00:00:00
 * @FilePath: \deepSeekCode\src\core\src\agent\agentNudges.ts
 * @Description: agent 主循环的 ephemeral nudge 调度器 —— 四类「机制性提示」文案 + 触发/预算/调度集中于此，
 *   runAgent 主循环只保留薄调用（pickNudge / interceptFinal / noteToolCall），控制流与提示词解耦。
 *
 *   四类 nudge 均走 ephemeral 尾部副本（推理时附加，不进 message 数组/transcript/压缩 → 保 message[0] 前缀稳定，
 *   DeepSeek 隐式缓存跨轮命中）：
 *   - PLAN_FIRST：首轮规划引导——顶层非计划模式下，用户首条 prompt 疑似非平凡实现任务时，引导先调 enter_plan_mode 规划（仅首轮一次）。
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
const TOOL_DIGEST_FENCE = "⟦DSC:TOOL_DIGEST⟧";
const TOOL_DIGEST_MAX = 2;               // 「工具消化收尾」守护：刚执行完工具就草草收尾时最多推 2 次
const TOOL_DIGEST_WINDOW = 2;            // 距上次工具调用 ≤ 此轮数才视为「工具消化期内」
const TOOL_DIGEST_TEXT_MAX_LEN = 30;     // ★ 只拦「空手收尾」：finalText 去空白后短于此才视为没给实质回应；长总结绝不拦（防「连续 final、中间无 user」）
const PLAN_FIRST_FENCE = "⟦DSC:PLAN_FIRST⟧";

// —— 文案（集中于此，调措辞不动控制流）——
const PHANTOM_TEXT = "你的上一条回复没有任何内容、也没有调用任何工具，但任务尚未完成。请继续推进（调用工具或给出实质回答）；若确实受阻、需要用户决策，用 ask_question 说明具体阻塞点。不要返回空回复。";
const EARLY_FINAL_TEXT = (round: number): string =>
    `你仅进行了 ${round} 轮工具调用就准备收尾，且回答中没有明确的完成声明。请严格自检：用户的每一个子目标是否都已真正落地（所需信息已获取 / 该改的文件已改完 / 已验证通过）？若确实全部完成，请明确回复"已完成"并简述成果；若还有任何未落地的子目标，立即继续调用工具推进，不要用自然语言草率总结收尾。`;
const TOOL_DIGEST_TEXT = "你刚执行完工具拿到结果，却未基于该结果给出实质回应就准备收尾。请结合工具返回结果继续推进；若结果表明任务尚未完成（如仍在编译/运行、需继续轮询），立即采取下一步行动，不要空手收尾。若确已全部完成，请明确回复「已完成」并简述成果。";
const NUDGE_TEXT = (round: number): string =>
    `你已执行约 ${round} 轮工具调用。请自评：若任务已可完成，立即给出最终答案、不再调用工具；若确需更多步骤，继续，但确保每步都在实质推进任务、不重复检索。`;

// —— 首轮 PLAN_FIRST 启发式（判断用户首条 prompt 是否疑似非平凡实现任务）——
const COMPLEX_VERBS = /实现|新增|添加|重构|改造|迁移|重写|拆分|升级|开发|编写|构建|集成|支持|完善/;
const COMPLEX_OBJECTS = /功能|模块|系统|架构|流程|机制|组件|服务|页面|接口|能力|特性|面板/;
const COMPLEX_MARKERS = /多个文件|多文件|整体|全套|端到端|从零|重新设计|一整套|跨[^，。\s]{1,6}/;
const QUERY_LEAD = /^(请)?\s*(解释|说明|查(一下|询)?|搜索|搜一下|怎么看|如何(用|使用|配置|启动)|怎么用|为什么|是什么|帮我看看|分析一下|检查|review|对比|评价)/i;
/** 首条 prompt 疑似非平凡实现任务 → 命中即在首轮注入「先规划」nudge（仅引导，模型可自决；误判代价低）。 */
const looksComplex = (text: string): boolean => {
    const t = (text || "").trim();
    if (t.length < 20) return false;            // 太短，多半是简单指令
    if (QUERY_LEAD.test(t)) return false;        // 以查询/解释开头，多半是问答而非实现
    if (COMPLEX_MARKERS.test(t)) return true;    // 显式多文件/整体/从零 → 非平凡
    return COMPLEX_VERBS.test(t) && COMPLEX_OBJECTS.test(t); // 动词 + 对象共现（如"实现登录功能"）
};
const PLAN_FIRST_TEXT = `系统判断你本次任务疑似「非平凡实现任务」（涉及多文件改动 / 架构决策 / 不确定路径 / 多步骤）。建议你**先调用 enter_plan_mode 进入计划模式**：以只读方式调研现状与改造点，再用 exit_plan_mode 提交完整实现方案（要改哪些文件、怎么改、为何这么做、有何风险），经用户审批后再动手实现——避免方向跑偏与返工。若你判断任务其实简单（单文件、明确小调整），可直接动手实现，无需进入计划模式。`;

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
export const createNudgeScheduler = (opts: { firstPrompt?: string; planMode?: boolean } = {}): {
    pickNudge: (round: number) => NudgeMsg | null;
    interceptFinal: (finalText: string, round: number) => boolean;
    noteToolCall: (round: number) => void;
} => {
    const firstPrompt = opts.firstPrompt ?? "";
    const planMode = !!opts.planMode;
    let phantomRetries = 0;
    let phantomPending: NudgeMsg | null = null;
    let earlyFinalNudges = 0;
    let earlyFinalPending: NudgeMsg | null = null;
    let toolDigestNudges = 0;
    let toolDigestPending: NudgeMsg | null = null;
    let lastToolCallRound = 0;
    let planFirstSent = false;

    return {
        pickNudge(round) {
            // 最高优先级：首轮对疑似非平凡实现任务引导「先规划」（仅一次，仅非计划模式）
            if (!planFirstSent && round === 1 && !planMode && looksComplex(firstPrompt)) {
                planFirstSent = true;
                return { role: 'system', content: `${PLAN_FIRST_FENCE}\n${PLAN_FIRST_TEXT}` };
            }
            // 优先级：tool_digest（工具消化收尾）> phantom（空回复）> early_final（早收尾）> 周期 nudge；前三者一次性消费
            if (toolDigestPending) { const m = toolDigestPending; toolDigestPending = null; return m; }
            if (phantomPending) { const m = phantomPending; phantomPending = null; return m; }
            if (earlyFinalPending) { const m = earlyFinalPending; earlyFinalPending = null; return m; }
            if (round > 1 && round % NUDGE_EVERY === 1) {
                return { role: 'system', content: `${NUDGE_FENCE}\n${NUDGE_TEXT(round)}` };
            }
            return null;
        },
        interceptFinal(finalText, round) {
            const text = (finalText || "").trim();
            // TOOL_DIGEST：刚执行完工具（消化期内）却「空手收尾」——finalText 空/极短且无完成声明。
            //   ★ 必须限长（< TOOL_DIGEST_TEXT_MAX_LEN）：只拦「拿到结果一句话不说/只蹦几个字就走」，
            //   绝不能拦「实质总结」。否则总结轮被 continue，每轮正文各落一条 assistant 消息 →
            //   出现「连续多个 final、中间无 user」的"没有结尾"症状（2026-08-11 复现于长轮询会话：
            //   looksComplete 漏判"已简化完成/都已就位/核对完毕"等合法收尾，误拦后连发 2~3 个总结）。
            //   looksComplete 关键词太窄不可靠，故以「文本长度」为准判定是否给了实质回应。
            if (lastToolCallRound > 0 && round - lastToolCallRound <= TOOL_DIGEST_WINDOW
                && toolDigestNudges < TOOL_DIGEST_MAX
                && text.length < TOOL_DIGEST_TEXT_MAX_LEN && !looksComplete(finalText)) {
                toolDigestNudges++;
                toolDigestPending = { role: 'system', content: `${TOOL_DIGEST_FENCE}\n${TOOL_DIGEST_TEXT}` };
                return true;
            }
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
        noteToolCall(round) {
            // 有 tool_calls = 实质推进 → 重置空响应预算（只计连续空包）+ 工具消化预算（下次消化又给新鲜预算）
            //   + 记录本轮号供 TOOL_DIGEST 判定「消化期内」
            phantomRetries = 0;
            toolDigestNudges = 0;
            lastToolCallRound = round;
        },
    };
};
