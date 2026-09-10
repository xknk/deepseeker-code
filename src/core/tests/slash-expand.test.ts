/**
 * @file tests/slash-expand.test.ts
 * @description 斜杠命令展开器（commands/expand.ts）守护测试：
 *  核心契约是「安全闸」——只有注册表命中的 /name 才展开，其余一律原样透传。
 *  这条闸守护着文件路径（/usr/bin/x、/etc/hosts）不被误展开，是设计红线，缺测会静默回归。
 *  命中分支经 registerCommand 注入夹具命令（不依赖磁盘发现，测试自包含）。
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-slash-expand-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { expandSlashCommand } = await import("@/commands/expand.ts");
const { registerCommand } = await import("@/commands/registry.ts");

describe("expandSlashCommand 安全闸（未注册一律原样透传）", () => {
    it("普通文本不动，含 $ARGUMENTS 也不动", () => {
        assert.equal(expandSlashCommand("帮我改一下 $ARGUMENTS 这个占位符"), "帮我改一下 $ARGUMENTS 这个占位符");
    });
    it("文件路径形态 /usr/bin/foo 不误展开（name 未注册）", () => {
        assert.equal(expandSlashCommand("/usr/bin/foo --help"), "/usr/bin/foo --help");
    });
    it("未注册命令 /nope 原样透传", () => {
        assert.equal(expandSlashCommand("/nope rest args"), "/nope rest args");
    });
    it("畸形输入不炸：裸 /、//、/1abc、非字符串", () => {
        for (const bad of ["/", "//", "/1abc", ""]) {
            assert.equal(expandSlashCommand(bad), bad);
        }
        assert.equal(expandSlashCommand(undefined as unknown as string), undefined);
    });
});

describe("expandSlashCommand 命中分支（$ARGUMENTS / $1 展开）", () => {
    beforeEach(() => {
        registerCommand({
            name: "fixture-cmd",
            description: "测试夹具",
            body: "对 $ARGUMENTS 执行检查；参数为 $1",
            file: "fixture://fixture-cmd",
            source: "builtin",
        });
    });

    it("命中：$ARGUMENTS 与 $1 都替换为 rest", () => {
        const out = expandSlashCommand("/fixture-cmd src/foo.ts");
        assert.equal(out, "对 src/foo.ts 执行检查；参数为 src/foo.ts");
    });
    it("rest 含 $ 特殊模式时不被 replacement 解释（函数替换契约）", () => {
        const out = expandSlashCommand("/fixture-cmd '$& $` $''");
        assert.ok(out.includes("'$& $` $'"), `用户原文须原样进入正文，实际：${out}`);
    });
    it("无 rest：占位符替换为空串", () => {
        const out = expandSlashCommand("/fixture-cmd");
        assert.equal(out, "对  执行检查；参数为 ");
    });
});
