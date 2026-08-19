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
approvalSel: 0,
pendingQuestion: null,
questionSel: 0,
questionPicked: [],
pendingPlan: null,
planSel: 1,
planEditing: false,
planCollapsed: false, // 计划正文折叠态（点击标题切换）
replaying: false, // 回放中：抑制逐条滚动，replayDone 一次性落底
sessions: [],
forkAnchors: [], // 当前会话可分叉锚点（各轮 assistant 检查点，host 经 listForkAnchors 回推）
showTodos: false,
todos: [],
roundSeq: 0,
currentTurn: 0,
turnHeaderBySeq: new Map(),
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

  // ———————— 文件修改类工具的 diff 视图（与 cli/src/lineDiff.ts、diffView.ts 同构的 JS 版） ————————
  //  ★ 纯 UI 层从 args 计算（edit_file 的 old_str/new_str），不依赖 git、不进工具结果字符串。
  //    「打开左右对比」按钮走 host 快照（fileDiff.ready 标记），历史回放无快照自然隐藏。
  const EDIT_TOOL_NAMES = ["edit_file", "create_file", "write_file"];

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

  /** 工具行 / 审批条共用的左右对比 HTML（两侧 −/+ 标记，改动静默无输出返回 ""）。 */
  function buildDiffHtml(toolName, args) {
    const pairs = extractEditPairs(toolName, args);
    if (!pairs) return "";
    const MAX_ROWS = 150;
    const parts = [];
    for (const p of pairs) {
      const rows = alignDiffRows(collapseContext(lineDiff(p.old, p.neu), 2));
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
  function buildApprovalDiffHtml(detail, toolName) {
    const parsed = parseApprovalDiff(detail, toolName);
    if (!parsed) return "";
    const out = [];
    for (const sec of parsed.sections) {
      const html = buildDiffHtml("edit_file", { old_str: sec.old, new_str: sec.neu });
      if (html) out.push(sec.label ? `<div class="diff-hunk-label">${escapeHtml(sec.label)}</div>${html}` : html);
    }
    if (!out.length) return "";
    return `<div class="modal-detail approval-diff">${escapeHtml(parsed.header)}</div>${out.join("")}`;
  }

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
    // ★ 轮次状态随会话重置：杜绝跨会话/回放累积（旧 bug：回放历史会话时 roundSeq 一路累加显示"第20+轮"）
    state.roundSeq = 0;
    state.currentTurn = 0;
    state.turnHeaderBySeq = new Map();
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
// ★ 轮次折叠头由 appendRow 统一在 user 行入栈时插入（覆盖实时 / 回放 / 所有 row 入口），此处不再单独插分割线
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
        appendRow({ key, kind: "tool", toolName: String(evt.toolName ?? ""), args: evt.args, status: "running", toolCallId: String(evt.toolCallId ?? "") });
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
      case "replayDone":
        // ★ 回放结束（host 经 sink 包成 evt 发来，故在此处理而非 onMessage）：所有历史行已入 DOM，
        //   强制滚到底展示最新对话。rAF 等一帧布局再量 scrollHeight，避免异步渲染/图片高度未定导致量到旧值。
        state.replaying = false; // 关闭回放抑制
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom(true)));
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
      case "fileDiff.ready": {
        // ★ host 已为该次文件修改留存「修改前」快照 → 工具行亮出「打开左右对比」按钮（回放无快照不亮）
        const key = state.toolRowByCallId.get(String(evt.toolCallId ?? ""));
        if (key) updateRow(key, { diffReady: true });
        break;
      }
      case "approval_request": {
        closeStreaming();
        state.approvalSel = 0;
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
        state.questionSel = 0;
        state.questionPicked = [];
        renderQuestion();
        break;
      case "plan":
        state.pendingPlan = { plan: String(msg.plan ?? "") };
        state.planSel = 1;
        state.planEditing = false;
        state.planCollapsed = false; // 每条新计划默认展开
        renderPlan();
        break;
      case "sessions":
        state.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        renderSessionsPanel();
        break;
      case "forkAnchors":
        state.forkAnchors = Array.isArray(msg.anchors) ? msg.anchors : [];
        renderForkPanel();
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

  // ———————— 提问条 ————————
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

  // ———————— 计划方案条 ————————
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
    const opts = [
      { d: "acceptAuto", cls: "ok", label: "⚡ 接受并自动执行" },
      { d: "accept", cls: "warn", label: "接受并逐步审批" },
      { d: editing ? "acceptEdited" : "edit", cls: "info", label: editing ? "✔️ 按编辑后方案执行" : "✏️ 编辑" },
      { d: "reject", cls: "danger", label: "拒绝" },
    ];
    const buttons = opts.map((o, i) =>
      `<button class="btn ${o.cls}${i === sel ? " selected" : ""}" data-d="${o.d}">${o.label}</button>`
    ).join("");
    const hideText = editing || collapsed; // 编辑态正文为空 / 折叠态用户收起 —— 都不占位，把空间让给 textarea
    anchor.innerHTML = `
      <div class="modal plan">
        <div class="modal-title plan-toggle" title="点击折叠/展开">
          <span class="plan-caret">${collapsed ? "▶" : "▼"}</span>✅ 实现方案（计划模式）${collapsed ? `<span class="plan-collapsed-hint">（已折叠，点击展开）</span>` : ""}
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
`;
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
