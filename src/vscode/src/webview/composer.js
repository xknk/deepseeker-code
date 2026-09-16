/**
 * @file vscode/src/webview/composer.js
 * @description 底部输入区（从 app.js 拆出，2026-09-16 防腐化拆分）：
 *  输入框自适应高度、发送/中止一体按钮、文件入库与贴图（file picker + Ctrl+V 粘贴共用 ingestImageFile）、
 *  本地斜杠命令（与 CLI LOCAL_COMMAND_NAMES 对齐）与 / 菜单（含 core 注册的自定义命令合并）、
 *  模式胶囊按钮与配置面板的 DOM 挂载（交互逻辑在 toolbar.js，经 modeRefs 回填引用）。
 */
import { vscode, $, state } from "./state.js";
import { escapeHtml } from "./markdown.js";
import { addInfo, clearMessages, clearPendingImages, appendImagePreview } from "./rows.js";
import { toggleSessionsPanel, toggleForkPanel } from "./panels.js";
import { syncToolbar, toggleModePopover, updateModeToggle, modeRefs } from "./toolbar.js";

// ———————— 本地斜杠命令（与 CLI 对齐） ————————
export function maybeLocalCommand(text) {
if (!text.startsWith("/")) return false;
const parts = text.slice(1).trim().split(/\s+/);
const cmd = parts[0];
const arg = parts.slice(1).join(" ");
switch (cmd) {
case "plan": {
state.planMode = !state.planMode;
vscode.postMessage({ type: "setPlanMode", on: state.planMode });
addInfo(`计划模式：${state.planMode ? "开" : "关"}`);
syncToolbar();
return true;
}
case "auto": {
state.autoMode = !state.autoMode;
vscode.postMessage({ type: "setAutoMode", on: state.autoMode });
addInfo(`自动模式：${state.autoMode ? "开" : "关"}`);
syncToolbar();
return true;
}
case "model":
if (arg) {
state.model = arg;
vscode.postMessage({ type: "setModel", model: arg });
addInfo(`模型：${arg}（下次回复生效，重载窗口后保持）`);
syncToolbar();
} else {
addInfo(`当前模型：${state.model || "默认（DEEP_SEEK_MODEL）"}\n用法：/model <模型id> 直输切换，或 /switch 弹出候选选择器`);
}
return true;
case "switch":
// ★ 一律走 host 回环（pickModel → openModelPicker 带最新候选）：设置项 deepseekerCode.models
//   改动即时生效。此前快照命中时本地直开，但 state.models 只在 state 消息时刷新——
//   改了设置没有新快照落地就会吃到旧清单（删掉的模型还出现在选择器里）。
//   消息回环天然跨事件，Enter 冒泡误确认（原「延迟一拍」防的坑）不会发生。
vscode.postMessage({ type: "pickModel" });
return true;
case "thinking":
if (["off", "high", "max"].includes(arg)) {
state.thinkingLevel = arg;
vscode.postMessage({ type: "setThinking", level: arg });
addInfo(`思考等级：${arg}`);
syncToolbar();
} else {
addInfo(`当前思考等级：${state.thinkingLevel}\n用法：/thinking off|high|max`);
}
return true;
case "lang":
if (arg === "zh" || arg === "en") {
state.locale = arg;
vscode.postMessage({ type: "setLocale", locale: arg });
addInfo(`界面语言：${arg === "zh" ? "中文" : "English"}（AI 回复语言默认跟随每轮提问自动判断；纯代码/无文字轮次以此语言为准）`);
syncToolbar();
} else if (!arg) {
addInfo(`当前界面语言：${state.locale === "zh" ? "中文" : "English"}\n用法：/lang zh|en`);
}
return true;
case "output-style":
case "usage":
case "context":
case "permissions":
case "mcp":
case "hooks":
case "trust":
case "debug":
// ★ 观测/管理类：数据在扩展宿主进程（trace/registry/store）采集，localObs 往返后 info 行回显
vscode.postMessage({ type: "localObs", cmd, arg });
return true;
case "fork":
toggleForkPanel();
vscode.postMessage({ type: "listForkAnchors" });
return true;
case "clear":
clearMessages();
return true;
case "new":
vscode.postMessage({ type: "newSession" });
return true;
case "sessions":
toggleSessionsPanel();
return true;
case "help":
addInfo("/help 帮助 · /status 状态 · /plan 计划 · /auto 自动 · /model 模型 · /thinking 思考 · /lang 语言 · /output-style 风格 · /sessions 历史 · /fork 分叉 · /usage 用量 · /context 上下文 · /permissions 权限 · /mcp · /hooks · /trust 信任 · /debug 排障 · /new 新会话 · /clear 清屏\n输入 / 查看全部命令（含自定义命令），↑↓ 选择、Enter 执行");
return true;
case "status":
addInfo(`计划模式：${state.planMode ? "开" : "关"} · 自动模式：${state.autoMode ? "开" : "关"} · 思考：${state.thinkingLevel} · 语言：${state.locale}${state.model ? " · 模型：" + state.model : ""}${state.projectRoot ? " · 根目录：" + state.projectRoot : ""}`);
return true;
default:
return false; // 非本地命令 → 交给 agent（自定义 slash 命令）
}
}

function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

// ★ / 菜单刷新的跨模块出口：updateSlashMenu 依赖 buildComposer 闭包内的 input/menu/slashItems，
//   buildComposer 挂载后回填引用。此前 app.js 单文件时代 onMessage 的 "commands" 分支直接调用
//   闭包内函数 = ReferenceError（潜在 bug，host 推自定义命令必炸）——拆分后经此转发自然修复。
let updateSlashMenuRef = null;
export const updateSlashMenu = () => updateSlashMenuRef?.();

function buildComposer() {
const c = $("#composer");
c.innerHTML = `
<div class="composer-shell">
<div class="busy-strip" id="busy-strip" hidden><span class="codicon codicon-loading codicon-modifier-spin"></span><span id="busy-label">生成中…</span></div>
<div class="composer-line">
<span class="composer-prompt">❯</span>
<textarea id="input" rows="1" placeholder="输入消息，/ 查看命令" spellcheck="false"></textarea>
</div>
<div class="composer-bar">
<div class="composer-bar-left">
<button class="icon-btn" id="btn-file" title="上传文件入库（文本，拼入消息）"><span class="codicon codicon-new-file"></span></button>
<button class="icon-btn" id="btn-image" title="上传图片（识别需配置图像理解 MCP）"><span class="codicon codicon-file-media"></span></button>
<input type="file" id="file-input" style="display:none" />
<input type="file" id="image-input" accept="image/*" style="display:none" />
</div>
<div class="composer-bar-right">
<button class="mode-toggle" id="btn-mode" title="模式设置">
<span class="codicon codicon-comment"></span>
<span class="mode-label">手动</span>
</button>
<button class="composer-send-btn" id="btn-send" title="发送 (Enter)">↑</button>
</div>
</div>
<div class="mode-popover" id="mode-popover" style="display:none">
<div class="mode-section">
<div class="mode-title">Modes</div>
<div class="mode-option" data-mode="manual">
<span class="codicon codicon-comment"></span>
<div class="mode-opt-text"><div class="mode-opt-name">手动</div><div class="mode-opt-desc">每次工具执行前均需你确认</div></div>
<span class="mode-check codicon codicon-check"></span>
</div>
<div class="mode-option" data-mode="auto">
<span class="codicon codicon-sync"></span>
<div class="mode-opt-text"><div class="mode-opt-name">自动</div><div class="mode-opt-desc">自动执行编辑与工具调用</div></div>
<span class="mode-check codicon codicon-check"></span>
</div>
<div class="mode-option" data-mode="plan">
<span class="codicon codicon-list-tree"></span>
<div class="mode-opt-text"><div class="mode-opt-name">计划</div><div class="mode-opt-desc">先产出方案，审批后再实施</div></div>
<span class="mode-check codicon codicon-check"></span>
</div>
</div>
<div class="mode-divider"></div>
<div class="mode-think">
<span class="think-label">思考 · Effort</span>
<div class="think-switch" id="think-switch">
<span class="think-opt" data-level="off">off</span>
<span class="think-opt" data-level="high">high</span>
<span class="think-opt" data-level="max">max</span>
</div>
</div>
</div>
<div class="slash-menu" id="slash-menu" style="display:none"></div>
<div class="composer-attachments" id="composer-attachments"></div>
<span class="mode-badge plan">⏻ plan mode on（只读调研 → 方案审批 → 实现）</span>
<span class="mode-badge auto">⏻ auto-accept edits on</span>
</div>
`;
const input = $("#input");
const menu = $("#slash-menu");
const btnSend = $("#btn-send");
modeRefs.btn = $("#btn-mode");
modeRefs.popover = $("#mode-popover");

// 命令驱动表：全部功能经斜杠命令交互，UI 零控件。
// ★ 与 CLI 的 LOCAL_COMMAND_NAMES 对齐（去掉无意义的 /exit）；obs=true 的命令数据在扩展宿主
//   进程采集（trace/registry/store），经 localObs 消息往返后以 info 行回显。
//   引擎加载完成后再合并 core 注册的自定义命令（state.customCommands，/ 菜单常驻可见）。
const SLASH = [
{ cmd: "/help", hint: "查看帮助与快捷键", arg: false },
{ cmd: "/status", hint: "查看当前模型/会话/模式", arg: false },
{ cmd: "/plan", hint: "切换计划模式（只读调研→审批→实现）", arg: false },
{ cmd: "/auto", hint: "切换自动模式（编辑分类器放行，高危转人工）", arg: false },
{ cmd: "/model", hint: "切换模型（直输）：/model <模型id>", arg: true },
{ cmd: "/switch", hint: "切换模型：弹出候选选择器", arg: false },
{ cmd: "/thinking", hint: "切换思考等级：/thinking <off|high|max>", arg: true },
{ cmd: "/lang", hint: "切换界面语言：/lang <zh|en>", arg: true },
{ cmd: "/output-style", hint: "切换输出风格：/output-style <name|off>", arg: true, obs: true },
{ cmd: "/sessions", hint: "选择并载入历史会话（续接对话）", arg: false },
{ cmd: "/fork", hint: "从当前会话的某轮回复处分叉出新会话", arg: false },
{ cmd: "/usage", hint: "查看 token 用量（主/子 agent、缓存命中、近 7 天使用日志）", arg: false, obs: true },
{ cmd: "/context", hint: "查看上下文窗口治理（阈值、填充率、已归档）", arg: false, obs: true },
{ cmd: "/permissions", hint: "查看已加载的权限规则（allow/ask/deny）", arg: false, obs: true },
{ cmd: "/mcp", hint: "查看已连接的 MCP server 与工具数", arg: false, obs: true },
{ cmd: "/hooks", hint: "查看已注册的 hook 规则", arg: false, obs: true },
{ cmd: "/trust", hint: "管理已信任目录（列出 / 撤销）", arg: true, obs: true },
{ cmd: "/debug", hint: "排障快照（session/cwd/模型/配置/环境）", arg: false, obs: true },
{ cmd: "/new", hint: "新会话（新页签，当前对话保留）", arg: false },
{ cmd: "/clear", hint: "清空当前屏幕", arg: false },
];

let slashItems = [];
let selIdx = -1;

function runSlash(s) {
if (s.arg) {
input.value = s.cmd + " ";
input.focus();
autoGrow(input);
} else {
input.value = s.cmd;
doSend();
}
updateSlashMenu();
}

/** 合并本地命令表 + core 注册的自定义命令（引擎就绪后经 "commands" 消息送达；本地同名优先）。 */
function allSlashItems() {
const seen = new Set(SLASH.map((s) => s.cmd));
const extra = (state.customCommands || [])
.filter((c) => c && c.name && !seen.has("/" + c.name))
.map((c) => ({ cmd: "/" + c.name, hint: c.description || "自定义命令", arg: false, custom: true }));
return SLASH.concat(extra);
}

function updateSlashMenu() {
const v = input.value;
if (!v.startsWith("/")) { menu.style.display = "none"; slashItems = []; selIdx = -1; return; }
const q = v.toLowerCase();
// ★ 不再截前 6 条：菜单 CSS 限高可滚动，选中项 scrollIntoView 跟随（修「命令显示不全」）
slashItems = allSlashItems().filter((s) => s.cmd.startsWith(q) || q.startsWith(s.cmd));
if (!slashItems.length) { menu.style.display = "none"; slashItems = []; selIdx = -1; return; }
selIdx = Math.min(Math.max(selIdx, 0), slashItems.length - 1);
menu.innerHTML = slashItems.map((s, i) =>
`<div class="slash-item${i === selIdx ? " selected" : ""}" data-i="${i}"><span class="slash-cmd">${s.cmd}</span><span class="slash-hint">${escapeHtml(s.hint)}</span></div>`
).join("");
menu.style.display = "";
const selEl = menu.querySelector(".slash-item.selected");
if (selEl) selEl.scrollIntoView({ block: "nearest" });
menu.querySelectorAll(".slash-item").forEach((el) => {
el.addEventListener("click", () => runSlash(slashItems[Number(el.dataset.i)]));
});
}
updateSlashMenuRef = updateSlashMenu; // 挂载后回填跨模块出口（见文件头说明）

const doSend = () => {
const text = input.value;
const hasPending = (state.pendingImages || []).length > 0;
if (!text.trim() && !hasPending) return;
if (maybeLocalCommand(text)) {
input.value = "";
autoGrow(input);
updateSlashMenu();
return;
}
// ★ 多模态：待发贴图随 submit 上送（vision 开启时才有积累），随后清空 chip 与暂存
if (hasPending) {
vscode.postMessage({
type: "submit",
text,
attachments: state.pendingImages.map((p) => ({ name: p.name, mime: p.mime, base64: p.base64, ...(p.savedPath ? { path: p.savedPath } : {}) })),
});
clearPendingImages();
} else {
vscode.postMessage({ type: "submit", text });
}
input.value = "";
autoGrow(input);
input.focus();
updateSlashMenu();
};
// ★ 全键盘驱动：↑↓ 移动选择命令，Enter 执行选中项；无菜单时 Enter 发送
input.addEventListener("keydown", (e) => {
if (e.key === "ArrowUp" || e.key === "ArrowDown") {
if (menu.style.display !== "none" && slashItems.length) {
e.preventDefault();
selIdx = e.key === "ArrowUp"
? (selIdx <= 0 ? slashItems.length - 1 : selIdx - 1)
: (selIdx + 1) % slashItems.length;
updateSlashMenu();
}
return;
}
if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
e.preventDefault();
if (menu.style.display !== "none" && slashItems.length) {
const sel = slashItems[selIdx >= 0 ? selIdx : 0];
// ★ 仅「输入仍是选中命令名的前缀」（如 /lan → /lang）才补全回填；已打到参数阶段
//   （/lang zh）或恰好敲完命令名（/lang，无参=查看当前值）时直接发送。
//   修：带参命令（/lang /model /thinking 等）菜单常驻时 Enter 回填抹掉已输参数。
if (sel.cmd !== input.value && sel.cmd.toLowerCase().startsWith(input.value.toLowerCase())) {
runSlash(sel);
} else {
doSend();
}
return;
}
doSend();
}
});
input.addEventListener("input", () => { autoGrow(input); updateSlashMenu(); });
input.addEventListener("focus", () => updateSlashMenu());
input.addEventListener("blur", () => setTimeout(() => { menu.style.display = "none"; }, 150));
// ★ 菜单内 mousedown 不夺焦点（防拖滚动条/点条目时 blur 收起菜单）；click 仍正常触发
menu.addEventListener("mousedown", (e) => e.preventDefault());

// 发送/中止一体按钮：空闲 ↑（发送），生成中 ■（中止）
btnSend.addEventListener("click", () => {
if (state.busy) {
vscode.postMessage({ type: "abort" });
} else {
doSend();
}
});
// ★ 文件入库（文本）：webview FileReader 直接读文本拼入输入框——零核心链路改动。
//   大文件（>100KB）拒绝全量入库，引导改用 read_file（避免上下文爆炸）。
const btnFile = $("#btn-file");
const btnImage = $("#btn-image");
const fileInput = $("#file-input");
const imageInput = $("#image-input");
btnFile.addEventListener("click", () => fileInput.click());
btnImage.addEventListener("click", () => {
addInfo("🖼 图片将随消息直达模型（chip 上的 × 可移除待发送的图）；若模型不支持图片会自动降级为文本处理。");
imageInput.click();
});
fileInput.addEventListener("change", () => {
const f = fileInput.files && fileInput.files[0];
fileInput.value = "";
if (!f) return;
if (f.size > 100 * 1024) { addInfo(`📎 文件 ${f.name} 较大（>100KB），已忽略入库。建议直接在对话里让助手用 read_file 读取：${f.name}`); return; }
const reader = new FileReader();
reader.onload = () => {
const content = String(reader.result ?? "");
input.value += `\n\n📎 文件 ${f.name}：\n\`\`\`\n${content}\n\`\`\`\n`;
autoGrow(input);
input.focus();
addInfo(`📎 已入库文件：${f.name}`);
};
reader.onerror = () => addInfo(`📎 读取文件失败：${f.name}`);
reader.readAsText(f);
});
// ★ 贴图统一入口（file picker 与 Ctrl+V 粘贴共用 ingestImageFile）——零配置多模态：
//   不再按 state.vision 分叉：图片进 pendingImages 待发（chip 带 × 可移除）随 submit 上送（base64 直达，
//   乐观发送，core 侧按端点实测自学习判定能力）；同时无条件 uploadImage 落工作区 tmp 拿存档路径——
//   回包路径只回填到待发附件（随 submit 上送）：乐观成功时模型可经工具复读原图，端点拒绝降级时
//   路径线索随 wire 尾注给模型（图像识别 MCP 中转读图）。
const ingestImageFile = (f) => {
if (!f) return;
if (f.size > 8 * 1024 * 1024) { addInfo(`🖼 图片 ${f.name} 过大（>8MB），已忽略`); return; }
const reader = new FileReader();
reader.onload = () => {
const dataUrl = String(reader.result ?? "");
const commaIdx = dataUrl.indexOf(",");
const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : "";
const mime = f.type || "image/png";
state.pendingImages.push({ name: f.name, mime, base64, dataUrl });
appendImagePreview(dataUrl, f.name, true);
vscode.postMessage({ type: "uploadImage", name: f.name, mime, base64 });
addInfo(`🖼 已添加待发送图片：${f.name}`);
};
reader.onerror = () => addInfo(`🖼 读取图片失败：${f.name}`);
reader.readAsDataURL(f);
};
imageInput.addEventListener("change", () => {
const f = imageInput.files && imageInput.files[0];
imageInput.value = "";
ingestImageFile(f);
});
// ★ Ctrl+V 粘贴贴图：截图工具（微信/QQ/Snipaste 等）的剪贴板位图直接粘贴入待发；
//   只拦截图片项，文本粘贴不受影响。剪贴板位图无业务文件名（Chromium 恒为 image.png），兜底 pasted-<时间戳>.png。
input.addEventListener("paste", (e) => {
const items = e.clipboardData && e.clipboardData.items;
if (!items) return;
const images = [];
for (const it of items) {
if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
const f = it.getAsFile();
if (f) images.push(f);
}
}
if (!images.length) return;
e.preventDefault();
const ts = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
images.forEach((f, i) => {
const name = f.name && f.name !== "image.png" ? f.name : `pasted-${stamp}${images.length > 1 ? `-${i + 1}` : ""}.png`;
ingestImageFile(new File([f], name, { type: f.type || "image/png" }));
});
});
// —— 模式胶囊按钮：切换弹出配置面板（toggle）——
modeRefs.btn.addEventListener("click", (e) => {
e.stopPropagation();
toggleModePopover();
});
modeRefs.popover.addEventListener("click", (e) => {
const opt = e.target.closest(".mode-option");
if (opt) {
const m = opt.dataset.mode;
const planOn = m === "plan";
const autoOn = m === "auto";
state.planMode = planOn;
state.autoMode = autoOn;
vscode.postMessage({ type: "setPlanMode", on: planOn });
vscode.postMessage({ type: "setAutoMode", on: autoOn });
addInfo(`模式：${m === "plan" ? "计划" : m === "auto" ? "自动" : "手动"}`);
syncToolbar();
return;
}
const th = e.target.closest(".think-opt");
if (th) {
state.thinkingLevel = th.dataset.level;
vscode.postMessage({ type: "setThinking", level: state.thinkingLevel });
addInfo(`思考等级：${state.thinkingLevel}`);
syncToolbar();
}
});
updateModeToggle();
}

export { buildComposer, autoGrow };
