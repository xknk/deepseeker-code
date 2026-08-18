/**
 * @file tests/dump-config.test.ts
 * @description dump-config（第二梯队 #5）回归：合并后有效配置树 + 来源标注。
 *  1) in-process：结构完整性（effective 键集 = appConfig）/ 机密脱敏 / env 源标注 / settingsFiles 探测 / 确定性；
 *  2) 子进程三场景（config 在模块加载期固化，进程内无法重演合并——每场景独立进程 + 干净 env）：
 *     P-DC-ENV（env 决定值与标注）/ P-DC-GLOBAL（全局 settings.json 白名单采纳 + 非法值与非白名单字段忽略）/
 *     P-DC-PROJECT（项目级覆盖全局，标注记最终赢家 settings.project）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 必须在 import core 之前设置 → 全动态 import（同 replay.test.ts 惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-dumpcfg-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.TAVILY_API_KEY = "sk-test-1234567890abcdef"; // 脱敏断言用（仅测试进程，不打 API）

// ★ 走 "@/" 别名导入：与 core 内部同 specifier 同实例（tsx alias/相对混用 = 双实例，见 replay.test.ts 头注释）。
const { dumpEffectiveConfig } = await import("@/config/dump.ts");
const { appConfig } = await import("@/config/index.ts");

// ============ 1) in-process：结构 / 脱敏 / env 标注 / 探测路径 ============

describe("dumpEffectiveConfig 结构与脱敏（in-process）", () => {
    it("effective 键集与 appConfig 一致；sources 全键有合法标签", () => {
        const dump = dumpEffectiveConfig();
        assert.deepEqual(Object.keys(dump.effective).sort(), Object.keys(appConfig).sort());
        const VALID = ["default", "env", "settings.global", "settings.project"];
        assert.deepEqual(Object.keys(dump.sources).sort(), Object.keys(appConfig).sort(), "sources 覆盖全部字段");
        for (const label of Object.values(dump.sources)) assert.ok(VALID.includes(label), `非法标签: ${label}`);
    });

    it("机密脱敏：tavilyApiKey 不出明文，仅指纹（前4 + MASKED + 长度）", () => {
        const dump = dumpEffectiveConfig();
        const masked = String(dump.effective.tavilyApiKey);
        assert.ok(!masked.includes("1234567890abcdef"), "不得泄露明文中后段");
        assert.match(masked, /^sk-t…/);
        assert.match(masked, /MASKED 24 chars/);
        assert.equal(dump.sources.tavilyApiKey, "env", "TAVILY_API_KEY 已设 → env 源");
    });

    it("env 源标注：dataDir 记 env；无 settings 场景 engine 字段记 default", () => {
        const dump = dumpEffectiveConfig();
        assert.equal(dump.effective.dataDir, SANDBOX);
        assert.equal(dump.sources.dataDir, "env");
        assert.equal(dump.effective.traceRetentionDays, 7);
        assert.equal(dump.sources.traceRetentionDays, "default");
    });

    it("envVars 表：字段 → 变量名映射完整（12 项 spot check）", () => {
        const dump = dumpEffectiveConfig();
        assert.equal(dump.envVars.hookRewrite, "DEEP_SEEK_HOOK_REWRITE");
        assert.equal(dump.envVars.inboxSteering, "DEEP_SEEK_INBOX");
        assert.equal(dump.envVars.dataDir, "DEEPSEEKER_CODE_DATA_DIR");
        assert.equal(Object.keys(dump.envVars).length, 12);
    });

    it("settingsFiles：全局 = dataDir/settings.json；项目 = cwd/.deepseeker-code/settings.json；存在性现查", async () => {
        const dumpBefore = dumpEffectiveConfig();
        assert.equal(dumpBefore.settingsFiles[0]!.path, path.join(SANDBOX, "settings.json"));
        assert.equal(dumpBefore.settingsFiles[0]!.exists, false, "沙盒初始无全局 settings");
        assert.ok(dumpBefore.settingsFiles[1]!.path.endsWith(path.join(".deepseeker-code", "settings.json")));
        // 现查性质：落一个文件后 exists 翻转（非加载期快照）
        await fs.writeFile(path.join(SANDBOX, "settings.json"), JSON.stringify({ engine: {} }));
        const dumpAfter = dumpEffectiveConfig();
        assert.equal(dumpAfter.settingsFiles[0]!.exists, true);
        await fs.rm(path.join(SANDBOX, "settings.json"));
    });

    it("确定性：两次调用输出逐字节一致（无时间戳/随机）", () => {
        assert.deepEqual(dumpEffectiveConfig(), dumpEffectiveConfig());
    });
});

// ============ 2) 子进程三场景（干净 env + 独立模块加载） ============

const CORE_DIR = path.resolve(import.meta.dirname, "..");
const DUMP_MODULE = path.join(CORE_DIR, "src", "config", "dump.ts");

/** 探针：PROBE_CWD 设置时先 chdir 再 import（config 在模块加载期读 process.cwd() 定项目级路径）。 */
const PROBE = `
if (process.env.PROBE_CWD) process.chdir(process.env.PROBE_CWD);
const { pathToFileURL } = await import("url");
const { dumpEffectiveConfig } = await import(pathToFileURL(process.env.DUMP_MODULE).href);
console.log("DUMP_JSON=" + JSON.stringify(dumpEffectiveConfig()));
`;

/** 构造干净子进程 env：剥离全部配置相关变量（防宿主泄漏），再叠加场景变量。 */
const cleanEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (/^(DEEP_SEEK_|DEEPSEEKER_|SEARCH_PROVIDER$|TAVILY_API_KEY$|WEB_FETCH_ALLOW_PRIVATE$|PROBE_CWD$|DUMP_MODULE$)/.test(k)) continue;
        env[k] = v;
    }
    return { ...env, ...extra };
};

/** 跑探针子进程，解析 DUMP_JSON 行（DUMP_MODULE 恒注入——探针靠它定位 dump 模块）。 */
const runProbe = (label: string, env: Record<string, string>): any => {
    const r = spawnSync("node", ["--import", "tsx", path.join(SANDBOX, "probe-dump.mts")], {
        cwd: CORE_DIR,
        env: cleanEnv({ DUMP_MODULE, ...env }),
        encoding: "utf8",
        timeout: 90000,
    });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("DUMP_JSON="));
    assert.ok(line, `${label} 探针无输出（status=${r.status}）stderr: ${(r.stderr ?? "").slice(-400)}`);
    return JSON.parse(line.slice("DUMP_JSON=".length));
};

describe("dump-config 子进程场景（env / settings.global / settings.project）", () => {
    it("P-DC-ENV：env 决定值与标注；未设变量记 default", async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-dumpcfg-env-"));
        await fs.writeFile(path.join(SANDBOX, "probe-dump.mts"), PROBE);
        const dump = runProbe("ENV", { DEEPSEEKER_CODE_DATA_DIR: dataDir, DEEP_SEEK_PARALLEL_SAFE_TOOLS: "0" });
        assert.equal(dump.effective.parallelSafeTools, false, "env=0 关闭");
        assert.equal(dump.sources.parallelSafeTools, "env");
        assert.equal(dump.effective.planEnforcement, "runtime", "未设变量走默认");
        assert.equal(dump.sources.planEnforcement, "default");
        assert.equal(dump.effective.tavilyApiKey, "", "未设 key → 空串");
        assert.equal(dump.sources.tavilyApiKey, "default");
    });

    it("P-DC-GLOBAL：白名单字段采纳并记 settings.global；非法值与非白名单字段忽略", async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-dumpcfg-glb-"));
        await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({
            engine: { traceRetentionDays: 14, undoBackupSensitive: "deny", MAX_TOOL_RESULT_CHARS: "bad", COMPACT_RATIO: 0.9 },
        }));
        const dump = runProbe("GLOBAL", { DEEPSEEKER_CODE_DATA_DIR: dataDir });
        assert.equal(dump.effective.traceRetentionDays, 14);
        assert.equal(dump.sources.traceRetentionDays, "settings.global");
        assert.equal(dump.effective.undoBackupSensitive, "deny");
        assert.equal(dump.sources.undoBackupSensitive, "settings.global");
        assert.equal(dump.effective.MAX_TOOL_RESULT_CHARS, 16000, "非法类型（字符串）忽略");
        assert.equal(dump.sources.MAX_TOOL_RESULT_CHARS, "default");
        assert.equal(dump.effective.COMPACT_RATIO, 0.72, "非白名单字段不采纳");
        assert.equal(dump.sources.COMPACT_RATIO, "default");
        assert.equal(dump.settingsFiles[0].exists, true);
    });

    it("P-DC-PROJECT：项目级覆盖全局，标注记最终赢家 settings.project", async () => {
        const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-dumpcfg-glb2-"));
        const projDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-dumpcfg-prj-"));
        await fs.writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ engine: { undoEnabled: false } }));
        await fs.mkdir(path.join(projDir, ".deepseeker-code"), { recursive: true });
        await fs.writeFile(path.join(projDir, ".deepseeker-code", "settings.json"), JSON.stringify({ engine: { undoEnabled: true } }));
        const dump = runProbe("PROJECT", { DEEPSEEKER_CODE_DATA_DIR: dataDir, PROBE_CWD: projDir });
        assert.equal(dump.effective.undoEnabled, true, "项目级 true 覆盖全局 false");
        assert.equal(dump.sources.undoEnabled, "settings.project", "标注记最终赢家");
        assert.equal(dump.settingsFiles[0].exists, true);
        assert.equal(dump.settingsFiles[1].exists, true);
        assert.ok(dump.settingsFiles[1].path.startsWith(projDir), "项目级路径跟随 chdir 后的 cwd");
    });
});
