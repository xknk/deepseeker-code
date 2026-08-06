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
    order: [],                    // 有序 row key
    rowMap: new Map(),            // key -> row
    toolRowByCallId: new Map(),   // toolCallId -> key
    currentAssistant: null,       // 流式 assistant 行 key
    currentThinking: null,        // 流式 thinking 行 key
    busy: false,
    planMode: false,
    autoMode: false,
    pendingApproval: null,
    pendingQuestion: null,
    pendingPlan: null,
    sessions: [],
    showTodos: false,
    todos: [],
  };

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
          wrap.innerHTML =
            `<div class="think-head">✻ 思考过程（${lines} 行）· 点击收起</div>` +
            `<div class="think-body">${escapeHtml(row.text)}</div>`;
        } else if (row.streaming) {
          const elapsed = row.startedAt ? Math.max(0, Math.round((Date.now() - row.startedAt) / 1000)) : 0;
          wrap.innerHTML = `<div class="think-head">✻ 思考中 · ${elapsed}s</div>`;
        } else if (row.durationMs != null) {
          wrap.innerHTML = `<div class="think-head">✻ Thought for ${Math.round(row.durationMs / 1000)}s</div>`;
        } else {
          wrap.innerHTML = `<div class="think-head">✻ Thoughts（${lines} 行）</div>`;
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
        const head = `<span class="tool-icon">⚙</span><span class="tool-name lvl-${level}">${escapeHtml(row.toolName)}</span>` +
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
    messagesEl().appendChild(buildRowEl(row));
    if (nearBottom()) scrollToBottom();
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
    const row = { key: nextKey(), kind: "thinking", text: "", streaming: true, expanded: true, startedAt: Date.now() };
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

  function clearMessages() {
    closeStreaming();
    state.order = [];
    state.rowMap.clear();
    state.toolRowByCallId.clear();
    messagesEl().innerHTML = "";
    renderTodos();
  }

  // ———————— 事件分发（host → webview） ————————
  function handleEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "text.delta": {
        ensureAssistantRow();
        textBuf += String(evt.text ?? "");
        scheduleFlush();
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
        syncToolbar();
        break;
      }
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
        renderSessionsPopup();
        break;
      case "sessionReset":
        clearMessages();
        break;
      default:
        break;
    }
  }
  window.addEventListener("message", (e) => onMessage(e.data));

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

  // ———————— 历史会话弹层 ————————
  function renderSessionsPopup() {
    const anchor = $("#approval-anchor");
    if (!state.pendingSessions && state.sessions.length === 0) {
      if (!anchor.dataset.sessionsOpen) return;
    }
    anchor.dataset.sessionsOpen = "1";
    const list = state.sessions;
    if (list.length === 0) {
      anchor.innerHTML = `<div class="modal sessions"><div class="modal-title">🕘 历史会话</div><div class="modal-detail">（暂无历史会话）</div>
        <div class="modal-actions"><button class="btn" id="s-close">关闭</button></div></div>`;
    } else {
      anchor.innerHTML = `<div class="modal sessions">
        <div class="modal-title">🕘 历史会话（点击载入续接）</div>
        <div class="session-list">${list
          .map(
            (s, i) =>
              `<div class="session-item" data-i="${i}">
                <div class="s-preview">${escapeHtml(s.preview || "(空会话)")}</div>
                <div class="s-meta">${escapeHtml(relTime(s.updatedAt))} · ${s.messageCount} 条 · ${escapeHtml(String(s.sessionId).slice(0, 8))}</div>
              </div>`,
          )
          .join("")}</div>
        <div class="modal-actions"><button class="btn" id="s-close">关闭</button></div>
      </div>`;
      anchor.querySelectorAll(".session-item").forEach((el) => {
        el.addEventListener("click", () => {
          const s = list[Number(el.dataset.i)];
          if (s) {
            vscode.postMessage({ type: "loadSession", id: s.sessionId });
            closeAllModals();
          }
        });
      });
    }
    anchor.querySelector("#s-close")?.addEventListener("click", closeAllModals);
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
    state.pendingSessions = false;
    delete document.querySelector("#approval-anchor").dataset.sessionsOpen;
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
        const on = !state.planMode;
        vscode.postMessage({ type: "setPlanMode", on });
        addInfo(`计划模式：${on ? "开" : "关"}`);
        return true;
      }
      case "auto": {
        const on = !state.autoMode;
        vscode.postMessage({ type: "setAutoMode", on });
        addInfo(`自动模式：${on ? "开" : "关"}`);
        return true;
      }
      case "model":
        if (arg) {
          vscode.postMessage({ type: "setModel", model: arg });
          addInfo(`模型：${arg}`);
        }
        return true;
      case "thinking":
        if (["off", "high", "max"].includes(arg)) {
          vscode.postMessage({ type: "setThinking", level: arg });
          addInfo(`思考等级：${arg}`);
        }
        return true;
      case "lang":
        if (arg === "zh" || arg === "en") {
          vscode.postMessage({ type: "setLocale", locale: arg });
          addInfo(`界面语言：${arg === "zh" ? "中文" : "English"}`);
        }
        return true;
      case "clear":
        clearMessages();
        return true;
      case "new":
        vscode.postMessage({ type: "newSession" });
        return true;
      case "sessions":
        vscode.postMessage({ type: "listSessions" });
        state.pendingSessions = true;
        return true;
      case "help":
        addInfo("/help 帮助 · /plan 计划模式 · /auto 自动模式 · /model 切换模型 · /thinking 思考等级 · /lang 语言 · /sessions 历史 · /clear 清屏 · /new 新会话");
        return true;
      case "status":
        addInfo(`计划模式：${state.planMode ? "开" : "关"} · 自动模式：${state.autoMode ? "开" : "关"}`);
        return true;
      default:
        return false; // 非本地命令 → 交给 agent（自定义 slash 命令）
    }
  }

  // ———————— 输入区 ————————
  function buildComposer() {
    const c = $("#composer");
    c.innerHTML = `
      <div class="composer-box">
        <textarea id="input" rows="1" placeholder="发送消息（Enter 发送，Shift+Enter 换行）…" spellcheck="false"></textarea>
        <button id="btn-send" title="发送">➤</button>
      </div>`;
    const input = $("#input");
    const send = $("#btn-send");
    const doSend = () => {
      const text = input.value;
      if (!text.trim()) return;
      if (maybeLocalCommand(text)) {
        input.value = "";
        autoGrow(input);
        return;
      }
      vscode.postMessage({ type: "submit", text });
      input.value = "";
      autoGrow(input);
      input.focus();
    };
    send.addEventListener("click", doSend);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        doSend();
      }
    });
    input.addEventListener("input", () => autoGrow(input));
  }

  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  // ———————— 工具栏 ————————
  function buildToolbar() {
    const tb = $("#toolbar");
    tb.innerHTML = `
      <div class="brand"><span class="logo">✻</span> deepSeekCode <span id="busy-dot" class="dot"></span></div>
      <div class="actions">
        <button id="btn-new" title="新会话" class="icon-btn">＋</button>
        <button id="btn-sessions" title="历史会话" class="icon-btn">🕘</button>
        <button id="btn-todos" title="任务清单" class="icon-btn">☑</button>
      </div>
      <div class="modes">
        <label class="switch" title="计划模式（只读调研→方案审批→实现）"><input type="checkbox" id="chk-plan"/>计划</label>
        <label class="switch" title="自动模式（工作区文件编辑分类器放行）"><input type="checkbox" id="chk-auto"/>自动</label>
        <select id="sel-thinking" title="思考等级">
          <option value="off">off</option><option value="high" selected>high</option><option value="max">max</option>
        </select>
        <select id="sel-lang" title="语言"><option value="zh" selected>中文</option><option value="en">EN</option></select>
      </div>
      <div class="model-row">
        <input id="inp-model" placeholder="模型（可选）" spellcheck="false"/>
        <button id="btn-stop" title="中止生成" class="icon-btn danger">■</button>
      </div>`;
    $("#btn-new").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
    $("#btn-sessions").addEventListener("click", () => {
      vscode.postMessage({ type: "listSessions" });
      state.pendingSessions = true;
    });
    $("#btn-todos").addEventListener("click", () => {
      state.showTodos = !state.showTodos;
      renderTodos();
    });
    $("#chk-plan").addEventListener("change", (e) => vscode.postMessage({ type: "setPlanMode", on: e.target.checked }));
    $("#chk-auto").addEventListener("change", (e) => vscode.postMessage({ type: "setAutoMode", on: e.target.checked }));
    $("#sel-thinking").addEventListener("change", (e) => vscode.postMessage({ type: "setThinking", level: e.target.value }));
    $("#sel-lang").addEventListener("change", (e) => vscode.postMessage({ type: "setLocale", locale: e.target.value }));
    $("#inp-model").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        vscode.postMessage({ type: "setModel", model: e.target.value.trim() });
        addInfo(`模型：${e.target.value.trim() || "(默认)"}`);
      }
    });
    $("#btn-stop").addEventListener("click", () => vscode.postMessage({ type: "abort" }));
  }

  function syncToolbar() {
    const dot = $("#busy-dot");
    if (dot) {
      dot.className = "dot" + (state.busy ? " busy" : "");
      dot.title = state.busy ? "生成中…" : "就绪";
    }
    const plan = $("#chk-plan");
    const auto = $("#chk-auto");
    if (plan && plan.checked !== state.planMode) plan.checked = state.planMode;
    if (auto && auto.checked !== state.autoMode) auto.checked = state.autoMode;
  }

  // 链接安全：webview 内 a 标签不导航（除 http/https 外拦截）
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
  buildToolbar();
  buildComposer();
  syncToolbar();
  vscode.postMessage({ type: "ready" });
})();
