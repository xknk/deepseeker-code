/**
 * @file vscode/src/webview/panels.js
 * @description 历史会话面板 + 分叉面板（从 app.js 拆出，2026-09-16 防腐化拆分）。
 *  会话行支持 inline 重命名 / 删除二次确认（跨重绘的编辑态存模块级变量）；
 *  分叉面板复用同款浮层样式，列当前会话各轮检查点。
 */
import { vscode, $, state } from "./state.js";
import { escapeHtml } from "./markdown.js";

// ———————— 历史会话面板（终端风格：搜索 + 单行列表） ————————
let sessionsFilter = "";
// 会话行 inline 操作态（重命名编辑 / 删除二次确认）——模块级，跨 renderSessionsPanel 重绘保持。
let editingSessionId = null;
let confirmingDeleteId = null;
let confirmDeleteTimer = null;

function buildSessionsPanel() {
if ($("#sessions-panel")) return;
const panel = document.createElement("div");
panel.id = "sessions-panel";
panel.className = "sessions-panel";
panel.style.display = "none";
panel.innerHTML = `
<div class="sessions-search">
<span class="codicon codicon-search"></span>
<input id="sessions-filter" type="text" placeholder="Search sessions..." spellcheck="false"/>
<button id="sessions-close" class="icon-btn" title="关闭"><span class="codicon codicon-close"></span></button>
</div>
<div class="sessions-list" id="sessions-list"></div>`;
document.querySelector("#approval-anchor").before(panel);
$("#sessions-filter").addEventListener("input", (e) => {
sessionsFilter = e.target.value.trim().toLowerCase();
renderSessionsPanel();
});
$("#sessions-filter").addEventListener("keydown", (e) => {
if (e.key === "Escape") {
closeSessionsPanel();
const inp = $("#input");
if (inp) inp.focus();
}
});
$("#sessions-close").addEventListener("click", () => {
closeSessionsPanel();
const inp = $("#input");
if (inp) inp.focus();
});
}

function toggleSessionsPanel() {
let panel = $("#sessions-panel");
if (!panel) buildSessionsPanel();
panel = $("#sessions-panel");
if (panel && panel.style.display !== "none") {
closeSessionsPanel();
return;
}
openSessionsPanel();
}

function openSessionsPanel() {
vscode.postMessage({ type: "listSessions" });
let panel = $("#sessions-panel");
if (!panel) buildSessionsPanel();
panel = $("#sessions-panel");
panel.style.display = "";
const f = $("#sessions-filter");
if (f) { f.value = ""; sessionsFilter = ""; f.focus(); }
renderSessionsPanel();
}

function closeSessionsPanel() {
const p = $("#sessions-panel");
if (p) p.style.display = "none";
sessionsFilter = "";
// 关闭面板时取消任何进行中的编辑/确认态，避免再次打开面板时残留。
editingSessionId = null;
confirmingDeleteId = null;
clearTimeout(confirmDeleteTimer);
}

// ———————— 分叉面板（当前会话各轮检查点，点击该轮即从其后分叉出新会话） ————————
function buildForkPanel() {
if ($("#fork-panel")) return;
const panel = document.createElement("div");
panel.id = "fork-panel";
panel.className = "sessions-panel"; // 复用历史面板样式（同款浮层外观）
panel.style.display = "none";
panel.innerHTML = `
<div class="sessions-search">
<span class="codicon codicon-gist-fork"></span>
<span style="flex:1;font-size:12px;color:#888;">选择分叉点：保留该轮及之前的历史，之后重新走向</span>
<button id="fork-close" class="icon-btn" title="关闭"><span class="codicon codicon-close"></span></button>
</div>
<div class="sessions-list" id="fork-list"></div>`;
document.querySelector("#approval-anchor").before(panel);
$("#fork-close").addEventListener("click", () => {
closeForkPanel();
const inp = $("#input");
if (inp) inp.focus();
});
}

function toggleForkPanel() {
let panel = $("#fork-panel");
if (!panel) buildForkPanel();
panel = $("#fork-panel");
if (panel && panel.style.display !== "none") {
closeForkPanel();
return;
}
openForkPanel();
}

function openForkPanel() {
vscode.postMessage({ type: "listForkAnchors" });
let panel = $("#fork-panel");
if (!panel) buildForkPanel();
panel = $("#fork-panel");
panel.style.display = "";
renderForkPanel();
}

function closeForkPanel() {
const p = $("#fork-panel");
if (p) p.style.display = "none";
}

function renderForkPanel() {
const panel = $("#fork-panel");
if (!panel || panel.style.display === "none") return;
const box = $("#fork-list");
const anchors = state.forkAnchors || [];
if (!anchors.length) {
box.innerHTML = `<div class="sessions-empty">当前会话暂无可分叉的检查点</div>`;
return;
}
box.innerHTML = anchors
.map(
(a, i) => `
<div class="session-row fork-row" data-i="${i}" title="从该轮分叉出新会话（原会话不变）">
<span class="session-title">#${a.roundNo} ${escapeHtml(a.userPreview || "(无提问)")}</span>
<span class="session-meta">→ ${escapeHtml(a.assistantPreview || "")}</span>
</div>`
)
.join("");
box.querySelectorAll(".fork-row").forEach((row) => {
row.addEventListener("click", () => {
const a = anchors[Number(row.dataset.i)];
if (!a) return;
closeForkPanel();
vscode.postMessage({ type: "fork", lineId: a.lineId });
});
});
}

function dedupBySessionId(arr) {
const best = new Map();
for (const s of arr) {
const id = s.sessionId;
if (!id) continue;
const prev = best.get(id);
if (!prev || String(s.updatedAt ?? "") > String(prev.updatedAt ?? "")) best.set(id, s);
}
return [...best.values()];
}
function renderSessionsPanel() {
const panel = $("#sessions-panel");
if (!panel || panel.style.display === "none") return;
const list = dedupBySessionId(state.sessions);
const q = sessionsFilter;
const filtered = q ? list.filter((s) => String(s.title || s.preview || "").toLowerCase().includes(q)) : list;
const box = $("#sessions-list");
if (!filtered.length) {
box.innerHTML = `<div class="sessions-empty">${q ? "无匹配会话" : "暂无历史会话"}</div>`;
return;
}
box.innerHTML = filtered.map((s, i) => renderSessionRow(s, i)).join("");
bindSessionRows(filtered);
}

/** 单行渲染：普通态 / 重命名编辑态 / 删除确认态三选一。 */
function renderSessionRow(s, i) {
const title = s.title || s.preview || "(空会话)";
if (editingSessionId === s.sessionId) {
return `<div class="session-row editing" data-i="${i}">
<input class="session-rename-input" data-i="${i}" value="${escapeHtml(s.title || s.preview || "")}" spellcheck="false"/>
<span class="session-meta">Enter 确认 · Esc 取消</span>
</div>`;
}
if (confirmingDeleteId === s.sessionId) {
return `<div class="session-row confirming" data-i="${i}">
<span class="session-title">🗑️ 确认删除「${escapeHtml(title)}」？</span>
<span class="session-tools">
<button class="session-del-ok" data-i="${i}">确认删除</button>
<button class="session-del-cancel" data-i="${i}">取消</button>
</span>
</div>`;
}
return `<div class="session-row" data-i="${i}">
<span class="session-title">${escapeHtml(title)}</span>
<span class="session-tools">
<span class="codicon codicon-edit session-rename" data-i="${i}" title="重命名"></span>
<span class="codicon codicon-trash session-delete" data-i="${i}" title="删除"></span>
</span>
<span class="session-meta">${escapeHtml(relTime(s.updatedAt))} · ${s.messageCount} 条</span>
</div>`;
}

/** 绑定行交互：点击行加载会话 / ✏️ 重命名 / 🗑️ 删除 / 编辑键盘 / 确认按钮。 */
function bindSessionRows(filtered) {
const box = $("#sessions-list");
// 普通行：点击 = 加载该会话（操作按钮 stopPropagation，不触发行加载）
box.querySelectorAll(".session-row:not(.editing):not(.confirming)").forEach((el) => {
el.addEventListener("click", (e) => {
if (e.target.closest(".session-rename, .session-delete")) return;
const s = filtered[Number(el.dataset.i)];
if (!s) return;
vscode.postMessage({ type: "loadSession", id: s.sessionId });
state.replaying = true; // 抑制回放期间逐条滚动，replayDone 一次性落底
closeSessionsPanel();
});
});
box.querySelectorAll(".session-rename").forEach((el) => {
el.addEventListener("click", (e) => {
e.stopPropagation();
const s = filtered[Number(el.dataset.i)];
if (!s) return;
editingSessionId = s.sessionId;
renderSessionsPanel();
const inp = box.querySelector(".session-rename-input");
if (inp) { inp.focus(); inp.select(); }
});
});
box.querySelectorAll(".session-delete").forEach((el) => {
el.addEventListener("click", (e) => {
e.stopPropagation();
const s = filtered[Number(el.dataset.i)];
if (!s) return;
confirmingDeleteId = s.sessionId;
renderSessionsPanel();
clearTimeout(confirmDeleteTimer);
confirmDeleteTimer = setTimeout(() => {
if (confirmingDeleteId === s.sessionId) { confirmingDeleteId = null; renderSessionsPanel(); }
}, 4000);
});
});
const renameInput = box.querySelector(".session-rename-input");
if (renameInput) {
const commitRename = () => {
const s = filtered[Number(renameInput.dataset.i)];
const val = String(renameInput.value ?? "").trim();
if (s && val && editingSessionId === s.sessionId) {
vscode.postMessage({ type: "renameSession", id: s.sessionId, title: val });
}
editingSessionId = null;
renderSessionsPanel();
};
renameInput.addEventListener("keydown", (e) => {
if (e.key === "Enter") { e.preventDefault(); commitRename(); }
else if (e.key === "Escape") { e.preventDefault(); editingSessionId = null; renderSessionsPanel(); }
});
renameInput.addEventListener("blur", commitRename);
}
box.querySelectorAll(".session-del-ok").forEach((el) => {
el.addEventListener("click", (e) => {
e.stopPropagation();
const s = filtered[Number(el.dataset.i)];
clearTimeout(confirmDeleteTimer);
confirmingDeleteId = null;
if (s) vscode.postMessage({ type: "deleteSession", id: s.sessionId });
// 列表刷新由后端 sendSessions 推送触发；先清确认态防重复点击。
});
});
box.querySelectorAll(".session-del-cancel").forEach((el) => {
el.addEventListener("click", (e) => {
e.stopPropagation();
clearTimeout(confirmDeleteTimer);
confirmingDeleteId = null;
renderSessionsPanel();
});
});
}
function relTime(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!t) return "";
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return "刚刚";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return new Date(t).toLocaleDateString("zh-CN");
  }

export {
  buildSessionsPanel, toggleSessionsPanel, closeSessionsPanel, renderSessionsPanel,
  toggleForkPanel, renderForkPanel,
};
