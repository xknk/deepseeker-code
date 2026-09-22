/**
 * @file vscode/src/webview/rows.js
 * @description 消息流渲染（从 app.js 拆出，2026-09-16 防腐化拆分）：
 *  行构建/追加/更新（user·assistant·thinking·tool·turnHeader·meta·info·system）、流式缓冲与 rAF 节流
 *  flush、轮次折叠头、任务清单面板、空态、初始化错误横幅、贴图 chip。
 *  流式缓冲（textBuf/thinkBuf/progressBuf）与消费它们的 flush 同模块——缓冲生命周期不跨模块泄漏。
 */
import { vscode, $, state, nextKey } from "./state.js";
import { escapeHtml, mdToHtml, truncate, argHint } from "./markdown.js";
import { EDIT_TOOL_NAMES, buildDiffHtml, openDiffOverlay } from "./diff.js";

// ———————— 消息流渲染 ————————
const messagesEl = () => $("#messages");

function nearBottom() {
  const el = messagesEl();
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
}

function scrollToBottom(instant = false) {
  const el = messagesEl();
  if (instant) {
    // 瞬时跳底：临时关 CSS smooth，避免回放落底变成可见的平滑滚动动画
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prev;
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

// 长 assistant 文本（实现方案/计划等）可折叠——实时与历史回放一致，不依赖后端标记
const isLongAssistant = (t) => { const s = t || ""; return s.split("\n").length > 5 || s.length > 300; };
const firstLine = (t) => truncate((String(t || "").split("\n").map((x) => x.trim()).find(Boolean)) || "(内容)", 60);

function buildRowEl(row) {
  const wrap = document.createElement("div");
  wrap.className = `row row-${row.kind}`;
  wrap.dataset.key = row.key;

  switch (row.kind) {
    case "user": {
      wrap.innerHTML = `<div class="user-bubble">${escapeHtml(row.text)}</div>`;
      // ★ 多模态：随行缩略图（实时回显与历史回放同构；dataURL 直出，CSP img-src data: 已放行）
      const atts = Array.isArray(row.attachments) ? row.attachments : [];
      if (atts.length) {
        const box = document.createElement("div");
        box.className = "user-attachments";
        for (const a of atts) {
          const img = document.createElement("img");
          img.className = "attach-thumb";
          img.src = String(a.dataUrl || "");
          img.alt = String(a.name || "图片");
          img.title = String(a.name || "图片");
          box.appendChild(img);
        }
        wrap.appendChild(box);
      }
      break;
    }
    case "assistant": {
      const html = mdToHtml(row.text);
      if (!row.streaming && isLongAssistant(row.text)) {
        // 长回复（计划/方案）默认展开，点头部折叠——历史回放同样可折
        const collapsed = !!row.collapsed;
        // ★ 标题与正文需纵向堆叠：包进 .assistant-wrap（flex 列），
        //   否则二者作为 .row-assistant（flex 行）的同级 item，展开时正文的大 max-content
        //   会把 CJK 最小内容仅 1~2 字的标题挤到 min-content，导致标题逐字折行。
        wrap.innerHTML =
          `<div class="assistant-wrap">` +
          `<div class="assistant-head" title="点击折叠/展开"><span class="assistant-caret">${collapsed ? "▸" : "▾"}</span>${escapeHtml(firstLine(row.text))}</div>` +
          `<div class="assistant-content" style="${collapsed ? "display:none" : ""}">${html}</div>` +
          `</div>`;
        wrap.querySelector(".assistant-head")?.addEventListener("click", () => {
          row.collapsed = !row.collapsed;
          rebuildRow(row);
        });
        // ★ 点击正文 → 全屏放大阅读（同 diff/计划正文）；流式输出中不绑，收尾 rebuildRow 后自然生效
        if (!row.streaming) {
          wrap.querySelector(".assistant-content")?.addEventListener("click", (e) => {
            if (e.target.closest("a")) return;
            if (window.getSelection()?.toString()) return;
            openDiffOverlay(`● ${escapeHtml(truncate(row.text, 60))}`, `<div class="plan-overlay-content">${mdToHtml(row.text)}</div>`);
          });
        }
      } else {
        wrap.innerHTML = `<div class="assistant-body">${html}${row.streaming ? '<span class="cursor">▊</span>' : ""}</div>`;
      }
      break;
    }
    case "thinking": {
const lines = (row.text || "").split("\n").length;
if (row.expanded) {
wrap.classList.add("expanded");
const dur = row.durationMs ?? (row.startedAt ? Date.now() - row.startedAt : 0);
wrap.innerHTML =
`<div class="think-head"><span class="think-caret">▾</span> Thought for ${Math.round(dur / 1000)}s</div>` +
`<div class="think-body">${escapeHtml(row.text)}</div>`;
} else if (row.streaming) {
const elapsed = row.startedAt ? Math.max(0, Math.round((Date.now() - row.startedAt) / 1000)) : 0;
wrap.innerHTML = `<div class="think-head"><span class="think-caret">›</span> Thinking... ${elapsed}s</div>`;
} else if (row.durationMs != null) {
wrap.innerHTML = `<div class="think-head"><span class="think-caret">›</span> Thought for ${Math.round(row.durationMs / 1000)}s</div>`;
} else {
wrap.innerHTML = `<div class="think-head"><span class="think-caret">›</span> Thoughts（${lines} 行）</div>`;
}
wrap.querySelector(".think-head")?.addEventListener("click", () => {
row.expanded = !row.expanded;
rebuildRow(row);
});
break;
}
case "tool": {
      const level = toolLevel(row.toolName);
      const statusIcon = row.status === "running" ? "" : row.ok ? "✓" : "✗";
      const statusCls = row.status === "running" ? "run" : row.ok ? "ok" : "fail";
      // 运行中徽标：codicon 自转 spinner + 已耗时（秒数由全局 1s ticker 只改 textContent，零整行重渲染）
      const runningBadge = row.status === "running"
        ? `<span class="tool-status run"><span class="codicon codicon-loading codicon-modifier-spin"></span><span class="t-elapsed" data-s="${row.startedAt || ""}"></span></span>`
        : "";
      const head = `<span class="tool-icon lvl-${level}">⏺</span><span class="tool-name lvl-${level}">${escapeHtml(row.toolName)}</span>` +
        (row.args && argHint(row.args) ? `<span class="tool-hint">${escapeHtml(argHint(row.args))}</span>` : "") +
        (statusIcon ? `<span class="tool-status ${statusCls}">${statusIcon}</span>` : runningBadge);
      let body = "";
      if (row.status === "running" && row.progress) {
        const last = String(row.progress).replace(/\r/g, "").split("\n").map((s) => s.trim()).filter(Boolean).pop() || "";
        body = `<div class="tool-progress">${escapeHtml(last)}</div>`;
      } else if (row.status === "done") {
        const first = truncate(row.result, 400).split("\n").find((l) => l.trim()) || "";
        body = `<div class="tool-result ${row.ok ? "ok" : "fail"}">${escapeHtml(first)}</div>`;
        if (row.result && String(row.result).trim()) {
          wrap.classList.add("expandable");
          body += `<div class="tool-detail" style="display:none"><pre>${escapeHtml(row.result)}</pre></div>`;
          if (row.args && JSON.stringify(row.args) !== "{}") {
            body += `<div class="tool-detail" style="display:none"><pre class="dim">${escapeHtml(JSON.stringify(row.args, null, 2))}</pre></div>`;
          }
        }
        // ★ 编辑类工具：args → 左右对比 diff（纯 UI 计算，回放同样可看）；host 有修改前快照时附「打开对比」按钮
        if (row.ok && EDIT_TOOL_NAMES.includes(row.toolName)) {
          const diffHtml = buildDiffHtml(row.toolName, row.args);
          if (diffHtml) body += diffHtml;
          if (diffHtml && row.diffReady && row.toolCallId) {
            body += `<button class="diff-open-btn" title="在编辑器打开原生左右对比（修改前 → 修改后）">⎇ 打开左右对比</button>`;
          }
        }
      }
      wrap.innerHTML = `<div class="tool-head">${head}</div>${body}`;
      wrap.querySelector(".tool-head")?.addEventListener("click", () => {
        wrap.classList.toggle("open");
        wrap.querySelectorAll(".tool-detail").forEach((d) => {
          d.style.display = d.style.display === "none" ? "" : "none";
        });
      });
      wrap.querySelector(".diff-open-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "openDiff", toolCallId: row.toolCallId });
      });
      break;
    }
    case "turnHeader": {
      const caret = row.collapsed ? "▸" : "▾";
      const summaryHtml = row.collapsed && row.summary ? ` <span class="turn-summary">${escapeHtml(row.summary)}</span>` : "";
      wrap.innerHTML = `<div class="turn-head"><span class="turn-caret">${caret}</span><span class="turn-seq">第 ${row.seq} 轮</span>${summaryHtml}</div>`;
      wrap.querySelector(".turn-head")?.addEventListener("click", () => toggleTurn(row.seq));
      break;
    }
    case "meta": {
wrap.innerHTML = `<div class="meta-line">${escapeHtml(row.text)}</div>`;
break;
}
case "info":
      wrap.innerHTML = `<div class="info-line">› ${escapeHtml(row.text)}</div>`;
      break;
    case "compact":
      wrap.innerHTML = `<div class="compact-line">${escapeHtml(row.text)}</div>`;
      break;
    case "system":
      wrap.innerHTML = `<div class="system-line">! ${escapeHtml(row.text)}</div>`;
      break;
    default:
      break;
  }
  return wrap;
}

function toolLevel(name) {
  // 视觉层级：危险/变更/安全 —— 与 core 的 safetyLevel 对齐（本地启发式）
  if (/delete|rm\b|run_command|run_in_background/.test(name)) return "danger";
  if (/edit|write|create|move|git_commit|undo_restore|stop_background/.test(name)) return "mutation";
  return "safe";
}

function rebuildRow(row) {
  const el = messagesEl().querySelector(`[data-key="${CSS.escape(row.key)}"]`);
  if (el) {
    const fresh = buildRowEl(row);
    el.replaceWith(fresh);
  }
}

// ★ 开启新一轮对话 turn：插可折叠头（seq + user 摘要），后续行归入此 turn。
//   由 appendRow 在 user 行入栈时统一调用——覆盖实时 / 回放 / 所有 row 入口，无需各入口重复处理。
function beginUserTurn(text) {
  state.roundSeq = (state.roundSeq || 0) + 1;
  state.currentTurn = state.roundSeq;
  const header = { key: nextKey(), kind: "turnHeader", seq: state.roundSeq, turn: state.roundSeq, summary: truncate(text || "", 50), collapsed: false };
  state.turnHeaderBySeq.set(state.roundSeq, header);
  appendRow(header); // turnHeader.kind !== "user"，不会递归触发
}

// ★ 折叠/展开某 turn：切换该 turn 下所有非头行的 display（user 消息 + agent 工具/思考/回复/info 全收起）。
function toggleTurn(seq) {
  const header = state.turnHeaderBySeq.get(seq);
  if (!header) return;
  header.collapsed = !header.collapsed;
  rebuildRow(header);
  const hide = header.collapsed;
  for (const k of state.order) {
    const r = state.rowMap.get(k);
    if (r && r.turn === seq && r.kind !== "turnHeader") {
      const el = messagesEl().querySelector(`[data-key="${CSS.escape(k)}"]`);
      if (el) el.style.display = hide ? "none" : "";
    }
  }
  if (!hide && nearBottom()) scrollToBottom();
}

function appendRow(row) {
  // ★ user 行 = turn 边界：先开新 turn（插折叠头），统一覆盖所有 row 入口
  if (row.kind === "user") beginUserTurn(row.text);
  if (row.turn == null) row.turn = state.currentTurn;
  state.order.push(row.key);
  state.rowMap.set(row.key, row);
  const wrap = buildRowEl(row);
  wrap.classList.add("row-enter");
  // 归属 turn 已折叠 → 新行也隐藏（流式新行尊重已有折叠状态）
  if (row.kind !== "turnHeader" && row.turn != null && state.turnHeaderBySeq.get(row.turn)?.collapsed) {
    wrap.style.display = "none";
  }
  messagesEl().appendChild(wrap);
  if (!state.replaying && nearBottom()) scrollToBottom(); // 回放中不逐条跟随，replayDone 统一落底
  updateEmptyState();
}

function updateRow(key, patch) {
  const row = state.rowMap.get(key);
  if (!row) return;
  Object.assign(row, patch);
  rebuildRow(row);
  if (!state.replaying && nearBottom()) scrollToBottom();
}

// ———————— 流式缓冲（text/thinking/progress）与节流 flush ————————
// 缓冲本体模块内私有；事件侧（events.js）经下方 appendXxx/setProgress/resetStreams 操作——
// 缓冲只被 flush 消费，跨模块只暴露动作、不暴露变量（防止绕过节流直接改缓冲）。
const FLUSH_MS = 60;
let textBuf = "";
let thinkBuf = "";
let progressBuf = null;
let flushTimer = null;

/** text.delta 事件侧入栈（rAF 节流 flush 消费）。 */
export const appendTextDelta = (t) => { textBuf += t; };
/** thinking.delta 事件侧入栈。 */
export const appendThinkDelta = (t) => { thinkBuf += t; };
/** tool.progress 事件侧入栈（单槽，后到覆盖）。 */
export const setProgress = (key, msg) => { progressBuf = { key, msg }; };
/** 流式 stall 重试前：丢弃已累积的部分正文/思考并清空对应行视图（避免重试后重复显示）。 */
export function resetStreams() {
  textBuf = "";
  thinkBuf = "";
  if (state.currentAssistant != null) {
    const row = state.rowMap.get(state.currentAssistant);
    if (row) {
      row.text = "";
      const el = messagesEl().querySelector(`[data-key="${CSS.escape(row.key)}"] .assistant-body`);
      if (el) el.innerHTML = '<span class="cursor">▊</span>';
    }
  }
  if (state.currentThinking != null) {
    const trow = state.rowMap.get(state.currentThinking);
    if (trow) trow.text = "";
  }
}

function closeStreaming() {
  flush();
  if (state.currentAssistant != null) {
    updateRow(state.currentAssistant, { streaming: false });
    state.currentAssistant = null;
  }
  if (state.currentThinking != null) {
    const row = state.rowMap.get(state.currentThinking);
    if (row) updateRow(state.currentThinking, { streaming: false, expanded: false, durationMs: row.startedAt ? Date.now() - row.startedAt : 0 });
    state.currentThinking = null;
  }
}

function ensureAssistantRow() {
  if (state.currentAssistant != null) return;
  closeThinking();
  const row = { key: nextKey(), kind: "assistant", text: "", streaming: true };
  state.currentAssistant = row.key;
  appendRow(row);
}

function closeThinking() {
  if (state.currentThinking != null) {
    const row = state.rowMap.get(state.currentThinking);
    if (row) updateRow(state.currentThinking, { streaming: false, durationMs: row.startedAt ? Date.now() - row.startedAt : 0 });
    state.currentThinking = null;
  }
}

function ensureThinkingRow() {
  if (state.currentThinking != null) return;
  const row = { key: nextKey(), kind: "thinking", text: "", streaming: true, expanded: false, startedAt: Date.now() };
  state.currentThinking = row.key;
  appendRow(row);
}

// 流式节流 flush
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_MS);
}

function flush() {
  const t = textBuf;
  textBuf = "";
  const th = thinkBuf;
  thinkBuf = "";
  const pp = progressBuf;
  progressBuf = null;
  if (t && state.currentAssistant != null) {
    const row = state.rowMap.get(state.currentAssistant);
    if (row) {
      row.text += t;
      const el = messagesEl().querySelector(`[data-key="${CSS.escape(row.key)}"] .assistant-body`);
      if (el) {
        el.innerHTML = mdToHtml(row.text) + '<span class="cursor">▊</span>';
        if (nearBottom()) scrollToBottom();
      }
    }
  }
  if (th && state.currentThinking != null) {
    const row = state.rowMap.get(state.currentThinking);
    if (row) {
      row.text += th;
      rebuildRow(row);
      if (nearBottom()) scrollToBottom();
    }
  }
  if (pp && pp.key) updateRow(pp.key, { progress: pp.msg });
}

function addInfo(text) {
  appendRow({ key: nextKey(), kind: "info", text });
}

// ★ 图片预览 chip：上传后在 composer 上方显示缩略图 + 文件名 + 可见 × 删除钮（data URL，CSP img-src data: 已放行）
//   待发送附件一律可移除（点 ×），与 Claude Code 贴图 chip 一致；× 只在 hover chip 时显形防误触。
function appendImagePreview(dataUrl, name, removable) {
  const box = $("#composer-attachments");
  if (!box) return;
  const chip = document.createElement("div");
  chip.className = "attach-chip";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = name;
  const span = document.createElement("span");
  span.textContent = name;
  chip.appendChild(img);
  chip.appendChild(span);
  if (removable) {
    const btn = document.createElement("button");
    btn.className = "attach-remove";
    btn.title = "移除图片";
    btn.innerHTML = '<span class="codicon codicon-close"></span>';
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.pendingImages = state.pendingImages.filter((p) => !(p.dataUrl === dataUrl && p.name === name));
      chip.remove();
    });
    chip.appendChild(btn);
  }
  box.appendChild(chip);
}

/** 清空待发送贴图（vision 模式）：chip DOM + 待发数组一并重置（新会话/发送成功后调用）。 */
function clearPendingImages() {
  state.pendingImages = [];
  const box = $("#composer-attachments");
  if (box) box.innerHTML = "";
}

function clearMessages() {
  closeStreaming();
  state.order = [];
  state.rowMap.clear();
  state.toolRowByCallId.clear();
  // ★ 轮次状态随会话重置：杜绝跨会话/回放累积（旧 bug：回放历史会话时 roundSeq 一路累加显示"第20+轮"）
  state.roundSeq = 0;
  state.currentTurn = 0;
  state.turnHeaderBySeq = new Map();
  messagesEl().innerHTML = "";
  buildEmptyState();
  renderTodos();
updateEmptyState();
}

// ———————— 初始化错误横幅（缺 API Key 等配置问题） ————————
function renderInitError(msg) {
let el = $("#init-error");
if (!msg) {
if (el) el.remove();
return;
}
if (!el) {
el = document.createElement("div");
el.id = "init-error";
messagesEl().parentElement.insertBefore(el, messagesEl());
}
el.textContent = "⚠️ " + msg;
}

// ———————— 任务清单 ————————
function renderTodos() {
  let panel = $("#todos-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "todos-panel";
    messagesEl().parentElement.insertBefore(panel, messagesEl());
  }
  if (!state.showTodos || state.todos.length === 0) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";
  panel.innerHTML =
    `<div class="todos-title">任务</div>` +
    state.todos
      .map((t) => {
        const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◉" : "☐";
        const cls = t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "";
        const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        return `<div class="todo-item ${cls}"><span class="todo-mark">${mark}</span> ${escapeHtml(label)}</div>`;
      })
      .join("");
}

function buildEmptyState() {
const host = messagesEl();
if ($("#empty-state")) return;
const el = document.createElement("div");
el.id = "empty-state";
el.className = "empty-state";
el.innerHTML = `
<svg width="32" height="32" viewBox="0 0 16 16" fill="#D97706" aria-hidden="true">
<rect x="3" y="0" width="2" height="2"/><rect x="11" y="0" width="2" height="2"/>
<rect x="4" y="2" width="8" height="2"/>
<rect x="2" y="4" width="2" height="2"/><rect x="6" y="4" width="4" height="2"/><rect x="12" y="4" width="2" height="2"/>
<rect x="3" y="6" width="2" height="2"/><rect x="5" y="6" width="2" height="2"/><rect x="9" y="6" width="2" height="2"/><rect x="11" y="6" width="2" height="2"/>
<rect x="4" y="8" width="2" height="2"/><rect x="10" y="8" width="2" height="2"/>
<rect x="3" y="10" width="2" height="2"/><rect x="11" y="10" width="2" height="2"/>
</svg>
<div class="empty-title">DeepSeeker-Code</div>
<div class="empty-sub">You've come to the absolutely right place!</div>`;
host.appendChild(el);
}

function updateEmptyState() {
const el = $("#empty-state");
if (!el) return;
el.style.display = state.order.length > 0 ? "none" : "";
}

export {
  messagesEl, nearBottom, scrollToBottom,
  appendRow, updateRow, rebuildRow,
  closeStreaming, ensureAssistantRow, closeThinking, ensureThinkingRow,
  scheduleFlush, flush, addInfo,
  appendImagePreview, clearPendingImages, clearMessages,
  renderInitError, renderTodos, buildEmptyState, updateEmptyState,
};
