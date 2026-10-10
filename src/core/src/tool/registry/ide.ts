/**
 * @file tool/registry/ide.ts
 * @description IDE 桥工具集：经宿主钩子 ctx.ideAction（RequestIdeActionFn，见 host/type.ts）请求
 *  宿主（VSCode）执行 IDE 动作并拿回结构化结果。三工具三等级（与 background.ts 同构）：
 *   - ide_open_file   SAFE  —— 在编辑器打开文件并跳转到行/列
 *   - ide_diagnostics SAFE  —— 读 IDE 真实诊断（含 .vue 等所有已装语言服务器的语言，补 get_diagnostics 只覆盖 TS/JS 的缺口）
 *   - ide_run_task    DANGER —— 触发 VSCode 任务（tasks.json），触发即返回不等待完成
 *
 *  双层防御：① validateEnvironment 检查 ctx.ideAction——CLI/HTTP 宿主未注入钩子时三工具直接从
 *  模型工具表剔除（仿 typescript.ts 自隐藏）；② execute 内兜底降级返回引导文案（仿 ask.ts:58-61）。
 *  vscode 类型不进 core：宿主在边界把 Diagnostic 映射为纯数据 IdeDiagnosticItem。
 */
import { toolFailure, CustomTool, ToolContext, ToolSafetyLevel } from "../type.ts";
import { IdeActionResult, IdeDiagnosticItem } from "@/host/type.ts";

/** ide_* 三工具共用的环境断言：宿主没注入 IDE 桥钩子 = 当前环境无 IDE，工具不暴露给模型。 */
const requireIdeHost = (ctx?: ToolContext): boolean => !!ctx?.ideAction;

/** execute 内兜底降级文案（validateEnvironment 因每轮 validationCtx 差异漏拦时的第二层防御）。 */
const IDE_UNAVAILABLE = toolFailure(
    "[IDE 桥不可用]：当前宿主未接入 IDE。诊断请改用 run_command 跑对应工具链（tsc/vue-tsc/mvn compile 等）；" +
    "打开文件请在回复中直接给出 文件路径:行号。本工具仅在 VSCode 宿主可用。",
    'permission',
);

/** 把宿主回传的诊断条目格式化为与 get_diagnostics 同构的文本行（模型已熟悉该格式，零学习成本）。 */
const formatDiagnostics = (items: IdeDiagnosticItem[], truncated?: number): string => {
    const count = (s: string) => items.filter(i => i.severity === s).length;
    const sources = [...new Set(items.map(i => i.source).filter(Boolean))].join("/");
    const head = `[IDE 诊断] error×${count("error")} warning×${count("warning")} info×${count("info")}` +
        `${sources ? `（来源: ${sources}）` : ""}${truncated ? `；另有 ${truncated} 条未显示` : ""}`;
    const body = items
        .map(i => `${i.file}:${i.line}:${i.column}  ${i.severity}${i.code != null && i.code !== "" ? " " + i.code : ""}  ${i.message}${i.source ? ` (${i.source})` : ""}`)
        .join("\n");
    const hint = items.length === 0
        ? "\n（诊断为空：若目标文件可能未在 IDE 中加载，先 ide_open_file 打开再取一次）"
        : "\n修复后可再次调用确认清零。.vue 等诊断来自 IDE 语言服务器（如 Volar），与 run_command 跑 vue-tsc 的口径一致。";
    return `${head}\n${body}${hint}`;
};

/** ide 结果统一出口：宿主 ok:false → 结构化失败；其余把 message/items 拼成面向模型的文本。 */
const ideResultToText = (r: IdeActionResult): string | ReturnType<typeof toolFailure> => {
    if (!r.ok) return toolFailure(`[IDE 动作失败]：${r.message}`);
    if (r.action === 'diagnostics') return formatDiagnostics(r.items, r.truncated);
    return `✅ ${r.message}`;
};

export const ideTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "ide_open_file",
            planAllowed: true,
            validateEnvironment: requireIdeHost,
            description:
                "在用户的 IDE 编辑器里打开文件并跳转到指定行/列（如改完代码后让用户直接看到修改处）。" +
                "仅 VSCode 宿主可用；其他环境本工具不会出现，出现即代表可用。" +
                "★ 只读安全，可与其它只读工具在同一条消息里并行调用。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "目标文件路径（相对工作区根或绝对路径）" },
                    line: { type: "number", description: "跳转行号（1-based，可选）" },
                    column: { type: "number", description: "跳转列号（1-based，可选，缺省行首）" },
                },
                required: ["path"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { path?: string; line?: number; column?: number }, ctx?: ToolContext) {
                const p = (args?.path ?? "").trim();
                if (!p) return toolFailure("[打开失败]：path 不能为空。", 'syntax');
                if (!ctx?.ideAction) return IDE_UNAVAILABLE;
                try {
                    const r = await ctx.ideAction({ action: 'open', path: p, line: args?.line, column: args?.column });
                    return ideResultToText(r);
                } catch (e: any) {
                    return toolFailure(`[IDE 异常]：${e?.message ?? e}`);
                }
            },
        },
    },
    {
        type: "function",
        function: {
            name: "ide_diagnostics",
            planAllowed: true,
            validateEnvironment: requireIdeHost,
            maxOutputCharacters: 8000,
            description:
                "读取 IDE 当前真实诊断（错误波浪线），支持所有已装语言服务器的语言——含 .vue（Volar）/Java 等；" +
                "get_diagnostics 只覆盖 TS/JS，两者互补。path 缺省=整个工作区（按 error 优先排序）；" +
                "severity 缺省 error。★ 修复 .vue 报错、验证改动后 IDE 是否还亮红，用它；" +
                "文件可能未加载时先 ide_open_file 打开再取。★ 只读安全，可并行调用。",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "目标文件路径（可选，缺省=全工作区诊断）" },
                    severity: { type: "string", enum: ["error", "warning", "all"], description: "最低严重度（缺省 error；排查警告时用 warning/all）" },
                },
                required: [],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: { path?: string; severity?: 'error' | 'warning' | 'all' }, ctx?: ToolContext) {
                if (!ctx?.ideAction) return IDE_UNAVAILABLE;
                try {
                    const r = await ctx.ideAction({ action: 'diagnostics', path: args?.path?.trim() || undefined, severity: args?.severity });
                    return ideResultToText(r);
                } catch (e: any) {
                    return toolFailure(`[IDE 异常]：${e?.message ?? e}`);
                }
            },
        },
    },
    {
        type: "function",
        function: {
            name: "ide_run_task",
            validateEnvironment: requireIdeHost,
            description:
                "触发 VSCode 任务（.vscode/tasks.json 里定义的 build/test/watch 等），在 IDE 终端面板启动。" +
                "★ 触发即返回、不等待完成（watch 类任务永不结束）；要看程序化输出请改用 run_command。" +
                "name 缺省=只列出可用任务名不执行（SAFE 探测）。仅 VSCode 宿主可用。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "任务名（缺省则仅列出可用任务）" },
                },
                required: [],
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: (args: { name?: string }) =>
                args?.name ? `在 IDE 中触发任务「${args.name}」？任务将在 VSCode 终端面板执行。` : "读取 IDE 可用任务列表？",
            async execute(args: { name?: string }, ctx?: ToolContext) {
                if (!ctx?.ideAction) return IDE_UNAVAILABLE;
                try {
                    const r = await ctx.ideAction({ action: 'task', name: args?.name?.trim() || undefined });
                    return ideResultToText(r);
                } catch (e: any) {
                    return toolFailure(`[IDE 异常]：${e?.message ?? e}`);
                }
            },
        },
    },
];
