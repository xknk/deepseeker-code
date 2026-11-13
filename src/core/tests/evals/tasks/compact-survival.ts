/**
 * @file tests/evals/tasks/compact-survival.ts
 * @description 跨压缩存活题（T2，施工单 2026-11-13 §4.3）：压缩是唯一必然发生、又从未被测过的路径——
 *  27 题从不跨压缩边界（truncate.ts 是 core 最大单文件），本题用「仅本任务生效的小窗口」逼出真实压缩，
 *  测「压完还能不能把活干完」，不测定位能力。fixture 刻意复用现有题型规模（不造大仓），靠小窗口 + 几轮
 *  工具输出自然撞线（windowTokens 初值 12000，按实测校准；校准止损见施工单 §4.5：压不动 → 缩窗到 8K，
 *  压完必挂 → 换题/重调，两轮为限别磨）。
 *  ★ prompt 是正常用户口吻，不许写「记住前面」「这是压力测试」类元提示——元提示会替模型扛住压缩，
 *    题就废了。压缩后模型对任务的全部认知只能来自摘要槽（⟦DSC:ARCHIVE-INDEX/NOTES⟧）+ 保留区。
 */
import type { EvalTask } from "./types.ts";
import { nodeTestsPass, sourceAssert } from "./checkers.ts";

export const task: EvalTask = {
    id: 'compact-survival',
    name: '跨压缩边界修 bug 补回归',
    tags: ['long-session', 'compaction'],
    windowTokens: 16000,   // ★ 校准记录（2026-11-13）：初值 12K 实测不可行——基础上下文（system+tools 估算，
                           //   新会话 calibRatio 1.4 口径）≈11.3K，直接顶穿 0.85×window 硬闸（10.2K）走「任务过大」
                           //   兜底而非压缩。16K：硬闸 13.6K > 基础 11.3K 不误触，压缩阈值 0.72×16K=11.5K 在
                           //   干活中途（几轮工具输出后）自然撞线。校准依据 compactCount：0=压不动 / 压完必挂=窗口过小。
    prompt: '项目里的测试有几个用例失败，现象都是分页结果多出一条。请修复 src/pagination.js 里的这个边界 bug，并照 test/pagination.test.js 里现有用例的风格给这个 bug 补一条回归测试（加在同一个测试文件里），跑一遍全量测试确认全绿。其他模块不要动。这次修复挂了 QA 追溯流程，追溯码是 STK-4402（QA 平台登记的，仓库里查不到）：全部改完、测试跑绿之后，在仓库根新建 QA-TRACE.md，内容里带上这个追溯码和一句对修复内容的说明，措辞随意。',
    fixture: {
        // —— 被测模块：右边界 +1 是本 bug（初始即红，sourceAssert 断言其修复）——
        'src/pagination.js': `// 分页切片：page 从 0 计，size 每页条数
const paginate = (items, page, size) => {
    if (!Array.isArray(items)) return [];
    const safeSize = Math.max(1, Math.floor(size) || 1);
    const safePage = Math.max(0, Math.floor(page) || 0);
    const start = safePage * safeSize;
    return items.slice(start, start + safeSize + 1);
};

// 全量分页：把 items 按 size 切成若干页（供报表整体遍历）
const paginateAll = (items, size) => {
    const pages = [];
    for (let p = 0; p * size < items.length; p++) pages.push(paginate(items, p, size));
    return pages;
};

// 末页判定：给定 items/size，返回最后一页的页码（不足一页也算一页）
const lastPage = (items, size) => Math.max(0, Math.ceil(items.length / Math.max(1, size)) - 1);

module.exports = { paginate, paginateAll, lastPage };
`,
        // —— 展示层：报表按页渲染（模型调试时需要顺着调用链读它，自然产生读文件体积）——
        'src/report.js': `// 报表渲染：数据按页切片后逐行格式化。分页语义以 src/pagination.js 为准。
const { paginate, lastPage } = require('./pagination');
const { padEnd, truncate } = require('./text');

const renderRow = (item, width) => padEnd(truncate(item.name, 24), 24) + padEnd(String(item.qty), 8) + truncate(item.note || '', 20);

// 单页报表：标题 + 行 + 页脚（page 从 0 计）
const renderPage = (items, page, size, width) => {
    const rows = paginate(items, page, size);
    const lines = [];
    lines.push('== 库存报表 第 ' + (page + 1) + ' 页 ==');
    for (const item of rows) lines.push(renderRow(item, width));
    lines.push('-- 共 ' + rows.length + ' 条 --');
    return lines.join('\\n');
};

// 全量报表：逐页拼接，末页后停止
const renderReport = (items, size, width) => {
    const out = [];
    const last = lastPage(items, size);
    for (let p = 0; p <= last; p++) out.push(renderPage(items, p, size, width));
    return out.join('\\n\\n');
};

module.exports = { renderPage, renderReport };
`,
        // —— 字符串工具：report 依赖（体量最大的读文件，撑起撞线的上下文体积）——
        'src/text.js': `// 文本展示工具：报表与终端输出共用。全部纯函数，无副作用。
const padEnd = (s, n) => {
    const str = String(s ?? '');
    return str.length >= n ? str : str + ' '.repeat(n - str.length);
};

const padStart = (s, n) => {
    const str = String(s ?? '');
    return str.length >= n ? str : ' '.repeat(n - str.length) + str;
};

const center = (s, n) => {
    const str = String(s ?? '');
    if (str.length >= n) return str;
    const left = Math.floor((n - str.length) / 2);
    return ' '.repeat(left) + str + ' '.repeat(n - str.length - left);
};

const truncate = (s, n) => {
    const str = String(s ?? '');
    return str.length > n ? str.slice(0, n) : str;
};

const truncateWithEllipsis = (s, n) => {
    const str = String(s ?? '');
    return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str;
};

const slugify = (s) => String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');

const countWords = (s) => String(s ?? '').split(/\\s+/).filter(Boolean).length;

const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const indent = (s, n) => String(s ?? '').split('\\n').map((line) => ' '.repeat(n) + line).join('\\n');

const dedent = (s) => {
    const lines = String(s ?? '').split('\\n');
    const widths = lines.filter((l) => l.trim()).map((l) => (l.match(/^\\s*/) || [''])[0].length);
    const min = widths.length ? Math.min(...widths) : 0;
    return lines.map((l) => l.slice(min)).join('\\n');
};

const wordWrap = (s, width) => {
    const words = String(s ?? '').split(/\\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
        if (!cur) { cur = w; continue; }
        if ((cur + ' ' + w).length <= width) cur = cur + ' ' + w;
        else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.join('\\n');
};

const camelCase = (s) => String(s ?? '')
    .replace(/[-_\\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)*/, (m) => m.charAt(0).toLowerCase() + m.slice(1));

const kebabCase = (s) => String(s ?? '')
    .replace(/([a-z\\d])([A-Z])/g, '$1-$2')
    .replace(/[-_\\s]+/g, '-')
    .toLowerCase();

const snakeCase = (s) => kebabCase(s).replace(/-/g, '_');

const titleCase = (s) => String(s ?? '').split(/\\s+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

const repeatToWidth = (s, n) => {
    const str = String(s ?? '');
    if (n <= 0) return '';
    let out = '';
    while (out.length < n) out += str;
    return out.slice(0, n);
};

module.exports = { padEnd, padStart, center, truncate, truncateWithEllipsis, slugify, countWords, escapeHtml, indent, dedent, wordWrap, camelCase, kebabCase, snakeCase, titleCase, repeatToWidth };
`,
        // —— 测试：3 绿 + 1 红（红的即本 bug；初始 fixture 必须 checker 不通过，入池硬约定）——
        'test/pagination.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paginate, paginateAll, lastPage } = require('../src/pagination');

test('paginate: 第一页取前 size 条', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    assert.deepEqual(paginate(items, 0, 3), ['a', 'b', 'c']);
});

test('paginate: page 超出范围返回空数组', () => {
    const items = ['a', 'b', 'c'];
    assert.deepEqual(paginate(items, 5, 3), []);
});

test('paginateAll: 7 条按 3 页分共 3 页', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const pages = paginateAll(items, 3);
    assert.equal(pages.length, 3);
    assert.deepEqual(pages[2], ['g']);
});

test('paginate: 最后一页不足一页时只返回剩余条数（当前 bug：多出一条）', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    assert.deepEqual(paginate(items, 1, 3), ['d', 'e', 'f']);
});
`,
        'test/report.test.js': `const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderPage } = require('../src/report');

const stock = [
    { name: '螺丝 M4', qty: 120 },
    { name: '螺丝 M6', qty: 80 },
    { name: '垫片 8mm', qty: 200 },
    { name: '轴承 6204', qty: 32 },
];

test('renderPage: 第一页 3 条渲染 3 行', () => {
    const out = renderPage(stock, 0, 3, 60);
    assert.equal(out.split('\\n').length, 5); // 标题 + 3 行 + 页脚
});

test('renderPage: 超出范围页只有标题和页脚', () => {
    const out = renderPage(stock, 9, 3, 60);
    assert.equal(out.split('\\n').length, 2);
});
`,
    },
    checker: async (ws) => {
        // ① fixture 内测试全绿（修复 + 回归测试都不得破坏现有用例）
        const tests = await nodeTestsPass(ws);
        if (!tests.ok) return tests;
        // ② 源码断言：修改点存在（右边界以 size 收尾）且旧错误逻辑消失（+1 多吐一条）。
        //  /i：fixture 变量名是 safeSize（驼峰大小写），断言对 size/Size 均生效，勿收窄。
        const src = await sourceAssert(ws, ['src/pagination.js'], {
            mustHave: [/slice\([^)]*size\s*\)/i],
            mustNotHave: [/size\s*\+\s*1/i],
        });
        if (!src.ok) return src;
        // ③ 对话独有事实存活：追溯码 STK-4402 只在 prompt 里出现（不上盘、不加引号→不进实体索引、
        //  纯数字段被索引提取器过滤），压缩后唯一载体是叙述段——本题「跨压缩存活」的核心量测点。
        return sourceAssert(ws, ['QA-TRACE.md'], {
            mustHave: [/STK-4402/],
        });
    },
};
