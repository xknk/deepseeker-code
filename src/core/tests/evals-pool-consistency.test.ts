/**
 * @file tests/evals-pool-consistency.test.ts
 * @description eval 任务池注册一致性守护（T3，施工单 2026-11-13 §3.1，进 CI，零 API 成本）。
 *  真实风险：往 tests/evals/tasks/ 加了任务文件却忘了在 index.ts 注册 → 静默不计入基线
 *  （通过率分母缺一块，没人知道）。本测试两条腿：
 *  1) 每个导出 task 的任务文件必须出现在 evalTasks 中（漏注册即红）；
 *  2) evalTasks.length 锁死在 EXPECTED_POOL_SIZE——加题/删题必须**有意识地**改这里 +
 *     同步 evals/README.md 表格。这是逼一次显式更新，不是防手滑（手滑由第 1 条兜）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evalTasks } from './evals/tasks/index.ts';

// ★ 加题必须同步改此处 + evals/README.md 表格（改完跑一次 `npm run facts` 校准文档数字）
const EXPECTED_POOL_SIZE = 28;

// 辅助模块（非任务文件）：不导出 task，从扫描中排除
const NON_TASK_FILES = ['index.ts', 'types.ts', 'checkers.ts', 'refusal.ts'];

const TASKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evals', 'tasks');

test('任务池规模锁死：evalTasks.length === EXPECTED_POOL_SIZE', () => {
    assert.equal(evalTasks.length, EXPECTED_POOL_SIZE,
        `实际 ${evalTasks.length} ≠ 锁定值 ${EXPECTED_POOL_SIZE}——加题/删题请有意识地更新本常量 + evals/README.md 表格 + npm run facts 口径`);
});

test('每个导出 task 的任务文件都已注册进 evalTasks（漏注册 = 静默出局）', async () => {
    const files = (await fs.readdir(TASKS_DIR)).filter((f) => f.endsWith('.ts') && !NON_TASK_FILES.includes(f));
    const registeredIds = new Set(evalTasks.map((t) => t.id));
    const problems: string[] = [];
    for (const f of files) {
        const mod: any = await import(pathToFileURL(path.join(TASKS_DIR, f)).href);
        const id = mod?.task?.id;
        if (typeof id === 'string' && !registeredIds.has(id)) {
            problems.push(`${f} 导出了 task(id=${id}) 但未注册进 tasks/index.ts 的 evalTasks——该任务静默不计入基线`);
        }
    }
    assert.equal(problems.length, 0, problems.join('\n'));
});

test('注册表无幽灵条目：evalTasks 的每个 id 都能在任务文件里找到导出源（防删文件留死注册）', async () => {
    const files = (await fs.readdir(TASKS_DIR)).filter((f) => f.endsWith('.ts') && !NON_TASK_FILES.includes(f));
    const exportedIds = new Set<string>();
    for (const f of files) {
        const mod: any = await import(pathToFileURL(path.join(TASKS_DIR, f)).href);
        if (typeof mod?.task?.id === 'string') exportedIds.add(mod.task.id);
    }
    const ghosts = evalTasks.filter((t) => !exportedIds.has(t.id)).map((t) => t.id);
    assert.equal(ghosts.length, 0, `evalTasks 里有任务文件已不存在的条目: ${ghosts.join(', ')}`);
});
