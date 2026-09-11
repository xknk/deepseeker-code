/**
 * @file tests/evals/tasks/discount-bugfix.ts
 * @description 任务级 eval 种子任务：折扣计算 bug 修复（跑测试复现 → 修 src → 测试全绿）。
 */
import type { EvalTask } from "./types.ts";
import { nodeTestsPass } from "./checkers.ts";

export const task: EvalTask = {
    id: 'discount-bugfix',
    name: '折扣计算 bug 修复',
    tags: ['bugfix', 'test'],
    prompt: '下单结算金额不对：打完折比原价还贵。项目就在当前目录。先跑 `node --test` 复现失败，然后修复 src/cart.js 里的折扣计算，改完再跑测试确认全绿。不要改 test 目录。',
    fixture: {
        'src/cart.js': `// 购物车金额计算：折扣按「百分比off」表达（20 表示减 20%）
const applyDiscount = (price, percentOff) => price * percentOff / 100;

const cartTotal = (items, percentOff) =>
    items.reduce((sum, it) => sum + applyDiscount(it.price, percentOff) * it.qty, 0);

module.exports = { applyDiscount, cartTotal };
`,
        'test/cart.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyDiscount, cartTotal } = require('../src/cart.js');

test('applyDiscount: 100 减 20% 应为 80', () => {
    assert.equal(applyDiscount(100, 20), 80);
});

test('cartTotal: 多商品合计再打折', () => {
    const total = cartTotal([{ price: 50, qty: 2 }, { price: 30, qty: 1 }], 10);
    assert.equal(total, 117); // (100 + 30) * 0.9
});

test('cartTotal: 0% 折扣不打折', () => {
    assert.equal(cartTotal([{ price: 99, qty: 1 }], 0), 99);
});
`,
    },
    checker: (ws) => nodeTestsPass(ws),
};
