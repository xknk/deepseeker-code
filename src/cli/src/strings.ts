/**
 * @file cli/src/strings.ts
 * @description CLI 面向用户文案集中管理（中英文 i18n）。
 *  S 为 Proxy：按当前 locale（getLocale/setLocale）分发，调用点 S.xxx 无需改动、随重渲染刷新。
 *  ★ 约束：禁止在模块加载期快照 S.x（如 const x = S.placeholder）——会脱离响应式；必须在 render/调用期读取。
 */
import type { Locale } from "@/common/index.ts";

/** 版本号（与 package.json 对齐；展示用，避免再读文件）。 */
export const VERSION = "v1.0.0";

/** 文案字典类型（zh/en 同型约束，缺 key 编译期报错，杜绝两套漂移）。 */
interface StringDict {
    brand: string;
    welcomeTitle: string;
    tipLine: string;
    emptyHints: string[];
    placeholder: string;
    generating: string;
    round: (n: number | string) => string;
    thinkingStreaming: string;
    thinkingCollapsed: (lines: number) => string;
    thinkingExpanded: (lines: number) => string;
    toolRunning: (name: string) => string;
    toolDone: (name: string, ok: boolean) => string;
    toolDenied: (name: string) => string;
    planTitle: string;
    planPrompt: string;
    planAccept: string;
    planReject: string;
    approvalTitle: string;
    approvalPrompt: string;
    approvalAllow: string;
    approvalAllowAlways: string;
    approvalDeny: string;
    errAborted: string;
    busyBlockSend: string;
    cmdHint: string;
    statusStreaming: string;
    statusIdle: string;
    statusAborting: string;
    statusPlan: string;
    noApiKey: (env: string) => string;
    startupBanner: (cwd: string, projectKey: string, isHome: boolean) => string;
    /** 本地命令描述（命令 name 不翻译，仅描述随 locale） */
    cmdHelp: string;
    cmdStatus: string;
    cmdPlan: string;
    cmdModel: string;
    cmdThinking: string;
    cmdLang: string;
    cmdClear: string;
    cmdExit: string;
    /** /lang 与启动期信任询问 */
    langCurrent: () => string;
    langSet: (l: string) => string;
    langInvalid: (arg: string) => string;
    askTrust: (cwd: string) => string;
    optTrust: string;
    optExit: string;
    helpText: (model: string, thinking: string, locale: string) => string;
    statusText: (model: string, thinking: string, planOn: boolean, locale: string, cwd: string) => string;
}

const STRINGS: Record<Locale, StringDict> = {
    zh: {
        brand: "deepSeekCode",
        welcomeTitle: "✻ 欢迎使用 deepSeekCode",
        tipLine: "输入需求开始 · 输入 / 唤出命令 · Ctrl+C 退出 · Esc 中止 · Ctrl+T 折叠思考",
        emptyHints: [
            "帮我看一下这个项目的结构",
            "把这个函数改成箭头函数",
            "解释 runAgent 的主循环逻辑",
        ],
        placeholder: "发送消息（Shift+Enter 换行，Enter 发送）…",
        generating: "生成中…",
        round: (n) => `第 ${n} 轮`,
        thinkingStreaming: "✻ 深度思考中…",
        thinkingCollapsed: (lines) => `✻ 思考过程（${lines} 行）· Ctrl+T 展开`,
        thinkingExpanded: (lines) => `✻ 思考过程（${lines} 行）· Ctrl+T 收起`,
        toolRunning: (name) => `⏺ ${name} 运行中…`,
        toolDone: (name, ok) => `⏺ ${name} · ${ok ? "成功" : "失败"}`,
        toolDenied: (name) => `🚫 ${name} 已被拒绝`,
        planTitle: "✅ 实现方案（计划模式）",
        planPrompt: "↑↓ 选择后 Enter：接受则进入实现，拒绝则继续计划。",
        planAccept: "接受方案，开始实现",
        planReject: "拒绝，继续计划",
        approvalTitle: "🔐 操作审批",
        approvalPrompt: "↑↓ 选择后 Enter（Esc 拒绝）：允许本次 / 总是允许（写持久规则）/ 拒绝。",
        approvalAllow: "允许本次",
        approvalAllowAlways: "总是允许（此项目）",
        approvalDeny: "拒绝",
        errAborted: "已中止当前轮。",
        busyBlockSend: "⏳ 正在生成，请等待或按 Esc 中止后再发送。",
        cmdHint: "/help 帮助 · /plan 计划模式 · /model 切换模型 · /thinking 思考等级 · /lang 语言 · /clear 清屏 · /exit 退出",
        statusStreaming: "生成中",
        statusIdle: "就绪",
        statusAborting: "中止中…",
        statusPlan: "计划模式",
        noApiKey: (env) => `❌ 未配置 ${env}，无法调用模型。\n请在环境变量中设置后重试，或先启动 serve 用 Web 界面。`,
        startupBanner: (cwd, projectKey, isHome) => {
            // 普通目录不打印（TopPanel 已显示）；仅家目录时打印黄色风险警告。
            if (!isHome) return "";
            const yellow = "\x1b[33m", dim = "\x1b[2m", reset = "\x1b[0m";
            return (
                `${yellow}⚠️  当前工作目录是用户家目录（${cwd}）${reset}\n` +
                `${yellow}   工具将以该目录为项目根读写文件，建议先 cd 到具体项目目录再运行。${reset}\n` +
                `${dim}   项目键：${projectKey}${reset}\n\n`
            );
        },
        cmdHelp: "查看帮助与快捷键",
        cmdStatus: "查看当前模型/会话/模式",
        cmdPlan: "切换计划模式（只读调研→审批→实现）",
        cmdModel: "切换模型：/model <deepseek-v4|deepseek-v4-flash|…>",
        cmdThinking: "切换思考等级：/thinking <off|high|max>",
        cmdLang: "切换界面语言：/lang <zh|en>",
        cmdClear: "清空当前屏幕",
        cmdExit: "退出 CLI",
        langCurrent: () => `当前界面语言：中文（/lang en 切换英文）`,
        langSet: (l) => `界面语言已切换：${l === "zh" ? "中文" : "English"}`,
        langInvalid: (arg) => `无效语言：${arg}（可选：zh 中文 / en English）`,
        askTrust: (cwd) => `安全检查：这是你信任的项目吗？\n${cwd}\n\ndeepSeekCode 将在此目录读取、编辑和执行文件。`,
        optTrust: "信任此目录",
        optExit: "退出",
        helpText: (model, thinking, locale) => [
            "/help · /status · /clear · /exit",
            "/plan  — 切换计划模式（只读调研 → 方案审批 → 实现）",
            `/model [deepseek-v4|deepseek-v4-flash|<任意>] — 切换模型（当前 ${model}）`,
            `/thinking [off|high|max] — 切换思考等级（当前 ${thinking}）`,
            `/lang [zh|en] — 切换界面语言（当前 ${locale}）`,
            "Ctrl+C 退出 · Esc 中止/清输入 · Ctrl+G 中止 · Ctrl+T 展开/收起思考",
        ].join("\n"),
        statusText: (model, thinking, planOn, locale, cwd) => [
            `模型：${model}`,
            `思考等级：${thinking}`,
            `计划模式：${planOn ? "开" : "关"}`,
            `界面语言：${locale}`,
            `工作目录：${cwd}`,
        ].join("\n"),
    },
    en: {
        brand: "deepSeekCode",
        welcomeTitle: "✻ Welcome to deepSeekCode",
        tipLine: "Type a request to start · Type / for commands · Ctrl+C exit · Esc abort · Ctrl+T toggle thinking",
        emptyHints: [
            "Show me this project's structure",
            "Convert this function to an arrow function",
            "Explain runAgent's main loop",
        ],
        placeholder: "Send a message (Shift+Enter newline, Enter to send)…",
        generating: "Generating…",
        round: (n) => `Round ${n}`,
        thinkingStreaming: "✻ Thinking…",
        thinkingCollapsed: (lines) => `✻ Thoughts (${lines} lines) · Ctrl+T expand`,
        thinkingExpanded: (lines) => `✻ Thoughts (${lines} lines) · Ctrl+T collapse`,
        toolRunning: (name) => `⏺ ${name} running…`,
        toolDone: (name, ok) => `⏺ ${name} · ${ok ? "ok" : "failed"}`,
        toolDenied: (name) => `🚫 ${name} denied`,
        planTitle: "✅ Implementation plan (plan mode)",
        planPrompt: "↑↓ then Enter: accept to implement, reject to keep planning.",
        planAccept: "Accept plan, start implementing",
        planReject: "Reject, keep planning",
        approvalTitle: "🔐 Action approval",
        approvalPrompt: "↑↓ then Enter (Esc to deny): allow once / always allow (persist rule) / deny.",
        approvalAllow: "Allow once",
        approvalAllowAlways: "Always allow (this project)",
        approvalDeny: "Deny",
        errAborted: "Aborted current turn.",
        busyBlockSend: "⏳ Still generating—wait or press Esc to abort before sending.",
        cmdHint: "/help help · /plan plan mode · /model switch model · /thinking thinking level · /lang language · /clear clear · /exit quit",
        statusStreaming: "streaming",
        statusIdle: "ready",
        statusAborting: "aborting…",
        statusPlan: "plan mode",
        noApiKey: (env) => `❌ ${env} is not configured—cannot call the model.\nSet it as an env var and retry, or start serve for the Web UI.`,
        startupBanner: (cwd, projectKey, isHome) => {
            if (!isHome) return "";
            const yellow = "\x1b[33m", dim = "\x1b[2m", reset = "\x1b[0m";
            return (
                `${yellow}⚠️  Current working directory is your home directory (${cwd})${reset}\n` +
                `${yellow}   Tools will read/write files with this as project root—cd into the actual project first.${reset}\n` +
                `${dim}   Project key: ${projectKey}${reset}\n\n`
            );
        },
        cmdHelp: "Show help & shortcuts",
        cmdStatus: "Show current model/session/mode",
        cmdPlan: "Toggle plan mode (read-only research → review → implement)",
        cmdModel: "Switch model: /model <deepseek-v4|deepseek-v4-flash|…>",
        cmdThinking: "Switch thinking level: /thinking <off|high|max>",
        cmdLang: "Switch interface language: /lang <zh|en>",
        cmdClear: "Clear the screen",
        cmdExit: "Quit the CLI",
        langCurrent: () => `Interface language: English (/lang zh for 中文)`,
        langSet: (l) => `Interface language: ${l === "zh" ? "中文" : "English"}`,
        langInvalid: (arg) => `Invalid language: ${arg} (choose zh / en)`,
        askTrust: (cwd) => `Quick safety check: is this a project you trust?\n${cwd}\n\ndeepSeekCode will read, edit, and execute files here.`,
        optTrust: "Yes, I trust this folder",
        optExit: "No, exit",
        helpText: (model, thinking, locale) => [
            "/help · /status · /clear · /exit",
            "/plan  — Toggle plan mode (read-only research → review → implement)",
            `/model [deepseek-v4|deepseek-v4-flash|<any>] — Switch model (current ${model})`,
            `/thinking [off|high|max] — Switch thinking level (current ${thinking})`,
            `/lang [zh|en] — Switch interface language (current ${locale})`,
            "Ctrl+C exit · Esc abort/clear input · Ctrl+G abort · Ctrl+T toggle thinking",
        ].join("\n"),
        statusText: (model, thinking, planOn, locale, cwd) => [
            `Model: ${model}`,
            `Thinking: ${thinking}`,
            `Plan mode: ${planOn ? "on" : "off"}`,
            `Language: ${locale}`,
            `Working dir: ${cwd}`,
        ].join("\n"),
    },
};

let locale: Locale = "zh";
export const getLocale = (): Locale => locale;
export const setLocale = (l: Locale): void => { locale = l; };

/**
 * 文案分发 Proxy：S.xxx 在读取时按当前 locale 返回，调用点无需改动、随重渲染刷新。
 * 函数属性 S.round(n) 自动 work（get 返回函数再调用）；symbol 键守卫防 React 内省（S.then 等）。
 */
export const S: StringDict = new Proxy({} as StringDict, {
    get: (_t, k) => (typeof k === "string" ? (STRINGS[locale] as any)[k] : undefined),
});

/** 本地斜杠命令名（name 是命令键不翻译；描述在渲染时用 S.cmdXxx 现取）。 */
export const LOCAL_COMMAND_NAMES = ["help", "status", "plan", "model", "thinking", "lang", "clear", "exit"] as const;
