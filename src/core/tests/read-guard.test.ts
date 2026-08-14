/**
 * @file tests/read-guard.test.ts
 * @description read 系工具的跨界读解析 + 读保护闸门验证（放行只读跨界的回归基线）。
 *  resolveReadablePath：放行 ../跨兄弟项目与绝对路径（不围栏），相对路径仍以活动根为锚——
 *    与写工具的 resolveSafePath（围栏拒 .. 越界，见 guard-als.test.ts）形成对照。
 *  assertReadable：放行跨界读后，凭证防线须跟随到工作区外——对【物理绝对路径】做正则判定，
 *    工作区外的 .env / 私钥 / ~/.aws/credentials（无扩展名）/ ~/.netrc 等同样硬拒。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import os from "os";
import fs from "fs";
import { resolveReadablePath, runWithWorkspaceRoot } from "@/tool/guard.ts";
import { assertReadable } from "@/tool/registry/fs.ts";

describe("resolveReadablePath — 只读跨界放行", () => {
    const tmp = path.join(os.tmpdir(), "dsc-read-root");

    it("../ 跨界到活动根之外不抛 SECURITY（与 resolveSafePath 写围栏相反）", () => {
        const r = runWithWorkspaceRoot(tmp, () => resolveReadablePath("../other/pkg/a.ts"));
        assert.equal(r, path.resolve(tmp, "../other/pkg/a.ts"));
        assert.doesNotThrow(() => resolveReadablePath("../escape.txt"));
    });

    it("绝对路径原样解析（不围栏）", () => {
        const abs = path.join(os.tmpdir(), "dsc-external-abs.txt");
        const r = runWithWorkspaceRoot(tmp, () => resolveReadablePath(abs));
        assert.equal(r, path.resolve(abs));
    });

    it("相对路径仍以活动根为锚（零回归）", () => {
        const r = runWithWorkspaceRoot(tmp, () => resolveReadablePath("a.txt"));
        assert.equal(r, path.resolve(tmp, "a.txt"));
    });

    it("重复根名前缀去重容错（ENOENT 时自愈模型常见错误）", () => {
        // 模型常误带「活动根目录名」前缀：根=pms-front，却传 pms-front/src/x.vue → 去重为 src/x.vue
        const root = path.join(os.tmpdir(), "dsc-dedup", "pms-front");
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, "src", "x.vue"), "x");
        try {
            const r = runWithWorkspaceRoot(root, () => resolveReadablePath("pms-front/src/x.vue"));
            assert.equal(r, path.join(root, "src", "x.vue"));
        } finally {
            fs.rmSync(path.join(os.tmpdir(), "dsc-dedup"), { recursive: true, force: true });
        }
    });
});

describe("assertReadable — 跨界读下的凭证硬拒（对物理绝对路径判定）", () => {
    it("普通代码文件放行（返回 null）", async () => {
        const block = await assertReadable(path.join(os.tmpdir(), "sibling", "src", "App.tsx"), "App.tsx");
        assert.equal(block, null);
    });

    it("工作区外 .env 拒读", async () => {
        const block = await assertReadable(path.join(os.tmpdir(), "sibling", ".env"), ".env");
        assert.match(block ?? "", /安全拦截/);
    });

    it("无扩展名 credentials 拒读（AWS ~/.aws/credentials）", async () => {
        const block = await assertReadable(path.join(os.homedir(), ".aws", "credentials"), "credentials");
        assert.match(block ?? "", /安全拦截/);
    });

    it("~/.netrc 拒读", async () => {
        const block = await assertReadable(path.join(os.homedir(), ".netrc"), ".netrc");
        assert.match(block ?? "", /安全拦截/);
    });

    it("SSH 私钥 id_rsa 拒读（含 .ssh 子目录路径）", async () => {
        const block = await assertReadable(path.join(os.homedir(), ".ssh", "id_rsa"), "id_rsa");
        assert.match(block ?? "", /安全拦截/);
    });

    it("credentials.json 拒读（带扩展名凭证）", async () => {
        const block = await assertReadable(path.join(os.tmpdir(), "sibling", "credentials.json"), "credentials.json");
        assert.match(block ?? "", /安全拦截/);
    });
});
