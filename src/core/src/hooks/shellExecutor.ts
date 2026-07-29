/**
 * @file hooks/shellExecutor.ts
 * @description 声明式 hook 的命令执行器：以有界 spawn 执行用户在 settings.json 配置的 command。
 *
 *  安全护栏（决策：默认信任用户配置 + 硬护栏，对标 Claude Code）：
 *   - timeout 默认走【梯度】（见 types.ts DEFAULT_TIMEOUT_BY_EVENT，由 loader 按事件注入 10/30/60s），
 *     此处 DEFAULT_TIMEOUT_MS 仅作未指定时的最终兜底；硬顶 300s，超时 SIGKILL，绝不让 hook 挂死主流程；
 *   - 环境变量净化：仅透传白名单 + 调用方额外 env，不全量透传 process.env（防泄密）；
 *   - stdout/stderr 截断到 ~4KB，避免大输出污染上下文；
 *   - 结构化 JSON 经 stdin 传入，关键字段另同步到 HOOK_* 环境变量（兼顾不读 stdin 的简单脚本）。
 */
import { spawn, type ChildProcess } from "child_process";
import { killTree } from "@/tool/registry/background.ts";

// 4KB 的输出截断足够了，防止大模型上下文爆掉，这个不需要动
const MAX_OUTPUT = 4096; 

// 最终兜底超时：仅在调用方完全未传 timeoutMs 时生效（如程序化直调 executeHookCommand）。
// 声明式 hook 的默认超时由 loader 按事件梯度注入（types.ts DEFAULT_TIMEOUT_BY_EVENT），不走此值。
const DEFAULT_TIMEOUT_MS = 30_000;

// 硬性天花板从 60s 提升到 300s (5分钟) 或更长。
// 允许用户配置稍微耗时的工作（比如大项目的编译检查、完整的 Sonar 漏洞扫描）。
const HARD_TIMEOUT_CAP_MS = 300_000;

/** 透传给 hook 子进程的环境变量白名单（不全量透传 process.env） */
const ENV_WHITELIST = [
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "WORKSPACE_ROOT", "LANG", "TERM", "SHELL", "SystemRoot", "ComSpec",
];

export interface HookExecInput {
    command: string;
    cwd?: string;
    /** 额外环境变量（与白名单合并，优先级高于白名单） */
    env?: Record<string, string>;
    timeoutMs?: number;
    /** 经 stdin 传入的结构化 JSON（含 sessionId/toolName/args/prompt 等，供脚本决策） */
    stdinPayload?: any;
}

export interface HookExecResult {
    /** 进程退出码；null=未能获取（如 spawn 失败） */
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

const truncate = (s: string): string => {
    if (s.length <= MAX_OUTPUT) return s;
    return s.slice(0, MAX_OUTPUT) + `\n…[输出截断，共 ${s.length} 字符]`;
};

// ★ stdin JSON 载荷字段截断：edit_file 的 old_str/new_str、read_file 大内容等 args 可能很大，
//   无截断直传 stdin 会滞留管道缓冲 + 背压拖慢；按字段截断既限总量又保持合法 JSON（与 HOOK_PROMPT 1024 截断同口径）。
//   被 registry.ts 的 HOOK_RESULT_MAX 复用为同口径，故 export 共享单一真相源。
export const MAX_STDIN_FIELD = 4096;
const capFieldStrings = (v: any): any => {
    if (typeof v === 'string') return v.length > MAX_STDIN_FIELD ? v.slice(0, MAX_STDIN_FIELD) + `…[截断，共 ${v.length} 字符]` : v;
    if (Array.isArray(v)) return v.map(capFieldStrings);
    if (v && typeof v === 'object') {
        const o: Record<string, any> = {};
        for (const k of Object.keys(v)) o[k] = capFieldStrings(v[k]);
        return o;
    }
    return v;
};

/**
 * 执行声明式 hook 命令。
 * spawn 失败 / 超时均不抛错（resolve 带错误信息），由调用方按 denyOnNonZero 决策。
 */
export const executeHookCommand = (input: HookExecInput): Promise<HookExecResult> => {
    return new Promise((resolve) => {
        const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_CAP_MS);

        // 净化环境变量：白名单 + 调用方额外 env
        const childEnv: Record<string, string> = {};
        for (const k of ENV_WHITELIST) {
            const v = process.env[k];
            if (v !== undefined) childEnv[k] = v;
        }
        if (input.env) Object.assign(childEnv, input.env);
        // 关键字段同步到环境变量（兼顾不读 stdin 的简单脚本）
        const p = input.stdinPayload;
        if (p && typeof p === "object") {
            if (typeof p.sessionId === "string") childEnv.HOOK_SESSION_ID = p.sessionId;
            if (typeof p.toolName === "string") childEnv.HOOK_TOOL_NAME = p.toolName;
            if (typeof p.prompt === "string") childEnv.HOOK_PROMPT = p.prompt.slice(0, 1024);
        }

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        // ★ 跨平台进程组隔离：非 Windows 下 detached 让 shell 及其派生命令自成独立进程组，
        //   超时时才能用 process.kill(-pid) 彻底剿灭整组（否则 child.kill 只杀 sh，实际命令变孤儿继续跑）。
        const isWin = process.platform === "win32";
        let child: ChildProcess;
        try {
            child = spawn(input.command, {
                shell: true,
                cwd: input.cwd || process.cwd(),
                env: childEnv,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                detached: !isWin,
            });
        } catch (e: any) {
            resolve({ exitCode: null, stdout: "", stderr: `[spawn 启动失败] ${e?.message ?? e}`, timedOut: false });
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            // ★ 杀整个进程组（Win: taskkill /T /F；非 Win: process.kill(-pid)），而非只杀 shell。
            //   旧实现 child.kill("SIGKILL") 只杀 sh -c，shell 派生的实际命令脱离控制成为孤儿。
            void killTree(child);
        }, timeoutMs);

        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

        const done = (code: number | null) => {
            clearTimeout(timer);
            resolve({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr), timedOut });
        };

        child.on("error", (e: Error) => {
            stderr += `\n[spawn error] ${e.message}`;
            done(null);
        });
        child.on("close", (code: number | null) => done(code));

        // 经 stdin 传入结构化 JSON（字段级截断，限总量且保持合法 JSON）
        try {
            if (input.stdinPayload !== undefined) child.stdin?.end(JSON.stringify(capFieldStrings(input.stdinPayload)));
            else child.stdin?.end();
        } catch {
            try { child.stdin?.end(); } catch { /* ignore */ }
        }
    });
};
