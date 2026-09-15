/**
 * @file tests/evals/tasks/state-leak-fix.ts
 * @description 调试定位类：模块级缓存只装第一个键（if size===0），第二个用户拿 undefined——
 *  症状在入口 main，根因在两层之下的 cache.js，service.js 是纯中转。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput } from "./checkers.ts";

export const task: EvalTask = {
    id: 'state-leak-fix',
    name: '缓存只认第一个用户的泄漏',
    tags: ['bugfix', 'debug'],
    prompt: '`node src/main.js` 第二行输出成了 hello undefined（第一、三行是好的）。看一下问题在哪并修掉：缓存应该按用户名各自生效，ann 命中缓存、bob 也要正常显示。改完输出三行：hello Ann / hello Bob / hello Ann。',
    fixture: {
        'src/cache.js': `// 用户显示名的进程内缓存（按用户名 keyed）
const cache = new Map();

const displayName = (user) => {
    if (cache.size === 0) {
        cache.set(user.name, user.display);
    }
    return cache.get(user.name);
};

module.exports = { displayName };
`,
        'src/service.js': `const { displayName } = require('./cache.js');

const greet = (user) => \`hello \${displayName(user)}\`;

module.exports = { greet };
`,
        'src/main.js': `const { greet } = require('./service.js');

if (require.main === module) {
    console.log(greet({ name: 'ann', display: 'Ann' }));
    console.log(greet({ name: 'bob', display: 'Bob' }));
    console.log(greet({ name: 'ann', display: 'Ann' }));
}
`,
    },
    checker: async (ws) =>
        nodeRunOutput(ws, 'src/main.js', { include: ['hello Ann', 'hello Bob'], notInclude: ['undefined'] }),
};
