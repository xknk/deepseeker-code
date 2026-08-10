/**
 * @file cli/src/main.tsx
 * @description CLI 入口：argv 解析 → 校验 DEEP_SEEK_API_KEY → 语言/信任启动询问 → initEngine → render(<App/>)。
 *  运行：npx tsx --tsconfig src/cli/tsconfig.json src/cli/src/main.tsx [--resume <id>] [--continue] [--plan]
 *
 *  ★ 核心/Agent 模块用动态 import：createModel.ts 在模块加载期即构造 OpenAI client，
 *    无 key 时会在静态 import 求值阶段抛错（早于 main 体）。延迟到 key 校验之后再加载，
 *    使缺失密钥时给出干净提示而非裸 OpenAI 栈。
 *
 *  ★ 启动期询问（语言/信任）用 node:readline/promises，在 render 前 rl.close()，随后 Ink 接管 stdin。
 */
import "./preload-config.ts"; // ★ 必须第一：在任何 core 模块求值前把 ~/.deepseeker-code/config.json 回填到 env（env 仍可覆盖）
import React from "react";
import { render } from "ink";
import os from "os";
import path from "path";
import { emitKeypressEvents } from "node:readline";
import { S, setLocale } from "./strings.ts";
import { readLocale, writeLocale } from "./prefs.ts";
import { isTrustedDir, trustDir } from "@/trust/index.ts";
import type { Locale } from "@/common/index.ts";

/** 极简 argv 解析（不引第三方）：--resume/-r <id>、--plan/-p、--continue/-c、--trust。 */
const parseArgs = (argv: string[]): { resume?: string; plan?: boolean; auto?: boolean; continue?: boolean; trust?: boolean } => {
    const out: { resume?: string; plan?: boolean; auto?: boolean; continue?: boolean; trust?: boolean } = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--resume" || a === "-r") out.resume = argv[++i];
        else if (a === "--plan" || a === "-p") out.plan = true;
        else if (a === "--auto" || a === "-a") out.auto = true;
        else if (a === "--continue" || a === "-c") out.continue = true;
        else if (a === "--trust") out.trust = true; // 非 TTY 显式信任（CI/脚本启用项目级配置）
    }
    return out;
};

/**
 * 启动期单选询问（render 前）：↑↓ 移动、Enter 确认、Esc 取消(=fallback)、Ctrl+C 退出。
 * 用 raw mode + keypress 捕获方向键；非 TTY（管道/CI）直接返回 fallbackKey，不阻塞。
 * ★ 须在 render() 前完成且 cleanup 复位 raw mode，随后 Ink 才能接管 stdin。
 */
const askChoice = async (
    prompt: string,
    options: { key: string; label: string }[],
    fallbackKey: string,
): Promise<string> => {
    if (process.stdin.isTTY !== true) return fallbackKey;
    const n = options.length;
    let selected = 0;

    process.stdout.write(prompt + "\n");

    const stdin = process.stdin;
    emitKeypressEvents(stdin);
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);

    const buildLines = (): string[] => options.map((o, i) => `${i === selected ? "❯ " : "  "}${o.label}`);
    /** 重绘选项块（光标须在块顶行首）；绘完光标回到块顶。 */
    const draw = (): void => {
        const ls = buildLines();
        for (let i = 0; i < n; i++) {
            process.stdout.write(`\r\x1B[K${ls[i]}`);
            if (i < n - 1) process.stdout.write("\n");
        }
        if (n > 1) process.stdout.write(`\x1B[${n - 1}A`); // 回块顶
    };

    draw(); // 首次绘制

    return new Promise<string>((resolve) => {
        const cleanup = (): void => {
            stdin.removeListener("keypress", onKey);
            if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
        };
        const onKey = (_s: string, key: any): void => {
            if (!key) return;
            if (key.name === "up" && selected > 0) { selected--; draw(); }
            else if (key.name === "down" && selected < n - 1) { selected++; draw(); }
            else if (key.name === "return") {
                cleanup();
                process.stdout.write(`\x1B[${n - 1}B\n\r`); // 光标移到块底→换行→归列
                resolve(options[selected].key);
            }
            else if (key.name === "escape") {
                cleanup();
                process.stdout.write(`\x1B[${n - 1}B\n\r`);
                resolve(fallbackKey);
            }
            else if (key.ctrl && key.name === "c") {
                cleanup();
                process.exit(0);
            }
        };
        stdin.on("keypress", onKey);
    });
};

const main = async (): Promise<void> => {
    // ★ 静默 core 层 console.log/warn/info/debug：Ink 靠「自己写到 stdout 的内容」追踪光标行数，决定下一帧
    //   擦除几行。core（runAgent 的 🤖/🔄、guard 的审批、各 loader 的 warn 等）在渲染期间把 console.* 写进
    //   stdout → 打乱 Ink 行数追踪 → 工具行叠影、输入框/状态条错位、日志污染画面。
    //   CLI 模式把它们重定向为 no-op，让 Ink 独占 stdout（启动横幅用 process.stdout.write 不受影响；
    //   console.error 仍进 stderr，罕见且不致乱）。需要调试时注释掉本段即可恢复日志。
    const silence = (): void => {};
    console.log = silence;
    console.info = silence;
    console.debug = silence;
    console.warn = silence;

    const args = parseArgs(process.argv.slice(2));

    // ★ 模型密钥前置校验（核心 OpenAI client 经 DEEP_SEEK_API_KEY 配置）。
    //    必须在动态 import 核心/Agent 之前——否则 createModel 加载期即抛错。
    if (!process.env.DEEP_SEEK_API_KEY) {
        console.error(S.noApiKey("DEEP_SEEK_API_KEY"));
        process.exit(1);
    }

    // ★ 语言（最早询问）：首次启动未设 → 选中文/English；之后从 prefs 持久化复用。
    //   询问本身双语展示，不依赖已选 locale。
    const savedLocale = await readLocale();
    if (savedLocale) {
        setLocale(savedLocale);
    } else {
        const picked = await askChoice(
            "请选择界面语言 / Select interface language",
            [{ key: "zh", label: "中文" }, { key: "en", label: "English" }],
            "zh",
        ) as Locale;
        setLocale(picked);
        await writeLocale(picked);
    }

    const cwd = process.cwd();
    // ★ 信任文件夹闸门：未信任目录不加载项目级配置（hooks 会 spawn 执行命令 / CLAUDE.md 注入 system prompt /
    //   permissions 可自动放行）。includeProject 由 isTrustedDir 驱动，复用各 loader 已就绪的裁剪路径。
    let includeProject = await isTrustedDir(cwd);
    if (process.stdin.isTTY === true) {
        // TTY：交互式确认（保留 askChoice 流程）。
        if (!includeProject) {
            const choice = await askChoice(
                S.askTrust(cwd),
                [{ key: "trust", label: S.optTrust }, { key: "exit", label: S.optExit }],
                "trust",
            );
            if (choice === "exit") process.exit(0);
            await trustDir(cwd);
            includeProject = true;
        }
    } else if (args.trust && !includeProject) {
        // ★ 非 TTY（CI/脚本/管道）显式信任：--trust 持久化信任并启用项目级配置。
        //   默认（无 --trust）不加载项目级配置、不写入信任列表——安全默认，堵住「克隆即中招」。
        await trustDir(cwd);
        includeProject = true;
    }

    // 延迟加载核心与 App（避免无 key 时 createModel 在静态 import 期抛错）。
    const [{ initEngine }, { agentTools }, { App }, { appConfig }] = await Promise.all([
        import("@/bootstrap.ts"),
        import("@/tool/index.ts"),
        import("./App.tsx"),
        import("@/config/index.ts"),
    ]);

    // ★ 初始化引擎（MCP/hooks/permissions/skills/agents/projectGuide/commands），返回 dispose。
    //   includeProject 由信任闸门决定：已信任/已确认 → 加载项目级配置；未信任 → 跳过（安全默认）。
    const dispose = await initEngine(agentTools, { includeProject });
    const onExit = (): void => { dispose(); };
    process.on("SIGINT", () => { onExit(); process.exit(0); });
    process.on("SIGTERM", () => { onExit(); process.exit(0); });

    // ★ 清屏（含滚动缓冲）+ 光标归位：擦去 PowerShell 横幅与 initEngine 的加载日志，启动即纯净全屏。
    process.stdout.write("\x1B[2J\x1B[3J\x1B[1;1H");

    // ★ 启动横幅：cwd 落在家目录时转黄色警告（工具以家目录为项目根，风险高）。
    const cwdIsHome = (): boolean => {
        try {
            return path.resolve(cwd).toLowerCase() === path.resolve(os.homedir()).toLowerCase();
        } catch {
            return false;
        }
    };
    process.stdout.write(S.startupBanner(cwd, appConfig.userWorkspaceDir, cwdIsHome()));

    // ★ --continue/-c：无显式 --resume 时，自动续接本工作区最近一次会话（对标 cc -c）。
    //   取 sessions 目录里 updatedAt 最新的主会话 id；无历史则回落到全新会话（resumeId 留空）。
    let resumeId = args.resume;
    if (!resumeId && args.continue) {
        const { getMostRecentSessionId } = await import("@/session/store.ts");
        resumeId = (await getMostRecentSessionId()) ?? undefined;
    }

    const { waitUntilExit } = render(
        <App resumeSessionId={resumeId} initialPlanMode={args.plan} initialAutoMode={args.auto} initialIncludeProject={includeProject} />,
        // exitOnCtrlC:false：Ctrl+C 交由 App useInput 处理（统一退出/中止语义）；
        // patchConsole:false：避免 console 劫持与全屏重绘叠加闪屏。
        { exitOnCtrlC: false, patchConsole: false },
    );
    await waitUntilExit();
    onExit();
};

main().catch((err) => {
    console.error("CLI 启动失败：", err);
    process.exit(1);
});
