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
 */
import { vscode } from "./state.js";
import { buildEmptyState, updateEmptyState } from "./rows.js";
import { buildSessionsPanel } from "./panels.js";
import { buildToolbar, syncToolbar } from "./toolbar.js";
import { buildComposer } from "./composer.js";
import "./events.js"; // 消息监听随 import 注册（与原单文件时序一致）

// ———————— 初始化 ————————
buildEmptyState();
updateEmptyState();
buildSessionsPanel();
buildToolbar();
buildComposer();
syncToolbar();
vscode.postMessage({ type: "ready" });
