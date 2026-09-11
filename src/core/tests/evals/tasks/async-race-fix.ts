/**
 * @file tests/evals/tasks/async-race-fix.ts
 * @description 任务级 eval 种子任务：异步时序 bug（漏 await 导致返回 undefined），测试驱动修复。
 */
import type { EvalTask } from "./types.ts";
import { nodeTestsPass } from "./checkers.ts";

export const task: EvalTask = {
    id: 'async-race-fix',
    name: '修复漏 await 的异步 bug',
    tags: ['bugfix', 'async'],
    prompt: 'test/users.test.js 挂了：getFirstUser 返回的是 undefined。修复 src/users.js（注意异步时序），让 `node --test` 全绿。不要改 test 目录。',
    fixture: {
        'src/users.js': `const fetchUsers = async () => [
    { id: 1, name: 'alice' },
    { id: 2, name: 'bob' },
];

// 取第一个注册的用户（有 bug：返回 undefined）
const getFirstUser = async () => {
    const users = fetchUsers();
    return users[0];
};

module.exports = { fetchUsers, getFirstUser };
`,
        'test/users.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getFirstUser } = require('../src/users.js');

test('getFirstUser 返回 alice', async () => {
    const u = await getFirstUser();
    assert.equal(u.name, 'alice');
});
`,
    },
    checker: (ws) => nodeTestsPass(ws),
};
