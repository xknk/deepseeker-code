/**
 * @file vscode/src/webview/state.js
 * @description webview 全局单例：vscode API（acquireVsCodeApi 整个上下文只许调一次，必须单点持有）、
 *  DOM 查询助手、消息流状态（行序/流式指针/模式/浮层待办）与 row key 发放器。
 *  从 app.js 拆出（2026-09-16 防腐化拆分）：所有模块经此共享同一份状态，杜绝重复 acquire。
 */

// @ts-ignore webview 专用 API（上下文内只能 acquire 一次）
export const vscode = acquireVsCodeApi();

/** document.querySelector 简写（webview 内约定俗成的 $）。 */
export const $ = (sel) => document.querySelector(sel);

// ———————— 状态 ————————
export const state = {
order: [], // 有序 row key
rowMap: new Map(), // key -> row
toolRowByCallId: new Map(), // toolCallId -> key
currentAssistant: null, // 流式 assistant 行 key
currentThinking: null, // 流式 thinking 行 key
busy: false,
busySince: 0, // busy 翻 true 的时刻（生成中条/工具行已耗时计秒的公共钟）
planMode: false,
autoMode: false,
thinkingLevel: "high",
locale: "zh",
model: "",
models: [], // 模型候选清单（host 经 state 快照下发；/switch 面板内选择器渲染用）
modelPicker: false, // 面板内模型选择器开关（↑↓/Enter/Esc，交互与提问条一致）
modelPickerSel: 0,
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
customCommands: [], // core 注册的自定义斜杠命令（引擎就绪后经 "commands" 消息送达，合并进 / 菜单）
forkAnchors: [], // 当前会话可分叉锚点（各轮 assistant 检查点，host 经 listForkAnchors 回推）
vision: false, // ★ 多模态：视觉开关（host 经 state.vision 下发）——true=贴图走原生附件直达模型
pendingImages: [], // ★ 多模态：待发送贴图 [{name,mime,base64,dataUrl}]（仅 vision=true 时积累，随 submit 上送后清空）
showTodos: false,
todos: [],
roundSeq: 0,
currentTurn: 0,
turnHeaderBySeq: new Map(),
};

/** row key 发放器（单调递增，整个 webview 生命周期唯一）。 */
let seq = 0;
export const nextKey = () => `k${++seq}`;
