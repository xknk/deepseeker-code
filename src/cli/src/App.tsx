/**
 * @file cli/src/App.tsx
 * @description CLI 主界面（对齐 Claude Code 视觉/交互）：
 *  - 已完成消息用 <Static> 只渲染一次（写入滚动缓冲），杜绝流式全量重绘闪屏；动态区只留流式尾巴 + 输入。
 *  - 头部 logo 在 main 启动时打印一次（随对话滚走，符合 CC）；状态条常驻底部。
 *  - 斜杠：未知命令不发给模型；菜单 Enter 执行选中命令。
 *  按键：Ctrl+C 退出 · Esc 中止/清输入 · Ctrl+G 中止 · Ctrl+T 切换思考 · 模态/菜单 ↑↓Enter。
 *  useInput 闭包易过期：input/selectIdx/busy 用 ref 镜像读取最新值。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { listCommands } from "@/commands/registry.ts";
import { MODEL_NAME } from "@/llm/createModel.ts";
import { useChatState, type ChatRow } from "./useChatState.ts";
import { THEME } from "./theme.ts";
import { S, LOCAL_COMMANDS } from "./strings.ts";
import { dimRule, truncateMiddle } from "./util.ts";
import { MessageBlock } from "./components/MessageBlock.tsx";
import { ThinkingBlock } from "./components/ThinkingBlock.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { TodosPanel } from "./components/TodosPanel.tsx";
import { ApprovalModal } from "./components/ApprovalModal.tsx";
import { PlanModal } from "./components/PlanModal.tsx";
import { SlashMenu, type MenuEntry } from "./components/SlashMenu.tsx";
import { MultilineInput, defaultPlaceholder } from "./components/MultilineInput.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { TopPanel } from "./components/TopPanel.tsx";

const KNOWN_MODELS = ["deepseek-v4", "deepseek-v4-flash"];
const CWD = process.cwd();

/** 单行渲染分发：tool/thinking 走专用组件，其余走 MessageBlock。 */
const RowView = ({ row, wrapW }: { row: ChatRow; wrapW: number }): React.ReactElement => {
    if (row.kind === "tool") return <ToolCard toolName={row.toolName} args={row.args} result={row.result} ok={row.ok} status={row.status} wrapW={wrapW} />;
    if (row.kind === "thinking") return <ThinkingBlock streaming={row.streaming ?? false} startedAt={row.startedAt} durationMs={row.durationMs} tokens={row.tokens} />;
    return <MessageBlock row={row} wrapW={wrapW} />;
};

/** 是否留在动态区：仅流式中的 assistant/thinking 与运行中的 tool。
 *  ★ 思考行完成后回 Static——之前"始终动态"导致已完成的思考堆积在末尾（消息混乱）。 */
const isDynamicRow = (r: ChatRow): boolean =>
    (r.kind === "assistant" && !!r.streaming) ||
    (r.kind === "thinking" && !!r.streaming) ||
    (r.kind === "tool" && r.status === "running");

export const App = ({ resumeSessionId, initialPlanMode }: { resumeSessionId?: string; initialPlanMode?: boolean }): React.ReactElement => {
    const state = useChatState(resumeSessionId, initialPlanMode);
    const { exit } = useApp();
    const { stdout } = useStdout();
    const cols = stdout?.columns ?? 80;
    const wrapW = Math.max(16, cols - 2);

    const [input, setInput] = useState("");
    const [cursor, setCursor] = useState(0);
    const [selectIdx, setSelectIdx] = useState(0);
    const [modelDisplay, setModelDisplay] = useState(MODEL_NAME);

    const inputRef = useRef(input);
    const selectIdxRef = useRef(selectIdx);
    const busyRef = useRef(state.busy);
    inputRef.current = input;
    selectIdxRef.current = selectIdx;
    busyRef.current = state.busy;

    const staticRows = useMemo(() => state.rows.filter((r) => !isDynamicRow(r)), [state.rows]);
    const dynamicRows = useMemo(() => state.rows.filter(isDynamicRow), [state.rows]);

    // ★ 顶部双列卡片作为 Static 首项：位于最顶端、只渲染一次（零闪屏），随对话超过屏幕后滚走（同 Claude Code）。
    type StaticItem = { id: number; kind: "__header" } | ChatRow;
    const HEADER_ITEM: StaticItem = { id: -1, kind: "__header" };
    const staticItems = useMemo<StaticItem[]>(() => [HEADER_ITEM, ...staticRows], [staticRows]);

    // 斜杠菜单条目：本地命令 + 核心注册命令（本地优先去重）
    const menuEntries = useMemo<MenuEntry[]>(() => {
        const map = new Map<string, MenuEntry>();
        for (const e of LOCAL_COMMANDS) map.set(e.name, e);
        for (const c of listCommands()) if (!map.has(c.name)) map.set(c.name, { name: c.name, description: c.description });
        return [...map.values()];
    }, []);
    const filteredCommands = useMemo(() => {
        if (!input.startsWith("/")) return [];
        const q = input.slice(1).toLowerCase();
        return menuEntries.filter((c) => c.name.toLowerCase().startsWith(q));
    }, [input, menuEntries]);

    const menuActive = state.pendingApproval != null || state.pendingPlan != null;
    const slashVisible = !menuActive && input.startsWith("/") && filteredCommands.length > 0;
    const inputActive = !menuActive && !slashVisible;

    useEffect(() => { setSelectIdx(0); }, [state.pendingApproval, state.pendingPlan, slashVisible]);

    // —— 本地斜杠命令 ——
    const runLocalSlash = (text: string): boolean => {
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
            case "/help":
                state.pushInfo([
                    "/help · /status · /clear · /exit",
                    "/plan  — 切换计划模式（只读调研 → 方案审批 → 实现）",
                    `/model [${KNOWN_MODELS.join("|")}|<任意>] — 切换模型（当前 ${modelDisplay}）`,
                    "Ctrl+C 退出 · Esc 中止/清输入 · Ctrl+G 中止 · Ctrl+T 展开/收起思考",
                ].join("\n"));
                return true;
            case "/status":
                state.pushInfo([
                    `模型：${modelDisplay}`,
                    `计划模式：${state.getPlanMode() ? "开" : "关"}`,
                    `工作目录：${CWD}`,
                ].join("\n"));
                return true;
            case "/plan": {
                const on = !state.getPlanMode();
                state.setPlanMode(on);
                state.pushInfo(`计划模式：${on ? "开（下次提问先只读调研并产出方案，审批后实现）" : "关"}`);
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
            default:
                return false;
        }
    };

    /** 执行斜杠命令：本地优先 → 注册命令（expandSlashCommand 展开）→ 未知则提示，绝不把 `/xxx` 发给模型。 */
    const executeSlash = async (fullText: string): Promise<void> => {
        const text = fullText.trim();
        if (!text.startsWith("/")) { await state.submit(text); return; }
        if (runLocalSlash(text)) return;
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

    // —— 全局按键分发（模态优先） ——
    useInput((ch, key) => {
        if (key.ctrl && ch === "c") { exit(); return; }
        if (state.pendingApproval) {
            if (key.upArrow || key.downArrow) setSelectIdx((i) => (i === 0 ? 1 : 0));
            else if (key.return) state.resolveApproval(selectIdxRef.current === 0);
            else if (key.escape || (key.ctrl && ch === "g")) state.resolveApproval(false);
            return;
        }
        if (state.pendingPlan) {
            if (key.upArrow || key.downArrow) setSelectIdx((i) => (i === 0 ? 1 : 0));
            else if (key.return) state.resolvePlan(selectIdxRef.current === 0);
            else if (key.escape || (key.ctrl && ch === "g")) state.resolvePlan(false);
            return;
        }
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
                    : <RowView key={item.id} row={item} wrapW={wrapW} />}
            </Static>

            {/* 动态区：流式尾巴 + 任务面板 + 模态 + 输入 + 状态 */}
            <Box flexDirection="column" width={cols}>
                <Box paddingX={1}>
                    <TodosPanel todos={state.todos} wrapW={wrapW} />
                </Box>

                <Box flexDirection="column" paddingX={1}>
                    {dynamicRows.map((row) => <RowView key={row.id} row={row} wrapW={wrapW} />)}
                    {state.busy ? (
                        <Box marginTop={0.5}><Text color={THEME.coralBright}>● {S.generating}</Text></Box>
                    ) : null}
                </Box>

                <Box flexDirection="column" paddingX={1} flexShrink={0}>
                    {state.pendingApproval ? (
                        <ApprovalModal toolName={state.pendingApproval.toolName} detail={state.pendingApproval.detail} selectedIndex={selectIdx} wrapW={wrapW} />
                    ) : null}
                    {state.pendingPlan ? (
                        <PlanModal plan={state.pendingPlan.plan} selectedIndex={selectIdx} wrapW={wrapW} />
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
                        placeholder={defaultPlaceholder}
                    />
                </Box>

                <Box paddingX={1} marginTop={1} flexShrink={0}>
                    <StatusStrip model={modelDisplay} busy={state.busy} aborting={state.aborting} planMode={state.getPlanMode()} sessionShort={sessionShort} cols={cols} />
                </Box>
            </Box>
        </Box>
    );
};
