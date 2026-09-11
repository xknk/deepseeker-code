/**
 * @file tests/evals/tasks/rename-api.ts
 * @description 任务级 eval 种子任务：跨文件重命名导出函数（要求所有定义与调用处一致、行为不变）。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput, sourceAssert } from "./checkers.ts";

export const task: EvalTask = {
    id: 'rename-api',
    name: '跨文件重命名 calcTotal',
    tags: ['refactor'],
    prompt: '把项目里的 calcTotal 函数统一重命名为 calculateTotal（所有定义和调用处都要改），行为保持不变。改完跑 `node src/invoice.js`，输出必须是 `TOTAL 20`。',
    fixture: {
        'src/pricing.js': `const calcTotal = (items) => items.reduce((sum, it) => sum + it.price * it.qty, 0);

module.exports = { calcTotal };
`,
        'src/invoice.js': `const { calcTotal } = require('./pricing.js');

const invoiceTotal = (items) => calcTotal(items);

if (require.main === module) {
    console.log('TOTAL', invoiceTotal([{ price: 10, qty: 2 }]));
}

module.exports = { invoiceTotal };
`,
        'src/report.js': `const { calcTotal } = require('./pricing.js');

const reportLine = (items) => 'report: ' + calcTotal(items);

module.exports = { reportLine };
`,
    },
    checker: async (ws) => {
        const run = await nodeRunOutput(ws, 'src/invoice.js', { include: ['TOTAL 20'] });
        if (!run.ok) return run;
        // 三个文件都必须改干净：新名必须出现、旧名（词边界，不误伤 calculateTotal）必须绝迹
        return sourceAssert(ws, ['src/pricing.js', 'src/invoice.js', 'src/report.js'], {
            mustHave: [/\bcalculateTotal\b/],
            mustNotHave: [/\bcalcTotal\b/],
        });
    },
};
