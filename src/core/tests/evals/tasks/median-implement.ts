/**
 * @file tests/evals/tasks/median-implement.ts
 * @description 任务级 eval 种子任务：按规范实现缺失函数（median 中位数），让既有测试全绿。
 */
import type { EvalTask } from "./types.ts";
import { nodeTestsPass } from "./checkers.ts";

export const task: EvalTask = {
    id: 'median-implement',
    name: '实现 median 中位数',
    tags: ['feature', 'test'],
    prompt: 'src/stats.js 里还差一个 median（中位数）没实现，测试跑不过。规则：奇数个取排序后正中间那个；偶数个取中间两个的平均值；不得修改传入数组。实现它并让 `node --test` 全绿。不要改 test 目录。',
    fixture: {
        'src/stats.js': `// 统计工具集
const mean = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;

// TODO: median（中位数）尚未实现：
//   - 奇数个：排序后取正中间一个
//   - 偶数个：排序后取中间两个的平均值
//   - 不得修改原数组

module.exports = { mean };
`,
        'test/stats.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { median } = require('../src/stats.js');

test('median: 奇数个', () => {
    assert.equal(median([3, 1, 2]), 2);
});

test('median: 偶数个取中间两位平均', () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('median: 单元素', () => {
    assert.equal(median([5]), 5);
});

test('median: 不修改原数组', () => {
    const arr = [3, 1, 2];
    median(arr);
    assert.deepEqual(arr, [3, 1, 2]);
});
`,
    },
    checker: (ws) => nodeTestsPass(ws),
};
