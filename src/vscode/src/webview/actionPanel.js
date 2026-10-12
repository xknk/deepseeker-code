/**
 * @file vscode/src/webview/actionPanel.js
 * @description 统一动作面板（对标 CC 输入框 "/" 按钮，2026-10-12 第一批）：
 *  顶部过滤框（模糊匹配，非前缀）+ 分组菜单 Context / Model / Commands。
 *  - Context：Attach file / Clear conversation / Export conversation（第二批将并入 Mention file / Bookmarks）
 *  - Model：Switch model（右侧显当前模型 id）/ Effort（右槽点阵滑块，点击定位档位、行点击轮换）
 *  - Commands：本地 SLASH 命令全量 + core 自定义命令（与输入框 "/" 菜单同一数据源，A3 挂接）
 *  ★ 形态对齐 CC（2026-10-12 用户定版）：纯文本行、无行首图标、句首大写分组标题、
 *    说明文字不上行（Commands 的描述右对齐淡色），弹菜单类动作带 "…" 后缀。
 *  键盘 ↑↓/Enter/Esc 可达；动作项直接执行，命令项沿用 slash 菜单的回填/发送逻辑（经 bindComposerBridge
 *  注入 buildComposer 闭包能力，避免模块环依赖）。浮层挂 composer-shell 下（absolute 悬浮于输入框上方，
 *  零布局影响，同 mode-popover 收编机制）。
 */
import { vscode, $, state } from "./state.js";
import { escapeHtml } from "./markdown.js";
import { clearMessages, addInfo } from "./rows.js";
import { syncToolbar, modeRefs } from "./toolbar.js";
import { toggleModelPicker, closeModelPicker } from "./modals.js";

// ———— composer 闭包能力桥（buildComposer 挂载后回填） ————
// runCommand：把命令交给输入框现有路径执行（带参回填输入框 / 无参直发），面板自身不复刻 doSend。
// getCommands：实时取「SLASH + core 自定义命令」合并表（自定义命令引擎就绪晚于首开面板也能吃到）。
// openFilePicker：触发附加文件（host showOpenDialog，大小自动分流）。
// getInputText/insertText：B3 书签读写输入框现文（Bookmark current input / Bookmarks 一键插入）。
const bridge = { runCommand: null, getCommands: null, openFilePicker: null, getInputText: null, insertText: null };
export const bindComposerBridge = (b) => {
  bridge.runCommand = b.runCommand;
  bridge.getCommands = b.getCommands;
  bridge.openFilePicker = b.openFilePicker;
  bridge.getInputText = b.getInputText;
  bridge.insertText = b.insertText;
};

// ———— 面板项定义：{ group, label, right?, action }（hint 仅参与模糊过滤，不上行——CC 同款素净） ————
const GROUP_CONTEXT = "Context";
const GROUP_MODEL = "Model";
const GROUP_BOOKMARKS = "Bookmarks";
const GROUP_COMMANDS = "Commands";

/** Effort 档位（与模式面板 think-switch 同一取值域）；行点击轮换、点阵点击定位。 */
const THINK_LEVELS = ["off", "high", "max"];
const setThinking = (level) => {
  state.thinkingLevel = level;
  vscode.postMessage({ type: "setThinking", level });
  syncToolbar();
  // 重建 items 再重绘：right/label 里的档位是打开时快照，不重建会显示旧值（面板保持打开，同 CC 滑杆语义）
  items = [...buildActionItems(), ...buildCommandItems()];
  renderActionPanel();
};
const cycleThinking = () => setThinking(THINK_LEVELS[(THINK_LEVELS.indexOf(state.thinkingLevel) + 1) % THINK_LEVELS.length] || "high");

/** B3 书签组：host globalState 清单（state.bookmarks，ready/add/remove 后推）。行点击插入输入框、
 *  右槽 × 删除；label 取首行截断（全文在 hint 参与模糊过滤）。 */
const bookmarkItems = () => (state.bookmarks || []).map((b) => ({
  group: GROUP_BOOKMARKS,
  label: String(b.text || "").split("\n")[0].slice(0, 60) || "（空书签）",
  hint: String(b.text || ""),
  right: { kind: "remove", id: String(b.id ?? "") },
  action: () => { closeActionPanel(true); bridge.insertText?.(String(b.text || "")); },
}));

/** Context / Model / Bookmarks 三组动作项（Model 组的 right 是实时值，每次打开/重绘时现取）。 */
const buildActionItems = () => [
  {
    group: GROUP_CONTEXT, label: "Attach file...",
    hint: "选文件：≤100KB 全文入消息，大文件自动转引用（模型 read_file）",
    right: { kind: "value", value: "附加文件（大小自动分流）" },
    action: () => { closeActionPanel(); bridge.openFilePicker?.(); },
  },
  {
    group: GROUP_CONTEXT, label: "Bookmark current input...",
    hint: "把输入框当前内容收藏为书签（常用 prompt 复用；也可 /bookmark <文本>）",
    action: () => {
      closeActionPanel();
      const t = (bridge.getInputText?.() || "").trim();
      if (!t) {
        addInfo("🔖 输入框为空——先写好要收藏的 prompt 再收藏，或用 /bookmark <文本> 直接收藏。");
        return;
      }
      vscode.postMessage({ type: "bookmarkAdd", text: t });
    },
  },
  {
    group: GROUP_CONTEXT, label: "Clear conversation",
    hint: "清空当前屏幕（同 /clear）",
    right: { kind: "value", value: "清空当前屏幕（同 /clear）" },
    action: () => { closeActionPanel(); clearMessages(); },
  },
  {
    group: GROUP_CONTEXT, label: "Export conversation",
    hint: "导出当前会话为 Markdown 文件（同 /export）",
    right: { kind: "value", value: "导出 Markdown（同 /export）" },
    action: () => { closeActionPanel(); vscode.postMessage({ type: "exportConversation" }); },
  },
  {
    group: GROUP_MODEL, label: "Switch model...",
    hint: "弹出候选选择器（同 /switch）",
    right: { kind: "value", value: state.model || "默认" },
    action: () => { closeActionPanel(); toggleModelPicker(); },
  },
  {
    group: GROUP_MODEL, label: `Effort（${state.thinkingLevel}）`,
    hint: "思考等级：点击行轮换 off / high / max，点右侧圆点直接定位",
    right: { kind: "slider", levels: THINK_LEVELS, value: state.thinkingLevel },
    action: () => cycleThinking(),
  },
  ...bookmarkItems(),
];

/** Commands 组：合并表 → 面板项（命令项沿用回填/发送逻辑，零额外分支；描述右对齐淡色）。 */
const buildCommandItems = () => (bridge.getCommands?.() || []).map((s) => ({
  group: GROUP_COMMANDS,
  label: s.cmd,
  hint: (s.hint || "") + (s.arg ? "（需参数：回填输入框补全）" : ""),
  right: { kind: "value", value: (s.hint || "") + (s.arg ? " · 需参数" : "") },
  action: () => { closeActionPanel(); bridge.runCommand?.(s); },
}));

// ———— 模糊过滤：q 为 text 的子序列即命中（非前缀；对标 CC Filter actions） ————
const fuzzyMatch = (q, ...texts) => {
  if (!q) return true;
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  let i = 0;
  for (const ch of hay) {
    if (ch === q[i]) i++;
    if (i >= q.length) return true;
  }
  return false;
};

// ———— 面板 DOM（懒建，挂 composer-shell 下） ————
let panelEl = null;
let filterText = "";
let items = []; // 全量项（打开时构建）
let filtered = []; // 过滤后可见项
let selIdx = 0;

const buildPanel = () => {
  const shell = document.querySelector("#composer .composer-shell");
  if (!shell) return;
  panelEl = document.createElement("div");
  panelEl.id = "action-panel";
  panelEl.className = "action-panel"; // ★ 类名必须显式设：CSS 全部按 .action-panel 类选择器写，
  //   漏了这行面板就退化成文档流元素——把消息区挤没（输入框顶到页顶）、超视口部分被截断。
  panelEl.style.display = "none";
  panelEl.innerHTML = `
<input id="action-filter" type="text" placeholder="Filter actions..." spellcheck="false"/>
<div class="action-list" id="action-list"></div>`;
  shell.appendChild(panelEl);
  const inp = panelEl.querySelector("#action-filter");
  inp.addEventListener("input", () => { filterText = inp.value.trim().toLowerCase(); selIdx = 0; renderActionPanel(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (!filtered.length) return;
      selIdx = e.key === "ArrowUp"
        ? (selIdx <= 0 ? filtered.length - 1 : selIdx - 1)
        : (selIdx + 1) % filtered.length;
      renderActionPanel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[selIdx];
      if (it) it.action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeActionPanel(true);
    }
  });
};

/** 打开时收拢其它浮层：模式面板/模型选择器/"+"附件菜单同锚区，并存会叠罗汉。
 *  attach-menu 走 getElementById（composer 闭包私有，经 import 收编会造模块环）。 */
const collapseSiblings = () => {
  if (modeRefs.popover) modeRefs.popover.style.display = "none";
  closeModelPicker();
  const attach = document.getElementById("attach-menu");
  if (attach) attach.style.display = "none";
};

export const toggleActionPanel = () => {
  if (panelEl && panelEl.style.display !== "none") {
    closeActionPanel();
    return;
  }
  openActionPanel();
};

export const openActionPanel = () => {
  if (!panelEl) buildPanel();
  if (!panelEl) return;
  collapseSiblings();
  filterText = "";
  selIdx = 0;
  items = [...buildActionItems(), ...buildCommandItems()];
  const inp = panelEl.querySelector("#action-filter");
  if (inp) { inp.value = ""; }
  renderActionPanel();
  panelEl.style.display = "";
  if (inp) { inp.focus(); inp.select(); }
};

export const closeActionPanel = (refocus = false) => {
  if (panelEl) panelEl.style.display = "none";
  if (refocus) {
    const inp = $("#input");
    if (inp) inp.focus();
  }
};

/** 右槽控件 HTML：value = 淡色值文本；slider = CC 同款点阵滑块（当前档放大亮显，点圆点直接定位）；
 *  remove = 删除钮（B3 书签行右槽 ×）。 */
const renderRight = (it) => {
  if (!it.right) return "";
  if (it.right.kind === "slider") {
    const dots = it.right.levels
      .map((lv) => `<span class="effort-dot${lv === it.right.value ? " on" : ""}" data-level="${lv}" title="${lv}"></span>`)
      .join("");
    return `<span class="action-right effort-dots">${dots}</span>`;
  }
  if (it.right.kind === "remove") {
    return `<span class="action-right action-remove" data-remove="${escapeHtml(it.right.id)}" title="删除书签"><span class="codicon codicon-close"></span></span>`;
  }
  return `<span class="action-right">${escapeHtml(String(it.right.value ?? ""))}</span>`;
};

/** 重绘列表（过滤 + 分组标题 + 右侧控件槽），保持面板打开状态的调用（Effort 轮换）安全。 */
function renderActionPanel() {
  if (!panelEl) return;
  const list = panelEl.querySelector("#action-list");
  filtered = items.filter((it) => fuzzyMatch(filterText, it.label, it.hint));
  if (selIdx >= filtered.length) selIdx = Math.max(0, filtered.length - 1);
  if (!filtered.length) {
    list.innerHTML = `<div class="action-empty">无匹配动作</div>`;
    return;
  }
  let html = "";
  let lastGroup = null;
  filtered.forEach((it, i) => {
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      html += `<div class="action-group-title">${escapeHtml(it.group)}</div>`;
    }
    html += `<div class="action-item${i === selIdx ? " selected" : ""}" data-i="${i}">` +
      `<span class="action-label">${escapeHtml(it.label)}</span>` +
      renderRight(it) +
      `</div>`;
  });
  list.innerHTML = html;
  const selEl = list.querySelector(".action-item.selected");
  if (selEl) selEl.scrollIntoView({ block: "nearest" });
  list.querySelectorAll(".action-item").forEach((el) => {
    el.addEventListener("click", () => {
      const it = filtered[Number(el.dataset.i)];
      // withSuppress：action 内重绘会摘除本行，冒泡到 document 的外点关闭委托会误判（见其注释）
      if (it) withSuppress(it.action);
    });
  });
  // 点阵滑块的圆点：点击直接定位档位（stopPropagation 防触发行点击的轮换；setThinking 重绘同需抑制）
  list.querySelectorAll(".effort-dot").forEach((dot) => {
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      withSuppress(() => setThinking(dot.dataset.level));
    });
  });
  // B3 书签删除钮：本地先删（面板保持打开、行即时消失），host globalState 同步 + 广播回推
  list.querySelectorAll(".action-remove").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = el.dataset.remove || "";
      vscode.postMessage({ type: "bookmarkRemove", id });
      state.bookmarks = (state.bookmarks || []).filter((b) => String(b.id ?? "") !== id);
      items = [...buildActionItems(), ...buildCommandItems()];
      renderActionPanel();
    });
  });
}

// ———— 点击外部关闭（与 toolbar 模式面板同一委托形态；面板/"/"按钮内点击不关） ————
// ★ suppressClose：行 action 重绘（innerHTML 替换）会让被点元素从面板摘除，click 冒到 document 时
//   contains(e.target) 已为 false——不抑制会把「面板内选择」误判成「点外面」直接关窗（Effort 行踩过）。
let suppressClose = false;
const withSuppress = (fn) => {
  suppressClose = true;
  setTimeout(() => { suppressClose = false; }, 0); // 本轮 click 冒泡结束后恢复
  fn();
};
document.addEventListener("click", (e) => {
  if (!panelEl || panelEl.style.display === "none") return;
  if (suppressClose) return;
  if (panelEl.contains(e.target)) return;
  if (e.target.closest?.("#btn-actions")) return; // 按钮自身 toggle（composer 侧 stopPropagation 双保险）
  panelEl.style.display = "none";
});
