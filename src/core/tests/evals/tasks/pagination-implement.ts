/**
 * @file tests/evals/tasks/pagination-implement.ts
 * @description 按测试实现类：分页工具规格全部钉在 test/（默认值/上限/越界/非法页码），
 *  度量「先读测试再动手」的决策质量。测试不许改 = 契约唯一来源。
 */
import type { EvalTask } from "./types.ts";
import { nodeTestsPass } from "./checkers.ts";

export const task: EvalTask = {
    id: 'pagination-implement',
    name: '按测试实现分页工具',
    tags: ['feature'],
    prompt: '把 src/paginate.js 里的 paginate 实现出来，规格以 test/paginate.test.js 为准（测试已写好，不许改测试）。`node --test` 全绿即可。',
    fixture: {
        'src/paginate.js': `// 分页工具（未实现，规格见 test/paginate.test.js）
module.exports = {};
`,
        'test/paginate.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { paginate } = require('../src/paginate.js');

const mk = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('默认 size=10', () => {
    assert.deepEqual(paginate(mk(25), { page: 1 }), mk(10));
    assert.deepEqual(paginate(mk(25), { page: 3 }), [21, 22, 23, 24, 25]);
});

test('size 可覆盖，上限 100', () => {
    assert.deepEqual(paginate(mk(25), { page: 1, size: 5 }), [1, 2, 3, 4, 5]);
    assert.equal(paginate(mk(250), { page: 1, size: 5000 }).length, 100);
});

test('页码越界返回空数组，page<1 按第 1 页', () => {
    assert.deepEqual(paginate(mk(25), { page: 99 }), []);
    assert.deepEqual(paginate(mk(25), { page: 0 }), mk(10));
    assert.deepEqual(paginate(mk(25), { page: -3 }), mk(10));
});

test('空列表与恰好整页', () => {
    assert.deepEqual(paginate([], { page: 1 }), []);
    assert.deepEqual(paginate(mk(20), { page: 1, size: 20 }), mk(20));
    assert.deepEqual(paginate(mk(20), { page: 2, size: 20 }), []);
});
`,
    },
    checker: async (ws) => nodeTestsPass(ws),
};
