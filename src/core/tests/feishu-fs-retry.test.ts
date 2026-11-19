/**
 * @file tests/feishu-fs-retry.test.ts
 * @description renameWithRetry 函数级契约守门（2026-11-19 CI EPERM 假超时事故的修复件）。
 *
 *  覆盖：瞬时锁码（EPERM/EACCES/EBUSY）按退避重试直至成功 / 重试耗尽抛最后错误 /
 *  非瞬时码（ENOENT）立即抛出不拖延 / 默认参数走真 fs（真实 tmp+rename 冒烟）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
const { renameWithRetry } = await import("@/batch/feishu/fsRetry.ts");

const instantSleep = async (): Promise<void> => { };

test("瞬时锁码 EPERM 重试后成功（调用次数 = 失败次数 + 1）", async () => {
    let calls = 0;
    const fakeRename = async (): Promise<void> => {
        calls += 1;
        if (calls <= 2) {
            const e = new Error("EPERM mock") as NodeJS.ErrnoException;
            e.code = "EPERM";
            throw e;
        }
    };
    await renameWithRetry("a", "b", { sleep: instantSleep, rename: fakeRename });
    assert.equal(calls, 3);
});

test("三类瞬时锁码都会触发重试（EACCES/EBUSY）", async () => {
    for (const code of ["EACCES", "EBUSY"]) {
        let calls = 0;
        const fakeRename = async (): Promise<void> => {
            calls += 1;
            if (calls === 1) {
                const e = new Error(`${code} mock`) as NodeJS.ErrnoException;
                e.code = code;
                throw e;
            }
        };
        await renameWithRetry("a", "b", { sleep: instantSleep, rename: fakeRename });
        assert.equal(calls, 2, `${code} 应重试一次后成功`);
    }
});

test("重试耗尽抛最后一次的瞬时锁错误", async () => {
    const fakeRename = async (): Promise<void> => {
        const e = new Error("EPERM persist") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
    };
    await assert.rejects(
        () => renameWithRetry("a", "b", { tries: 3, sleep: instantSleep, rename: fakeRename }),
        /EPERM persist/,
    );
});

test("结构性错误（ENOENT）立即抛出，不重试", async () => {
    let calls = 0;
    const fakeRename = async (): Promise<void> => {
        calls += 1;
        const e = new Error("ENOENT mock") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
    };
    await assert.rejects(() => renameWithRetry("a", "b", { sleep: instantSleep, rename: fakeRename }), /ENOENT/);
    assert.equal(calls, 1, "非瞬时码只调一次");
});

test("默认参数走真 fs：真实 tmp+rename 冒烟", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-fs-retry-test-"));
    try {
        const tmp = path.join(dir, "x.json.tmp-1");
        const target = path.join(dir, "x.json");
        await fs.writeFile(tmp, '{"ok":true}', "utf-8");
        await renameWithRetry(tmp, target);
        assert.equal(await fs.readFile(target, "utf-8"), '{"ok":true}');
        await assert.rejects(() => fs.readFile(tmp, "utf-8")); // tmp 已搬走
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
