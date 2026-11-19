/**
 * @file tool/provenance.ts
 * @description P0-A provenance 追踪（评审修复批 2026-11-19）：记录「本回合是否消费过外部内容」。
 *
 *  外部内容 = 声明 externalContent 的工具的【成功输出】（web_fetch / web_search / run_command /
 *  run_in_background——网页、搜索结果、命令 stdout，均可能携带不可信的提示词注入文本）。
 *
 *  威胁模型（评审 §P0-A）：被注入的工具结果可诱导模型把外部文本经 memory_save 写进跨会话记忆，
 *  写入内容将进入之后所有会话的系统提示词（跨会话持久提示词注入）。provenance 命中后：
 *    - memory_save project 源 → 硬拒（随 git 扩散给所有克隆者，绝不允许外部来源触发）；
 *    - memory_save global 源 → 降权待确认（既有 allow 规则本次失效，强制人工过目一次）。
 *  消费方：toolExecution.runSecurityGates（provenanceGate 门）+ memory_save.execute（第二道硬拒）。
 *
 *  粒度：session 级、主 run（一次用户输入的回合）生命周期——runAgent 主 run（depth=0）启动时
 *  reset；本回合内任何工具（含并行子代理，与主 run 共享 sessionId）命中即 mark。宽松方向安全
 *  （宁多确认一次、不漏一次）；跨回合不外溢——下一回合主 run 启动即归零。
 */
const markedSessions = new Set<string>();

/** 清空某会话的外部内容标记（runAgent 主 run 启动时调用；子 run depth>0 不清——它们共享父回合）。 */
export const resetExternalContent = (sessionId: string): void => {
    if (sessionId) markedSessions.delete(sessionId);
};

/** 标记某会话本回合已消费外部内容（externalContent 声明工具成功执行后由执行层调用）。 */
export const markExternalContent = (sessionId: string): void => {
    if (sessionId) markedSessions.add(sessionId);
};

/** 查询某会话本回合是否消费过外部内容（provenanceGate 门与 memory_save 硬拒的判定源）。 */
export const hasExternalContent = (sessionId?: string): boolean =>
    !!sessionId && markedSessions.has(sessionId);
