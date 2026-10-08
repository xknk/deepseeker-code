/**
 * @file tests/read-file-stamp.test.ts
 * @description P3-8 read_file 读取戳（run 级 Map<path,mtime>）行为锁：
 *  首读无标注 → 二读标「第 2 次·未变更」 → mtime 变后标「已变更」 → tracker 缺省零开销。
 *  ★ 契约：只做信息标注（模型自决），不做结果缓存/截断——压缩后旧读取可能已出上下文，硬缓存会饿死模型。
 *  env 先行 + 动态 import（fsTools 注册链上 config 在模块加载期读 env）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-rdstamp-"));
const { fsTools } = await import("../src/tool/registry/fs.ts");

const execute = fsTools.find((t: any) => t.function.name === "read_file")!.function.execute as (
    args: { path: string; start_line?: number; end_line?: number },
    toolCtx?: { readTracker?: Map<string, { mtimeMs: number; count: number }> },
) => Promise<string>;

describe("read_file 读取戳（P3-8）", () => {
    it("首读无标注；二读标「第 2 次·未变更」；mtime 变后标「已变更」；tracker 缺省零开销", async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-stamp-"));
        const p = path.join(dir, "a.txt");
        await fs.writeFile(p, "line1\nline2\nline3\n", "utf-8");

        const tracker = new Map<string, { mtimeMs: number; count: number }>();
        const r1 = await execute({ path: p }, { readTracker: tracker });
        assert.ok(!r1.includes("次读取"), "首读无标注");
        assert.ok(r1.includes("[File:"), "首读内容正常");

        const r2 = await execute({ path: p }, { readTracker: tracker });
        assert.ok(r2.includes("第 2 次读取（本 run）"), `二读带次数标注：${r2.split("\n")[0]}`);
        assert.ok(r2.includes("未变更"), "mtime 未变 → 未变更");
        assert.ok(r2.includes("line1"), "内容本身不受标注影响");

        const future = new Date(Date.now() + 50_000);
        await fs.utimes(p, future, future);
        const r3 = await execute({ path: p }, { readTracker: tracker });
        assert.ok(r3.includes("已变更"), "mtime 变 → 已变更");

        const r4 = await execute({ path: p }, {}); // tracker 缺省（异常路径）：零开销跳过，不炸
        assert.ok(r4.includes("line1"), "无 tracker 时读取照常");
    });
});
