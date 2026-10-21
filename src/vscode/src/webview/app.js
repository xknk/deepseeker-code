/**
 * @file vscode/src/webview/app.js
 * @description webview 前端入口（零依赖，esbuild bundle 为 IIFE）。
 *  与 CLI 的 React Ink 界面一一对应但使用 DOM：
 *  - 消息流：user / assistant（markdown）/ thinking（可折叠）/ tool 卡片 / info / system
 *  - 流式：text.delta / thinking.delta 经 rAF 节流追加
 *  - 浮层：审批条（允许本次 / 总是允许 / 拒绝）、提问选项、计划方案条、历史会话
 *  - 工具栏：新会话 / 历史 / 清屏 / 任务清单 / 计划模式 / 自动模式 / 思考等级 / 语言 / 模型 / 中止
 *
 *  2026-09-16 防腐化拆分：原 2200+ 行单文件按职责拆为同目录 ES 模块——
 *  state（单例/vscode API）→ markdown（渲染工具）→ diff（对比视图/overlay）→ rows（消息流）
 *  → toolbar（工具栏/模式面板）→ panels（历史/分叉面板）→ modals（审批/提问/模型/计划浮层）
 *  → composer（输入区//菜单）→ events（消息分发）。本文件只保留初始化序列；
 *  bundle 入口不变（build.mjs 仍打包本文件 → dist/webview.js），宿主零改动。
 *  拆分顺带修复：onMessage "commands" 分支调用闭包内 updateSlashMenu 的 ReferenceError
 *  （host 推送 core 自定义命令时必炸），现经 composer 模块级出口转发。
 *
 *  ★ 双语（/lang）：S 代理按访问时 state.locale 分发，动态渲染路径天然跟随；静态 DOM 文案
 *    （工具栏 title/输入区模板/浮层骨架）靠本文件的 ds-locale 重建机制——buildComposer 的
 *    innerHTML 会连带摧毁先前收编进来的浮层锚点（approval-anchor/sessions/fork/checkpoints 面板），
 *    重建序列必须逐一复活并恢复草稿、待发 chip、阻塞中的审批/提问/方案条。
 */
import { vscode, $, state, copyText, flashCopied } from "./state.js";
import { buildEmptyState, updateEmptyState, appendImagePreview, appendRefChip, renderTodos, rebuildRow } from "./rows.js";
import { buildSessionsPanel, buildForkPanel, buildCheckpointsPanel } from "./panels.js";
import { buildToolbar, syncToolbar, syncContextRing } from "./toolbar.js";
import { buildComposer } from "./composer.js";
import { renderApproval, renderQuestion, renderPlan } from "./modals.js";
import "./events.js"; // 消息监听随 import 注册（与原单文件时序一致）

// ———————— 初始化 ————————
buildEmptyState();
updateEmptyState();
buildSessionsPanel();
buildToolbar();
buildComposer();
syncToolbar();
vscode.postMessage({ type: "ready" });

// ———————— 代码块复制（mdToHtml 产出 .md-copy，消息流/浮层/计划条全域委托） ————————
// ★ capture 阶段拦截 + stopPropagation：点击只复制，不冒泡进「正文点击放大 overlay」
//   （rows.js assistant-content / modals.js plan-text 的 bubble 监听在传播后段，此处拦得来得及）。
//   委托而非逐块绑监听：流式期间正文 innerHTML 整块重建（rows.js 流式 flush），委托对重建免疫。
document.addEventListener(
  "click",
  (e) => {
    const btn = e.target instanceof Element ? e.target.closest(".md-copy") : null;
    if (!btn) return;
    e.stopPropagation();
    flashCopied(btn, copyText(btn.parentElement?.querySelector("pre")?.textContent ?? ""));
  },
  true
);

// ———————— /lang 语言切换重建（composer.js /lang 分支与 events.js state 快照两路都派发本事件） ————————
window.addEventListener("ds-locale", () => {
  // 0) <html lang> 跟随（首载按宿主默认语言渲染，切换后此处不再过期；仅影响 a11y/拼写检查，无视觉作用）
  document.documentElement.lang = state.locale === "en" ? "en" : "zh-CN";

  // 1) 抢救会话态输入：草稿文本 + 待发贴图/引用 chip（数据都在 state，DOM 会随重建蒸发）
  const draft = String($("#input")?.value ?? "");
  const savedImages = [...(state.pendingImages || [])];
  const savedRefs = [...(state.pendingRefs || [])];

  // 2) 重建静态文案载体：工具栏 title + 输入区模板（modeRefs/菜单闭包随之重挂；
  //    原先收编进 #composer 的浮层锚点被 innerHTML 摧毁，下方逐一复活）
  buildToolbar();
  buildComposer();

  // 3) 复活 approval-anchor（审批/提问/方案条共用锚点）+ 懒建面板（buildXxx 均有已存在早退，安全重入）
  const c = $("#composer");
  if (c && !$("#approval-anchor")) {
    const anchor = document.createElement("div");
    anchor.id = "approval-anchor";
    c.appendChild(anchor);
  }
  buildSessionsPanel();
  buildForkPanel();
  buildCheckpointsPanel();

  // 4) 恢复草稿与 chip（dispatch input 事件复用监听做 autoGrow/slash/@ 菜单刷新）
  const inp = $("#input");
  if (inp) {
    inp.value = draft;
    inp.dispatchEvent(new Event("input"));
  }
  for (const p of savedImages) appendImagePreview(p.dataUrl, p.name, true);
  for (const r of savedRefs) appendRefChip(r.path);

  // 5) 动态区重刷：工具栏动态 label/水位环、任务面板标题、阻塞中的审批/提问/方案条（新语言重渲染）
  syncToolbar();
  syncContextRing();
  renderTodos();
  renderApproval();
  renderQuestion();
  renderPlan();

  // 6) 消息流结构行重渲染（轮次头「第 N 轮」/工具行 diff 标签/压缩行 title 等）；
  //    info/system 历史文本属会话记录，不追溯翻译（与 CC 行为一致）。
  for (const k of state.order) {
    const row = state.rowMap.get(k);
    if (row) rebuildRow(row);
  }
});
