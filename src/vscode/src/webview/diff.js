/**
 * @file vscode/src/webview/diff.js
 * @description 文件修改类工具的 diff 视图 + 全屏放大 overlay（从 app.js 拆出，2026-09-16 防腐化拆分）。
 *  ★ 纯 UI 层从 args 计算（edit_file 的 old_str/new_str），不依赖 git、不进工具结果字符串。
 *    「打开左右对比」按钮走 host 快照（fileDiff.ready 标记），历史回放无快照自然隐藏。
 *  与 cli/src/lineDiff.ts、diffView.ts 同构的 JS 版。
 */
import { $ } from "./state.js";
import { state } from "./state.js";
import { escapeHtml } from "./markdown.js";

export const EDIT_TOOL_NAMES = ["edit_file", "create_file", "write_file"];

/** 行级 LCS diff：公共前后缀裁剪 + 中段 DP；中段超大退化为整删整增（防大文件爆内存）。 */
function lineDiff(oldStr, newStr) {
  // 空串 = 零行（"".split 会得到一个幽灵空行，把「全新增」误显示成「删空行 + 增」）
  const splitLines = (s) => {
    const t = String(s ?? "").replace(/\r\n/g, "\n");
    return t === "" ? [] : t.split("\n");
  };
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const m1 = a.slice(s, a.length - e);
  const m2 = b.slice(s, b.length - e);
  const rows = [];
  for (let i = 0; i < s; i++) rows.push({ t: "ctx", s: a[i] });
  const n = m1.length, m = m2.length;
  if (n === 0 && m === 0) {
    // 中段无差异
  } else if (n * m > 4000000) {
    for (const l of m1) rows.push({ t: "del", s: l });
    for (const l of m2) rows.push({ t: "add", s: l });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = m1[i] === m2[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (m1[i] === m2[j]) { rows.push({ t: "ctx", s: m1[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { rows.push({ t: "del", s: m1[i] }); i++; }
      else { rows.push({ t: "add", s: m2[j] }); j++; }
    }
    while (i < n) { rows.push({ t: "del", s: m1[i] }); i++; }
    while (j < m) { rows.push({ t: "add", s: m2[j] }); j++; }
  }
  for (let k = 0; k < e; k++) rows.push({ t: "ctx", s: a[a.length - e + k] });
  return rows;
}

/** 折叠连续 ctx 段：超长未变段只留首尾各 keep 行，中段收成省略标记。 */
function collapseContext(rows, keep = 2) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].t !== "ctx") { out.push(rows[i]); i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].t === "ctx") j++;
    const run = j - i;
    if (run > keep * 2 + 1) {
      for (let k = 0; k < keep; k++) out.push(rows[i + k]);
      out.push({ t: "ellip", n: run - keep * 2 });
      for (let k = run - keep; k < run; k++) out.push(rows[i + k]);
    } else {
      for (let k = 0; k < run; k++) out.push(rows[i + k]);
    }
    i = j;
  }
  return out;
}

/** 从 args 提取替换对（edit_file 支持 edits 批量；create_file/write_file 按「全新增」）。 */
function extractEditPairs(toolName, args) {
  if (!args || typeof args !== "object") return null;
  if (toolName === "edit_file") {
    const list = Array.isArray(args.edits) && args.edits.length ? args.edits : [{ old_str: args.old_str, new_str: args.new_str }];
    const pairs = list.filter((x) => typeof x?.old_str === "string" && x.old_str.length);
    return pairs.length
      ? pairs.map((x, i) => ({
          label: pairs.length > 1 ? `第 ${i + 1} 处${x.replace_all ? "（批量替换全部匹配）" : ""}` : "",
          old: x.old_str,
          neu: typeof x.new_str === "string" ? x.new_str : "",
        }))
      : null;
  }
  if (toolName === "create_file" || toolName === "write_file") {
    return typeof args.content === "string" && args.content.length ? [{ label: "", old: "", neu: args.content }] : null;
  }
  return null;
}

/** 左右对齐：连续 del/add 相邻时按序配对成同一行（mod：左旧右新），多余侧留空——GitHub 式对齐。 */
function alignDiffRows(rows) {
  const out = [];
  let dels = [];
  const flush = () => { for (const d of dels) out.push({ k: "del", l: d, r: "" }); dels = []; };
  for (const row of rows) {
    if (row.t === "del") dels.push(row.s);
    else if (row.t === "add") {
      if (dels.length) out.push({ k: "mod", l: dels.shift(), r: row.s });
      else out.push({ k: "add", l: "", r: row.s });
    } else if (row.t === "ctx") { flush(); out.push({ k: "ctx", l: row.s, r: row.s }); }
    else { flush(); out.push({ k: "ellip", n: row.n }); }
  }
  flush();
  return out;
}

/** 工具行 / 审批条共用的左右对比 HTML（两侧 −/+ 标记，改动静默无输出返回 ""）。
 *  big=true 为全屏放大模式：行数上限放开 + 上下文折叠保留更多行。 */
export function buildDiffHtml(toolName, args, big = false) {
  const pairs = extractEditPairs(toolName, args);
  if (!pairs) return "";
  const MAX_ROWS = big ? 3000 : 150;
  const parts = [];
  for (const p of pairs) {
    const rows = alignDiffRows(collapseContext(lineDiff(p.old, p.neu), big ? 6 : 2));
    if (!rows.some((r) => r.k === "del" || r.k === "add" || r.k === "mod")) continue;
    const lines = rows.slice(0, MAX_ROWS).map((r) => {
      if (r.k === "ellip") return `<div class="drow ellip"><span class="dl"></span><span class="dr">⋯ ${r.n} 行未变</span></div>`;
      const lm = r.k === "ctx" ? " " : r.k === "add" ? " " : "−";
      const rm = r.k === "ctx" ? " " : r.k === "del" ? " " : "+";
      return `<div class="drow ${r.k}"><span class="dl">${lm} ${escapeHtml(r.l)}</span><span class="dr">${rm} ${escapeHtml(r.r)}</span></div>`;
    }).join("");
    const more = rows.length > MAX_ROWS ? `<div class="drow ellip"><span class="dl"></span><span class="dr">⋯ 另有 ${rows.length - MAX_ROWS} 行未显示</span></div>` : "";
    parts.push(`<div class="tool-diff">${p.label ? `<div class="diff-hunk-label">${escapeHtml(p.label)}</div>` : ""}${lines}${more}</div>`);
  }
  return parts.join("");
}

/** 解析 edit_file 审批 detail 的【减少】/【增加】结构 → 替换对（格式由 core fs.ts 固定拼装）。 */
function parseApprovalDiff(detail, toolName) {
  if (toolName !== "edit_file" || !String(detail ?? "").includes("【减少】:")) return null;
  const parts = String(detail).split(/\n(?=—— 第 )/);
  const sections = [];
  for (const part of parts.slice(1)) {
    const label = (part.match(/^—— (第 \d+ 处[^\n]*)——/)?.[1] ?? "").trim();
    const rIdx = part.indexOf("【减少】:");
    const aIdx = part.indexOf("【增加】:");
    if (rIdx < 0 || aIdx < 0 || aIdx < rIdx) continue;
    const old = part.slice(rIdx + 5, aIdx).replace(/^\n+|\n+$/g, "");
    const neu = part.slice(aIdx + 5).replace(/^\n+|\n+$/g, "");
    sections.push({ label, old, neu });
  }
  return sections.length ? { header: parts[0], sections } : null;
}

/** 审批条 diff HTML：header 纯文本 + 各处左右对比。 */
export function buildApprovalDiffHtml(detail, toolName, big = false) {
  const parsed = parseApprovalDiff(detail, toolName);
  if (!parsed) return "";
  const out = [];
  for (const sec of parsed.sections) {
    const html = buildDiffHtml("edit_file", { old_str: sec.old, new_str: sec.neu }, big);
    if (html) out.push(sec.label ? `<div class="diff-hunk-label">${escapeHtml(sec.label)}</div>${html}` : html);
  }
  if (!out.length) return "";
  return `<div class="modal-detail approval-diff">${escapeHtml(parsed.header)}</div>${out.join("")}`;
}

// ———————— diff 全屏放大 overlay ————————
// 点击任意内嵌 .tool-diff → 占满面板的大号左右对比（行数放开 + 上下文多留），✕ / Esc / 点空白关闭。
// 数据源两类：工具行（rowMap 按 data-key 取 args 重算）、审批弹窗（renderApproval 存全局 source）。
let approvalDiffSource = null;

/** 审批弹窗渲染时登记/清除 overlay 数据源（跨模块可变量经 setter 收口）。 */
export const setApprovalDiffSource = (v) => { approvalDiffSource = v; };

export const closeDiffOverlay = () => { $(".diff-overlay")?.remove(); };

export const openDiffOverlay = (title, bodyHtml) => {
  closeDiffOverlay();
  const ov = document.createElement("div");
  ov.className = "diff-overlay";
  ov.innerHTML =
    `<div class="diff-overlay-panel">` +
    `<div class="diff-overlay-bar">` +
    `<span class="diff-overlay-title">${title}</span>` +
    `<span class="diff-overlay-hint">点击空白处 / Esc 关闭</span>` +
    `<button class="diff-overlay-close" title="关闭 (Esc)">✕</button>` +
    `</div>` +
    `<div class="diff-overlay-body">${bodyHtml}</div>` +
    `</div>`;
  document.body.appendChild(ov);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) closeDiffOverlay(); });
  ov.querySelector(".diff-overlay-close")?.addEventListener("click", closeDiffOverlay);
};

// overlay 打开期间接管键盘：Esc 关闭；↑↓/Enter 一并吞掉——
// 否则会穿透到计划/审批条的键盘导航（overlay 里按 Enter ≠ 确认方案）。
document.addEventListener("keydown", (e) => {
  if (!$(".diff-overlay")) return;
  if (e.key === "Escape" || e.key === "Enter" || e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") closeDiffOverlay();
  }
}, true);

// 委托：内嵌 diff 卡片整块可点（选中文本时视为复制，不触发）
document.addEventListener("click", (e) => {
  const diffEl = e.target.closest(".tool-diff");
  if (!diffEl || diffEl.closest(".diff-overlay")) return;
  if (window.getSelection()?.toString()) return;
  const rowWrap = diffEl.closest("[data-key]");
  if (rowWrap) {
    const row = state.rowMap.get(rowWrap.dataset.key);
    if (row?.toolName && row.args) {
      const body = buildDiffHtml(row.toolName, row.args, true);
      const p = String(row.args.path || row.args.file_path || "");
      if (body) openDiffOverlay(`${escapeHtml(row.toolName)}${p ? " · " + escapeHtml(p) : ""}`, body);
      return;
    }
  }
  if (approvalDiffSource) {
    const body = buildApprovalDiffHtml(approvalDiffSource.detail, approvalDiffSource.toolName, true);
    if (body) openDiffOverlay(`审批对比 · ${escapeHtml(approvalDiffSource.toolName)}`, body);
  }
});
