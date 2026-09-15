/**
 * @file tests/evals/tasks/promise-to-async.ts
 * @description 多文件重构类：回调风格全链路改 async/await（fetcher → service → main 三层）。
 *  新 API 契约由 test/ 钉死（await 返回值 / reject），main 的改写由运行输出钉死（回调形式拿不到结果）。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput, nodeTestsPass, sourceAssert } from "./checkers.ts";

export const task: EvalTask = {
    id: 'promise-to-async',
    name: '回调链改 async/await',
    tags: ['refactor'],
    maxMinutes: 15,
    prompt: 'src/fetcher.js / src/service.js / src/main.js 这条链是老回调风格（done(err, result)），全部改成 Promise + async/await：fetchUser 返回 Promise、userName 变 async 函数、main 里用 await 拿结果，错误走 reject/throw。行为语义不变（id<=0 仍然报 bad id）。改完 `node src/main.js` 输出 NAME user7，`node --test` 全绿。',
    fixture: {
        'src/fetcher.js': `const fetchUser = (id, done) => {
    setTimeout(() => {
        if (id <= 0) done(new Error('bad id'));
        else done(null, { id, name: \`user\${id}\` });
    }, 10);
};

module.exports = { fetchUser };
`,
        'src/service.js': `const { fetchUser } = require('./fetcher.js');

const userName = (id, done) => {
    fetchUser(id, (err, user) => {
        if (err) { done(err); return; }
        done(null, user.name);
    });
};

module.exports = { userName };
`,
        'src/main.js': `const { userName } = require('./service.js');

userName(7, (err, name) => {
    if (err) { console.log('ERR', err.message); return; }
    console.log('NAME', name);
});
`,
        'test/service.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { userName } = require('../src/service.js');

test('userName 正常返回名字', async () => {
    assert.equal(await userName(7), 'user7');
});

test('userName 非法 id 必须 reject', async () => {
    await assert.rejects(userName(0), /bad id/);
});
`,
    },
    checker: async (ws) => {
        const run = await nodeRunOutput(ws, 'src/main.js', { include: ['NAME user7'], notInclude: ['ERR'] });
        if (!run.ok) return run;
        const t = await nodeTestsPass(ws);
        if (!t.ok) return t;
        // 回调风格必须绝迹：done 标识符在三文件里只可能来自旧签名
        return sourceAssert(ws, ['src/fetcher.js', 'src/service.js', 'src/main.js'], {
            mustNotHave: [/\bdone\b/],
        });
    },
};
