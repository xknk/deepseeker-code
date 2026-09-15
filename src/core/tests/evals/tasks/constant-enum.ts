/**
 * @file tests/evals/tasks/constant-enum.ts
 * @description 多文件重构类：散落状态字符串收敛为 STATUS 常量对象，字面量只许留在 status.js。
 *  与 config-extract 互补（那个抽数字，这个抽字符串且跨文件更多）。
 */
import type { EvalTask } from "./types.ts";
import { nodeRunOutput, sourceAssert } from "./checkers.ts";

export const task: EvalTask = {
    id: 'constant-enum',
    name: '状态字符串收敛为 STATUS 常量',
    tags: ['refactor'],
    prompt: "订单状态 'pending'/'paid'/'cancelled' 这些字符串在 src/order.js、src/filter.js、src/main.js 里到处写死，容易拼错也不好改。收敛到 src/status.js：导出 STATUS = { PENDING: 'pending', PAID: 'paid', CANCELLED: 'cancelled' }，其他文件一律改用 STATUS.XXX 引用，状态字面量只允许留在 src/status.js 里。行为不变，改完跑 `node src/main.js` 输出还是那三行。",
    fixture: {
        'src/status.js': `// 订单状态常量（待收敛）
module.exports = {};
`,
        'src/order.js': `const label = (o) => {
    if (o.status === 'paid') return '已支付';
    if (o.status === 'pending') return '待支付';
    return '未知';
};

const isFinal = (o) => o.status === 'paid' || o.status === 'cancelled';

module.exports = { label, isFinal };
`,
        'src/filter.js': `const paidOnly = (orders) => orders.filter((o) => o.status === 'paid');

const countByStatus = (orders, s) => orders.filter((o) => o.status === s).length;

module.exports = { paidOnly, countByStatus };
`,
        'src/main.js': `const { paidOnly, countByStatus } = require('./filter.js');
const { label } = require('./order.js');

const orders = [
    { id: 1, status: 'paid' },
    { id: 2, status: 'pending' },
    { id: 3, status: 'paid' },
];

if (require.main === module) {
    console.log('PAID ORDERS', paidOnly(orders).length);
    console.log('PENDING ORDERS', countByStatus(orders, 'pending'));
    console.log(label(orders[1]));
}
`,
    },
    checker: async (ws) => {
        const run = await nodeRunOutput(ws, 'src/main.js', {
            include: ['PAID ORDERS 2', 'PENDING ORDERS 1', '待支付'],
        });
        if (!run.ok) return run;
        const status = await sourceAssert(ws, ['src/status.js'], {
            mustHave: [/PENDING.*'pending'|'pending'.*PENDING/, /PAID.*'paid'|'paid'.*PAID/, /CANCELLED.*'cancelled'|'cancelled'.*CANCELLED/],
        });
        if (!status.ok) return status;
        // 消费方：必须引用 STATUS，状态字面量绝迹（剥注释后）
        return sourceAssert(ws, ['src/order.js', 'src/filter.js', 'src/main.js'], {
            mustHave: [/STATUS/],
            mustNotHave: [/'(pending|paid|cancelled)'/],
        });
    },
};
