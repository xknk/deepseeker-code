/**
 * @file tests/prefix-fingerprint.test.ts
 * @description 前缀分段指纹（P0 缓存诊断）定义钉死（缓存塌方治理 M1 首步，2026-11-04）：
 *  - sumHash = sha1short(message[1].content)——【摘要槽内容 hash】。这是 2026-11-04 r53/r54 回算
 *    口径疑云的根源结论：全天恒 da39a3ee5e = 摘要槽从未被写过（排除「压缩槽改写」候选根因），
 *    分歧点必在 message[2]+ 的活动历史。本文件把定义钉进测试，防止未来重排消息/换槽位时定义漂移。
 *  - sysHash = sha1short(message[0].content)；toolsHash = sha1short(JSON.stringify(cleanedToolSchemas))
 *    （带 WeakMap 缓存）；msgCount = message.length。
 *
 *  纯函数单测，无落盘依赖——但 streamInference 模块加载链含 config（读 dataDir），
 *  故仍走「env 沙盒先于动态 import」惯例，与其他测试文件一致。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-prefix-fp-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const { buildPrefixFingerprint } = await import("@/agent/streamInference.ts");

/** sha1('') 前 10 位十六进制（空摘要槽的 sumHash 恒值——2026-11-04 全天 trace 实证值）。 */
const EMPTY_SHA1 = "da39a3ee5e";

describe("buildPrefixFingerprint：前缀分段指纹定义钉死（缓存塌方治理 M1）", () => {
    it("sumHash = sha1short(摘要槽 content)：空槽 → da39a3ee5e", () => {
        const message: any[] = [
            { role: "system", content: "SYS-CONTENT" },
            { role: "system", content: "" }, // 摘要槽（空，未压缩过的会话常态）
            { role: "user", content: "hello" },
        ];
        const fp = buildPrefixFingerprint(message, []);
        assert.equal(fp.sumHash, EMPTY_SHA1, "sumHash 定义 = message[1].content 的 sha1 短哈希；空槽恒 da39a3ee5e");
    });

    it("摘要槽改写 → sumHash 变、sysHash 不变（前缀击穿从 message[1] 起的可判依据）", () => {
        const mk = (slot: string): any[] => [
            { role: "system", content: "SYS-CONTENT" },
            { role: "system", content: slot },
            { role: "user", content: "hello" },
        ];
        const before = buildPrefixFingerprint(mk(""), []);
        const after = buildPrefixFingerprint(mk("⟦DSC:ARCHIVE-INDEX⟧\n- src/a.ts\n⟦DSC:ARCHIVE-NOTES⟧\n压缩叙述"), []);
        assert.notEqual(before.sumHash, after.sumHash, "槽内容变了 sumHash 必变");
        assert.equal(before.sysHash, after.sysHash, "message[0] 未动 → sysHash 稳定（压缩只改槽不碰 system 段）");
        assert.notEqual(after.sumHash, EMPTY_SHA1, "非空槽不再是空哈希");
    });

    it("toolsHash：同 schema 对象重复调用走 WeakMap 缓存同值；不同 schema → 不同值", () => {
        const schemas = [{ name: "read_file", description: "read a file" }];
        const message: any[] = [
            { role: "system", content: "SYS" },
            { role: "user", content: "go" },
        ];
        const a = buildPrefixFingerprint(message, schemas);
        const b = buildPrefixFingerprint(message, schemas); // 同一对象引用 → 缓存命中
        assert.equal(a.toolsHash, b.toolsHash, "同对象同值（WeakMap 缓存）");
        const c = buildPrefixFingerprint(message, [{ name: "read_file", description: "read a file" }]);
        assert.equal(c.toolsHash, a.toolsHash, "同内容不同引用 → JSON 序列化同值");
        const d = buildPrefixFingerprint(message, [{ name: "other_tool" }]);
        assert.notEqual(d.toolsHash, a.toolsHash, "不同 schema → 不同 toolsHash（工具表分歧可判）");
    });

    it("msgCount = message.length；sysHash 随 message[0] 内容变化", () => {
        const base: any[] = [
            { role: "system", content: "SYS-A" },
            { role: "system", content: "" },
            { role: "user", content: "x" },
        ];
        const fp1 = buildPrefixFingerprint(base, []);
        const fp2 = buildPrefixFingerprint([...base, { role: "assistant", content: "done" }], []);
        assert.equal(fp1.msgCount, 3);
        assert.equal(fp2.msgCount, 4);
        assert.notEqual(fp1.sysHash, buildPrefixFingerprint([{ role: "system", content: "SYS-B" }, ...base.slice(1)], []).sysHash,
            "message[0] 内容变 → sysHash 变（注入漂移可判）");
    });
});
