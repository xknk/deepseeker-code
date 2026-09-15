/**
 * @file tests/evals/tasks/retry-wrapper.ts
 * @description 按测试实现类：带指数退避的 retry 包装，规格钉在 test/（调用次数语义、耗尽抛最后错误、
 *  退避时长下界用 setTimeout 的「至少」语义断言，天然不抖）。
 */
import type { EvalTask } from "./types.ts";
import { nodeTestsPass } from "./checkers.ts";

export const task: EvalTask = {
    id: 'retry-wrapper',
    name: '按测试实现指数退避重试',
    tags: ['feature'],
    prompt: '实现 src/retry.js 的 retry：把一个 async 函数包成带指数退避的重试版本，规格以 test/retry.test.js 为准（测试不许改）。`node --test` 全绿即可。',
    fixture: {
        'src/retry.js': `// 带指数退避的重试包装（未实现，规格见 test/retry.test.js）
module.exports = {};
`,
        'test/retry.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { retry } = require('../src/retry.js');

test('首次成功不重试', async () => {
    let calls = 0;
    const v = await retry(async () => { calls++; return 'ok'; }, { retries: 3, baseMs: 1 });
    assert.equal(v, 'ok');
    assert.equal(calls, 1);
});

test('失败后重试到成功', async () => {
    let calls = 0;
    const v = await retry(async () => {
        calls++;
        if (calls < 3) throw new Error('boom');
        return 'recovered';
    }, { retries: 5, baseMs: 1 });
    assert.equal(v, 'recovered');
    assert.equal(calls, 3);
});

test('重试耗尽后抛最后一次的错误（首次 + retries 次）', async () => {
    let calls = 0;
    await assert.rejects(
        retry(async () => { calls++; throw new Error(\`fail-\${calls}\`); }, { retries: 3, baseMs: 1 }),
        /fail-4/,
    );
    assert.equal(calls, 4);
});

test('指数退避：失败后至少等 baseMs 再重试', async () => {
    const t0 = Date.now();
    await retry(async () => { throw new Error('x'); }, { retries: 1, baseMs: 50 }).catch(() => {});
    assert.ok(Date.now() - t0 >= 45, '没有等待就重试了');
});
`,
    },
    checker: async (ws) => nodeTestsPass(ws),
};
