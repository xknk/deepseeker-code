/**
 * @file tests/batch-feishu-config.test.ts
 * @description 多入口工单流水线 P4：feishu.json 配置（方案 §3）守门测试。
 *
 *  覆盖：缺省值（mentionOnlyInGroup=true / budgetYuan=0.5 / gatekeeper=false）/ 三态
 *  （缺文件=明确报错不是全缺省、坏 JSON、非对象）/ 未知键拒绝（拼写错静默失效红线）/
 *  白名单至少一项非空 / chats/users/budgetYuan/布尔形态校验 / example 照抄即用守门
 *  （严格 JSON 零注释——P3 sync.json.example 翻过车）/ 轻模块红线守门（config.ts import 白名单：
 *  零 SDK、零 LLM/agent 链）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const { loadFeishuConfig, FEISHU_CONFIG_PATH, DEFAULT_FEISHU_BUDGET_YUAN } = await import("@/batch/feishu/config.ts");
const queue = await import("@/batch/queue.ts");

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ============ 缺省值与合法配置 ============

test("缺省：只配 chats → mentionOnlyInGroup=true / budgetYuan=0.5 / gatekeeper=false / users=[]", async () => {
    const r = await loadFeishuConfig({ raw: JSON.stringify({ chats: ["oc_abc"] }) });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.config.chats, ["oc_abc"]);
    assert.deepEqual(r.config.users, []);
    assert.equal(r.config.mentionOnlyInGroup, true);
    assert.equal(r.config.budgetYuan, DEFAULT_FEISHU_BUDGET_YUAN);
    assert.equal(r.config.budgetYuan, 0.5);
    assert.equal(r.config.gatekeeper, false);
});

test("合法：users 单独成档（只私聊不进群）；空白项 trim；布尔/预算显式值生效", async () => {
    const r = await loadFeishuConfig({ raw: JSON.stringify({ users: [" ou_ok "], mentionOnlyInGroup: false, budgetYuan: 1.5, gatekeeper: true }) });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.config.users, ["ou_ok"]);
    assert.equal(r.config.mentionOnlyInGroup, false);
    assert.equal(r.config.budgetYuan, 1.5);
    assert.equal(r.config.gatekeeper, true);
});

// ============ fail-closed 三态与形态校验 ============

test("缺文件：明确报错给修复指引（白名单是安全闸，绝不默默收所有消息）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-feishu-cfg-"));
    process.env.DEEPSEEKER_CODE_BATCH_DIR = dir;
    try {
        assert.equal(path.basename(FEISHU_CONFIG_PATH()), "feishu.json");
        assert.ok(FEISHU_CONFIG_PATH().startsWith(dir), "配置路径跟随 batch 目录重定向");
        const r = await loadFeishuConfig();
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.match(r.error, /feishu\.json/);
        assert.match(r.error, /example/);
    } finally {
        delete process.env.DEEPSEEKER_CODE_BATCH_DIR;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("坏 JSON / 非对象 / 未知键 → fail-closed 各一句人话", async () => {
    const badJson = await loadFeishuConfig({ raw: "{chats: [" });
    assert.equal(badJson.ok, false);
    if (!badJson.ok) assert.match(badJson.error, /JSON/);

    const arr = await loadFeishuConfig({ raw: "[]" });
    assert.equal(arr.ok, false);
    if (!arr.ok) assert.match(arr.error, /对象/);

    const unknown = await loadFeishuConfig({ raw: JSON.stringify({ chats: ["oc_a"], gatkeeper: true }) });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) {
        assert.match(unknown.error, /未知配置键/);
        assert.match(unknown.error, /gatkeeper/, "报错点名拼错的键");
        assert.match(unknown.error, /gatekeeper/, "并列出可用键");
    }

    // 前缀/空键形态：字符串 includes 时代这些全会被放行（合法键前缀命中拼接串）——
    // 数组精确匹配后必须全拦（"chat" 漏 s 曾静默把群白名单清空，2026-11-06 复审修）。
    for (const k of ["chat", "user", "budget", "gat", ""]) {
        const pfx = await loadFeishuConfig({ raw: JSON.stringify({ chats: ["oc_a"], [k]: 1 }) });
        assert.equal(pfx.ok, false, `前缀/畸形键 "${k}" 必须拒绝`);
        if (!pfx.ok) assert.match(pfx.error, /未知配置键/);
    }
});

test("白名单全空 / chats·users 形态 / budgetYuan / 布尔 → fail-closed", async () => {
    const bad = async (obj: any, re: RegExp): Promise<void> => {
        const r = await loadFeishuConfig({ raw: JSON.stringify(obj) });
        assert.equal(r.ok, false);
        if (!r.ok) assert.match(r.error, re);
    };
    await bad({}, /白名单为空/);
    await bad({ chats: [], users: [] }, /白名单为空/);
    await bad({ chats: "oc_a" }, /chats 非法/);
    await bad({ chats: [42] }, /chats 非法/);
    await bad({ chats: ["oc a"] }, /chats 非法/);
    await bad({ chats: ["oc_a"], users: [""] }, /users 非法/);
    await bad({ chats: ["oc_a"], users: ["a\nb"] }, /users 非法/);
    await bad({ chats: ["oc_a"], budgetYuan: 0 }, /budgetYuan 非法/);
    await bad({ chats: ["oc_a"], budgetYuan: -1 }, /budgetYuan 非法/);
    await bad({ chats: ["oc_a"], budgetYuan: "x" }, /budgetYuan 非法/);
    await bad({ chats: ["oc_a"], mentionOnlyInGroup: "yes" }, /mentionOnlyInGroup 非法/);
    await bad({ chats: ["oc_a"], gatekeeper: 1 }, /gatekeeper 非法/);
});

// ============ example 照抄即用守门（严格 JSON 零注释——P3 翻过车勿重蹈） ============

test("feishu.json.example 必须通过 loadFeishuConfig 校验（照抄即用：严格 JSON、无注释、键合法）", async () => {
    const repoRoot = path.resolve(CORE_ROOT, "..", "..");
    const raw = fsSync.readFileSync(path.join(repoRoot, "feishu.json.example"), "utf-8");
    let obj: any;
    assert.doesNotThrow(() => { obj = JSON.parse(raw); }, "示例必须是严格 JSON（注释/尾逗号都会让 JSON.parse 抛）");
    const r = await loadFeishuConfig({ raw });
    assert.equal(r.ok, true, `示例配置必须能直接通过校验：${r.ok ? "" : r.error}`);
    assert.ok(Array.isArray(obj.chats) && obj.chats.length > 0, "示例必须示范 chats");
    assert.ok(Array.isArray(obj.users) && obj.users.length > 0, "示例必须示范 users");
    assert.ok(!raw.includes("//") && !raw.includes("#"), "示例不得带注释（严格 JSON 红线）");
});

// ============ 轻模块红线守门（源码扫描） ============

test("守门：config.ts import 白名单——零 SDK、零 LLM/agent 链（只许 fs/path + batch 内相对/别名）", () => {
    const src = fsSync.readFileSync(path.join(CORE_ROOT, "src", "batch", "feishu", "config.ts"), "utf-8");
    const specs = [...src.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(specs.length >= 2, `import 面提取疑似失配（仅 ${specs.length} 条）`);
    const okSpec = (s: string): boolean =>
        /^(fs|fs\/promises|os|path|crypto|node:[a-z]+)$/.test(s) || s.startsWith("./") || s.startsWith("../") || s.startsWith("@/batch/");
    const bad = specs.filter((s) => !okSpec(s));
    assert.deepEqual(bad, [], `config.ts 出现白名单外 import：${bad.join(", ")}`);
    assert.ok(!/@larksuiteoapi/.test(src), "零 SDK 红线");
    assert.ok(!/@\/(agent|llm|provider|tool|session|host)\//.test(src), "零 LLM/agent 链红线");
});

// queue.ts 引用保活（batchQueueRoot env 重定向依赖此模块已加载）
void queue;
