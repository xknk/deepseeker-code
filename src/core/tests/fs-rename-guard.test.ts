/**
 * @file tests/fs-rename-guard.test.ts
 * @description 裸 rename 禁令守门（评审修复施工单卡 1，2026-11-24）：tmp+rename 原子写盘路径
 *  统一走 common/fsRetry 的 renameWithRetry——Windows 杀软对刚写完的 tmp 瞬时加锁，
 *  裸 fs.rename 偶发 EPERM（2026-11-19 CI 事故根因），修法是重试自愈而非各自散落。
 *
 *  规则：src/**（排除 tests 与 common/fsRetry.ts 自身）禁止出现
 *  `fs.rename(` / `fs.renameSync(` / `fs.promises.rename(`。
 *  同族瞬时锁（fs.rm 兜底等）不在此禁令内，按需用 withLockRetry。
 *  写法参照 tool-failure-consistency.test.ts 的扫描形态（文本级正则即可，无需 AST）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = path.resolve(CORE_ROOT, ".."); // 仓库 src/（core + cli + vscode）

/** 禁令形态：三种裸 rename 调用。`fs.rename.bind(fs)` 这类借用形态不带 `(`，天然不命中。 */
const BANNED_RE = /fs\.rename\(|fs\.renameSync\(|fs\.promises\.rename\(/;

const EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIP_SEGMENTS = new Set(["node_modules", "dist", "out", ".git", "tests"]);
const SELF = path.join(CORE_ROOT, "src", "common", "fsRetry.ts"); // 重试实现自身是唯一合法持有者

/** 收集 src/ 下全部源码文件（排除 tests 目录、*.test.* 文件与构建产物目录） */
const collectSourceFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_SEGMENTS.has(entry.name)) continue;
            collectSourceFiles(full, acc);
        } else if (EXTS.has(path.extname(entry.name)) && !/\.test\.(ts|tsx|mts|cts)$/.test(entry.name)) {
            acc.push(full);
        }
    }
    return acc;
};

describe("裸 rename 禁令守门（tmp+rename 原子写统一走 renameWithRetry）", () => {
    it("src/** 下不允许出现 fs.rename( / fs.renameSync( / fs.promises.rename(（common/fsRetry.ts 自身除外）", () => {
        const offenders: string[] = [];
        for (const file of collectSourceFiles(SRC_ROOT)) {
            if (path.resolve(file) === path.resolve(SELF)) continue;
            const rel = path.relative(SRC_ROOT, file).replace(/\\/g, "/");
            const src = fs.readFileSync(file, "utf8");
            const lines = src.split("\n");
            lines.forEach((line, i) => {
                if (BANNED_RE.test(line)) offenders.push(`${rel}:${i + 1} → ${line.trim().slice(0, 80)}`);
            });
        }
        assert.deepEqual(offenders, [],
            `发现裸 fs.rename（Windows 瞬时锁会 EPERM，须经 @/common/fsRetry 的 renameWithRetry）：\n${offenders.join("\n")}`);
    });
});
