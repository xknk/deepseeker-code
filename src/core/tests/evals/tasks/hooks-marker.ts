/**
 * @file tests/evals/tasks/hooks-marker.ts
 * @description 扩展面行为级 eval（hooks①，路线 #10④）：项目级 PostToolUse command hook 随工具调用真实触发。
 *  task.eval 洁净室（includeProject:false）测不到 hooks 行为——本任务以 extensionFixture 物化
 *  项目级 settings.json，hook 触发后把 marker 追加进 hook-ran.log，checker 据此判定「hook 真的跑了」
 *  （格式钉靠单测，行为跑不跑得通靠本任务）。
 *  首跑审批门（#9）项目级规则默认开 → eval 宿主 allow-once 自动放行，门与执行链一起被真实驱动。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { EvalTask } from "./types.ts";

export const task: EvalTask = {
    id: 'hooks-marker',
    name: '项目 PostToolUse hook 随写文件触发',
    tags: ['extension', 'hooks'],
    prompt: '在工作区创建文件 hello.txt，内容为一行：hooks-ok',
    fixture: {
        'hook-mark.js': `require('node:fs').appendFileSync('hook-ran.log', 'POSTTOOLUSE\\n');\n`,
    },
    // ★ 项目级 hook 配置必须声明在 extensionFixture.project：标准阶段 includeProject:false 不加载
    //   项目配置——漏声明则任务静默跑在「hook 不存在」的洁净室里（checker 报未触发但其实是没加载）。
    extensionFixture: {
        project: {
            '.deepseeker-code/settings.json': JSON.stringify(
                { hooks: { PostToolUse: [{ matcher: 'create_file', command: 'node hook-mark.js' }] } },
                null, 2,
            ),
        },
    },
    checker: async (ws) => {
        const hello = await fs.readFile(path.join(ws, 'hello.txt'), 'utf-8').catch(() => null);
        if (!hello || !hello.includes('hooks-ok')) return { ok: false, detail: `hello.txt 缺失或内容不符：${JSON.stringify(hello)}` };
        const log = await fs.readFile(path.join(ws, 'hook-ran.log'), 'utf-8').catch(() => null);
        if (!log || !log.includes('POSTTOOLUSE')) return { ok: false, detail: 'hook-ran.log 未产生——PostToolUse hook 没有随 create_file 触发' };
        return { ok: true, detail: 'hello.txt 已写且 PostToolUse hook 已触发（marker 落盘）' };
    },
};
