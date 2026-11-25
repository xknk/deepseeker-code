/**
 * @file vscode/src/webview/replayPlan.js
 * @description 回放规划（纯函数，零依赖——不碰 DOM、不 import state.js，裸 node 可直接 import 做回归）。
 *
 *  历史回放「尾段先渲染」的对标 Claude Code 行为（2026-11-25）：进面板/切会话直接显示最新内容并落底，
 *  更早的行留在待挂载队列（backlog），用户往上滚才分批补挂。此前整段历史逐行入 DOM、每行落一次底，
 *  浏览器在消息任务的间隙照样出帧——长会话肉眼可见「从头滚到底」（实测 612 行会话 1.1 秒 10 个中间帧）。
 *
 *  规划分两步：
 *   1) layoutTurns：按序编轮——user 行前插轮次折叠头、每行贴 turn 序号。轮次号必须离线一次算定
 *      （不能沿用 appendRow 的「入栈时递增」）：尾段先渲染时首轮号就得是真实值，否则补挂更早的轮后号会倒挂。
 *   2) tailStart：定尾段切点——从末尾按【整轮】累加到 target 行为止（切在轮边界，顶部不出现缺提问的半截回复）；
 *      最后一轮单独就超 target 时：整轮不超过 max 则整段保留，否则在轮内按 max 硬顶截断。
 */

/** 轮次折叠头判定（rows.js buildRowEl 的 row.kind 同名字面量）。 */
const isTurnHeader = (row) => row.kind === "turnHeader";

/**
 * 按序编轮并返回尾段切点。
 * @param rows 回放行（host emitReplay 产物，已按对话顺序；会被就地写 turn 字段）
 * @param opts.nextKey 折叠头 key 发放器；opts.summarize 提问摘要（与实时轮头同款截断）
 * @param opts.target 尾段行数目标（软）；opts.max 单轮硬顶
 * @returns {{ ordered: object[], turns: number, start: number }}
 *   ordered=插好折叠头的完整行序；turns=总轮数；start=尾段在 ordered 中的起始下标（之前的是 backlog）
 */
export const planReplay = (rows, { nextKey, summarize, target = 120, max = 400 }) => {
  const ordered = [];
  let seq = 0;
  for (const row of rows) {
    if (row.kind === "user") {
      seq += 1;
      ordered.push({ key: nextKey(), kind: "turnHeader", seq, turn: seq, summary: summarize(row.text || "", 50), collapsed: false });
    }
    row.turn = seq;
    ordered.push(row);
  }
  return { ordered, turns: seq, start: tailStart(ordered, target, max) };
};

/** 尾段切点下标：见文件头第 2 步。n ≤ target 时整段都是尾段（start=0）。 */
export const tailStart = (ordered, target, max) => {
  const n = ordered.length;
  if (n <= target) return 0;
  let start = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isTurnHeader(ordered[i])) continue;
    if (n - i <= target) start = i; // 整轮纳入，继续看更早的轮
    else break; // 再往前一整轮就超目标：停
  }
  if (start < 0) {
    // 最后一轮单独就超 target：≤ max 整轮保留，否则在轮内按 max 截断（顶部是半截轮，backlog 补挂后自然接上）
    const lastHeader = ordered.findLastIndex(isTurnHeader);
    // 无任何轮头（全程 info/system 散行）：n - max 可能为负，直接夹到 0，不留负下标靠下方 findIndex 兜底
    start = lastHeader < 0
      ? Math.max(0, n - max)
      : n - lastHeader <= max ? lastHeader : Math.max(lastHeader, n - max);
  }
  // 切点落在首个轮头：它之前是没有归属轮的散行（系统行等），没有「按轮加载」可言，并入尾段
  if (ordered.findIndex(isTurnHeader) >= start) start = 0;
  return start;
};
