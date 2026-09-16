/**
 * @file tests/eval-tasks-initial-red.test.ts
 * @description 任务池守护（2026-09-15 任务池扩容 6→16 配套）：每个 eval 任务的**初始 fixture**
 *  （agent 未动手前）必须不通过自己的 checker——「初始即绿 = 无信息量」是入池硬约定（types.ts）。
 *  同时反向守护 checker 本身：能正常执行并给出失败 detail（而不是自己先崩）。
 *  纯本地（物化 fixture + 子进程跑 checker），零 API 成本，进 CI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evalTasks } from './evals/tasks/index.ts';

const materialize = async (ws: string, fixture: Record<string, string>): Promise<void> => {
    for (const [rel, content] of Object.entries(fixture)) {
        const abs = path.join(ws, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf-8');
    }
};

test('任务池规模：15+（路线 #4 轮数经济学要求样本量）', () => {
    assert.ok(evalTasks.length >= 15, `任务池应有 15+ 个任务，实际 ${evalTasks.length}`);
});

test('全部任务初始状态必须 fail（初始即绿 = 无信息量）', async () => {
    for (const t of evalTasks) {
        const ws = await fs.mkdtemp(path.join(os.tmpdir(), `dsc-eval-red-${t.id}-`));
        try {
            await materialize(ws, t.fixture);
            const r = await t.checker(ws);
            assert.equal(r.ok, false, `${t.id} 初始 fixture 通过了 checker——任务无信息量，请检查 fixture 是否已含确定解`);
            assert.ok(r.detail, `${t.id} checker 失败时必须给出 detail（判定依据）`);
        } finally {
            await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
        }
    }
});

test('任务 id 唯一且 kebab-case（基线对齐主键）', () => {
    const ids = evalTasks.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'id 重复');
    for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${id} 不是 kebab-case`);
});

test('引用项目级配置（.deepseeker-code/）的任务必须声明 extensionFixture（路线 #10④）', () => {
    // 洁净室标准阶段 includeProject:false 不加载项目配置——把 .deepseeker-code/ 文件放进普通 fixture
    // 的任务会静默跑在「扩展面不存在」的环境里（checker 报行为缺失，实为配置未加载）。
    for (const t of evalTasks) {
        const projectFiles = Object.keys(t.fixture).filter((k) => k.includes('.deepseeker-code'));
        if (projectFiles.length > 0) {
            assert.ok(t.extensionFixture, `${t.id} 在 fixture 里放了项目级配置 [${projectFiles.join(', ')}] 却未声明 extensionFixture——洁净室不会加载它，请移入 extensionFixture.project`);
        }
    }
});
