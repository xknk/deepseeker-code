/**
 * @file tests/evals/tasks/currency-rename.ts
 * @description 多文件重构类：fmtMoney → formatMoney 五文件重命名（含 barrel re-export），
 *  rename-api 的宽样本——文件数翻倍，度量「读全 + 改全」的轮数成本。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput, sourceAssert } from "./checkers.ts";

// 引用 fmtMoney 的四个文件（report.js 只用 cartLine/totalLine，从不引用该函数——mustHave 不该查它，
// 首轮基线实跑误伤过：改名正确却因 report.js 无新名判负，2026-09-15 修）
const REFS = ['src/money.js', 'src/cart.js', 'src/summary.js', 'src/index.js'];
const FILES = ['src/money.js', 'src/cart.js', 'src/summary.js', 'src/report.js', 'src/index.js'];

export const task: EvalTask = {
    id: 'currency-rename',
    name: '五文件重命名 fmtMoney',
    tags: ['refactor'],
    prompt: '把 fmtMoney 全局重命名为 formatMoney：定义、所有调用处、src/index.js 的 re-export 都要改干净，行为不变。改完跑 `node src/index.js`，输出三行：book x2 = 7.00 / TOTAL 12.00 / CHECK 9.00。',
    fixture: {
        'src/money.js': `const fmtMoney = (n) => n.toFixed(2);

module.exports = { fmtMoney };
`,
        'src/cart.js': `const { fmtMoney } = require('./money.js');

const cartLine = (item) => \`\${item.name} x\${item.qty} = \${fmtMoney(item.price * item.qty)}\`;

module.exports = { cartLine };
`,
        'src/summary.js': `const { fmtMoney } = require('./money.js');

const totalLine = (items) => \`TOTAL \${fmtMoney(items.reduce((s, it) => s + it.price * it.qty, 0))}\`;

module.exports = { totalLine };
`,
        'src/report.js': `const { cartLine } = require('./cart.js');
const { totalLine } = require('./summary.js');

const render = (items) => [cartLine(items[0]), totalLine(items)].join('\\n');

module.exports = { render };
`,
        'src/index.js': `const { fmtMoney } = require('./money.js');
const { render } = require('./report.js');

if (require.main === module) {
    const items = [
        { name: 'book', price: 3.5, qty: 2 },
        { name: 'pen', price: 1.25, qty: 4 },
    ];
    console.log(render(items));
    console.log('CHECK', fmtMoney(9));
}

module.exports = { render, fmtMoney };
`,
    },
    checker: async (ws) => {
        const run = await nodeRunOutput(ws, 'src/index.js', { include: ['TOTAL 12.00', 'CHECK 9.00'] });
        if (!run.ok) return run;
        // 引用处新名必须出现；全仓旧名（词边界）必须绝迹
        const refs = await sourceAssert(ws, REFS, { mustHave: [/\bformatMoney\b/] });
        if (!refs.ok) return refs;
        return sourceAssert(ws, FILES, { mustNotHave: [/\bfmtMoney\b/] });
    },
};
