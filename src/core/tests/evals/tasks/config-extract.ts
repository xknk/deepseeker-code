/**
 * @file tests/evals/tasks/config-extract.ts
 * @description 任务级 eval 种子任务：重复魔数抽取为集中配置常量（行为不变 + 源码断言无残留字面量）。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput, sourceAssert } from "./checkers.ts";

export const task: EvalTask = {
    id: 'config-extract',
    name: '税率魔数抽取为配置常量',
    tags: ['refactor', 'config'],
    prompt: '税率 0.13 在 src/tax.js 和 src/invoice.js 里各写死了一份，以后调税率容易漏改。把它抽到 src/config.js，以导出常量 TAX_RATE 的形式提供，两个文件都改为从 config 引入。改完跑 `node src/invoice.js`，输出必须是 `TOTAL 113`。',
    fixture: {
        'src/config.js': `// 全局配置（集中管理可调参数）
module.exports = {};
`,
        'src/tax.js': `// 税额计算
const taxOf = (amount) => amount * 0.13;

module.exports = { taxOf };
`,
        'src/invoice.js': `const { taxOf } = require('./tax.js');

const invoiceTotal = (amount) => amount + amount * 0.13;

if (require.main === module) {
    console.log('TOTAL', invoiceTotal(100));
}

module.exports = { invoiceTotal };
`,
    },
    checker: async (ws) => {
        const run = await nodeRunOutput(ws, 'src/invoice.js', { include: ['TOTAL 113'] });
        if (!run.ok) return run;
        // 三个文件都必须出现 TAX_RATE；0.13 字面量只允许留在 config.js（定义处），
        // tax.js / invoice.js 剥注释后必须绝迹（独立小数片段级匹配，不误伤 .13x）
        const all = await sourceAssert(ws, ['src/config.js', 'src/tax.js', 'src/invoice.js'], { mustHave: [/TAX_RATE/] });
        if (!all.ok) return all;
        return sourceAssert(ws, ['src/tax.js', 'src/invoice.js'], { mustNotHave: [/(^|[^.\w])0\.13([^.\w]|$)/] });
    },
};
