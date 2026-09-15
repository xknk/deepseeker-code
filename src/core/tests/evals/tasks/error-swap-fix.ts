/**
 * @file tests/evals/tasks/error-swap-fix.ts
 * @description 调试定位类：parse.js 把 JSON 解析异常吞成空对象，坏配置静默变成 PORT undefined。
 *  修法契约被钉死（测试断言抛错 + main 的 catch 不许动）——存在确定解。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput, nodeTestsPass } from "./checkers.ts";

export const task: EvalTask = {
    id: 'error-swap-fix',
    name: '坏配置被静默吞错',
    tags: ['bugfix', 'debug'],
    prompt: 'config.json 是坏的（多了个尾逗号），但 `node src/main.js` 现在静默打印 PORT undefined——解析错误被吞了。改成解析失败必须抛异常（带着原始解析错误往上走），main.js 里的 catch 已经写好、不要改它。修完 main 应输出 CONFIG ERROR: 开头的一行，且 `node --test` 全绿。',
    fixture: {
        'config.json': `{
    "port": 8080,
    "host": "127.0.0.1",
}
`,
        'src/parse.js': `// JSON 安全解析
const safeParse = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return {}; // 解析失败先给空配置兜底
    }
};

module.exports = { safeParse };
`,
        'src/loader.js': `const fs = require('node:fs');
const { safeParse } = require('./parse.js');

const loadConfig = (file) => safeParse(fs.readFileSync(file, 'utf-8'));

module.exports = { loadConfig };
`,
        'src/main.js': `const { loadConfig } = require('./loader.js');

if (require.main === module) {
    try {
        const cfg = loadConfig('config.json');
        console.log('PORT', cfg.port);
    } catch (e) {
        console.log('CONFIG ERROR:', e.message);
    }
}
`,
        'test/parse.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { safeParse } = require('../src/parse.js');

test('合法 JSON 原样解析', () => {
    assert.deepEqual(safeParse('{"a":1}'), { a: 1 });
});

test('非法 JSON 必须抛错（不许静默吞成空对象）', () => {
    assert.throws(() => safeParse('{"a":1,}'));
});
`,
    },
    checker: async (ws) => {
        const run = await nodeRunOutput(ws, 'src/main.js', {
            include: ['CONFIG ERROR:'],
            notInclude: ['PORT undefined'],
        });
        if (!run.ok) return run;
        return nodeTestsPass(ws);
    },
};
