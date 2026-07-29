/**
 * @file cli/src/main.tsx
 * @description CLI 入口：argv 解析 → 校验 DEEP_SEEK_API_KEY → initEngine → render(<App/>)。
 *  运行：npx tsx --tsconfig src/cli/tsconfig.json src/cli/src/main.tsx [--resume <id>] [--plan]
 *
 *  ★ 核心/Agent 模块用动态 import：createModel.ts 在模块加载期即构造 OpenAI client，
 *    无 key 时会在静态 import 求值阶段抛错（早于 main 体）。延迟到 key 校验之后再加载，
 *    使缺失密钥时给出干净提示而非裸 OpenAI 栈。
 */
import React from "react";
import { render } from "ink";
import { S } from "./strings.ts";

/** 极简 argv 解析（不引第三方）：--resume/-r <id>、--plan/-p。 */
const parseArgs = (argv: string[]): { resume?: string; plan?: boolean } => {
    const out: { resume?: string; plan?: boolean } = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--resume" || a === "-r") out.resume = argv[++i];
        else if (a === "--plan" || a === "-p") out.plan = true;
    }
    return out;
};

const main = async (): Promise<void> => {
    const args = parseArgs(process.argv.slice(2));

    // ★ 模型密钥前置校验（核心 OpenAI client 经 DEEP_SEEK_API_KEY 配置）。
    //    必须在动态 import 核心/Agent 之前——否则 createModel 加载期即抛错。
    if (!process.env.DEEP_SEEK_API_KEY) {
        console.error(S.noApiKey("DEEP_SEEK_API_KEY"));
        process.exit(1);
    }

    // 延迟加载核心与 App（避免无 key 时 createModel 在静态 import 期抛错）。
    const [{ initEngine }, { agentTools }, { App }] = await Promise.all([
        import("@/bootstrap.ts"),
        import("@/tool/index.ts"),
        import("./App.tsx"),
    ]);

    // ★ 初始化引擎（MCP/hooks/permissions/skills/agents/projectGuide/commands），返回 dispose。
    const dispose = await initEngine(agentTools);
    const onExit = (): void => { dispose(); };
    process.on("SIGINT", () => { onExit(); process.exit(0); });
    process.on("SIGTERM", () => { onExit(); process.exit(0); });

    // ★ 清屏（含滚动缓冲）+ 光标归位：擦去 PowerShell 横幅与 initEngine 的加载日志，启动即纯净全屏。
    process.stdout.write("\x1B[2J\x1B[3J\x1B[1;1H");

    const { waitUntilExit } = render(
        <App resumeSessionId={args.resume} initialPlanMode={args.plan} />,
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
