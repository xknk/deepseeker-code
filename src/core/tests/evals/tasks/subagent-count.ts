/**
 * @file tests/evals/tasks/subagent-count.ts
 * @description 扩展面行为级 eval（subagent，路线 #10④）：spawn_agent 派发 → 子代理独立跑完整管线
 *  （自己的上下文/工具/回灌）→ 父代理汇总。fixture 两个文件函数个数确定且无内联箭头函数
 *  （消除「回调算不算」歧义），子代理各留一个产物文件（stats-*.txt）证明真的分头统计过，
 *  父代理汇总 count-report.json 由 checker 精确判定。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { EvalTask } from "./types.ts";

const ordersJs = `// 订单统计工具（勿改动本文件）
function totalAmount(orders) {
    let sum = 0;
    for (const o of orders) sum += o.amount;
    return sum;
}

function averageAmount(orders) {
    if (orders.length === 0) return 0;
    return totalAmount(orders) / orders.length;
}

const maxOrder = function (orders) {
    let best = null;
    for (const o of orders) {
        if (best === null || o.amount > best.amount) best = o;
    }
    return best;
};

const minOrder = (orders) => {
    let best = null;
    for (const o of orders) {
        if (best === null || o.amount < best.amount) best = o;
    }
    return best;
};

module.exports = { totalAmount, averageAmount, maxOrder, minOrder };
`;

const usersJs = `// 用户统计工具（勿改动本文件）
function activeUsers(users) {
    let n = 0;
    for (const u of users) {
        if (u.active) n += 1;
    }
    return n;
}

function bannedUsers(users) {
    let n = 0;
    for (const u of users) {
        if (u.banned) n += 1;
    }
    return n;
}

function retentionRate(users) {
    if (users.length === 0) return 0;
    return activeUsers(users) / users.length;
}

const newestUser = function (users) {
    let best = null;
    for (const u of users) {
        if (best === null || u.joinedAt > best.joinedAt) best = u;
    }
    return best;
};

const oldestUser = (users) => {
    let best = null;
    for (const u of users) {
        if (best === null || u.joinedAt < best.joinedAt) best = u;
    }
    return best;
};

const medianAge = (users) => {
    const ages = [];
    for (const u of users) ages.push(u.age);
    for (let i = 0; i < ages.length; i++) {
        for (let j = i + 1; j < ages.length; j++) {
            if (ages[j] < ages[i]) {
                const t = ages[i];
                ages[i] = ages[j];
                ages[j] = t;
            }
        }
    }
    const mid = Math.floor(ages.length / 2);
    if (ages.length === 0) return 0;
    if (ages.length % 2 === 1) return ages[mid];
    return (ages[mid - 1] + ages[mid]) / 2;
};

const topSpenders = (users) => {
    const sorted = [];
    for (const u of users) sorted.push(u);
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            if (sorted[j].spend > sorted[i].spend) {
                const t = sorted[i];
                sorted[i] = sorted[j];
                sorted[j] = t;
            }
        }
    }
    return sorted.slice(0, 10);
};

module.exports = { activeUsers, bannedUsers, retentionRate, newestUser, oldestUser, medianAge, topSpenders };
`;

export const task: EvalTask = {
    id: 'subagent-count',
    name: 'spawn_agent 派发统计并汇总',
    tags: ['extension', 'subagent'],
    prompt: [
        '分别统计 src/stats/orders.js 和 src/stats/users.js 两个文件里定义的函数个数（顶层 function 声明、',
        'function 表达式赋值、箭头函数赋值都算；函数体内部的回调不算）。要求：派两个子代理（spawn_agent），',
        '每个子代理只统计一个文件，并把它统计到的数量写入 stats-orders.txt / stats-users.txt（文件里只写数字）；',
        '然后你把两个数字汇总生成 count-report.json，内容格式：{"orders.js": 数字, "users.js": 数字}。',
    ].join(''),
    fixture: {
        'src/stats/orders.js': ordersJs,
        'src/stats/users.js': usersJs,
    },
    checker: async (ws) => {
        const reportRaw = await fs.readFile(path.join(ws, 'count-report.json'), 'utf-8').catch(() => null);
        if (!reportRaw) return { ok: false, detail: 'count-report.json 缺失' };
        let report: any;
        try { report = JSON.parse(reportRaw); } catch { return { ok: false, detail: 'count-report.json 不是合法 JSON' }; }
        if (report['orders.js'] !== 4 || report['users.js'] !== 7) {
            return { ok: false, detail: `计数不符：期望 orders.js=4、users.js=7，实际 ${JSON.stringify(report)}` };
        }
        const so = await fs.readFile(path.join(ws, 'stats-orders.txt'), 'utf-8').catch(() => null);
        const su = await fs.readFile(path.join(ws, 'stats-users.txt'), 'utf-8').catch(() => null);
        if (!so || !String(so).includes('4')) return { ok: false, detail: `stats-orders.txt 缺失或没有 4：${JSON.stringify(so)}` };
        if (!su || !String(su).includes('7')) return { ok: false, detail: `stats-users.txt 缺失或没有 7：${JSON.stringify(su)}` };
        return { ok: true, detail: '两个子代理产物与汇总计数全部正确（4 / 7）' };
    },
};
