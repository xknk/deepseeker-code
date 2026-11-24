/**
 * @file tests/command-env-hint.test.ts
 * @description 卡 4 提示行端到端（评审修复施工单 2026-11-24）：三个命令入口的子进程环境剔除提示。
 *  - run_command：提示行落在工具输出（首行），含被剔变量名、不含其值；子进程实际读不到该变量；
 *  - run_in_background：提示行并入首个 yield（runBackgroundTool 只取首个 yield 作结果）；
 *  - `!` 直跑（runBashDirect + formatBashEntry）：提示行随结果带回、落盘文本含提示行；
 *  - 既有敏感名模式剔除的变量不出现在提示里（静默语义，防刷屏）。
 * ★ env 注入统一 try/finally 恢复，防跨测试污染。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandTools } from "@/tool/registry/command.ts";
import { backgroundTools, resolveWinShell } from "@/tool/registry/background.ts";
import { runBashDirect, formatBashEntry } from "@/commands/bashDirect.ts";
import { ToolContext } from "@/tool/type.ts";
import os from "os";

const runCommand = commandTools.find((t: any) => t.function.name === "run_command")!;
const runBg = backgroundTools.find((t: any) => t.function.name === "run_in_background")!;

const makeCtx = (): ToolContext => ({ sessionId: "env-hint-test" }) as unknown as ToolContext;

/** 手动驱动 generator 至完成，返回全部 yield 拼接（只取首个 yield 不注册 close 监听的已知坑） */
const drain = async (gen: AsyncGenerator<string>): Promise<string> => {
    let s = "";
    while (true) {
        const r = await gen.next();
        if (r.done) break;
        s += r.value;
    }
    return s;
};

/** win32 无 Git Bash 时跳过（POSIX 语义命令不可用；node -e 双引号形态 cmd.exe 兼容但仍保守跳过） */
const needShell = (name: string, fn: () => Promise<void>): void => {
    const noBash = process.platform === "win32" && !resolveWinShell();
    it(name, { skip: noBash ? "win32 无 Git Bash，跳过" : false }, fn);
};

/** 临时注入 env（try/finally 恢复） */
const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
    try { await fn(); } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
};

/** 子进程打印 DATABASE_URL 值（被剔时打印 NONE）——证明确实读不到 */
const PROBE = `"${process.execPath}" -e "console.log(process.env.DATABASE_URL || 'NONE')"`;

describe("卡 4 提示行端到端 — run_command", () => {
    needShell("剔除提示入输出首行、值不回灌、子进程实际读不到", async () => {
        await withEnv({ DATABASE_URL: "postgres://u:secretpw@h/db" }, async () => {
            const out = await drain(runCommand.function.execute({ command: PROBE }, makeCtx()) as AsyncGenerator<string>);
            assert.match(out, /ℹ️ 已从子进程环境剔除含凭证的变量：DATABASE_URL/, "提示行在输出里（只露名）");
            assert.match(out, /DEEPSEEKER_COMMAND_ENV_PASSTHRU/, "提示行带放行名单指引");
            assert.doesNotMatch(out, /secretpw/, "被剔变量的值绝不回灌");
            assert.match(out, /NONE/, "子进程实际读不到该变量（剔除真实生效）");
        });
    });

    needShell("既有敏感名模式剔除不进提示（GITHUB_TOKEN 静默）", async () => {
        await withEnv({ GITHUB_TOKEN: "ghp_x", DATABASE_URL: "postgres://u:secretpw@h/db" }, async () => {
            const out = await drain(runCommand.function.execute({ command: PROBE }, makeCtx()) as AsyncGenerator<string>);
            assert.match(out, /DATABASE_URL/, "新两层剔除的变量入提示");
            assert.doesNotMatch(out, /GITHUB_TOKEN/, "既有名模式剔除静默（防刷屏）");
        });
    });

    needShell("放行名单放行后：值可达子进程、无提示行", async () => {
        await withEnv(
            { DATABASE_URL: "postgres://u:secretpw@h/db", DEEPSEEKER_COMMAND_ENV_PASSTHRU: "DATABASE_URL" },
            async () => {
                const out = await drain(runCommand.function.execute({ command: PROBE }, makeCtx()) as AsyncGenerator<string>);
                assert.doesNotMatch(out, /已从子进程环境剔除/, "放行后无提示");
                assert.match(out, /postgres:\/\/u:secretpw@h\/db/, "放行名单成员真实可达子进程");
            },
        );
    });
});

describe("卡 4 提示行端到端 — run_in_background", () => {
    needShell("提示行并入首个 yield（不顶掉 task_id）", async () => {
        await withEnv({ DATABASE_URL: "postgres://u:secretpw@h/db" }, async () => {
            const gen = runBg.function.execute({ command: PROBE }, makeCtx()) as AsyncGenerator<string>;
            const first = await gen.next();
            const text = String(first.value);
            assert.match(text, /ℹ️ 已从子进程环境剔除含凭证的变量：DATABASE_URL/, "提示行在首个 yield 里");
            assert.match(text, /task_id: /, "task_id 提取不被顶掉");
            assert.doesNotMatch(text, /secretpw/, "值不回灌");
            // ★ 不得 drain 到 done：子进程 spawn 后 unref()，不持事件循环——await close 会把 runner 的
            //   循环等空（「event loop has already resolved」整文件连坐取消，2026-11-24 实测）。
            //   gen.return() 在 yield 点收口 generator（生产路径 runBackgroundTool 同样只取首个 yield）。
            await gen.return(undefined as any);
        });
    });
});

describe("卡 4 提示行端到端 — `!` 直跑（runBashDirect + formatBashEntry）", () => {
    needShell("真实执行：droppedEnv 带回、落盘文本含提示行不含值", async () => {
        await withEnv({ DATABASE_URL: "postgres://u:secretpw@h/db" }, async () => {
            const r = await runBashDirect(PROBE, os.tmpdir());
            assert.deepEqual(r.droppedEnv, ["DATABASE_URL"], "剔除名单随结果带回");
            const text = formatBashEntry(PROBE, r);
            assert.match(text, /ℹ️ 已从子进程环境剔除含凭证的变量：DATABASE_URL/);
            assert.match(text, /NONE/, "子进程实际读不到");
            assert.doesNotMatch(text, /secretpw/);
        });
    });

    it("formatBashEntry：无剔除时不追加提示行（fixture 兼容缺省字段）", () => {
        const text = formatBashEntry("echo hi", {
            ok: true, output: "hi", exitCode: 0, timedOut: false, durationMs: 5,
        });
        assert.doesNotMatch(text, /已从子进程环境剔除/);
    });
});
