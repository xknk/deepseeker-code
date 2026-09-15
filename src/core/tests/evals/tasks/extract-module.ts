/**
 * @file tests/evals/tasks/extract-module.ts
 * @description 多文件重构类：巨石文件拆分——金额函数抽到 src/money.js，everything.js 变薄壳 re-export
 *  （外部 require 路径不能破，test/ 钉行为）。判定用「toFixed 唯一使用者搬家」锚定，不限定 re-export 书写式。
 */
import type { EvalTask } from "./types.ts";
import { nodeTestsPass, sourceAssert } from "./checkers.ts";

export const task: EvalTask = {
    id: 'extract-module',
    name: '巨石文件拆出 money 模块',
    tags: ['refactor'],
    maxMinutes: 15,
    prompt: 'src/everything.js 挤了三块不相关的功能，拆一下：parseOrder 留在 src/everything.js 不动；金额相关的 formatMoney、discount 抽到新文件 src/money.js。src/everything.js 要继续把这两个函数原样再导出（外面 require(\'./everything.js\') 的用法不能破）。改完 `node --test` 必须全绿。',
    fixture: {
        'src/everything.js': `// 订单工具集（历史原因挤在一起，待拆分）
const parseOrder = (text) => {
    const [id, qtyRaw, priceRaw] = text.trim().split(',');
    return { id, qty: Number(qtyRaw), price: Number(priceRaw) };
};

const formatMoney = (n) => n.toFixed(2);

const discount = (amount, rate) => Math.round(amount * rate * 100) / 100;

module.exports = { parseOrder, formatMoney, discount };
`,
        'test/everything.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOrder, formatMoney, discount } = require('../src/everything.js');

test('parseOrder', () => {
    assert.deepEqual(parseOrder('A1, 2, 3.5'), { id: 'A1', qty: 2, price: 3.5 });
});

test('formatMoney / discount（拆分后仍从 everything.js 可用）', () => {
    assert.equal(formatMoney(12), '12.00');
    assert.equal(discount(100, 0.13), 13);
});
`,
    },
    checker: async (ws) => {
        const t = await nodeTestsPass(ws);
        if (!t.ok) return t;
        // money.js 承接两个金额函数的实现
        const money = await sourceAssert(ws, ['src/money.js'], { mustHave: [/formatMoney/, /discount/] });
        if (!money.ok) return money;
        // everything.js：parseOrder 实现留在原地，金额实现搬走（toFixed 是 formatMoney 实现的唯一指纹）
        return sourceAssert(ws, ['src/everything.js'], {
            mustHave: [/parseOrder\s*=/, /money\.js/],
            mustNotHave: [/toFixed/],
        });
    },
};
