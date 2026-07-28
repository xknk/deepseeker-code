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

        let child: ChildProcess;
        try {
            child = spawn(input.command, {
                shell: true,
                cwd: input.cwd || process.cwd(),
                env: childEnv,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (e: any) {
            resolve({ exitCode: null, stdout: "", stderr: `[spawn 启动失败] ${e?.message ?? e}`, timedOut: false });
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
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

        // 经 stdin 传入结构化 JSON
        try {
            if (input.stdinPayload !== undefined) child.stdin?.end(JSON.stringify(input.stdinPayload));
            else child.stdin?.end();
        } catch {
            try { child.stdin?.end(); } catch { /* ignore */ }
        }
    });
};
