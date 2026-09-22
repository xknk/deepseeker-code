/**
 * @file vscode/src/webview/events.js
 * @description host → webview 消息分发（从 app.js 拆出，2026-09-16 防腐化拆分）。
 *  两条消息通道（见 vscode-webview-two-msg-channels）：
 *  - sink 包裹：{ type:"evt", evt } → handleEvent（agent 流事件/回放行）
 *  - 回调直发：其余顶层 type（state/question/plan/sessions/commands/…）→ onMessage
 *  本模块在 import 时注册 window message 监听（与原单文件时代一致：先于初始化、早于 ready postMessage）。
 */
import { vscode, state, nextKey } from "./state.js";
import {
  appendRow, updateRow, closeStreaming, ensureAssistantRow, ensureThinkingRow,
  scheduleFlush, flush, addInfo, renderTodos, clearMessages, clearPendingImages,
  renderInitError, appendTextDelta, appendThinkDelta, setProgress, resetStreams, scrollToBottom,
} from "./rows.js";
import { syncToolbar } from "./toolbar.js";
import { renderApproval, renderQuestion, renderPlan, openModelPicker } from "./modals.js";
import { renderSessionsPanel, renderForkPanel } from "./panels.js";
import { updateSlashMenu } from "./composer.js";

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
if (row.status === "running") row.startedAt = row.startedAt || Date.now();
}
if (evt.kind === "thinking") row.expanded = false;
// ★ 多模态：用户行的贴图缩略图字段透传（缺省 undefined，纯文本行零开销）
if (Array.isArray(evt.attachments)) row.attachments = evt.attachments;
appendRow(row);
} else {
if (evt.key) updateRow(evt.key, evt.patch || {});
}
return;
}
switch (evt.type) {
      case "text.delta": {
        ensureAssistantRow();
        appendTextDelta(String(evt.text ?? ""));
        scheduleFlush();
        break;
      }
      case "text.reset": {
        // 流式 stall 重试前：丢弃本轮已累积的部分正文/思考，避免重试重新生成后重复显示
        resetStreams();
        break;
      }
      case "thinking.delta": {
        ensureThinkingRow();
        appendThinkDelta(String(evt.text ?? ""));
        scheduleFlush();
        break;
      }
      case "tool.start": {
        closeStreaming();
        const key = nextKey();
        state.toolRowByCallId.set(String(evt.toolCallId ?? ""), key);
        appendRow({ key, kind: "tool", toolName: String(evt.toolName ?? ""), args: evt.args, status: "running", startedAt: Date.now(), toolCallId: String(evt.toolCallId ?? "") });
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
          setProgress(key, String(evt.message ?? ""));
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
      case "mode.change": {
        // ★ host 内部翻转模式（拒绝方案→留在计划模式 / 接受→退出）：同步本地态与输入框模式标识
        if (typeof evt.planMode === "boolean") state.planMode = evt.planMode;
        if (typeof evt.autoMode === "boolean") state.autoMode = evt.autoMode;
        syncToolbar();
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
      case "vision.downgraded": {
        // ★ 零配置多模态自学习：当前模型不支持图片，本轮已自动折叠为文本重试（能力已记住）
        flush();
        addInfo(`🖼 模型 ${String(evt.model ?? "")} 不支持图片，已自动降级为文本处理（已记住，后续消息直接按文本发送）`);
        break;
      }
      case "compact.done": {
        // ★ 压缩显示（对标 CC「Compacted chat」行）：主 agent 压缩完成且确有释放时，消息流插淡色斜体一行
        closeStreaming();
        const freed = Math.max(0, (Number(evt.tokensBefore) || 0) - (Number(evt.tokensAfter) || 0));
        const freedText = freed >= 1000 ? `${Math.round(freed / 1000)}k` : String(freed);
        const trigger = evt.trigger === "manual" ? "手动" : "自动";
        appendRow({ key: nextKey(), kind: "compact", text: `已压缩上下文 · ${trigger} · 释放 ${freedText} tokens` });
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
        if (row.status === "running") row.startedAt = row.startedAt || Date.now();
      }
      if (msg.kind === "thinking") row.expanded = false;
      // ★ 多模态：用户行的贴图缩略图字段透传
      if (Array.isArray(msg.attachments)) row.attachments = msg.attachments;
      appendRow(row);
      break;
    }
    case "rowUpdate": {
      if (msg.key) updateRow(msg.key, msg.patch || {});
      break;
    }
    case "state": {
      const wasBusy = state.busy;
      state.busy = !!msg.state?.busy;
      // busy 计秒：true 翻转瞬间记起点；回 false 清零（秒表随轮次，不跨轮累计）
      if (state.busy && !wasBusy) state.busySince = Date.now();
      if (!state.busy) state.busySince = 0;
      state.planMode = !!msg.state?.planMode;
      state.autoMode = !!msg.state?.autoMode;
      // ★ 模型快照（扩展端 host 为准）：修掉 webview 初始为空、/model 提示恒显硬编码默认值的问题
      state.model = String(msg.state?.model ?? state.model);
      // ★ 候选清单随快照下发：/switch 面板内选择器无需往返即可渲染
      if (Array.isArray(msg.state?.models)) state.models = msg.state.models.map(String);
      state.projectRoot = String(msg.state?.projectRoot ?? "");
      // ★ 多模态开关（决定贴图按钮行为：原生附件 vs MCP 中转兜底）
      state.vision = !!msg.state?.vision;
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
    case "commands":
      // core 自定义命令目录（引擎后台就绪时 / panel ready 时推来）：合并进 / 菜单
      state.customCommands = Array.isArray(msg.commands) ? msg.commands : [];
      updateSlashMenu();
      break;
    case "openModelPicker":
      // 命令面板「切换模型」入口：host 已 reveal 面板，这里渲染面板内选择器（与 /switch 同一路）
      if (Array.isArray(msg.models)) state.models = msg.models.map(String);
      openModelPicker();
      break;
    case "forkAnchors":
      state.forkAnchors = Array.isArray(msg.anchors) ? msg.anchors : [];
      renderForkPanel();
      break;
    case "sessionReset":
      clearMessages();
      clearPendingImages();   // ★ 多模态：跨会话清空未发送贴图，防串会话
      break;
    case "imageSaved": {
      // extension 已把图片存到工作区临时目录：路径只回填到待发附件（submit 随 attachments 上送，
      // core 在非 vision wire 尾注里给模型 MCP 读图线索）——不再注入输入框，贴图交互与 Claude Code 一致（零文本）。
      const p = String(msg.path ?? "");
      if (!p) {
        addInfo(`🖼 图片存盘失败：${String(msg.error ?? "未知错误")}`);
        break;
      }
      const pending = (state.pendingImages || []).find((x) => x.name === String(msg.name ?? "") && !x.savedPath);
      if (pending) pending.savedPath = p;
      break;
    }
    default:
      break;
  }
}
window.addEventListener("message", (e) => onMessage(e.data));
