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
runningAgents: 0, // 运行中子 agent 数（subagent.count 事件镜像 core 在飞 Set size；操作条「● N agent」胶囊）
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
pendingRefs: [], // ★ B1 @ 引用：待发送文件引用 [{path}]（chip 可 × 移除；submit 时以路径清单并入消息，模型按需 read_file）
fileList: null, // ★ B1：工作区文件候选清单（host findFiles 回包缓存；null=未请求/加载中）
fileListLoading: false, // 防重复请求标志（fileList 回包置 false）
bookmarks: [], // ★ B3 书签：常用 prompt [{id,text,createdAt}]（host globalState 持久，变更即推；面板 Bookmarks 组渲染）
checkpoints: [], // ★ C1 检查点：各轮「发送前」转录边界 [{id,lastLineId,preview,ts}]（listCheckpoints 回包；回滚面板渲染）
showTodos: false,
todos: [],
roundSeq: 0,
currentTurn: 0,
turnHeaderBySeq: new Map(),
compactProgressKey: null, // 压缩进度瞬态行 key（compact.progress 单行更新；compact.done/final/error 收敛删除）
subagentProgressKey: null, // 子 agent 进度瞬态行 key（P3-7 subagent.progress 单行更新；done/final/error 收敛删除）
// ★ 成本信任链第三环 HUD（H1/H2）：
contextUsage: null, // 最近 context.usage 快照 {usedTokens,windowTokens,fillRate}（水位环数据源；null=尚无，环隐藏）
compactCount: 0, // 会话级压缩次数（compact.done 消费处累加；环心「已压缩 N 次」闪显 + tooltip）
lastRunCacheHitRate: undefined, // 最近 run 缓存命中率（receipt 下发；cost-pill 命中率段）
};

/** row key 发放器（单调递增，整个 webview 生命周期唯一）。 */
let seq = 0;
export const nextKey = () => `k${++seq}`;
