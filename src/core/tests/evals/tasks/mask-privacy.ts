/**
 * @file tests/evals/tasks/mask-privacy.ts
 * @description 任务级 eval 种子任务：日志敏感信息脱敏（手机号掩码），以运行输出断言判定。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput } from "./checkers.ts";

export const task: EvalTask = {
    id: 'mask-privacy',
    name: '手机号日志脱敏',
    tags: ['bugfix', 'privacy'],
    prompt: '合规检查发现日志把用户手机号明文打出来了。要求：手机号脱敏后再打——保留前 3 位和后 4 位，中间用 4 个星号（例如 13812348000 改为 138****8000）。修复 src/logger.js，改完跑 `node src/demo.js` 确认输出里已经是掩码形式、没有明文手机号。',
    fixture: {
        'src/logger.js': `// 用户操作日志
const logUser = (user) => {
    console.log('[user]', user.name, user.phone);
};

module.exports = { logUser };
`,
        'src/demo.js': `const { logUser } = require('./logger.js');

logUser({ name: '王小明', phone: '13812348000' });
`,
    },
    checker: (ws) => nodeRunOutput(ws, 'src/demo.js', { include: ['138****8000'], notInclude: ['13812348000'] }),
};
