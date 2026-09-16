/**
 * @file vscode/src/webview/modals.js
 * @description 底部锚点浮层族（从 app.js 拆出，2026-09-16 防腐化拆分）：
 *  审批条（允许本次/总是允许/拒绝 + edit_file 左右对比）、提问条（单选/多选键盘化）、
 *  面板内模型选择器、计划方案条（含编辑态）。全部键盘化：↑↓ 移动 · Enter 确认 · Esc 取消，
 *  document 级 keydown 首次渲染时注册一次（bindXxxKeydown 的 bound 门闩）。
 */
import { vscode, $, state } from "./state.js";
import { escapeHtml, mdToHtml } from "./markdown.js";
import { buildApprovalDiffHtml, setApprovalDiffSource, openDiffOverlay } from "./diff.js";
import { addInfo } from "./rows.js";
import { syncToolbar } from "./toolbar.js";

// ———————— 审批条 ————————
const APPROVAL_DECISIONS = ["allow-once", "allow-always", "deny"];
let approvalKeydownBound = false;
/** 注册一次审批键盘导航（↑↓ 切换 / Enter 确认 / Esc 拒绝），首次渲染审批条时绑定。 */
function bindApprovalKeydown() {
  if (approvalKeydownBound) return;
  approvalKeydownBound = true;
  document.addEventListener("keydown", (e) => {
    if (!state.pendingApproval) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const n = APPROVAL_DECISIONS.length;
      state.approvalSel = e.key === "ArrowUp"
        ? ((state.approvalSel ?? 0) <= 0 ? n - 1 : (state.approvalSel ?? 0) - 1)
        : ((state.approvalSel ?? 0) + 1) % n;
      renderApproval();
    } else if (e.key === "Enter") {
      e.preventDefault();
      sendApproval(APPROVAL_DECISIONS[state.approvalSel ?? 0]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      sendApproval("deny");
    }
  });
}
function sendApproval(decision) {
  const p = state.pendingApproval;
  if (!p) return;
  vscode.postMessage({ type: "approval", sessionId: p.sessionId, toolsId: p.toolsId, decision });
  state.pendingApproval = null;
  renderApproval();
}
function renderApproval() {
  const anchor = $("#approval-anchor");
  if (!state.pendingApproval) {
    anchor.innerHTML = "";
    setApprovalDiffSource(null);
    return;
  }
  const p = state.pendingApproval;
  const sel = state.approvalSel ?? 0;
  const opts = [
    { d: "allow-once", cls: "ok", label: "✅ 允许本次" },
    { d: "allow-always", cls: "warn", label: "♻️ 总是允许" },
    { d: "deny", cls: "danger", label: "🚫 拒绝" },
  ];
  const buttons = opts.map((o, i) =>
    `<button class="btn ${o.cls}${i === sel ? " selected" : ""}" data-d="${o.d}">${o.label}</button>`
  ).join("");
  // ★ edit_file：detail 含【减少】/【增加】结构 → 左右对比（红删绿增），其余工具维持纯文本
  const diffHtml = buildApprovalDiffHtml(p.detail, p.toolName);
  setApprovalDiffSource(diffHtml ? { detail: p.detail, toolName: p.toolName } : null);
  anchor.innerHTML = `
    <div class="modal approval">
      <div class="modal-title">🔐 操作审批 · ${escapeHtml(p.toolName)}</div>
      ${diffHtml || `<pre class="modal-detail">${escapeHtml(p.detail || "(无说明)")}</pre>`}
      <div class="modal-actions">${buttons}</div>
      <div class="modal-hint">↑↓ 选择 · Enter 确认 · Esc 拒绝</div>
    </div>`;
  anchor.querySelectorAll(".modal-actions .btn").forEach((b) => {
    b.addEventListener("click", () => sendApproval(b.dataset.d));
  });
  bindApprovalKeydown();
}

// ———————— 提问条（键盘化：↑↓ 移动 · 单选 Enter 提交 · 多选 Space 勾选/Enter 确定 · Esc 取消） ————————
function sendQuestion(answer) {
  vscode.postMessage({ type: "question", answer });
  state.pendingQuestion = null;
  state.questionPicked = [];
  renderQuestion();
}
function submitQuestionOne(i) {
  const req = state.pendingQuestion;
  if (!req) return;
  const options = Array.isArray(req.options) ? req.options : Array.isArray(req.choices) ? req.choices : [];
  const values = options.map((o) => (typeof o === "string" ? o : o.value ?? o.label ?? ""));
  const label = typeof options[i] === "string" ? options[i] : (options[i]?.value ?? options[i]?.label ?? "");
  // ★ 协议 QuestionAnswer.selected: string[]（host/type.ts）——字段名必须是 selected，
  //   否则 ask.ts 判定「用户取消」、模型后续放弃结构化提问。
  sendQuestion({ selected: [values[i] ?? label ?? ""] });
}
function submitQuestionMulti() {
  const req = state.pendingQuestion;
  if (!req) return;
  const options = Array.isArray(req.options) ? req.options : Array.isArray(req.choices) ? req.choices : [];
  const values = options.map((o) => (typeof o === "string" ? o : o.value ?? o.label ?? ""));
  sendQuestion({ selected: state.questionPicked.map((i) => values[i] ?? String(options[i] ?? "")) });
}
function toggleQuestionPick(i) {
  const idx = state.questionPicked.indexOf(i);
  if (idx >= 0) state.questionPicked.splice(idx, 1);
  else state.questionPicked.push(i);
  renderQuestion();
}
let questionKeydownBound = false;
/** 注册一次提问键盘导航：↑↓ 移动高亮、Space 多选勾选、Enter 提交、Esc 取消（空 selected）。 */
function bindQuestionKeydown() {
  if (questionKeydownBound) return;
  questionKeydownBound = true;
  document.addEventListener("keydown", (e) => {
    if (!state.pendingQuestion) return;
    const req = state.pendingQuestion;
    const options = Array.isArray(req.options) ? req.options : Array.isArray(req.choices) ? req.choices : [];
    const multi = !!(req.multiSelect ?? req.multiple ?? false);
    const n = options.length || 1;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      state.questionSel = e.key === "ArrowUp"
        ? (state.questionSel <= 0 ? n - 1 : state.questionSel - 1)
        : (state.questionSel + 1) % n;
      renderQuestion();
    } else if (e.key === " " && multi) {
      e.preventDefault();
      toggleQuestionPick(state.questionSel);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (multi) submitQuestionMulti();
      else submitQuestionOne(state.questionSel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // 空 selected → ask.ts 判定「用户取消」，模型按默认继续，不阻断。
      sendQuestion({ selected: [] });
    }
  });
}
function renderQuestion() {
  const anchor = $("#approval-anchor");
  if (!state.pendingQuestion) {
    anchor.innerHTML = "";
    return;
  }
  const req = state.pendingQuestion;
  const prompt = String(req.prompt ?? req.question ?? req.message ?? "请选择：");
  const options = Array.isArray(req.options) ? req.options : Array.isArray(req.choices) ? req.choices : [];
  const multi = !!(req.multiSelect ?? req.multiple ?? false);
  const sel = Math.min(state.questionSel ?? 0, (options.length || 1) - 1);
  anchor.innerHTML = `
    <div class="modal question">
      <div class="modal-title">❓ 请选择</div>
      <div class="modal-detail q-prompt">${escapeHtml(prompt)}</div>
      <div class="modal-options"></div>
      <div class="modal-actions"><button class="btn ${multi ? "ok" : "info"}" id="q-ok">${multi ? "✅ 确定" : "✋ 取消"}</button></div>
      <div class="modal-hint">${multi ? "↑↓ 选择 · Space 勾选 · Enter 确定 · Esc 取消" : "↑↓ 选择 · Enter 确认 · Esc 取消"}</div>
    </div>`;
  const optBox = anchor.querySelector(".modal-options");
  options.forEach((opt, i) => {
    const label = typeof opt === "string" ? opt : String(opt.label ?? opt.title ?? `选项 ${i + 1}`);
    const desc = typeof opt === "object" ? opt.description : undefined;
    const picked = multi && state.questionPicked.includes(i);
    const btn = document.createElement("button");
    btn.className = ["btn", "opt", i === sel && "selected", picked && "picked"].filter(Boolean).join(" ");
    const mark = multi ? (picked ? "☑ " : "☐ ") : "";
    btn.innerHTML = `${mark}${escapeHtml(label)}${desc ? `<span class="opt-desc">${escapeHtml(desc)}</span>` : ""}`;
    btn.addEventListener("click", () => {
      if (multi) toggleQuestionPick(i);
      else submitQuestionOne(i);
    });
    optBox.appendChild(btn);
  });
  anchor.querySelector("#q-ok")?.addEventListener("click", () => {
    // 多选 = 确定（提交已选）；单选 = 取消（空 selected，ask.ts 判定用户取消）。
    if (multi) submitQuestionMulti();
    else sendQuestion({ selected: [] });
  });
  bindQuestionKeydown();
}

// ———————— 模型选择器（面板内：与提问条同一套 modal + ↑↓/Enter/Esc + 点击交互） ————————
function openModelPicker() {
  if (!state.models.length) {
    addInfo("候选清单为空：/model <模型id> 直输切换，或在设置 deepseekerCode.models 里配置候选模型");
    return;
  }
  state.modelPicker = true;
  state.modelPickerSel = Math.max(0, state.models.indexOf(state.model)); // 当前模型不在候选里则落在首项
  renderModelPicker();
}
function closeModelPicker() {
  state.modelPicker = false;
  renderModelPicker();
}
function pickModelLocal(i) {
  const m = state.models[i];
  if (!m) return;
  state.model = m;
  // setModel 分支统一 host.setModel + workspaceState 持久化（/model 直输与选择器两条路同收口）
  vscode.postMessage({ type: "setModel", model: m });
  addInfo(`🧠 模型已切换：${m}（下次回复生效，重载窗口后保持）`);
  syncToolbar();
  closeModelPicker();
}
function renderModelPicker() {
  let anchor = $("#model-picker-anchor");
  if (!anchor) {
    anchor = document.createElement("div");
    anchor.id = "model-picker-anchor";
    document.getElementById("app").insertBefore(anchor, document.getElementById("composer"));
  }
  if (!state.modelPicker) {
    anchor.innerHTML = "";
    return;
  }
  const cur = state.model;
  const sel = Math.min(state.modelPickerSel ?? 0, state.models.length - 1);
  anchor.innerHTML = `
    <div class="modal model-picker">
      <div class="modal-title">🧠 选择模型${cur ? `（当前：${escapeHtml(cur)}）` : ""}</div>
      <div class="modal-options"></div>
      <div class="modal-hint">${escapeHtml("↑↓ 选择 · Enter 切换 · Esc 取消（其它模型：/model <模型id> 直输）")}</div>
    </div>`;
  const optBox = anchor.querySelector(".modal-options");
  state.models.forEach((m, i) => {
    const isCur = m === cur;
    const btn = document.createElement("button");
    btn.className = ["btn", "opt", i === sel && "selected"].filter(Boolean).join(" ");
    btn.innerHTML = `${isCur ? "● " : ""}${escapeHtml(m)}${isCur ? `<span class="opt-desc">当前</span>` : ""}`;
    btn.addEventListener("click", () => pickModelLocal(i));
    optBox.appendChild(btn);
  });
  bindModelPickerKeydown();
}
let modelPickerKeydownBound = false;
/** 注册一次选择器键盘导航：↑↓ 移动高亮、Enter 切换、Esc 取消（document 级，与提问条同构）。 */
function bindModelPickerKeydown() {
  if (modelPickerKeydownBound) return;
  modelPickerKeydownBound = true;
  document.addEventListener("keydown", (e) => {
    if (!state.modelPicker) return;
    const n = state.models.length;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      state.modelPickerSel = e.key === "ArrowUp"
        ? (state.modelPickerSel <= 0 ? n - 1 : state.modelPickerSel - 1)
        : (state.modelPickerSel + 1) % n;
      renderModelPicker();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickModelLocal(state.modelPickerSel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeModelPicker();
    }
  });
}

// ———————— 计划方案条（键盘化：↑↓ 选择 · Enter 确认 · Esc 拒绝 · 编辑态 Ctrl+Enter 提交） ————————
const PLAN_DECISIONS = ["acceptAuto", "accept", "edit", "reject"];
function sendPlan(payload) {
  vscode.postMessage({ type: "plan", ...payload });
  state.pendingPlan = null;
  state.planEditing = false;
  renderPlan();
}
function applyPlanDecision(d) {
  if (d === "edit") {
    // 进入编辑态：展开 textarea 接管键盘（document keydown 让位），Ctrl+Enter 提交、Esc 退出。
    state.planEditing = true;
    renderPlan();
    $("#plan-edit")?.focus();
    return;
  }
  if (d === "acceptEdited") {
    const edited = $("#plan-edit")?.value ?? state.pendingPlan?.plan ?? "";
    sendPlan({ decision: "acceptEdited", plan: edited });
    return;
  }
  sendPlan({ decision: d });
}
let planKeydownBound = false;
/** 注册一次计划键盘导航：↑↓ 移动、Enter 触发选中项、Esc 拒绝；编辑态让位 textarea。 */
function bindPlanKeydown() {
  if (planKeydownBound) return;
  planKeydownBound = true;
  document.addEventListener("keydown", (e) => {
    const tag = String(e.target?.tagName ?? "").toLowerCase();
    if (tag === "textarea" || tag === "input") return;  // 编辑态 textarea 按键不拦截（Ctrl+Enter/Esc 由其自身处理，避免冒泡误触发 reject）
    if (!state.pendingPlan || state.planEditing) return;
    const n = PLAN_DECISIONS.length;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      state.planSel = e.key === "ArrowUp"
        ? (state.planSel <= 0 ? n - 1 : state.planSel - 1)
        : (state.planSel + 1) % n;
      renderPlan();
    } else if (e.key === "Enter") {
      e.preventDefault();
      applyPlanDecision(PLAN_DECISIONS[state.planSel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      sendPlan({ decision: "reject" });
    }
  });
}
function renderPlan() {
  const anchor = $("#approval-anchor");
  if (!state.pendingPlan) {
    anchor.innerHTML = "";
    return;
  }
  const plan = state.pendingPlan.plan;
  const editing = state.planEditing;
  const collapsed = state.planCollapsed; // 折叠态（编辑态正文为空，折叠无视觉差异）
  const sel = state.planSel ?? 1;
  // ★ 文案对齐 Claude Code：Ready to code? + 是/是/否三选项（编辑为额外能力保留）
  const opts = [
    { d: "acceptAuto", cls: "ok", label: "✅ 是，并自动接受编辑" },
    { d: "accept", cls: "warn", label: "是，并手动审批编辑" },
    { d: editing ? "acceptEdited" : "edit", cls: "info", label: editing ? "✔️ 按编辑后方案执行" : "✏️ 编辑方案" },
    { d: "reject", cls: "danger", label: "↩ 否，继续规划" },
  ];
  const buttons = opts.map((o, i) =>
    `<button class="btn ${o.cls}${i === sel ? " selected" : ""}" data-d="${o.d}">${o.label}</button>`
  ).join("");
  const hideText = editing || collapsed; // 编辑态正文为空 / 折叠态用户收起 —— 都不占位，把空间让给 textarea
  anchor.innerHTML = `
    <div class="modal plan">
      <div class="modal-title plan-toggle" title="点击折叠/展开">
        <span class="plan-caret">${collapsed ? "▶" : "▼"}</span>📋 准备开始编码？${collapsed ? `<span class="plan-collapsed-hint">（已折叠，点击展开）</span>` : ""}
      </div>
      <div class="modal-detail plan-text" style="${hideText ? "display:none" : ""}">${editing ? "" : mdToHtml(plan)}</div>
      <textarea id="plan-edit" spellcheck="false" style="${editing ? "" : "display:none"}">${escapeHtml(plan)}</textarea>
      <div class="modal-actions plan-actions">${buttons}</div>
      <div class="modal-hint">${editing ? "Ctrl+Enter 按编辑后方案执行 · Esc 退出编辑" : "↑↓ 选择 · Enter 确认 · Esc 拒绝 · 点击标题折叠"}</div>
    </div>`;
  anchor.querySelector(".plan-toggle")?.addEventListener("click", () => {
    state.planCollapsed = !state.planCollapsed;
    renderPlan();
  });
  // ★ 点击正文 → 全屏放大阅读（复用 diff overlay）；链接走外链逻辑、选中文本视为复制，不触发
  anchor.querySelector(".plan-text")?.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    if (window.getSelection()?.toString()) return;
    openDiffOverlay("📋 实施方案", `<div class="plan-overlay-content">${mdToHtml(plan)}</div>`);
  });
  anchor.querySelectorAll(".plan-actions .btn").forEach((b) => {
    b.addEventListener("click", () => applyPlanDecision(b.dataset.d));
  });
  if (editing) {
    const editBox = anchor.querySelector("#plan-edit");
    // 编辑态：textarea content 已是 plan（.value 经实体解码回原文）；Enter 换行不提交，
    //   Ctrl+Enter 才提交编辑后方案，Esc 退出编辑态回导航。
    editBox?.focus();
    editBox?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        applyPlanDecision("acceptEdited");
      } else if (e.key === "Escape") {
        e.preventDefault();
        state.planEditing = false;
        renderPlan();
      }
    });
  }
  bindPlanKeydown();
}

function closeAllModals() {
  state.pendingApproval = null;
  state.pendingQuestion = null;
  state.pendingPlan = null;
  document.querySelector("#approval-anchor").innerHTML = "";
}

export {
  renderApproval, renderQuestion, openModelPicker, renderPlan, closeAllModals,
};
