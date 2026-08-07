/**
 * @file vscode/src/webview/app.js
 * @description webview 前端（零依赖，esbuild bundle 为 IIFE）。
 *  与 CLI 的 React Ink 界面一一对应但使用 DOM：
 *  - 消息流：user / assistant（markdown）/ thinking（可折叠）/ tool 卡片 / info / system
 *  - 流式：text.delta / thinking.delta 经 rAF 节流追加
 *  - 浮层：审批条（允许本次 / 总是允许 / 拒绝）、提问选项、计划方案条、历史会话
 *  - 工具栏：新会话 / 历史 / 清屏 / 任务清单 / 计划模式 / 自动模式 / 思考等级 / 语言 / 模型 / 中止
 */
(() => {
  "use strict";

  // @ts-ignore webview 专用 API
  const vscode = acquireVsCodeApi();
  const $ = (sel) => document.querySelector(sel);

  // ———————— 状态 ————————
  const state = {
order: [], // 有序 row key
rowMap: new Map(), // key -> row
toolRowByCallId: new Map(), // toolCallId -> key
currentAssistant: null, // 流式 assistant 行 key
currentThinking: null, // 流式 thinking 行 key
busy: false,
planMode: false,
autoMode: false,
thinkingLevel: "high",
locale: "zh",
model: "",
pendingApproval: null,
pendingQuestion: null,
pendingPlan: null,
sessions: [],
showTodos: false,
todos: [],
roundSeq: 1,
  };

  // 模式配置面板元素（buildComposer 时挂载）
  let btnMode = null;
  let modePopover = null;

  const FLUSH_MS = 60;
  let textBuf = "";
  let thinkBuf = "";
  let progressBuf = null;
  let flushTimer = null;
  let seq = 0;
  const nextKey = () => `k${++seq}`;

  // ———————— 工具函数 ————————
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const mdToHtml = (src) => {
    if (!src) return "";
    let h = escapeHtml(src);
    h = h.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code.trim()}</code></pre>`);
    h = h.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    h = h.replace(/(^|\n)\s*#{1,6}\s+([^\n]+)/g, "$1<strong class='md-h'>$2</strong>");
    h = h.replace(/(^|\n)\s*[-*•]\s+/g, "$1<span class='md-bullet'>•</span> ");
    h = h.replace(/(^|\n)\s*&gt;\s+/g, "$1<span class='md-quote'>›</span> ");
    h = h.replace(/\n/g, "<br/>");
    return h;
  };

  const truncate = (s, n) => {
    const t = String(s ?? "").replace(/\s+\n/g, "\n").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };

  const argHint = (args) => {
    if (args == null || args === "") return "";
    if (typeof args === "string") return truncate(args, 60);
    if (typeof args === "object") {
      for (const k of ["path", "file", "filePath", "filename", "command", "cmd", "query", "url", "pattern", "name"]) {
        const v = args[k];
        if (typeof v === "string" && v) return truncate(v, 60);
      }
      try {
        return truncate(JSON.stringify(args), 60);
      } catch {
        return "";
      }
    }
    return "";
  };

  // ———————— 消息流渲染 ————————
  const messagesEl = () => $("#messages");

  function nearBottom() {
    const el = messagesEl();
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }

  function scrollToBottom() {
    const el = messagesEl();
    el.scrollTop = el.scrollHeight;
  }

  function buildRowEl(row) {
    const wrap = document.createElement("div");
    wrap.className = `row row-${row.kind}`;
    wrap.dataset.key = row.key;

    switch (row.kind) {
      case "user": {
        wrap.innerHTML = `<div class="user-bubble">${escapeHtml(row.text)}</div>`;
        break;
      }
      case "assistant": {
        const html = mdToHtml(row.text);
        wrap.innerHTML = `<div class="assistant-body">${html}${row.streaming ? '<span class="cursor">▊</span>' : ""}</div>`;
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
        const head = `<span class="tool-icon lvl-${level}">⏺</span><span class="tool-name lvl-${level}">${escapeHtml(row.toolName)}</span>` +
          (row.args && argHint(row.args) ? `<span class="tool-hint">${escapeHtml(argHint(row.args))}</span>` : "") +
          (statusIcon ? `<span class="tool-status ${statusCls}">${statusIcon}</span>` : "");
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
        }
        wrap.innerHTML = `<div class="tool-head">${head}</div>${body}`;
        wrap.querySelector(".tool-head")?.addEventListener("click", () => {
          wrap.classList.toggle("open");
          wrap.querySelectorAll(".tool-detail").forEach((d) => {
            d.style.display = d.style.display === "none" ? "" : "none";
          });
        });
        break;
      }
      case "meta": {
wrap.innerHTML = `<div class="meta-line">${escapeHtml(row.text)}</div>`;
break;
}
case "info":
        wrap.innerHTML = `<div class="info-line">› ${escapeHtml(row.text)}</div>`;
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

  function appendRow(row) {
    state.order.push(row.key);
    state.rowMap.set(row.key, row);
    const wrap = buildRowEl(row);
wrap.classList.add("row-enter");
messagesEl().appendChild(wrap);
    if (nearBottom()) scrollToBottom();
  updateEmptyState();
  }

  function updateRow(key, patch) {
    const row = state.rowMap.get(key);
    if (!row) return;
    Object.assign(row, patch);
    rebuildRow(row);
    if (nearBottom()) scrollToBottom();
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

  // ★ 图片预览 chip：上传后、存盘回包前，在 composer 上方显示缩略图 + 文件名（data URL，CSP img-src data: 已放行）
  function appendImagePreview(dataUrl, name) {
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
    box.appendChild(chip);
  }

  function clearMessages() {
    closeStreaming();
    state.order = [];
    state.rowMap.clear();
    state.toolRowByCallId.clear();
    messagesEl().innerHTML = "";
    buildEmptyState();
    renderTodos();
  updateEmptyState();
  }

  // ———————— 事件分发（host → webview） ————————
  function handleEvent(evt) {
if (!evt || typeof evt !== "object") return;
// ★ host 经 sink 发来的完整行（用户消息 / 回放 / meta），与 onMessage 顶层 row 逻辑一致
if (evt.type === "row" || evt.type === "rowUpdate") {
if (evt.type === "row") {
// 轮次分割线：用户开始新一轮对话时插入（首轮不插）
if (evt.kind === "user" && state.order.length > 0) {
state.roundSeq = (state.roundSeq || 0) + 1;
appendRow({ key: nextKey(), kind: "meta", text: `第 ${state.roundSeq} 轮` });
}
const row = { key: evt.key || nextKey(), kind: evt.kind, text: evt.text ?? "" };
if (evt.kind === "tool") {
row.toolName = String(evt.toolName ?? "");
row.args = evt.args;
row.status = evt.status || "running";
}
if (evt.kind === "thinking") row.expanded = false;
appendRow(row);
} else {
if (evt.key) updateRow(evt.key, evt.patch || {});
}
return;
}
switch (evt.type) {
      case "text.delta": {
        ensureAssistantRow();
        textBuf += String(evt.text ?? "");
        scheduleFlush();
        break;
      }
      case "text.reset": {
        // 流式 stall 重试前：丢弃本轮已累积的部分正文/思考，避免重试重新生成后重复显示
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
        break;
      }
      case "thinking.delta": {
        ensureThinkingRow();
        thinkBuf += String(evt.text ?? "");
        scheduleFlush();
        break;
      }
      case "tool.start": {
        closeStreaming();
        const key = nextKey();
        state.toolRowByCallId.set(String(evt.toolCallId ?? ""), key);
        appendRow({ key, kind: "tool", toolName: String(evt.toolName ?? ""), args: evt.args, status: "running" });
        break;
      }
      case "tool.end": {
        flush();
        const key = state.toolRowByCallId.get(String(evt.toolCallId ?? ""));
        if (key) updateRow(key, { status: "done", result: String(evt.result ?? ""), ok: !!evt.ok });
        break;
      }
      case "tool.progress": {
        const key = state.toolRowByCallId.get(String(evt.toolsId ?? ""));
        if (key) {
          progressBuf = { key, msg: String(evt.message ?? "") };
          scheduleFlush();
        }
        break;
      }
      case "round.start":
        closeStreaming();
        break;
      case "plan.proposed": {
        closeStreaming();
        appendRow({ key: nextKey(), kind: "assistant", text: String(evt.plan ?? ""), streaming: false });
        break;
      }
      case "plan.enterRequested": {
        closeStreaming();
        addInfo(`📋 模型请求进入计划模式${evt.reason ? `：${evt.reason}` : ""}`);
        break;
      }
      case "final":
        closeStreaming();
        break;
      case "error": {
        closeStreaming();
        appendRow({ key: nextKey(), kind: "system", text: `❌ ${String(evt.message ?? "未知错误")}` });
        break;
      }
      case "info":
        closeStreaming();
        addInfo(String(evt.text ?? ""));
        break;
      case "todo.update": {
        state.todos = Array.isArray(evt.todos) ? evt.todos : [];
        renderTodos();
        break;
      }
      case "tool.denied": {
        flush();
        addInfo(`🚫 ${String(evt.toolName ?? "")} 被拒绝`);
        break;
      }
      case "approval_request": {
        closeStreaming();
        state.pendingApproval = {
          sessionId: String(evt.sessionId ?? ""),
          toolsId: String(evt.toolsId ?? ""),
          toolName: String(evt.toolName ?? ""),
          detail: String(evt.detail ?? ""),
        };
        renderApproval();
        break;
      }
      default:
        break;
    }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "evt":
        handleEvent(msg.evt);
        break;
      case "row": {
        // 回放/用户行：完整行追加
        const row = { key: msg.key || nextKey(), kind: msg.kind, text: msg.text ?? "" };
        if (msg.kind === "tool") {
          row.toolName = String(msg.toolName ?? "");
          row.args = msg.args;
          row.status = msg.status || "running";
        }
        if (msg.kind === "thinking") row.expanded = false;
        appendRow(row);
        break;
      }
      case "rowUpdate": {
        if (msg.key) updateRow(msg.key, msg.patch || {});
        break;
      }
      case "state": {
        state.busy = !!msg.state?.busy;
        state.planMode = !!msg.state?.planMode;
        state.autoMode = !!msg.state?.autoMode;
        state.projectRoot = String(msg.state?.projectRoot ?? "");
        syncToolbar();
 renderInitError(String(msg.state?.initError ?? ""));
        break;
      }
      case "selectProjectRoot":
        vscode.postMessage({ type: "selectProjectRoot" });
        break;
      case "question":
        state.pendingQuestion = msg.req || {};
        renderQuestion();
        break;
      case "plan":
        state.pendingPlan = { plan: String(msg.plan ?? "") };
        renderPlan();
        break;
      case "sessions":
        state.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        renderSessionsPanel();
        break;
      case "sessionReset":
        clearMessages();
        break;
      case "imageSaved": {
        // extension 已把图片存到工作区临时目录，把路径 + 引导填入输入框
        const p = String(msg.path ?? "");
        const ins = $("#input");
        if (p && ins) {
          ins.value += `\n\n🖼 图片已上传：${p}\n如需理解图片内容，请调用已配置的图像识别 MCP 工具读取该路径并描述。\n`;
          autoGrow(ins);
          ins.focus();
        } else {
          addInfo(`🖼 图片存盘失败：${String(msg.error ?? "未知错误")}`);
        }
        break;
      }
      default:
        break;
    }
  }
  window.addEventListener("message", (e) => onMessage(e.data));

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

  // ———————— 审批条 ————————
  function renderApproval() {
    const anchor = $("#approval-anchor");
    if (!state.pendingApproval) {
      anchor.innerHTML = "";
      return;
    }
    const p = state.pendingApproval;
    anchor.innerHTML = `
      <div class="modal approval">
        <div class="modal-title">🔐 操作审批 · ${escapeHtml(p.toolName)}</div>
        <pre class="modal-detail">${escapeHtml(p.detail || "(无说明)")}</pre>
        <div class="modal-actions">
          <button class="btn ok" data-d="allow-once">✅ 允许本次</button>
          <button class="btn warn" data-d="allow-always">♻️ 总是允许</button>
          <button class="btn danger" data-d="deny">🚫 拒绝</button>
        </div>
      </div>`;
    anchor.querySelectorAll(".modal-actions .btn").forEach((b) => {
      b.addEventListener("click", () => {
        vscode.postMessage({ type: "approval", sessionId: p.sessionId, toolsId: p.toolsId, decision: b.dataset.d });
        state.pendingApproval = null;
        renderApproval();
      });
    });
  }

  // ———————— 提问条 ————————
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
    const selected = new Set();
    anchor.innerHTML = `
      <div class="modal question">
        <div class="modal-title">❓ 请选择</div>
        <div class="modal-detail q-prompt">${escapeHtml(prompt)}</div>
        <div class="modal-options"></div>
        <div class="modal-actions"><button class="btn ok" id="q-ok">确定</button></div>
      </div>`;
    const optBox = anchor.querySelector(".modal-options");
    options.forEach((opt, i) => {
      const label = typeof opt === "string" ? opt : String(opt.label ?? opt.title ?? `选项 ${i + 1}`);
      const desc = typeof opt === "object" ? opt.description : undefined;
      const btn = document.createElement("button");
      btn.className = "btn opt";
      btn.innerHTML = `${escapeHtml(label)}${desc ? `<span class="opt-desc">${escapeHtml(desc)}</span>` : ""}`;
      btn.addEventListener("click", () => {
        if (multi) {
          if (selected.has(i)) {
            selected.delete(i);
            btn.classList.remove("picked");
          } else {
            selected.add(i);
            btn.classList.add("picked");
          }
        } else {
          const values = options.map((o) => (typeof o === "string" ? o : o.value ?? o.label ?? ""));
          const answer = { values: [values[i] ?? label], answer: values[i] ?? label };
          if (req.id != null) answer.id = req.id;
          vscode.postMessage({ type: "question", answer });
          state.pendingQuestion = null;
          renderQuestion();
        }
      });
      optBox.appendChild(btn);
    });
    anchor.querySelector("#q-ok")?.addEventListener("click", () => {
      const values = options.map((o) => (typeof o === "string" ? o : o.value ?? o.label ?? ""));
      const picked = [...selected].map((i) => values[i] ?? String(options[i] ?? ""));
      const answer = { values: picked, answer: picked[0] ?? "" };
      if (req.id != null) answer.id = req.id;
      vscode.postMessage({ type: "question", answer });
      state.pendingQuestion = null;
      renderQuestion();
    });
  }

  // ———————— 计划方案条 ————————
  function renderPlan() {
    const anchor = $("#approval-anchor");
    if (!state.pendingPlan) {
      anchor.innerHTML = "";
      return;
    }
    const plan = state.pendingPlan.plan;
    anchor.innerHTML = `
      <div class="modal plan">
        <div class="modal-title">✅ 实现方案（计划模式）</div>
        <div class="modal-detail plan-text">${mdToHtml(plan)}</div>
        <textarea id="plan-edit" style="display:none" spellcheck="false"></textarea>
        <div class="modal-actions plan-actions">
          <button class="btn ok" data-d="acceptAuto">⚡ 接受并自动执行</button>
          <button class="btn warn" data-d="accept">接受并逐步审批</button>
          <button class="btn info" data-d="edit">✏️ 编辑</button>
          <button class="btn danger" data-d="reject">拒绝</button>
        </div>
      </div>`;
    const editBox = anchor.querySelector("#plan-edit");
    anchor.querySelectorAll(".plan-actions .btn").forEach((b) => {
      b.addEventListener("click", () => {
        const d = b.dataset.d;
        if (d === "edit") {
          editBox.style.display = "";
          editBox.value = plan;
          editBox.focus();
          b.textContent = "✔️ 按编辑后方案执行";
          b.dataset.d = "acceptEdited";
          return;
        }
        if (d === "acceptEdited") {
          vscode.postMessage({ type: "plan", decision: "acceptEdited", plan: editBox.value });
        } else {
          vscode.postMessage({ type: "plan", decision: d });
        }
        state.pendingPlan = null;
        renderPlan();
      });
    });
  }

  // ———————— 历史会话面板（终端风格：搜索 + 单行列表） ————————
let sessionsFilter = "";

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
}

function renderSessionsPanel() {
const panel = $("#sessions-panel");
if (!panel || panel.style.display === "none") return;
const list = state.sessions;
const q = sessionsFilter;
const filtered = q ? list.filter((s) => String(s.preview || "").toLowerCase().includes(q)) : list;
const box = $("#sessions-list");
if (!filtered.length) {
box.innerHTML = `<div class="sessions-empty">${q ? "无匹配会话" : "暂无历史会话"}</div>`;
return;
}
box.innerHTML = filtered.map((s, i) =>
`<div class="session-row" data-i="${i}">
<span class="session-title">${escapeHtml(s.preview || "(空会话)")}</span>
<span class="session-tools"><span class="codicon codicon-chevron-right"></span></span>
<span class="session-meta">${escapeHtml(relTime(s.updatedAt))} · ${s.messageCount} 条</span>
</div>`
).join("");
box.querySelectorAll(".session-row").forEach((el) => {
el.addEventListener("click", () => {
const s = filtered[Number(el.dataset.i)];
if (!s) return;
vscode.postMessage({ type: "loadSession", id: s.sessionId });
closeSessionsPanel();
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

  function closeAllModals() {
    state.pendingApproval = null;
    state.pendingQuestion = null;
    state.pendingPlan = null;
    document.querySelector("#approval-anchor").innerHTML = "";
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

  // ———————— 本地斜杠命令（与 CLI 对齐） ————————
  function maybeLocalCommand(text) {
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
addInfo(`模型：${arg}`);
syncToolbar();
} else {
addInfo("用法：/model <模型名>，如 /model deepseek-v4");
}
return true;
case "thinking":
if (["off", "high", "max"].includes(arg)) {
state.thinkingLevel = arg;
vscode.postMessage({ type: "setThinking", level: arg });
addInfo(`思考等级：${arg}`);
syncToolbar();
} else {
addInfo("用法：/thinking off|high|max");
}
return true;
case "lang":
if (arg === "zh" || arg === "en") {
state.locale = arg;
vscode.postMessage({ type: "setLocale", locale: arg });
addInfo(`界面语言：${arg === "zh" ? "中文" : "English"}`);
syncToolbar();
}
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
addInfo("/help 帮助 · /plan 计划模式 · /auto 自动模式 · /model 模型 · /thinking 思考等级 · /lang 语言 · /sessions 历史 · /clear 清屏 · /new 新会话");
return true;
case "status":
addInfo(`计划模式：${state.planMode ? "开" : "关"} · 自动模式：${state.autoMode ? "开" : "关"} · 思考：${state.thinkingLevel} · 语言：${state.locale}${state.model ? " · 模型：" + state.model : ""}`);
return true;
default:
return false; // 非本地命令 → 交给 agent（自定义 slash 命令）
}
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

function buildComposer() {
const c = $("#composer");
c.innerHTML = `
<div class="composer-shell">
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
</div>
<div class="composer-hint">ctrl esc to focus or unfocus DeepSeek</div>`;
const input = $("#input");
const menu = $("#slash-menu");
const btnSend = $("#btn-send");
btnMode = $("#btn-mode");
modePopover = $("#mode-popover");

// 命令驱动表：全部功能经斜杠命令交互，UI 零控件
const SLASH = [
{ cmd: "/plan", hint: "切换计划模式", arg: false },
{ cmd: "/auto", hint: "切换自动模式", arg: false },
{ cmd: "/model", hint: "设置模型，如 /model deepseek-v4", arg: true },
{ cmd: "/thinking", hint: "思考等级 off | high | max", arg: true },
{ cmd: "/lang", hint: "界面语言 zh | en", arg: true },
{ cmd: "/clear", hint: "清空当前会话", arg: false },
{ cmd: "/new", hint: "新会话", arg: false },
{ cmd: "/sessions", hint: "历史会话", arg: false },
{ cmd: "/help", hint: "显示帮助", arg: false },
{ cmd: "/status", hint: "显示当前状态", arg: false },
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

function updateSlashMenu() {
const v = input.value;
if (!v.startsWith("/")) { menu.style.display = "none"; slashItems = []; selIdx = -1; return; }
const q = v.toLowerCase();
slashItems = SLASH.filter((s) => s.cmd.startsWith(q) || q.startsWith(s.cmd)).slice(0, 6);
if (!slashItems.length) { menu.style.display = "none"; slashItems = []; selIdx = -1; return; }
selIdx = Math.min(Math.max(selIdx, 0), slashItems.length - 1);
menu.innerHTML = slashItems.map((s, i) =>
`<div class="slash-item${i === selIdx ? " selected" : ""}" data-i="${i}"><span class="slash-cmd">${s.cmd}</span><span class="slash-hint">${s.hint}</span></div>`
).join("");
menu.style.display = "";
menu.querySelectorAll(".slash-item").forEach((el) => {
el.addEventListener("click", () => runSlash(slashItems[Number(el.dataset.i)]));
});
}

const doSend = () => {
const text = input.value;
if (!text.trim()) return;
if (maybeLocalCommand(text)) {
input.value = "";
autoGrow(input);
updateSlashMenu();
return;
}
vscode.postMessage({ type: "submit", text });
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
runSlash(slashItems[selIdx >= 0 ? selIdx : 0]);
return;
}
doSend();
}
});
input.addEventListener("input", () => { autoGrow(input); updateSlashMenu(); });
input.addEventListener("focus", () => updateSlashMenu());
input.addEventListener("blur", () => setTimeout(() => { menu.style.display = "none"; }, 150));

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
addInfo("🖼 图片识别需配置图像理解 MCP（settings.json 的 mcpServers，如能读图返回文字描述的 server）；未配置则助手无法“看到”图片。");
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
// ★ 图片上传（MCP 中转）：webview 读 base64 显示预览 → 发给 extension 存到工作区临时目录 →
//   extension 回路径 → 把“图片路径 + 引导调图像 MCP”填入消息。底座非 vision 模型，靠 MCP 把图转文字。
imageInput.addEventListener("change", () => {
const f = imageInput.files && imageInput.files[0];
imageInput.value = "";
if (!f) return;
if (f.size > 8 * 1024 * 1024) { addInfo(`🖼 图片 ${f.name} 过大（>8MB），已忽略`); return; }
const reader = new FileReader();
reader.onload = () => {
const dataUrl = String(reader.result ?? "");
appendImagePreview(dataUrl, f.name);
const commaIdx = dataUrl.indexOf(",");
const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : "";
vscode.postMessage({ type: "uploadImage", name: f.name, mime: f.type || "image/png", base64 });
};
reader.onerror = () => addInfo(`🖼 读取图片失败：${f.name}`);
reader.readAsDataURL(f);
});
// —— 模式胶囊按钮：切换弹出配置面板（toggle）——
btnMode.addEventListener("click", (e) => {
e.stopPropagation();
toggleModePopover();
});
modePopover.addEventListener("click", (e) => {
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
function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  // ———————— 工具栏 ————————
  function buildToolbar() {
const tb = $("#toolbar");
tb.innerHTML = `
<div class="brand"><span class="logo codicon codicon-sparkle"></span> <span class="brand-name">DeepSeeker-Code</span> <span id="busy-dot" class="dot"></span></div>
<button id="btn-project-root" title="agent 当前工作的项目根（点击切换）" class="project-root"><span class="codicon codicon-root-folder"></span><span id="project-root-name">…</span></button>
<div class="actions">
<button id="btn-new" title="新会话" class="icon-btn"><span class="codicon codicon-comment-discussion"></span></button>
<button id="btn-sessions" title="历史会话" class="icon-btn"><span class="codicon codicon-history"></span></button>
</div>`;
$("#btn-project-root").addEventListener("click", () => vscode.postMessage({ type: "selectProjectRoot" }));
$("#btn-new").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
$("#btn-sessions").addEventListener("click", () => {
toggleSessionsPanel();
});
}
function syncToolbar() {
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

// —— 模式配置面板：胶囊按钮 toggle 显示/隐藏 ——
function toggleModePopover() {
if (!modePopover) return;
modePopover.style.display = modePopover.style.display === "none" ? "" : "none";
}
// —— 同步胶囊按钮文字与面板内各模式值 ——
function updateModeToggle() {
if (!btnMode || !modePopover) return;
const m = state.planMode ? "plan" : state.autoMode ? "auto" : "manual";
const label = btnMode.querySelector(".mode-label");
label.textContent = m === "plan" ? "计划" : m === "auto" ? "自动" : "手动";
const ic = btnMode.querySelector(".codicon");
if (ic) ic.className = "codicon " + (m === "plan" ? "codicon-list-tree" : m === "auto" ? "codicon-sync" : "codicon-comment");
btnMode.classList.toggle("on", m !== "manual");
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

  // ———————— 初始化 ————————
  buildEmptyState();
  updateEmptyState();
  buildSessionsPanel();
  buildToolbar();
  buildComposer();
  syncToolbar();
  vscode.postMessage({ type: "ready" });
})();
