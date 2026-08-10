/**
 * @file statusLine/runner.ts
 * @description 状态栏命令执行器（P2-16，对标 Claude Code）：以 shell 执行用户配置的 statusLine.command，
 *  把上下文 JSON 灌进其 stdin，取 stdout 首行（trim + 可选左 padding）作为底部状态栏文本。
 *
 *  有界 + best-effort：3s 超时、spawn 失败、命令出错、无 stdout → 一律返回 ""（调用方回退内置状态栏）。
 *  绝不抛错击垮主流程（状态栏是装饰性 UI）。
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { StatusLineConfig } from "./config.ts";
import { scrubCommandEnv } from "@/tool/guard.ts";

/** 灌进 statusLine.command stdin 的上下文（对标 CC 字段名）。 */
export interface StatusLineContext {
    /** 当前会话 ID。 */
    session_id: string;
    /** 工作目录（命令执行的 cwd 基准）。 */
    cwd: string;
    /** 当前模型名。 */
    model: string;
    /** 运行态：idle 就绪 / busy 生成中 / aborting 中止中。 */
    state: "idle" | "busy" | "aborting";
    /** 是否处于计划模式。 */
    plan_mode: boolean;
    /** 是否处于自动权限模式。 */
    auto_mode: boolean;
    /** 当前输出风格名（未设=中性）。 */
    output_style: string | null;
    /** 工作区目录（current_dir=当前、project_dir=项目根）。 */
    workspace: { current_dir: string; project_dir: string };
    /** 引擎版本（best-effort，取不到则省略该键）。 */
    version?: string;
}

const STATUSLINE_TIMEOUT_MS = 3000;

/**
 * best-effort 版本号：模块加载时同步读最近 package.json 的 version，缓存。
 * 取不到（文件缺失/无 version）则 cachedVersion 保持 undefined → 上下文省略 version 键。
 */
let cachedVersion: string | undefined;
try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(here, "../../../package.json"),   // src/core/package.json
        path.join(here, "../../../../package.json"), // 仓库根 package.json
    ];
    for (const p of candidates) {
        try {
            const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
            if (typeof pkg.version === "string" && pkg.version) { cachedVersion = pkg.version; break; }
        } catch { /* 继续尝试下一个候选 */ }
    }
} catch { /* ignore */ }

/**
 * 执行一次状态栏命令，返回其 stdout 首行（trim + 左 padding）。
 * 超时 / spawn 失败 / 命令出错 / 空输出 → 返回 ""（绝不 reject）。
 */
export const runStatusLine = (cfg: StatusLineConfig, ctx: StatusLineContext): Promise<string> =>
    new Promise((resolve) => {
        const payload = JSON.stringify({ ...ctx, version: cachedVersion }); // version 为 undefined 时 JSON.stringify 自动省略该键
        let child;
        try {
            child = spawn(cfg.command, { shell: true, cwd: ctx.cwd, env: scrubCommandEnv() });
        } catch {
            resolve("");
            return;
        }
        let stdout = "";
        let done = false;
        const finish = (text: string): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { child.kill(); } catch { /* ignore */ }
            resolve(text);
        };
        const timer = setTimeout(() => finish(""), STATUSLINE_TIMEOUT_MS);
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.on("error", () => finish(""));
        child.on("close", () => {
            const firstLine = (stdout.split(/\r?\n/)[0] ?? "").trim();
            const pad = typeof cfg.padding === "number" && cfg.padding > 0 ? " ".repeat(cfg.padding) : "";
            finish(`${pad}${firstLine}`);
        });
        try {
            child.stdin?.write(payload);
            child.stdin?.end();
        } catch { /* 命令不读 stdin 也无妨 */ }
    });
