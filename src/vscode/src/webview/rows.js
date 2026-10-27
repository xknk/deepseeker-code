/**
 * @file vscode/src/webview/rows.js
 * @description 消息流渲染（从 app.js 拆出，2026-09-16 防腐化拆分）：
 *  行构建/追加/更新（user·assistant·thinking·tool·turnHeader·meta·info·system）、流式缓冲与 rAF 节流
 *  flush、轮次折叠头、任务清单面板、空态、初始化错误横幅、贴图 chip。
 *  流式缓冲（textBuf/thinkBuf/progressBuf）与消费它们的 flush 同模块——缓冲生命周期不跨模块泄漏。
 */
import { vscode, $, state, nextKey, copyText, flashCopied } from "./state.js";
import { S } from "./strings.js";
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
  syncStuckRows();
}

// ★ 提问块钉顶卡片（pin-holder + stuck 类）：真行不参与钉顶——它是自然流全高气泡（贴日志类
//   输入块内自滚至 320px），若行盒自己 sticky+钉住态视觉钳高，钳掉的 ~254px 布局高度在钉住态
//   悬空成大片空白，后随内容要再滚完这段才接上来（2026-10 用户反馈实锤）。改为每个 user 行前
//   挂一个 height:0 的 sticky 占位（.pin-holder，见 ensurePinHolder），卡片克隆悬挂其上——
//   钉住与否都不占布局、不动 scrollHeight，「滚动 ⇄ 布局」彻底解耦。滚动时给占位打 .stuck，
//   钉住判定=真行顶边已越过容器顶（严格小于 + 半像素容差；行顶=容器顶时不打，否则会话顶端
//   scrollTop=0 处卡片与完整气泡同屏重影）。只读 rect 不写 scrollTop，与贴底跟随互不干扰；
//   scrollToBottom（回放落底/跟随跳底）也刷新一遍，防重建行后类状态滞留。
const syncStuckRows = () => {
  const el = messagesEl();
  if (!el) return;
  // ★ 判定基准=滚动容器 #messages 自身顶边，绝非视口 0（历史 bug：旧判定 rect.top<=1 是视口坐标，
  //   而 #toolbar 恒在 #messages 上方（~35px），真钉住的行 top≈35 恒不≤1——.stuck 自 1.0.86 引入
  //   起从未打上过，渐变/钳高全部从未渲染，连续四版「没生效」反馈同根因）。
  const base = el.getBoundingClientRect().top;
  for (const h of el.querySelectorAll(".pin-holder")) {
    const row = h.nextElementSibling; // 占位恒紧贴其行（ensurePinHolder 保证），钉住状态取自行
    const pinned = !!row && row.getBoundingClientRect().top < base - 0.5;
    h.classList.toggle("stuck", pinned);
  }
};
messagesEl().addEventListener("scroll", () => requestAnimationFrame(syncStuckRows), { passive: true });
// ★ 兜底重刷：rebuildRow（整行 replaceWith）/turn 折叠/回放重建都会变更行几何但不触发 scroll
//   事件——只靠滚动打标的话，钉住态滞留/缺失直到下次滚动。监听 childList 兜底（本函数只切
//   class，不产生 childList 变更，无回环），rAF 合并同帧成批变更，一帧至多一次布局读。
new MutationObserver(() => requestAnimationFrame(syncStuckRows)).observe(messagesEl(), { childList: true, subtree: true });

// ★ 贴底跟随原语（先测后改）：stickNow 必须在 DOM 变更【前】测，stickTo 在变更【后】落（一律 instant）。
//   旧实现「先插行后 nearBottom()」：单次插入 ≥100px（多行气泡+轮头/整块代码段）时距底距离被新行自身
//   撑过阈值 → 门禁自锁，流式后续增量全被跳过且永不自愈，只能手动滚；再叠加 smooth 动画期间
//   scrollTop 滞后，小增量也误判。先测后改 + 瞬时落底两刀全断。
const stickNow = () => !state.replaying && nearBottom();
const stickTo = (stick) => { if (stick) scrollToBottom(true); };

// 长 assistant 文本（实现方案/计划等）可折叠——实时与历史回放一致，不依赖后端标记
const isLongAssistant = (t) => { const s = t || ""; return s.split("\n").length > 5 || s.length > 300; };
const firstLine = (t) => truncate((String(t || "").split("\n").map((x) => x.trim()).find(Boolean)) || S.rwContentFallback, 60);
// ★ 用户行时间戳格式化（transcript ts 为 ISO 字符串）：本地时区 HH:MM，非法值返回空串（不渲染）
const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
// ★ 用户行展开判定（对标 CC Show more）：钉住态 2 行即截断——判定必须与钳高对齐（>2 行就给入口），
//   沿用 isLongAssistant 的 5 行/300 字门槛会漏掉「被截断却不给入口」的 3~4 行消息（实测踩坑）
const isLongUser = (t) => { const s = t || ""; return s.split("\n").length > 2 || s.length > 300; };

// ★ 用户输入块构建（真行与钉卡克隆共用，见 ensurePinHolder）：时间戳 + 气泡 + 展开 pill + ↺ 徽标。
//   附件缩略图不在此——它挂在行级（wrap），钉卡只克隆块级内容（钉住态视觉本就钳在 ~2 行）。
const buildUserBlockEl = (row) => {
  const block = document.createElement("div");
  // ★ CC 同款输入块：圆角边框盒子（撤掉 CLI `> ` 前缀——盒子本身就是「这是你说的」的视觉标识）；
  //   纯图片行不渲染空盒子。.user-block 是 ↺ 徽标的定位基准。
  // ★ 时间戳（对标 CC 卡片右上角 9:25 AM）：卡片上方右侧淡显 HH:MM，随卡片一起钉住；缺 ts 不渲染。
  const t = row.ts ? fmtTime(row.ts) : "";
  const time = t ? `<span class="user-time">${t}</span>` : "";
  const bubble = row.text ? `<div class="user-bubble">${escapeHtml(row.text)}</div>` : "";
  block.className = `user-block${t ? " has-time" : ""}`;
  block.innerHTML = `${time}${bubble}`;
  // ★ 超过 2 行的提问（isLongUser，与钉住态钳高对齐）点击气泡 → 全屏浮层读全文；
  //   更短的提问不挂——点击只用于选词复制。选中文本时放过（与 assistant-content 同款守卫）。
  //   卡片右下角附「展开」pill（对标 CC Show more）：滚动条隐藏后，截断末行+pill 是「还有更多」的可见凭证。
  const bubbleEl = block.querySelector(".user-bubble");
  if (bubbleEl && isLongUser(row.text)) {
    bubbleEl.classList.add("expandable");
    const openFull = () => {
      if (window.getSelection()?.toString()) return;
      openDiffOverlay(S.rwUserOriginal, `<div class="plan-overlay-content" style="white-space:pre-wrap">${escapeHtml(row.text)}</div>`);
    };
    bubbleEl.addEventListener("click", openFull);
    const more = document.createElement("span");
    more.className = "user-more";
    more.textContent = S.rwMore;
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      openFull();
    });
    block.appendChild(more);
  }
  // ★ 逐消息撤回（对标 CC 消息级 ↺）：徽标贴输入块右上角，hover 该行显形——点击回滚到此消息
  //   发送前（host 侧对话+文件 modal 照常弹），原文回填输入框可改写重发；无检查点的行不渲染。
  if (row.cpId) {
    const undo = document.createElement("button");
    undo.className = "msg-undo";
    undo.title = S.rwUndoTitle;
    undo.innerHTML = '<span class="codicon codicon-discard"></span>';
    undo.addEventListener("click", () => {
      const inp = document.querySelector("#input");
      if (inp && row.text) {
        inp.value = row.text;
        inp.dispatchEvent(new Event("input")); // 复用输入监听做 autoGrow/slash 菜单刷新
        inp.focus();
      }
      vscode.postMessage({ type: "rewindToCheckpoint", id: row.cpId });
    });
    block.appendChild(undo);
  }
  return block;
};

function buildRowEl(row) {
  const wrap = document.createElement("div");
  wrap.className = `row row-${row.kind}`;
  wrap.dataset.key = row.key;

  switch (row.kind) {
    case "user": {
      wrap.appendChild(buildUserBlockEl(row));
      // ★ 多模态：随行缩略图（实时回显与历史回放同构；dataURL 直出，CSP img-src data: 已放行）
      const atts = Array.isArray(row.attachments) ? row.attachments : [];
      if (atts.length) {
        const box = document.createElement("div");
        box.className = "user-attachments";
        for (const a of atts) {
          const img = document.createElement("img");
          img.className = "attach-thumb";
          img.src = String(a.dataUrl || "");
          img.alt = String(a.name || S.rwImage);
          img.title = String(a.name || S.rwImage);
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
          `<div class="assistant-head" title="${S.rwCollapseToggle}"><span class="assistant-caret">${collapsed ? "▸" : "▾"}</span>${escapeHtml(firstLine(row.text))}</div>` +
          `<div class="assistant-content assistant-body" style="${collapsed ? "display:none" : ""}">${html}</div>` +
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
      // ★ 消息级复制原文（对标 CC 消息 copy）：hover 行显形；流式中不挂，收尾 rebuildRow 后自然生效。
      //   徽标是 wrap 直接子元素（不在 .assistant-content 子树内），点它不会触发正文点击放大。
      if (!row.streaming) {
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "msg-copy";
        copy.title = S.rwCopyMsg;
        copy.textContent = "⧉";
        copy.addEventListener("click", (e) => {
          e.stopPropagation();
          flashCopied(copy, copyText(row.text || ""));
        });
        wrap.appendChild(copy);
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
wrap.innerHTML = `<div class="think-head"><span class="think-caret">›</span> ${S.rwThoughts(lines)}</div>`;
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
            body += `<button class="diff-open-btn" title="${S.rwOpenDiffTitle}">${S.rwOpenDiff}</button>`;
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
      wrap.innerHTML = `<div class="turn-head"><span class="turn-caret">${caret}</span><span class="turn-seq">${S.rwTurn(row.seq)}</span>${summaryHtml}</div>`;
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
    case "compact": {
      // 压缩行：附归档摘要时可点击展开/收起（Show more），直接 DOM 切换不走整行重绘
      const caret = row.summary ? ' <span class="compact-caret">▸</span>' : "";
      const pre = row.summary ? `<pre class="compact-summary" style="display:${row.expanded ? "block" : "none"}">${escapeHtml(row.summary)}</pre>` : "";
      wrap.innerHTML = `<div class="compact-line${row.summary ? " expandable" : ""}"${row.summary ? ` title="${S.rwCompactTitle}"` : ""}>${escapeHtml(row.text)}${caret}</div>${pre}`;
      if (row.summary) {
        wrap.querySelector(".compact-line")?.addEventListener("click", () => {
          row.expanded = !row.expanded;
          const box = wrap.querySelector(".compact-summary");
          const c = wrap.querySelector(".compact-caret");
          if (box) box.style.display = row.expanded ? "block" : "none";
          if (c) c.textContent = row.expanded ? "▾" : "▸";
        });
      }
      break;
    }
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
  ensurePinHolder(row); // 钉卡克隆随行重灌（ts/检查点等变更同步进卡片）
}

// ★ 钉卡占位（零布局占位设计见 syncStuckRows 注）：每个 user 行前挂 height:0 的 sticky 占位，
//   卡片=行内 .user-block 克隆（时间行+气泡+展开 pill+↺ 徽标，与真行同一构建器保证同源）。
//   占位恒紧贴其行（adjacency 在重建/插入两路都保持），钉住判定由 syncStuckRows 按行顶测。
const ensurePinHolder = (row) => {
  if (row.kind !== "user") return;
  const el = messagesEl().querySelector(`[data-key="${CSS.escape(row.key)}"]`);
  if (!el) return;
  let holder = messagesEl().querySelector(`[data-pin-for="${CSS.escape(String(row.key))}"]`);
  if (holder && holder.nextElementSibling !== el) holder.remove(); // 邻接被破坏（不应发生）：弃旧重建防孤儿卡错钉
  if (!holder || !holder.isConnected) {
    holder = document.createElement("div");
    holder.className = "pin-holder row-user"; // 携带 row-user：整套卡片视觉规则（渐隐/垫板/钳高）原样复用
    holder.dataset.pinFor = String(row.key);
    el.before(holder);
  }
  holder.replaceChildren(buildUserBlockEl(row));
  // 归属 turn 已折叠 → 卡随行隐藏（appendRow 折叠续写与 toggleTurn 展开收起两路都经此对齐）
  holder.style.display = el.style.display === "none" ? "none" : "";
};

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
  const stick = stickNow(); // ★ 先测后改：展开会成批显行，改完再测会被新增高度关死门禁
  header.collapsed = !header.collapsed;
  rebuildRow(header);
  const hide = header.collapsed;
  for (const k of state.order) {
    const r = state.rowMap.get(k);
    if (r && r.turn === seq && r.kind !== "turnHeader") {
      const el = messagesEl().querySelector(`[data-key="${CSS.escape(k)}"]`);
      if (el) {
        el.style.display = hide ? "none" : "";
        // user 行的钉卡占位随行同步显隐（折叠的 turn 滚过顶端时不许钉卡探出来）
        const holder = messagesEl().querySelector(`[data-pin-for="${CSS.escape(k)}"]`);
        if (holder) holder.style.display = el.style.display;
      }
    }
  }
  if (!hide) stickTo(stick);
}

// ———————— CC 风格思考动画行（对标「✳ Creating...」）————————
// 常驻消息流末尾的动画行：busy 期间显示在最后一条消息下方（内容区里，非输入框上方），
// 工具执行 / API 等待等「无动静」间隙也有可见生命感。appendRow 一律插到它之前，保证它恒为末行。
let thinkRowEl = null;

const ensureThinkRow = () => {
  if (thinkRowEl?.isConnected) return thinkRowEl;
  thinkRowEl = document.createElement("div");
  thinkRowEl.className = "row row-think busy-think";
  thinkRowEl.id = "busy-think";
  thinkRowEl.hidden = true;
  thinkRowEl.innerHTML = `<span class="think-glyph">✳&#xFE0E;</span><span id="think-verb">${S.thinkVerbs[0]}</span><span class="think-ellipsis">…</span>`;
  messagesEl().appendChild(thinkRowEl);
  return thinkRowEl;
};

function setThinkVisible(on) {
  const el = ensureThinkRow();
  if (!!on === !el.hidden) return;
  const stick = stickNow(); // ★ 先测后改：显示思考行也增高
  el.hidden = !on;
  if (on) stickTo(stick); // 用户贴底时才跟随落底，不抢滚动位置
}

function appendRow(row) {
  // ★ 先测后改（贴底跟随的门禁必须在变更前测：插行后距底距离被新行自身撑高，后测会把
  //   「正在跟随」误判成「已离开」而自锁，流式期间永不自愈只能手动滚）。
  //   user 行 = 用户主动发言：发送即视为「要跟随最新内容」（对标 CC 发送即落底），不受视口位置影响。
  const stick = row.kind === "user" ? !state.replaying : stickNow();
  // user 行 = turn 边界：先开新 turn（插折叠头），统一覆盖所有 row 入口
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
  messagesEl().insertBefore(wrap, thinkRowEl?.isConnected ? thinkRowEl : null); // 思考行存在则插它前面（恒为末行）
  ensurePinHolder(row); // user 行挂钉卡占位（其他 kind 直接返回）
  stickTo(stick); // 回放中不逐条跟随（stickNow/stick 均含回放抑制），replayDone 统一落底
  updateEmptyState();
}

function updateRow(key, patch) {
  const row = state.rowMap.get(key);
  if (!row) return;
  const stick = stickNow(); // ★ 先测后改：rebuildRow 整行替换
  Object.assign(row, patch);
  rebuildRow(row);
  stickTo(stick);
}

/** 整行删除（state 与 DOM 同步清理）：压缩进度瞬态行收敛删除等瞬态行生命周期用。 */
function removeRow(key) {
  if (key == null || !state.rowMap.has(key)) return;
  state.rowMap.delete(key);
  state.order = state.order.filter((k) => k !== key);
  messagesEl().querySelector(`[data-key="${CSS.escape(String(key))}"]`)?.remove();
  messagesEl().querySelector(`[data-pin-for="${CSS.escape(String(key))}"]`)?.remove(); // 钉卡占位随行清理，防孤儿卡
  updateEmptyState();
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
  // ★ 整帧增量一次度量（先测后改）：流式里单帧可能长出一大块（整段代码/表格），改完再测会被
  //   本帧新增高度关死门禁、后续增量全被跳过；变更前测一次，末尾统一瞬时落底。
  const stick = stickNow();
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
      if (el) el.innerHTML = mdToHtml(row.text) + '<span class="cursor">▊</span>';
    }
  }
  if (th && state.currentThinking != null) {
    const row = state.rowMap.get(state.currentThinking);
    if (row) {
      row.text += th;
      rebuildRow(row);
    }
  }
  stickTo(stick);
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
    btn.title = S.rwRemoveImg;
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

/** 清空待发送贴图（vision 模式）：chip DOM + 待发数组一并重置（新会话/发送成功后调用）。
 *  ★ 只清图片 chip：引用 chip（.ref-chip，B1 @ 引用）与贴图同住 #composer-attachments，
 *    整箱 innerHTML="" 会把引用也抹掉而 pendingRefs 还在——错配。 */
function clearPendingImages() {
  state.pendingImages = [];
  const box = $("#composer-attachments");
  if (box) box.querySelectorAll(".attach-chip:not(.ref-chip)").forEach((c) => c.remove());
}

// ★ 文件引用 chip（B1 @ 引用 / B2 大文件自动转引用）：与贴图 chip 同排（#composer-attachments）、
//   同 × 移除交互；submit 时引用以路径清单并入消息文本（core 不动，模型按需 read_file）。
function appendRefChip(refPath) {
  const box = $("#composer-attachments");
  if (!box) return;
  const chip = document.createElement("div");
  chip.className = "attach-chip ref-chip";
  chip.title = refPath; // 路径可能椭圆截断，悬浮看全名
  const ic = document.createElement("span");
  ic.className = "codicon codicon-file";
  const span = document.createElement("span");
  span.textContent = refPath;
  chip.appendChild(ic);
  chip.appendChild(span);
  const btn = document.createElement("button");
  btn.className = "attach-remove";
  btn.title = S.rwRemoveRef;
  btn.innerHTML = '<span class="codicon codicon-close"></span>';
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.pendingRefs = (state.pendingRefs || []).filter((r) => r.path !== refPath);
    chip.remove();
  });
  chip.appendChild(btn);
  box.appendChild(chip);
}

/** 清空待发送引用：chip DOM + 待发数组一并重置（新会话/发送成功后调用）。 */
function clearPendingRefs() {
  state.pendingRefs = [];
  const box = $("#composer-attachments");
  if (box) box.querySelectorAll(".ref-chip").forEach((c) => c.remove());
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
    `<div class="todos-title">${S.rwTodos}</div>` +
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
  appendRow, updateRow, rebuildRow, removeRow,
  closeStreaming, ensureAssistantRow, closeThinking, ensureThinkingRow,
  scheduleFlush, flush, addInfo,
  appendImagePreview, clearPendingImages, appendRefChip, clearPendingRefs, clearMessages,
  renderInitError, renderTodos, buildEmptyState, updateEmptyState,
  setThinkVisible,
};
