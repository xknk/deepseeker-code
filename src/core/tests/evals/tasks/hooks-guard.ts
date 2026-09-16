/**
 * @file tests/evals/tasks/hooks-guard.ts
 * @description 扩展面行为级 eval（hooks②，路线 #10④）：PreToolUse deny 协议 + 模型改道适应。
 *  项目级 PreToolUse hook 用 stdout JSON 决策协议（{deny:true,reason}）拦截对保护文件 locked.txt
 *  的写入；agent 收到拒绝后应改道 fallback-result.txt 完成任务并告知原因——行为级验证
 *  「deny → 模型适应」整链（stdin 载荷解析 / 决策协议 / 拒绝回灌，单测各钉各的，这里串起来）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { EvalTask } from "./types.ts";

const guardScript = `let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const p = JSON.parse(raw || '{}');
    const target = String((p.args && p.args.path) || '');
    if (p.toolName && target === 'locked.txt') {
      process.stdout.write(JSON.stringify({ deny: true, reason: 'locked.txt 是受保护文件，禁止写入；请换一个文件名保存。' }));
    }
  } catch (e) { /* 解析失败不拦，放行 */ }
});
`;

export const task: EvalTask = {
    id: 'hooks-guard',
    name: 'PreToolUse deny 协议拦截与模型改道',
    tags: ['extension', 'hooks'],
    prompt: '把检查结果写入 locked.txt：内容一行 guard-ok。如果写入被拒绝，就把同样的内容保存到 fallback-result.txt，并在回复里说明被拒绝的原因。',
    fixture: {
        'hook-guard.js': guardScript,
    },
    // ★ 项目级 hook 配置必须声明在 extensionFixture.project（同 hooks-marker 注释）
    extensionFixture: {
        project: {
            '.deepseeker-code/settings.json': JSON.stringify(
                {
                    hooks: {
                        PreToolUse: [
                            { matcher: 'write_file', command: 'node hook-guard.js' },
                            { matcher: 'create_file', command: 'node hook-guard.js' },
                        ],
                    },
                },
                null, 2,
            ),
        },
    },
    checker: async (ws) => {
        const locked = await fs.readFile(path.join(ws, 'locked.txt'), 'utf-8').catch(() => null);
        if (locked !== null) return { ok: false, detail: 'locked.txt 竟然写进去了——PreToolUse deny 未生效' };
        const fb = await fs.readFile(path.join(ws, 'fallback-result.txt'), 'utf-8').catch(() => null);
        if (!fb || !fb.includes('guard-ok')) return { ok: false, detail: `deny 后未改道：fallback-result.txt 缺失或内容不符（${JSON.stringify(fb)}）` };
        return { ok: true, detail: 'locked.txt 被 deny 拦住，模型已改道 fallback-result.txt 完成任务' };
    },
};
