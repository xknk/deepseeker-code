/**
 * @file tests/evals/tasks/checkers.ts
 * @description 任务级 eval 的确定性 checker 工具集：node 子进程执行 + 输出断言 + 源码正则断言。
 *  全部纯 Node（child_process + fs），不依赖 shell 内建（跨 Windows/Git Bash 可移植）、不调用 LLM。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import type { CheckResult } from "./types.ts";

/** 在工作区跑一个 node 子进程（判定用，独立于 agent 的 run_command 通道） */
export const runNode = (ws: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
        execFile(process.execPath, args, { cwd: ws, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                const code = err && typeof (err as any).code === 'number' ? (err as any).code as number : (err ? 1 : 0);
                resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            });
    });

/** node --test 全绿判定（fixture 约定：测试放 test/ 目录，纯 Node 无依赖） */
export const nodeTestsPass = async (ws: string): Promise<CheckResult> => {
    const r = await runNode(ws, ['--test']);
    if (r.code === 0) return { ok: true, detail: 'node --test 全绿' };
    const tail = (r.stdout + '\n' + r.stderr).split('\n').filter(Boolean).slice(-6).join('\n');
    return { ok: false, detail: `node --test 失败(code=${r.code})\n${tail}` };
};

/** 跑入口脚本并对 stdout 断言：include 必须出现、notInclude 必须不出现 */
export const nodeRunOutput = async (ws: string, entry: string, expects: { include?: string[]; notInclude?: string[] }): Promise<CheckResult> => {
    const r = await runNode(ws, [entry]);
    if (r.code !== 0) return { ok: false, detail: `node ${entry} 退出码 ${r.code}\n${r.stderr.slice(-400)}` };
    const missing = (expects.include ?? []).filter(s => !r.stdout.includes(s));
    if (missing.length) return { ok: false, detail: `stdout 缺少期望内容 [${missing.join(' | ')}]，实际输出尾部: ${r.stdout.slice(-300)}` };
    const leaked = (expects.notInclude ?? []).filter(s => r.stdout.includes(s));
    if (leaked.length) return { ok: false, detail: `stdout 仍包含不该出现的内容 [${leaked.join(' | ')}]` };
    return { ok: true, detail: `node ${entry} 输出符合预期` };
};

/** 递归列出目录下全部文件（相对路径，跳过 node_modules/.git），供源码断言/全仓扫描用 */
export const listFiles = async (dir: string, out: string[] = []): Promise<string[]> => {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) await listFiles(abs, out);
        else out.push(path.relative(dir, abs));
    }
    return out;
};

/** 剥掉 // 与 /* *\/ 注释（粗粒度：够用于「字面量不得再出现」类断言，避免注释里的示例误伤） */
const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * 源码断言：对指定文件（剥注释后）逐条断言 mustHave / mustNotHave（正则）。
 * 文件缺失按失败处理（agent 不该删掉要改的文件）。
 */
export const sourceAssert = async (ws: string, files: string[], rules: { mustHave?: RegExp[]; mustNotHave?: RegExp[] }): Promise<CheckResult> => {
    for (const rel of files) {
        const abs = path.join(ws, rel);
        let src: string;
        try { src = stripComments(await fs.readFile(abs, 'utf-8')); }
        catch { return { ok: false, detail: `源文件缺失: ${rel}` }; }
        for (const re of rules.mustHave ?? []) {
            if (!re.test(src)) return { ok: false, detail: `${rel} 未通过 mustHave 断言: ${re}` };
        }
        for (const re of rules.mustNotHave ?? []) {
            if (re.test(src)) return { ok: false, detail: `${rel} 未通过 mustNotHave 断言（仍命中）: ${re}` };
        }
    }
    return { ok: true, detail: `源码断言通过（${files.length} 个文件）` };
};
