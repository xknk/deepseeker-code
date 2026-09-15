/**
 * @file tests/evals/tasks/decoy-bugfix.ts
 * @description 调试定位类：症状在报表日期（2026-3-5 未补零），根因在两层之下的 pad 工具；
 *  round.js 的 +1e-9 浮点修正是刻意行为（干扰项）——行为被测试钉死，动了就红。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput, nodeTestsPass } from "./checkers.ts";

export const task: EvalTask = {
    id: 'decoy-bugfix',
    name: '日期补零根因定位（含干扰项）',
    tags: ['bugfix', 'debug'],
    prompt: '跑 `node src/report.js`，日期输出成了 2026-3-5 这种没补零的格式，应该是 2026-03-05 才对。帮忙定位问题出在哪并修掉（金额那部分显示是对的，别动）。改完 `node src/report.js` 正常、`node --test` 全绿。',
    fixture: {
        'src/pad.js': `// 数字字符串左补零到指定宽度（如 3 → "03"）
const pad = (n, width) => n.toString().slice(0, width);

module.exports = { pad };
`,
        'src/format.js': `const { pad } = require('./pad.js');

// 日期格式化为 YYYY-MM-DD
const formatDate = (d) => \`\${d.getFullYear()}-\${pad(d.getMonth() + 1, 2)}-\${pad(d.getDate(), 2)}\`;

module.exports = { formatDate };
`,
        'src/round.js': `// 金额四舍五入到分。+1e-9 修正 n*100 的浮点下坠（如 0.145*100 = 14.499999...），
// 去掉会让边界值舍错——看起来可疑，实为刻意。
const round2 = (n) => Math.round(n * 100 + 1e-9) / 100;

module.exports = { round2 };
`,
        'src/report.js': `const { formatDate } = require('./format.js');
const { round2 } = require('./round.js');

const line = (y, m, d, amount) => \`\${formatDate(new Date(y, m - 1, d, 10, 0, 0))}  \${round2(amount).toFixed(2)}\`;

if (require.main === module) {
    console.log(line(2026, 3, 5, 123.456));
    console.log(line(2026, 11, 1, 0.145));
}

module.exports = { line };
`,
        'test/report.test.js': `const test = require('node:test');
const assert = require('node:assert/strict');
const { formatDate } = require('../src/format.js');
const { round2 } = require('../src/round.js');

test('formatDate 月份/日期补零', () => {
    assert.equal(formatDate(new Date(2026, 2, 5, 10, 0, 0)), '2026-03-05');
    assert.equal(formatDate(new Date(2026, 10, 1, 10, 0, 0)), '2026-11-01');
    assert.equal(formatDate(new Date(2026, 11, 31, 10, 0, 0)), '2026-12-31');
});

test('round2 金额舍入（含浮点边界）', () => {
    assert.equal(round2(0.145), 0.15);
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(123.456), 123.46);
    assert.equal(round2(2), 2);
});
`,
    },
    checker: async (ws) => {
        const run = await nodeRunOutput(ws, 'src/report.js', {
            include: ['2026-03-05  123.46', '2026-11-01  0.15'],
        });
        if (!run.ok) return run;
        return nodeTestsPass(ws);
    },
};
