/**
 * @file cli/src/strings.ts
 * @description CLI 面向用户的中文文案集中管理。
 */

/** 版本号（与 package.json 对齐；展示用，避免再读文件）。 */
export const VERSION = "v1.0.0";

export const S = {
    brand: "deepSeekCode",
    /** 顶部欢迎标题（仅一处，对齐 Claude Code「✻ Welcome to ...」）。 */
    welcomeTitle: "✻ Welcome to deepSeekCode",
    /** 顶部单行提示（去重：只出现一次）。 */
    tipLine: "输入需求开始 · 输入 / 唤出命令 · Ctrl+C 退出 · Esc 中止 · Ctrl+T 折叠思考",
    /** 空会话示例提示（替代重复的欢迎语）。 */
    emptyHints: [
        "帮我看一下这个项目的结构",
        "把这个函数改成箭头函数",
        "解释 runAgent 的主循环逻辑",
    ],
    placeholder: "发送消息（Shift+Enter 换行，Enter 发送）…",
    generating: "生成中…",
    round: (n: number | string) => `第 ${n} 轮`,
    thinkingStreaming: "✻ 深度思考中…",
    thinkingCollapsed: (lines: number) => `✻ 思考过程（${lines} 行）· Ctrl+T 展开`,
    thinkingExpanded: (lines: number) => `✻ 思考过程（${lines} 行）· Ctrl+T 收起`,
    toolRunning: (name: string) => `⏺ ${name} 运行中…`,
    toolDone: (name: string, ok: boolean) => `⏺ ${name} · ${ok ? "成功" : "失败"}`,
    toolDenied: (name: string) => `🚫 ${name} 已被拒绝`,
    planTitle: "✅ 实现方案（计划模式）",
    planPrompt: "↑↓ 选择后 Enter：接受则进入实现，拒绝则继续计划。",
    planAccept: "接受方案，开始实现",
    planReject: "拒绝，继续计划",
    approvalTitle: "🔐 操作审批",
    approvalPrompt: "该操作需要确认。↑↓ 选择后 Enter（Esc 拒绝）。",
    approvalAllow: "允许",
    approvalDeny: "拒绝",
    errAborted: "已中止当前轮。",
    busyBlockSend: "⏳ 正在生成，请等待或按 Esc 中止后再发送。",
    cmdHint: "/help 帮助 · /plan 计划模式 · /model 切换模型 · /clear 清屏 · /exit 退出",
    statusStreaming: "生成中",
    statusIdle: "就绪",
    statusAborting: "中止中…",
    statusPlan: "计划模式",
    noApiKey: (env: string) => `❌ 未配置 ${env}，无法调用模型。\n请在环境变量中设置后重试，或先启动 serve 用 Web 界面。`,
} as const;

/** 本地斜杠命令清单（菜单展示 + /help 文案统一来源）。 */
export const LOCAL_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
    { name: "help", description: "查看帮助与快捷键" },
    { name: "status", description: "查看当前模型/会话/模式" },
    { name: "plan", description: "切换计划模式（只读调研→审批→实现）" },
    { name: "model", description: "切换模型：/model <deepseek-v4|deepseek-v4-flash|…>" },
    { name: "clear", description: "清空当前屏幕" },
    { name: "exit", description: "退出 CLI" },
];
