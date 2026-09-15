/**
 * @file tests/evals/tasks/csv-report.ts
 * @description 功能实现类：CSV 读取 → 按组聚合 → 排序输出，三步小流水线。
 *  checker 逐行精确比对 stdout（顺序也钉死），初始 stub 只数行数必红。
 */
import type { EvalTask } from "./types.ts";
import { runNode } from "./checkers.ts";

export const task: EvalTask = {
    id: 'csv-report',
    name: 'CSV 按区域汇总报表',
    tags: ['feature'],
    prompt: 'src/report.js 目前只数了行数。改成正式报表：读取 orders.csv（两列 region,amount，首行是表头），按 region 汇总 amount 总和，每行输出 `region 合计`（一个空格分隔），行序按 region 字母序。跑 `node src/report.js` 应输出三行：east 180 / south 200 / west 120。',
    fixture: {
        'orders.csv': `region,amount
east,120
west,80
east,60
south,200
west,40
`,
        'src/report.js': `const fs = require('node:fs');

// TODO: 改成按 region 汇总输出（详见任务描述）
const rows = fs.readFileSync('orders.csv', 'utf-8').trim().split('\\n').slice(1);
console.log('ROWS', rows.length);
`,
    },
    checker: async (ws) => {
        const r = await runNode(ws, ['src/report.js']);
        if (r.code !== 0) return { ok: false, detail: `退出码 ${r.code}: ${r.stderr.slice(-300)}` };
        const expected = ['east 180', 'south 200', 'west 120'];
        const lines = r.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const same = lines.length === expected.length && expected.every((e, i) => lines[i] === e);
        return same
            ? { ok: true, detail: '输出逐行一致（含顺序）' }
            : { ok: false, detail: `期望 [${expected.join(' | ')}]，实际 [${lines.join(' | ')}]` };
    },
};
