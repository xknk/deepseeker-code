/**
 * @file cli/src/App.tsx
 * @description CLI 主界面（对齐 Claude Code 视觉/交互）：
 *  - 已完成消息用 <Static> 只渲染一次（写入滚动缓冲），杜绝流式全量重绘闪屏；动态区只留流式尾巴 + 输入。
 *  - 头部 logo 在 main 启动时打印一次（随对话滚走，符合 CC）；状态条常驻底部。
 *  - 斜杠：未知命令不发给模型；菜单 Enter 执行选中命令。
 *  按键：Ctrl+C 退出 · Esc 中止/清输入 · Ctrl+G 中止 · Ctrl+T 切换思考 · 模态/菜单 ↑↓Enter。
 *  useInput 闭包易过期：input/selectIdx/busy 用 ref 镜像读取最新值。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { listCommands } from "@/commands/registry.ts";
import { listOutputStyles } from "@/outputStyles/registry.ts";
import { readStatusLineConfig, type StatusLineConfig } from "@/statusLine/config.ts";
import { readTrustedDirs, untrustDir } from "@/trust/index.ts";
import { runStatusLine, type StatusLineContext } from "@/statusLine/runner.ts";
import { MODEL_NAME } from "@/llm/createModel.ts";
import type { ThinkingLevel } from "@/agent/type.ts";
import { useChatState, type ChatRow } from "./useChatState.ts";
import { THEME } from "./theme.ts";
import { S, LOCAL_COMMAND_NAMES, getLocale, setLocale } from "./strings.ts";
import { writeLocale } from "./prefs.ts";
import type { Locale } from "@/common/index.ts";
import { dimRule, truncateMiddle } from "./util.ts";
import { MessageBlock } from "./components/MessageBlock.tsx";
import { ThinkingBlock } from "./components/ThinkingBlock.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { TodosPanel } from "./components/TodosPanel.tsx";
import { ApprovalModal } from "./components/ApprovalModal.tsx";
import { QuestionModal } from "./components/QuestionModal.tsx";
import { PlanModal } from "./components/PlanModal.tsx";
import { PlanEditor } from "./components/PlanEditor.tsx";
import { SessionPicker } from "./components/SessionPicker.tsx";
import { SlashMenu, type MenuEntry } from "./components/SlashMenu.tsx";
import { MultilineInput } from "./components/MultilineInput.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { TopPanel } from "./components/TopPanel.tsx";
import { inspectUsage, inspectContext, inspectPermissions, inspectMcp, inspectHooks, inspectDebug } from "./inspect.ts";

const KNOWN_MODELS = ["deepseek-v4", "deepseek-v4-flash"];
const CWD = process.cwd();

/** 单行渲染分发：tool/thinking/todos 走专用组件，其余走 MessageBlock。 */
const RowView = ({ row, wrapW, streamTail, showThinking }: { row: ChatRow; wrapW: number; streamTail?: number; showThinking?: boolean }): React.ReactElement => {
    if (row.kind === "todos") return <TodosPanel todos={row.todos} wrapW={wrapW} />;
    if (row.kind === "tool") return <ToolCard toolName={row.toolName} args={row.args} result={row.result} ok={row.ok} status={row.status} progress={row.progress} wrapW={wrapW} />;
    if (row.kind === "thinking") return <ThinkingBlock streaming={row.streaming ?? false} startedAt={row.startedAt} durationMs={row.durationMs} tokens={row.tokens} text={row.text} expanded={showThinking} wrapW={wrapW} />;
    // ★ 每轮对话（user 提问）前加淡色横线，视觉分隔各轮，便于在长对话中定位（user 提问 + assistant 回复 = 一个轮次单元）
    if (row.kind === "user") {
        return (
            <Box flexDirection="column" marginTop={1}>
                <Text color={THEME.grayDim}>{"─".repeat(Math.max(8, wrapW))}</Text>
                <MessageBlock row={row} wrapW={wrapW} streamTail={streamTail} />
            </Box>
        );
    }
    return <MessageBlock row={row} wrapW={wrapW} streamTail={streamTail} />;
};

/** 是否留在动态区：仅流式中的 assistant/thinking、运行中的 tool、活动中的 todos 行。
 *  ★ 思考行完成后回 Static——之前"始终动态"导致已完成的思考堆积在末尾（消息混乱）。
 *  ★ todos 行 active 时留动态区随状态刷新；pushUser 冻结为 Static，留在原位（新消息上方）。 */
const isDynamicRow = (r: ChatRow): boolean =>
    (r.kind === "assistant" && !!r.streaming) ||
    (r.kind === "thinking" && !!r.streaming) ||
    (r.kind === "tool" && r.status === "running") ||
    (r.kind === "todos" && !!r.active);

export const App = ({ resumeSessionId, initialPlanMode, initialAutoMode, initialIncludeProject }: { resumeSessionId?: string; initialPlanMode?: boolean; initialAutoMode?: boolean; initialIncludeProject?: boolean }): React.ReactElement => {
    const state = useChatState(resumeSessionId, initialPlanMode, initialAutoMode);
    const { exit } = useApp();
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    const wrapW = Math.max(16, cols - 2);
    /** 流式正文动态区保留的尾部行数：终端高度 - 预留（任务面板/生成指示/输入/状态/留白）。
     *  稳定动态区高度 → 治闪屏/错位；收尾后整行进 Static 渲染全文，不丢内容。
     *  ★ rows-18（原 -12）：Ink log-update 全量擦写动态区，高度越低越不闪；30 行终端→12 行尾巴。
     *  ★ cap 14（治"生成过多闪屏"）：大终端按 rows-18 会算出几十行尾巴，擦写面积大→闪；
     *    取尾部 14 行已够流式上下文，封顶后动态区高度与终端高度解耦，大屏不再更闪。 */
    const streamTail = Math.min(Math.max(4, (stdout?.rows ?? 24) - 18), 14);

    const [input, setInput] = useState("");
    const [cursor, setCursor] = useState(0);
    const [selectIdx, setSelectIdx] = useState(0);
    const [modelDisplay, setModelDisplay] = useState(MODEL_NAME);
    /** 语言切换计数器：setLocale 后 setTick 触发重渲染，刷新界面文案（S 在 render 期读取）。 */
    const [tick, setTick] = useState(0);
    /** 计划方案编辑相位：pendingPlan 下选「修改」进入编辑器，预填原方案；Enter 确认 / Esc 取消回选项。 */
    const [planEditing, setPlanEditing] = useState(false);
    const [planDraft, setPlanDraft] = useState("");
    const [planCursor, setPlanCursor] = useState(0);
    /** P2-12 提问模态：qCursor=选项光标，qChecked=多选已勾选项集合。 */
    const [qCursor, setQCursor] = useState(0);
    const [qChecked, setQChecked] = useState<Set<number>>(new Set());
    const qCursorRef = useRef(0);
    const qCheckedRef = useRef<Set<number>>(new Set());

    const inputRef = useRef(input);
    const selectIdxRef = useRef(selectIdx);
    const busyRef = useRef(state.busy);
    const planEditingRef = useRef(false);
    const planDraftRef = useRef("");
    inputRef.current = input;
    selectIdxRef.current = selectIdx;
    busyRef.current = state.busy;
    planEditingRef.current = planEditing;
    planDraftRef.current = planDraft;
    qCursorRef.current = qCursor;
    qCheckedRef.current = qChecked;

    // ★ P2-16 statusline（对标 Claude Code）：加载用户 settings.json 的 statusLine.command，
    //   按轮次边界 + 5s 慢速轮询刷新底部状态栏；无配置则全程跳过（零开销）。出错保留上次好值防闪烁。
    const statusLineCfgRef = useRef<StatusLineConfig | null>(null);
    const statusLineRunRef = useRef(false);
    const [statusLineText, setStatusLineText] = useState("");
    /** 组装上下文并执行一次状态栏命令；cfg 缺失/重入中 → 直接返回。 */
    const refreshStatusLine = useCallback(async () => {
        const cfg = statusLineCfgRef.current;
        if (!cfg || statusLineRunRef.current) return;
        statusLineRunRef.current = true;
        try {
            const ctx: StatusLineContext = {
                session_id: state.sessionIdRef.current ?? "",
                cwd: CWD,
                model: modelDisplay,
                state: state.aborting ? "aborting" : state.busy ? "busy" : "idle",
                plan_mode: state.getPlanMode(),
                auto_mode: state.getAutoMode(),
                output_style: state.getOutputStyle() ?? null,
                workspace: { current_dir: CWD, project_dir: CWD },
            };
            const text = await runStatusLine(cfg, ctx);
            if (text) setStatusLineText(text); // 仅非空更新；出错/超时返回 "" → 保留上次好值
        } finally {
            statusLineRunRef.current = false;
        }
    }, [modelDisplay, state.busy, state.aborting, state.getPlanMode, state.getAutoMode, state.getOutputStyle, state.sessionIdRef]);
    const refreshStatusLineRef = useRef(refreshStatusLine);
    refreshStatusLineRef.current = refreshStatusLine;
    // 挂载时加载配置并首刷
    useEffect(() => {
        void (async () => {
            statusLineCfgRef.current = await readStatusLineConfig(initialIncludeProject ?? false); // 信任闸门：未信任时不读项目级 statusLine（其 command 以 shell 执行）
            await refreshStatusLineRef.current();
        })();
    }, []);
    // 轮次边界（busy/aborting/模型 翻转）刷新
    useEffect(() => { void refreshStatusLineRef.current(); }, [state.busy, state.aborting, modelDisplay]);
    // 慢速 idle 轮询（5s），让状态栏反映命令内部的时间敏感信息（如 git 分支/时钟）
    useEffect(() => {
        const id = setInterval(() => { void refreshStatusLineRef.current(); }, 5000);
        return () => clearInterval(id);
    }, []);

    const staticRows = useMemo(() => state.rows.filter((r) => !isDynamicRow(r)), [state.rows]);
    const dynamicRows = useMemo(() => state.rows.filter(isDynamicRow), [state.rows]);

    // ★ 顶部双列卡片作为 Static 首项：位于最顶端、只渲染一次（零闪屏），随对话超过屏幕后滚走（同 Claude Code）。
    type StaticItem = { id: number; kind: "__header" } | ChatRow;
    const HEADER_ITEM: StaticItem = { id: -1, kind: "__header" };
    const staticItems = useMemo<StaticItem[]>(() => [HEADER_ITEM, ...staticRows], [staticRows]);

    // 斜杠菜单条目：本地命令 + 核心注册命令（本地优先去重）
    const menuEntries = useMemo<MenuEntry[]>(() => {
        const descOf = (name: string): string => {
            switch (name) {
                case "help": return S.cmdHelp;
                case "status": return S.cmdStatus;
                case "plan": return S.cmdPlan;
                case "auto": return S.cmdAuto;
                case "model": return S.cmdModel;
                case "thinking": return S.cmdThinking;
                case "lang": return S.cmdLang;
                case "output-style": return S.cmdOutputStyle;
                case "sessions": return S.cmdSessions;
                case "usage": return S.cmdUsage;
                case "context": return S.cmdContext;
                case "permissions": return S.cmdPermissions;
                case "mcp": return S.cmdMcp;
                case "hooks": return S.cmdHooks;
                case "trust": return S.cmdTrust;
                case "debug": return S.cmdDebug;
                case "clear": return S.cmdClear;
                case "exit": return S.cmdExit;
                default: return "";
            }
        };
        const map = new Map<string, MenuEntry>();
        for (const name of LOCAL_COMMAND_NAMES) map.set(name, { name, description: descOf(name) });
        for (const c of listCommands()) if (!map.has(c.name)) map.set(c.name, { name: c.name, description: c.description });
        return [...map.values()];
        // tick 用于语言切换后重算描述（S.cmdXxx 随 locale 变）；本身不在体内引用。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tick]);
    const filteredCommands = useMemo(() => {
        if (!input.startsWith("/")) return [];
        const q = input.slice(1).toLowerCase();
        return menuEntries.filter((c) => c.name.toLowerCase().startsWith(q));
    }, [input, menuEntries]);

    const menuActive = state.pendingApproval != null || state.pendingQuestion != null || state.pendingPlan != null || state.pendingSessions != null;
    const slashVisible = !menuActive && input.startsWith("/") && filteredCommands.length > 0;
    // ★ 斜杠菜单时输入仍活跃（suppressSubmit 仅把 Enter 交 App 执行选中命令）：可继续打字过滤命令、
    //   Tab 补全后输参数（如 /thinking max）。仅模态打开时才禁用输入。
    const inputActive = !menuActive;

    useEffect(() => { setSelectIdx(0); setPlanEditing(false); }, [state.pendingApproval, state.pendingQuestion, state.pendingPlan, state.pendingSessions, slashVisible, filteredCommands.length]);
    // ★ 提问模态打开/切换时重置光标与已勾选
    useEffect(() => { setQCursor(0); setQChecked(new Set()); }, [state.pendingQuestion]);

    // —— 本地斜杠命令（异步：可观测性命令需读 trace / MCP / store）——
    const runLocalSlash = async (text: string): Promise<boolean> => {
        const [cmd, ...rest] = text.trim().split(/\s+/);
        const arg = rest.join(" ");
        switch (cmd) {
            case "/exit":
            case "/quit":
                exit();
                return true;
            case "/clear":
                state.clearRows();
                return true;
            case "/sessions":
                void state.openSessionPicker();
                return true;
            case "/help":
                state.pushInfo(S.helpText(modelDisplay, state.getThinkingLevel(), getLocale()));
                return true;
            case "/status":
                state.pushInfo(S.statusText(modelDisplay, state.getThinkingLevel(), state.getPlanMode(), getLocale(), CWD));
                return true;
            case "/usage":
                state.pushInfo(await inspectUsage(state.sessionIdRef.current ?? ""));
                return true;
            case "/context":
                state.pushInfo(await inspectContext(state.sessionIdRef.current ?? ""));
                return true;
            case "/permissions":
                state.pushInfo(inspectPermissions());
                return true;
            case "/mcp":
                state.pushInfo(await inspectMcp());
                return true;
            case "/hooks":
                state.pushInfo(inspectHooks());
                return true;
            case "/trust": {
                const trusted = await readTrustedDirs();
                if (!arg) {
                    if (trusted.length === 0) { state.pushInfo("已信任目录：（无）。首次进入某目录时会询问是否信任。"); return true; }
                    const list = trusted.map((d, i) => `  [${i}] ${d}`).join("\n");
                    state.pushInfo(`已信任目录（撤销用 /trust <序号 或 路径>）：\n${list}\n\n撤销后需重启 CLI 生效（项目级配置仅在启动时加载）。`);
                    return true;
                }
                const idx = Number(arg);
                const target = Number.isInteger(idx) && idx >= 0 && idx < trusted.length ? trusted[idx] : arg;
                const removed = await untrustDir(target);
                state.pushInfo(removed ? `已撤销信任：${target}\n（重启 CLI 后生效——项目级配置仅在启动时加载）` : `未找到该信任目录：${target}`);
                return true;
            }
            case "/debug":
                state.pushInfo(inspectDebug(state.sessionIdRef.current ?? ""));
                return true;
            case "/plan": {
                const on = !state.getPlanMode();
                state.setPlanMode(on);
                state.pushInfo(`计划模式：${on ? "开（下次提问先只读调研并产出方案，审批后实现）" : "关"}`);
                return true;
            }
            case "/auto": {
                const on = !state.getAutoMode();
                state.setAutoMode(on);
                state.pushInfo(`自动模式：${on ? "开（工作区内文件编辑由分类器自动放行，高危转人工）" : "关"}`);
                return true;
            }
            case "/model":
                if (!arg) {
                    state.pushInfo(`当前模型：${modelDisplay}\n可选：${KNOWN_MODELS.join("、")} 或任意模型 id。`);
                    return true;
                }
                state.setModelOverride(arg);
                setModelDisplay(arg);
                state.pushInfo(`模型已切换：${arg}`);
                return true;
            case "/thinking": {
                const lvl = arg.toLowerCase();
                if (arg && lvl !== "off" && lvl !== "high" && lvl !== "max") {
                    state.pushInfo(`无效等级：${arg}（可选：off 关闭 / high 常规 / max 深度）`);
                    return true;
                }
                if (!arg) {
                    state.pushInfo(`当前思考等级：${state.getThinkingLevel()}（off 关闭 / high 常规 / max 深度）`);
                    return true;
                }
                state.setThinkingLevel(lvl as ThinkingLevel);
                state.pushInfo(`思考等级：${lvl}${lvl === "off" ? "（关闭，简单任务更快更省）" : lvl === "max" ? "（深度，复杂任务）" : "（常规）"}`);
                return true;
            }
            case "/lang": {
                const l = arg.toLowerCase();
                if (arg && l !== "zh" && l !== "en") {
                    state.pushInfo(S.langInvalid(arg));
                    return true;
                }
                if (!arg) {
                    state.pushInfo(S.langCurrent());
                    return true;
                }
                setLocale(l as Locale);
                void writeLocale(l as Locale);   // 持久化（异步，不阻塞）
                setTick((t) => t + 1);            // 触发重渲染，刷新界面文案
                state.pushInfo(S.langSet(l));
                return true;
            }
            case "/output-style": {
                const styles = listOutputStyles();
                if (styles.length === 0) { state.pushInfo(S.outputStyleNone()); return true; }
                const listText = styles.map((s) => `  · ${s.name} — ${s.description}`).join("\n");
                if (!arg) {
                    const cur = state.getOutputStyle();
                    state.pushInfo(`${S.outputStyleCurrent(cur)}\n${listText}\n${S.outputStyleHint()}`);
                    return true;
                }
                const a = arg.toLowerCase();
                if (a === "off" || a === "none" || a === "default") {
                    state.setOutputStyle(undefined);
                    state.pushInfo(S.outputStyleCleared());
                    return true;
                }
                if (!styles.some((s) => s.name === a)) {
                    state.pushInfo(`${S.outputStyleUnknown(arg)}\n${listText}`);
                    return true;
                }
                state.setOutputStyle(a);
                state.pushInfo(S.outputStyleSet(a));
                return true;
            }
            default:
                return false;
        }
    };

    /** 执行斜杠命令：本地优先 → 注册命令（expandSlashCommand 展开）→ 未知则提示，绝不把 `/xxx` 发给模型。 */
    const executeSlash = async (fullText: string): Promise<void> => {
        const text = fullText.trim();
        if (!text.startsWith("/")) { await state.submit(text); return; }
        if (await runLocalSlash(text)) return;
        const name = text.slice(1).split(/\s+/)[0] ?? "";
        if (listCommands().some((c) => c.name === name)) { await state.submit(text); return; }
        state.pushInfo(`未知命令：/${name || "(空)"}（输入 / 查看可用命令）`);
    };

    const onSubmit = async () => {
        const v = inputRef.current.trim();
        if (!v) return;
        if (busyRef.current) {
            state.pushEvent({ type: "error", message: S.busyBlockSend });
            return;
        }
        setInput("");
        setCursor(0);
        if (v.startsWith("/")) { await executeSlash(v); return; }
        await state.submit(v);
    };

    /** 计划编辑器确认（编辑态 Enter）：空方案不确认；否则以编辑后方案接受。 */
    const confirmPlanEdit = () => {
        if (!planDraftRef.current.trim()) { state.pushInfo(S.planEditEmpty); return; }
        state.resolvePlan({ action: 'accept', plan: planDraftRef.current });
    };

    // —— 全局按键分发（模态优先） ——
    useInput((ch, key) => {
        if (key.ctrl && ch === "c") { exit(); return; }
        if (state.pendingApproval) {
            const APPROVAL_DECISIONS = ['allow-once', 'allow-always', 'deny'] as const;
            if (key.upArrow) setSelectIdx((i) => (i - 1 + APPROVAL_DECISIONS.length) % APPROVAL_DECISIONS.length);
            else if (key.downArrow) setSelectIdx((i) => (i + 1) % APPROVAL_DECISIONS.length);
            else if (key.return) state.resolveApproval(APPROVAL_DECISIONS[selectIdxRef.current] ?? 'deny');
            else if (key.escape || (key.ctrl && ch === "g")) state.resolveApproval('deny');
            return;
        }
        if (state.pendingQuestion) {
            const q = state.pendingQuestion.req;
            const n = q.options.length;
            const multi = !!q.multiSelect;
            if (key.upArrow) setQCursor((i) => (i - 1 + n) % n);
            else if (key.downArrow) setQCursor((i) => (i + 1) % n);
            else if (multi && ch === " ") {
                setQChecked((prev) => { const nx = new Set(prev); nx.has(qCursorRef.current) ? nx.delete(qCursorRef.current) : nx.add(qCursorRef.current); return nx; });
            } else if (key.return) {
                if (multi) {
                    const sel = qCheckedRef.current.size > 0
                        ? [...qCheckedRef.current].sort((a, b) => a - b).map(i => q.options[i]?.label).filter(Boolean)
                        : [q.options[qCursorRef.current]?.label].filter(Boolean);
                    state.resolveQuestion({ selected: sel });
                } else {
                    state.resolveQuestion({ selected: [q.options[qCursorRef.current]?.label].filter(Boolean) });
                }
            } else if (key.escape || (key.ctrl && ch === "g")) state.resolveQuestion({ selected: [] });
            return;
        }
        if (state.pendingPlan) {
            // 编辑态：仅 Esc/Ctrl+G 取消回选项；其余按键交给 PlanEditor 的 MultilineInput 处理
            if (planEditingRef.current) {
                if (key.escape || (key.ctrl && ch === "g")) setPlanEditing(false);
                return;
            }
            if (key.upArrow) setSelectIdx((i) => (i - 1 + 4) % 4);
            else if (key.downArrow) setSelectIdx((i) => (i + 1) % 4);
            else if (key.return) {
                const idx = selectIdxRef.current;
                if (idx === 0) state.resolvePlan({ action: 'accept', autoExecute: true });
                else if (idx === 1) state.resolvePlan({ action: 'accept', autoExecute: false });
                else if (idx === 2) {
                    // 进入编辑器，预填原方案、光标置末尾
                    setPlanDraft(state.pendingPlan.plan);
                    setPlanCursor(state.pendingPlan.plan.length);
                    setPlanEditing(true);
                } else state.resolvePlan({ action: 'reject' });
            } else if (key.escape || (key.ctrl && ch === "g")) state.resolvePlan({ action: 'reject' });
            return;
        }
        if (state.pendingSessions) {
            const list = state.pendingSessions.sessions;
            if (key.upArrow) setSelectIdx((i) => (i - 1 + list.length) % list.length);
            else if (key.downArrow) setSelectIdx((i) => (i + 1) % list.length);
            else if (key.return) {
                const sel = list[Math.min(selectIdxRef.current, list.length - 1)];
                state.resolveSession(sel?.sessionId ?? null);
            }
            else if (key.escape || (key.ctrl && ch === "g")) state.resolveSession(null);
            return;
        }
        if (key.ctrl && ch === "t") { state.toggleShowThinking(); return; }
        if (key.ctrl && ch === "g") { state.abortCurrent(); return; }
        if (slashVisible) {
            const list = filteredCommands;
            if (key.upArrow) setSelectIdx((i) => (i - 1 + list.length) % list.length);
            else if (key.downArrow) setSelectIdx((i) => (i + 1) % list.length);
            else if (key.tab) {
                const sel = list[Math.min(selectIdxRef.current, list.length - 1)];
                if (sel) { const completed = `/${sel.name} `; setInput(completed); setCursor(completed.length); }
            } else if (key.escape) { setInput(""); setCursor(0); }
            else if (key.return) {
                const sel = list[Math.min(selectIdxRef.current, list.length - 1)];
                setInput(""); setCursor(0);
                if (sel) void executeSlash(`/${sel.name}`);
            }
            return;
        }
        if (key.escape) {
            if (busyRef.current) state.abortCurrent();
            else { setInput(""); setCursor(0); }
            return;
        }
    });

    const sessionShort = state.sessionIdRef.current ? truncateMiddle(state.sessionIdRef.current, 12) : "";

    return (
        <Box flexDirection="column" width={cols}>
            {/* 顶部卡片（首项）+ 已完成消息：Static 只渲染一次，避免流式全量重绘闪屏 */}
            <Static items={staticItems}>
                {(item) => item.kind === "__header"
                    ? <TopPanel key="header" cwd={CWD} cols={cols} />
                    : <RowView key={item.id} row={item} wrapW={wrapW} streamTail={streamTail} showThinking={state.showThinkingText} />}
            </Static>

            {/* 动态区：流式尾巴 + 模态 + 输入 + 状态（任务清单已改为内联行，见 RowView / isDynamicRow） */}
            <Box flexDirection="column" width={cols}>
                {/* ★ 治"审批/模态选择闪屏"：任意模态打开时（审批/提问/计划/会话）不渲染流式尾巴，
                    动态区瘦到只剩模态本身 + 输入 + 状态条。否则 ↑↓ 选择会触发 Ink log-update
                    全量擦写「长尾巴 + 高模态」的大动态区 → 闪屏（根因见 cli-render-flicker）。 */}
                {menuActive ? null : (
                    <Box flexDirection="column" paddingX={1}>
                        {dynamicRows.map((row) => <RowView key={row.id} row={row} wrapW={wrapW} streamTail={streamTail} showThinking={state.showThinkingText} />)}
                        {state.busy ? (
                            <Box marginTop={0.5}><Text color={THEME.coralBright}>● {S.generating}</Text></Box>
                        ) : null}
                    </Box>
                )}

                <Box flexDirection="column" paddingX={1} flexShrink={0}>
                    {state.pendingApproval ? (
                        <ApprovalModal toolName={state.pendingApproval.toolName} detail={state.pendingApproval.detail} selectedIndex={selectIdx} wrapW={wrapW} />
                    ) : null}
                    {state.pendingQuestion ? (
                        <QuestionModal
                            question={state.pendingQuestion.req.question}
                            options={state.pendingQuestion.req.options}
                            multiSelect={!!state.pendingQuestion.req.multiSelect}
                            cursor={qCursor}
                            checked={qChecked}
                            wrapW={wrapW}
                        />
                    ) : null}
                    {state.pendingPlan ? (
                        planEditing ? (
                            <PlanEditor
                                value={planDraft}
                                cursor={planCursor}
                                onChange={(v, c) => { setPlanDraft(v); setPlanCursor(c); }}
                                onSubmit={confirmPlanEdit}
                            />
                        ) : (
                            <PlanModal selectedIndex={selectIdx} />
                        )
                    ) : null}
                    {state.pendingSessions ? (
                        <SessionPicker sessions={state.pendingSessions.sessions} selectedIndex={selectIdx} wrapW={wrapW} />
                    ) : null}
                    {slashVisible ? (
                        <SlashMenu entries={filteredCommands} selectedIndex={selectIdx} cols={cols} />
                    ) : null}
                </Box>

                <Box flexDirection="column" paddingX={1} marginTop={1} flexShrink={0}>
                    <Text dimColor color={THEME.gray}>{dimRule(cols)}</Text>
                    <MultilineInput
                        value={input}
                        cursor={cursor}
                        onChange={(v, c) => { setInput(v); setCursor(c); }}
                        onSubmit={() => { void onSubmit(); }}
                        active={inputActive}
                        suppressSubmit={slashVisible}
                        placeholder={S.placeholder}
                    />
                </Box>

                <Box paddingX={1} marginTop={1} flexShrink={0}>
                    <StatusStrip model={modelDisplay} busy={state.busy} aborting={state.aborting} planMode={state.getPlanMode()} autoMode={state.getAutoMode()} sessionShort={sessionShort} cols={cols} customLine={statusLineText} />
                </Box>
            </Box>
        </Box>
    );
};
