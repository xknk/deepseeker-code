/**
 * @file vscode/src/webview/toolbar.js
 * @description 顶部工具栏 + 生成中指示 + 模式配置面板（从 app.js 拆出，2026-09-16 防腐化拆分）：
 *  buildToolbar/syncToolbar、1s 心跳 ticker（工具行已耗时/生成中秒表，只改文本节点零重建）、
 *  模式胶囊按钮与弹出面板（btnMode/modePopover 由 composer 挂载后经 modeRefs 回填——
 *  DOM 归属 composer、交互与同步归本模块，模块级可变量经 refs 对象收口）、外链点击委托。
 */
import { vscode, $, state } from "./state.js";
import { toggleSessionsPanel, toggleForkPanel } from "./panels.js";

// 模式配置面板元素（buildComposer 挂载后回填；交互/同步逻辑在本模块）
export const modeRefs = { btn: null, popover: null };

// ———————— 工具栏 ————————
export function buildToolbar() {
const tb = $("#toolbar");
tb.innerHTML = `
<div class="brand"><span class="logo codicon codicon-sparkle"></span> <span class="brand-name">DeepSeeker-Code</span> <span id="busy-dot" class="dot"></span></div>
<button id="btn-project-root" title="agent 当前工作的项目根（点击切换）" class="project-root"><span class="codicon codicon-root-folder"></span><span id="project-root-name">…</span></button>
<div class="actions">
<button id="btn-new" title="新会话（在新页签打开，当前对话保留）" class="icon-btn"><span class="codicon codicon-comment-discussion"></span></button>
<button id="btn-sessions" title="历史会话" class="icon-btn"><span class="codicon codicon-history"></span></button>
<button id="btn-fork" title="分叉当前会话" class="icon-btn"><span class="codicon codicon-gist-fork"></span></button>
</div>`;
$("#btn-project-root").addEventListener("click", () => vscode.postMessage({ type: "selectProjectRoot" }));
$("#btn-new").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
$("#btn-sessions").addEventListener("click", () => {
toggleSessionsPanel();
});
$("#btn-fork").addEventListener("click", () => {
toggleForkPanel();
});
}
export function syncToolbar() {
const dot = $("#busy-dot");
if (dot) {
dot.className = "dot" + (state.busy ? " busy" : "");
dot.title = state.busy ? "生成中…" : "就绪";
}
const btnSend = $("#btn-send");
if (btnSend) {
btnSend.textContent = state.busy ? "■" : "↑";
btnSend.title = state.busy ? "中止生成" : "发送 (Enter)";
}
// 生成中指示条：显示在输入框上方（spinner 由 codicon 自转，秒表由 1s ticker 驱动）
const strip = $("#busy-strip");
if (strip) {
strip.hidden = !state.busy;
if (state.busy) {
const lbl = $("#busy-label");
if (lbl) lbl.textContent = `生成中… ${state.busySince ? Math.round((Date.now() - state.busySince) / 1000) : 0}s`;
}
}
// 项目根：末段文件夹名 + 完整路径 title（让用户一眼看到 agent 工作在哪个项目）
const rootName = $("#project-root-name");
if (rootName) {
const p = state.projectRoot || "";
const seg = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "未选择";
rootName.textContent = seg;
rootName.parentElement.title = p ? `项目根：${p}（点击切换）` : "未选择项目根（点击选择）";
}
updateModeToggle();
}
// 1s 心跳：只改文本节点——工具行已耗时（.t-elapsed）与生成中条秒表；无行在跑时零 DOM 写。
//   刻意不做整行重建（rebuildRow 会闪 + 丢展开态）；spinner 的连续动画由 codicon CSS 无限旋转承担。
setInterval(() => {
document.querySelectorAll(".t-elapsed[data-s]").forEach((el) => {
const s = Number(el.dataset.s);
if (s) el.textContent = `${Math.max(1, Math.round((Date.now() - s) / 1000))}s`;
});
if (state.busy && state.busySince) {
const lbl = $("#busy-label");
if (lbl) lbl.textContent = `生成中… ${Math.round((Date.now() - state.busySince) / 1000)}s`;
}
}, 1000);

// —— 模式配置面板：胶囊按钮 toggle 显示/隐藏 ——
export function toggleModePopover() {
const modePopover = modeRefs.popover;
if (!modePopover) return;
modePopover.style.display = modePopover.style.display === "none" ? "" : "none";
}
// —— 同步胶囊按钮文字与面板内各模式值 ——
export function updateModeToggle() {
const btnMode = modeRefs.btn;
const modePopover = modeRefs.popover;
if (!btnMode || !modePopover) return;
const m = state.planMode ? "plan" : state.autoMode ? "auto" : "manual";
const label = btnMode.querySelector(".mode-label");
label.textContent = m === "plan" ? "计划" : m === "auto" ? "自动" : "手动";
const ic = btnMode.querySelector(".codicon");
if (ic) ic.className = "codicon " + (m === "plan" ? "codicon-list-tree" : m === "auto" ? "codicon-sync" : "codicon-comment");
btnMode.classList.toggle("on", m !== "manual");
// 输入框模式标识：计划/自动 → 边框高亮 + 悬浮徽标（对齐 Claude Code 的模式提示）
const shell = $("#composer .composer-shell");
if (shell) {
shell.classList.toggle("plan-on", m === "plan");
shell.classList.toggle("auto-on", m === "auto");
}
modePopover.querySelectorAll(".mode-option").forEach((row) => {
row.classList.toggle("on", row.dataset.mode === m);
});
const sw = $("#think-switch");
if (sw) {
sw.querySelectorAll(".think-opt").forEach((o) => {
o.classList.toggle("on", o.dataset.level === state.thinkingLevel);
});
}
}
// —— 统一委托：胶囊按钮 toggle + 点击外部关闭（双保险，即使元素级监听失效也能响应）——
document.addEventListener("click", (e) => {
const btnMode = modeRefs.btn;
const modePopover = modeRefs.popover;
if (!btnMode || !modePopover) return;
const inBtn = btnMode.contains(e.target);
const inPop = modePopover.contains(e.target);
if (inBtn) {
toggleModePopover();
return;
}
if (!inPop && modePopover.style.display !== "none") {
modePopover.style.display = "none";
}
});
document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a");
    if (a) {
      e.preventDefault();
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) {
        // @ts-ignore
        window.open(href, "_blank");
      }
    }
  });
