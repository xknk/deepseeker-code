/**
 * @file vscode/src/webview/panels.js
 * @description 历史会话抽屉 + 分叉面板 + 回滚面板（从 app.js 拆出，2026-09-16 防腐化拆分）。
 *  会话行支持 inline 重命名 / 删除二次确认（跨重绘的编辑态存模块级变量）；
 *  分叉/回滚面板复用浮层样式，列当前会话各轮检查点。
 *  历史会话抽屉（2026-11-25 重做，对标 CC 的会话列表）：
 *   - 形态：锚定头部历史按钮的紧凑下拉浮层（搜索框 + 单行列表，CC 同款）——此前一版是 body 级
 *     右侧全高抽屉（遮罩 + sheet），用户对照 CC 截图反馈不好看，改为下拉；
 *   - 数据懒加载：host 只回「索引」（标题/预览/时间，读 state.json + transcript 头部）；消息数须读完整
 *     transcript，按「已渲染的行」另行批量请求，回包后原位补到行尾（不重画列表）；
 *   - 渲染懒加载：首屏 SESSIONS_PAGE 行，列表滚到底部附近再追加一页（只追加增量，不重画已渲染行）；
 *   - 归档段（CC Archived sessions 同款）：活跃行之后一个折叠头（chevron + 标签 + 数量徽章），
 *     展开后归档行更深一级缩进，悬停 = 重命名 + 取消归档（无删除——先恢复再删，两段语义分明）；
 *     折叠态模块级记忆（跨开关抽屉），搜索时归档段自动展开参与匹配。
 */
import { vscode, $, state } from "./state.js";
import { S } from "./strings.js";
import { escapeHtml } from "./markdown.js";

// ———————— 历史会话抽屉（搜索 + 懒加载单行列表） ————————
/** 首屏与每页渲染的会话行数（滚到底部附近再追加一页）。 */
const SESSIONS_PAGE = 50;
/** 列表距底部多少像素以内触发追加下一页。 */
const SESSIONS_MORE_PX = 320;
/** 消息数请求的去抖：滚动追加时把同一批可见行合并成一次请求。 */
const COUNTS_DEBOUNCE_MS = 80;
let sessionsFilter = "";
let sessionsVisible = SESSIONS_PAGE; // 已渲染行数上限（随滚动递增；过滤词变化/重新打开时重置回首屏）
// 会话行 inline 操作态（重命名编辑 / 删除二次确认）——模块级，跨 renderSessionsPanel 重绘保持。
let editingSessionId = null;
let confirmingDeleteId = null;
let confirmDeleteTimer = null;
let countsTimer = null;
const countsInFlight = new Set(); // 已发出、尚未回包的会话 id（防重复请求）
// ★ 待发批次累积槽：去抖窗口内多次请求合并到这里。不能只把本批 ids 交给定时器——上一批已进
//   countsInFlight 而它的定时器会被本次 clearTimeout 取消，那批 id 就永远发不出去（既不在途也发不出，
//   后续 filter 当「在途」跳过），表现为部分行到关闭抽屉为止一直没有消息数。
const pendingCounts = new Set();
// 归档段折叠态（模块级记忆：跨开关抽屉保持，CC 同款）。搜索时归档段强制展开（否则匹配到的归档会话不可见）。
let archivedOpen = false;

function buildSessionsPanel() {
if ($("#sessions-panel")) return;
const panel = document.createElement("div");
panel.id = "sessions-panel";
panel.className = "sessions-pop";
panel.style.display = "none";
panel.innerHTML = `
<div class="sessions-search">
<span class="codicon codicon-search"></span>
<input id="sessions-filter" type="text" placeholder="${S.pnSearch}" spellcheck="false"/>
</div>
<div class="sessions-list" id="sessions-list"></div>`;
document.body.appendChild(panel);
$("#sessions-filter").addEventListener("input", (e) => {
sessionsFilter = e.target.value.trim().toLowerCase();
sessionsVisible = SESSIONS_PAGE;
$("#sessions-list").scrollTop = 0;
renderSessionsPanel();
});
// Esc 在浮层内任何位置都能关（搜索框/列表/行上）；重命名输入框的 Esc 由它自己处理（=取消重命名，不关浮层）
panel.addEventListener("keydown", (e) => {
if (e.key !== "Escape" || e.target.closest(".session-rename-input")) return;
e.preventDefault();
closeSessionsPanel(true);
});
// CC 同款：点击浮层以外任意处关闭（无遮罩，对话区保持可见可滚）。capture 在 document 上收全部
// 点击；#btn-sessions 本体跳过——它的 click 走 toggleSessionsPanel 收口，这里拦了会「pointerdown 关、
// click 再开」闪一下。
document.addEventListener("pointerdown", (e) => {
const p = $("#sessions-panel");
if (!p || p.style.display === "none") return;
if (p.contains(e.target) || e.target.closest("#btn-sessions")) return;
closeSessionsPanel(true);
}, true);
$("#sessions-list").addEventListener("scroll", loadMoreSessions, { passive: true });
}

function toggleSessionsPanel() {
let panel = $("#sessions-panel");
if (!panel) buildSessionsPanel();
panel = $("#sessions-panel");
if (panel && panel.style.display !== "none") {
closeSessionsPanel(true);
return;
}
openSessionsPanel();
}

function openSessionsPanel() {
vscode.postMessage({ type: "listSessions" });
let panel = $("#sessions-panel");
if (!panel) buildSessionsPanel();
panel = $("#sessions-panel");
// 锚定定位（CC 同款：浮层挂在头部历史按钮正下方、右缘与按钮对齐；贴视口下缘时上抬保底高度）。
// 每次打开现算——webview 宽度变化/按钮移位后位置仍准。
const anchor = $("#btn-sessions");
if (anchor) {
const r = anchor.getBoundingClientRect();
const pop = panel;
pop.style.top = `${Math.min(r.bottom + 6, Math.max(8, window.innerHeight - 120))}px`;
pop.style.right = `${Math.max(8, document.documentElement.clientWidth - r.right)}px`;
}
panel.style.display = "";
const f = $("#sessions-filter");
if (f) { f.value = ""; sessionsFilter = ""; f.focus(); }
sessionsVisible = SESSIONS_PAGE; // 每次打开都从首屏开始
// 消息数索引按打开清空：上次打开后聊过的会话数字已旧；host 侧按文件缓存，没变的会话不重读全文
state.sessionCounts.clear();
countsInFlight.clear();
pendingCounts.clear();
clearTimeout(countsTimer);
const box = $("#sessions-list");
if (box) box.scrollTop = 0;
renderSessionsPanel();
}

function closeSessionsPanel(refocus = false) {
const p = $("#sessions-panel");
if (p) p.style.display = "none";
sessionsFilter = "";
// 关闭抽屉时取消任何进行中的编辑/确认态，避免再次打开抽屉时残留。
editingSessionId = null;
confirmingDeleteId = null;
clearTimeout(confirmDeleteTimer);
// 待发的消息数请求一并作废（抽屉已关，下 80ms 后再白跑一批全文读没意义）
clearTimeout(countsTimer);
pendingCounts.clear();
if (refocus) {
const inp = $("#input");
if (inp) inp.focus();
}
}

/** 去重 + 搜索过滤后的清单按归档标记分两段（各自 updatedAt 降序——索引回包已排，stable filter 保序）。 */
function sessionGroups() {
const q = sessionsFilter;
const all = dedupBySessionId(state.sessions).filter((s) => !q || String(s.title || s.preview || "").toLowerCase().includes(q));
return {
active: all.filter((s) => s.archived !== true),
archived: all.filter((s) => s.archived === true),
};
}

/** data-i 下标口径的合并清单：折叠态仅活跃段；展开态/搜索态 = 活跃 + 归档（折叠头不算下标）。 */
function sessionList() {
const { active, archived } = sessionGroups();
return (archivedOpen || sessionsFilter) ? [...active, ...archived] : active;
}

/** 全量重绘（打开浮层 / 过滤词变化 / host 推来新索引 / 折叠切换）：活跃段 → 折叠头 →（展开时）归档段。
 *  只画前 sessionsVisible 行（懒加载）；折叠头插在渲染范围越过活跃/归档边界处，折叠态恒显示在段尾。 */
function renderSessionsPanel() {
const panel = $("#sessions-panel");
if (!panel || panel.style.display === "none") return;
const { active, archived } = sessionGroups();
const showArchived = archivedOpen || !!sessionsFilter;
const all = showArchived ? [...active, ...archived] : active;
const box = $("#sessions-list");
if (!box) return;
const headHtml = archivedHeadHtml(archived.length, showArchived);
// 两组全空才显示空态；仅活跃空而归档有货时也要能见到折叠头（点开才能看到归档会话）
if (!all.length) {
box.innerHTML = archived.length ? headHtml : `<div class="sessions-empty">${sessionsFilter ? S.pnNoMatch : S.pnEmpty}</div>`;
bindArchivedHead();
return;
}
sessionsVisible = Math.min(Math.max(sessionsVisible, SESSIONS_PAGE), all.length);
const activeRendered = Math.min(sessionsVisible, active.length);
let html = sessionRowsHtml(all, 0, activeRendered);
// 折叠头只在「活跃段已渲染完」时出现（它插在活跃段末尾）；深滚动场景由 loadMoreSessions 在跨界处补插
const showHead = archived.length > 0 && sessionsVisible >= active.length;
if (showHead) {
html += headHtml;
if (showArchived) {
const from = active.length;
const to = active.length + Math.max(0, sessionsVisible - activeRendered);
html += sessionRowsHtml(all, from, to);
}
}
if (sessionsVisible < all.length) html += sessionTailHtml(all.length);
box.innerHTML = html;
bindSessionRows(0);
bindArchivedHead();
bindRenameInput();
requestSessionCounts(all.slice(0, sessionsVisible));
}

/** 归档折叠头（CC Archived sessions 同款：chevron + 标签 + 数量徽章；数量恒为归档总数）。 */
const archivedHeadHtml = (archivedCount, expanded) =>
archivedCount === 0
? ""
: `<div class="sessions-archived-head" id="sessions-archived-head" role="button" tabindex="0">
<span class="codicon ${expanded ? "codicon-chevron-down" : "codicon-chevron-right"}"></span>
<span class="sessions-archived-label">${escapeHtml(S.pnArchived)}</span>
<span class="sessions-archived-badge">${archivedCount}</span>
</div>`;

/** 折叠头交互：点击/回车切换展开；展开时渲染窗口至少覆盖到折叠头之后一页（否则刚展开仍看不见归档行）。 */
function bindArchivedHead() {
const head = $("#sessions-archived-head");
if (!head || head.dataset.bound) return;
head.dataset.bound = "1";
const toggle = () => {
archivedOpen = !archivedOpen;
if (archivedOpen) {
const { active } = sessionGroups();
sessionsVisible = Math.max(sessionsVisible, active.length + SESSIONS_PAGE);
}
renderSessionsPanel();
};
head.addEventListener("click", toggle);
head.addEventListener("keydown", (e) => {
if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
});
}

/** 滚到底部附近再追加一页：只追加增量行（不重画已渲染行——滚动位置与重命名编辑态都不受影响）。
 *  追加段跨活跃/归档边界时在此处补插折叠头（全量重绘只在活跃段渲染完时插，深滚动到这里接手）。 */
function loadMoreSessions() {
const box = $("#sessions-list");
if (!box) return;
const { active, archived } = sessionGroups();
const showArchived = archivedOpen || !!sessionsFilter;
const all = showArchived ? [...active, ...archived] : active;
if (sessionsVisible >= all.length) return;
if (box.scrollHeight - box.scrollTop - box.clientHeight > SESSIONS_MORE_PX) return;
const from = sessionsVisible;
sessionsVisible = Math.min(from + SESSIONS_PAGE, all.length);
box.querySelector(".sessions-more")?.remove();
const activeCount = active.length;
const headNeeded = showArchived && archived.length > 0
&& sessionsVisible >= activeCount && !box.querySelector(".sessions-archived-head");
let html = "";
if (headNeeded && from < activeCount) {
// 一次窗口跨过活跃/归档边界：活跃尾巴 → 折叠头 → 归档头段（顺序不能乱）
html += sessionRowsHtml(all, from, activeCount)
+ archivedHeadHtml(archived.length, true)
+ sessionRowsHtml(all, activeCount, sessionsVisible);
} else {
if (headNeeded) html += archivedHeadHtml(archived.length, true);
html += sessionRowsHtml(all, from, sessionsVisible);
}
html += sessionTailHtml(all.length);
box.insertAdjacentHTML("beforeend", html);
bindSessionRows(from);
requestSessionCounts(all.slice(from, sessionsVisible));
}

/** 清单 [from, to) 下标区间的行 HTML。 */
const sessionRowsHtml = (all, from, to) => {
let html = "";
for (let i = from; i < to; i++) html += renderSessionRow(all[i], i);
return html;
};

/** 列表尾部状态行：还有没渲染的行时提示滚动加载；全部渲染完不留痕。 */
const sessionTailHtml = (total) =>
sessionsVisible >= total ? "" : `<div class="sessions-more">${escapeHtml(S.pnMore(sessionsVisible, total))}</div>`;

/** 单行渲染：普通态 / 重命名编辑态 / 删除确认态三选一；活跃行与归档行差异在悬停工具组
 *  （活跃 = 重命名/归档/删除；归档 = 重命名/取消归档——先恢复再删，CC 同款两段语义）与缩进。
 *  data-i=在当前清单里的下标（交互时按下标回查会话对象）；data-id=会话 id（回包原位补数、下标错位防护）。 */
function renderSessionRow(s, i) {
const title = s.title || s.preview || S.pnUntitled;
const attrs = `data-i="${i}" data-id="${escapeHtml(String(s.sessionId))}" title="${escapeHtml(title)}"`;
if (editingSessionId === s.sessionId) {
return `<div class="session-row editing" ${attrs}>
<input class="session-rename-input" value="${escapeHtml(s.title || s.preview || "")}" spellcheck="false"/>
<span class="session-meta">${S.pnRenameHint}</span>
</div>`;
}
if (confirmingDeleteId === s.sessionId) {
return `<div class="session-row confirming" ${attrs}>
<span class="session-title">${S.pnConfirmDelete(escapeHtml(title))}</span>
<span class="session-tools">
<button class="session-del-ok">${S.pnDelOk}</button>
<button class="session-del-cancel">${S.pnCancel}</button>
</span>
</div>`;
}
// 消息数是懒加载明细：索引回包时还没有（空着），计数回包后 patchSessionCounts 原位补进 .session-count
const cnt = sessionCountText(s);
const isArchived = s.archived === true;
const tools = isArchived
? `<span class="codicon codicon-edit session-rename" title="${S.pnRename}"></span>
<span class="codicon codicon-discard session-unarchive" title="${S.pnUnarchive}"></span>`
: `<span class="codicon codicon-edit session-rename" title="${S.pnRename}"></span>
<span class="codicon codicon-archive session-archive" title="${S.pnArchive}"></span>
<span class="codicon codicon-trash session-delete" title="${S.pnDelete}"></span>`;
return `<div class="session-row${isArchived ? " archived" : ""}" ${attrs}>
<span class="session-title">${escapeHtml(title)}</span>
<span class="session-tools">${tools}</span>
<span class="session-meta">${escapeHtml(relTime(s.updatedAt))}<span class="session-count" style="display:${cnt ? "" : "none"}">${escapeHtml(cnt)}</span></span>
</div>`;
}

const sessionCountText = (s) => {
const n = state.sessionCounts.get(String(s.sessionId));
return n == null ? "" : ` · ${S.pnMsgCount(n)}`;
};

/** 为已渲染但尚无消息数的行批量请求计数（去抖合并：滚动追加 / 连续输入时多批并作一次发）。
 *  批次累积在 pendingCounts：定时器只取消重排、不丢弃已累积的 id（否则 clearTimeout 会把上一批憋死）。 */
function requestSessionCounts(rows) {
for (const s of rows) {
const id = String(s.sessionId);
if (!state.sessionCounts.has(id) && !countsInFlight.has(id)) pendingCounts.add(id);
}
if (!pendingCounts.size) return;
for (const id of pendingCounts) countsInFlight.add(id);
clearTimeout(countsTimer);
countsTimer = setTimeout(() => {
const ids = [...pendingCounts];
pendingCounts.clear();
for (let i = 0; i < ids.length; i += 100) vscode.postMessage({ type: "countSessionMessages", ids: ids.slice(i, i + 100) });
}, COUNTS_DEBOUNCE_MS);
}

/** 计数回包：存索引 + 原位补进行尾（不重画列表——重画会打断滚动与重命名编辑）。 */
function patchSessionCounts(counts) {
const box = $("#sessions-list");
for (const c of Array.isArray(counts) ? counts : []) {
if (!c || typeof c.sessionId !== "string") continue;
countsInFlight.delete(c.sessionId);
const n = Number(c.messageCount) || 0;
state.sessionCounts.set(c.sessionId, n);
const cnt = box?.querySelector(`.session-row[data-id="${CSS.escape(c.sessionId)}"] .session-count`);
if (cnt) {
cnt.textContent = ` · ${S.pnMsgCount(n)}`;
cnt.style.display = "";
}
}
}

/** 行交互（事件委托，每行一个监听）：工具图标/确认按钮/空白处点击在行内分流。只绑 [from, ∞) 的新增行。 */
function bindSessionRows(from) {
const box = $("#sessions-list");
if (!box) return;
box.querySelectorAll(".session-row").forEach((el) => {
if (Number(el.dataset.i) < from || el.dataset.bound) return;
el.dataset.bound = "1";
el.addEventListener("click", onSessionRowClick);
});
}

function onSessionRowClick(e) {
const el = e.currentTarget;
const s = sessionList()[Number(el.dataset.i)];
if (!s || String(s.sessionId) !== el.dataset.id) return; // 清单已变、下标对不上：不动作（下一次重绘后恢复），防误操作别的会话
const tool = e.target.closest(".session-rename, .session-archive, .session-unarchive, .session-delete, .session-del-ok, .session-del-cancel");
if (tool?.classList.contains("session-rename")) {
editingSessionId = s.sessionId;
renderSessionsPanel();
const inp = $("#sessions-list .session-rename-input");
if (inp) { inp.focus(); inp.select(); }
return;
}
// 归档 / 取消归档：只发标记写（state.archived），列表刷新由 host sendSessions 推送。
// 当前活动会话被归档不清屏（host 侧不清 id）——会话照常续聊，仅列表里收进折叠段。
if (tool?.classList.contains("session-archive")) {
vscode.postMessage({ type: "archiveSession", id: s.sessionId, archived: true });
return;
}
if (tool?.classList.contains("session-unarchive")) {
vscode.postMessage({ type: "archiveSession", id: s.sessionId, archived: false });
return;
}
if (tool?.classList.contains("session-delete")) {
confirmingDeleteId = s.sessionId;
renderSessionsPanel();
clearTimeout(confirmDeleteTimer);
confirmDeleteTimer = setTimeout(() => {
if (confirmingDeleteId === s.sessionId) { confirmingDeleteId = null; renderSessionsPanel(); }
}, 4000);
return;
}
if (tool?.classList.contains("session-del-ok")) {
if (confirmingDeleteId !== s.sessionId) return; // 确认态已被超时/别处清掉：忽略迟到点击
clearTimeout(confirmDeleteTimer);
confirmingDeleteId = null;
vscode.postMessage({ type: "deleteSession", id: s.sessionId }); // 列表刷新由后端 sendSessions 推送触发
return;
}
if (tool?.classList.contains("session-del-cancel")) {
clearTimeout(confirmDeleteTimer);
confirmingDeleteId = null;
renderSessionsPanel();
return;
}
// 空白处点击 = 加载该会话续接（回放态由 host 的 replayStart 统一起头）
vscode.postMessage({ type: "loadSession", id: s.sessionId });
closeSessionsPanel(true);
}

/** 重命名输入框的键盘/失焦提交（全量重绘后调用；Enter 提交与随后的 blur 不会二次提交）。 */
function bindRenameInput() {
const inp = $("#sessions-list .session-rename-input");
if (!inp || inp.dataset.bound) return;
inp.dataset.bound = "1";
const commitRename = () => {
if (editingSessionId == null) return;
const s = sessionList().find((x) => x.sessionId === editingSessionId);
const val = String(inp.value ?? "").trim();
if (s && val) vscode.postMessage({ type: "renameSession", id: s.sessionId, title: val });
editingSessionId = null;
renderSessionsPanel();
};
inp.addEventListener("keydown", (e) => {
if (e.key === "Enter") { e.preventDefault(); commitRename(); }
else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editingSessionId = null; renderSessionsPanel(); }
});
inp.addEventListener("blur", commitRename);
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

function relTime(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!t) return "";
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return S.relNow;
    const m = Math.floor(s / 60);
    if (m < 60) return S.relMin(m);
    const h = Math.floor(m / 60);
    if (h < 24) return S.relHour(h);
    const d = Math.floor(h / 24);
    if (d < 30) return S.relDay(d);
    return new Date(t).toLocaleDateString(S.dateLocale);
  }

function buildForkPanel() {
if ($("#fork-panel")) return;
const panel = document.createElement("div");
panel.id = "fork-panel";
panel.className = "sessions-panel"; // 复用历史面板样式（同款浮层外观）
panel.style.display = "none";
panel.innerHTML = `
<div class="sessions-search">
<span class="codicon codicon-gist-fork"></span>
<span style="flex:1;font-size:12px;color:#888;">${S.pnForkHint}</span>
<button id="fork-close" class="icon-btn" title="${S.pnClose}"><span class="codicon codicon-close"></span></button>
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
box.innerHTML = `<div class="sessions-empty">${S.pnForkEmpty}</div>`;
return;
}
box.innerHTML = anchors
.map(
(a, i) => `
<div class="session-row fork-row" data-i="${i}" title="${S.pnForkRow}">
<span class="session-title">#${a.roundNo} ${escapeHtml(a.userPreview || S.pnNoQuestion)}</span>
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

// ———————— 回滚面板（C1 Checkpoints：各轮「发送前」检查点，点击原地截断回滚） ————————
function buildCheckpointsPanel() {
if ($("#checkpoints-panel")) return;
const panel = document.createElement("div");
panel.id = "checkpoints-panel";
panel.className = "sessions-panel"; // 复用历史面板浮层样式（同 fork-panel）
panel.style.display = "none";
panel.innerHTML = `
<div class="sessions-search">
<span class="codicon codicon-history"></span>
<span style="flex:1;font-size:12px;color:#888;">${S.pnCpHint}</span>
<button id="checkpoints-close" class="icon-btn" title="${S.pnClose}"><span class="codicon codicon-close"></span></button>
</div>
<div class="sessions-list" id="checkpoints-list"></div>`;
document.querySelector("#approval-anchor").before(panel);
$("#checkpoints-close").addEventListener("click", () => {
closeCheckpointsPanel();
const inp = $("#input");
if (inp) inp.focus();
});
}

function toggleCheckpointsPanel() {
let panel = $("#checkpoints-panel");
if (!panel) buildCheckpointsPanel();
panel = $("#checkpoints-panel");
if (panel && panel.style.display !== "none") {
closeCheckpointsPanel();
return;
}
openCheckpointsPanel();
}

function openCheckpointsPanel() {
vscode.postMessage({ type: "listCheckpoints" });
let panel = $("#checkpoints-panel");
if (!panel) buildCheckpointsPanel();
panel = $("#checkpoints-panel");
panel.style.display = "";
renderCheckpointsPanel();
}

function closeCheckpointsPanel() {
const p = $("#checkpoints-panel");
if (p) p.style.display = "none";
}

function renderCheckpointsPanel() {
const panel = $("#checkpoints-panel");
if (!panel || panel.style.display === "none") return;
const box = $("#checkpoints-list");
const cps = state.checkpoints || [];
if (!cps.length) {
box.innerHTML = `<div class="sessions-empty">${S.pnCpEmpty}</div>`;
return;
}
// CC 形态：条目 = 时钟图标 + 时间 + 副文案 "Before you sent: <摘要>"；列表末尾提示无更新检查点
const fmtTime = (iso) => {
const t = Date.parse(iso);
return Number.isFinite(t) ? new Date(t).toLocaleTimeString(S.dateLocale, { hour: "2-digit", minute: "2-digit" }) : "";
};
const dayNow = new Date().toDateString();
const html = cps.map((c, i) => {
const d = Date.parse(c.ts);
const day = Number.isFinite(d) ? new Date(d).toDateString() : dayNow;
const time = fmtTime(c.ts) + (day !== dayNow ? ` (${Number.isFinite(d) ? new Date(d).toLocaleDateString(S.dateLocale) : ""})` : "");
return `
<div class="session-row checkpoint-row" data-i="${i}" title="${S.pnCpRowTitle}">
<span class="codicon codicon-clock" style="font-size:13px;color:#888;flex-shrink:0;"></span>
<span class="checkpoint-time">${escapeHtml(time)}</span>
<span class="checkpoint-preview">Before you sent: ${escapeHtml(c.preview || S.pnCpEmptyMsg)}</span>
</div>`;
}).join("") + `<div class="sessions-empty" style="padding:8px 12px;">${S.pnCpEnd}</div>`;
box.innerHTML = html;
box.querySelectorAll(".checkpoint-row").forEach((row) => {
row.addEventListener("click", () => {
const c = cps[Number(row.dataset.i)];
if (!c) return;
closeCheckpointsPanel();
vscode.postMessage({ type: "rewindToCheckpoint", id: c.id });
});
});
}

export {
  buildSessionsPanel, toggleSessionsPanel, openSessionsPanel, closeSessionsPanel, renderSessionsPanel, patchSessionCounts,
  buildForkPanel, toggleForkPanel, renderForkPanel, closeForkPanel,
  buildCheckpointsPanel, toggleCheckpointsPanel, renderCheckpointsPanel, closeCheckpointsPanel,
};
