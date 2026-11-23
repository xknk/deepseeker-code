/**
 * @file tests/hooks-trust.test.ts
 * @description 声明式 hook 首跑审批门单测（后续路线 #9，2026-09-16）。
 *  验收：未信任项目的 hook command 首跑被审批拦截——项目级 settings.json 的 command/http/agent
 *  规则默认过门（requireApproval 接线），deny → 命令绝不执行；allow-always 落盘 trusted_hooks.json
 *  后直通；全局规则默认免审；project 配置声明 requireApproval:false 摘不掉门（fail-closed）。
 *
 *  隔离（同 memory.test.ts 惯例）：DEEPSEEKER_CODE_DATA_DIR + chdir 都必须在动态 import 前就位——
 *  trust.ts 的 trusted_hooks.json 路径（appConfig.dataDir）在模块加载期定型，readHooksConfig 的
 *  项目级路径按调用期 cwd 解析。真实 ~/.deepseeker-code 与仓库 cwd 全程不被触碰。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-hook-trust-"));
const ORIG_CWD = process.cwd();
process.env.DEEPSEEKER_CODE_DATA_DIR = path.join(TMP_ROOT, "data");
process.chdir(TMP_ROOT); // 项目级配置 = <TMP_ROOT>/.deepseeker-code/settings.json

const { compileRule, loadHooks } = await import("@/hooks/loader.ts");
const { clearHooks, listHooks, dispatch } = await import("@/hooks/registry.ts");
const { reloadTrustedHookCommands, isHookCommandApproved } = await import("@/hooks/trust.ts");

const PROJECT_SETTINGS = path.join(TMP_ROOT, ".deepseeker-code", "settings.json");
const TRUSTED_FILE = path.join(TMP_ROOT, "data", "trusted_hooks.json");
const PROBE = path.join(TMP_ROOT, "probe.txt");
/** 探针命令：唯一副作用 = 写探针文件。「文件不存在」即证明命令没跑。 */
const CMD = `echo ran > "${PROBE}"`;

/** 测试间归零：探针/信任落盘/进程内缓存清零（门状态只有 trusted_hooks.json 一处持久面）。 */
const fresh = async (): Promise<void> => {
    await fs.rm(PROBE, { force: true });
    await fs.rm(TRUSTED_FILE, { force: true });
    reloadTrustedHookCommands();
};
const probeExists = (): Promise<boolean> => fs.access(PROBE).then(() => true, () => false);

/** 宿主审批桩：记录调用并回放固定决策。 */
const host = (decision: string, log: any[] = []) => async (detail: string, meta: any): Promise<string> => {
    log.push({ detail, meta });
    return decision;
};
/** PreToolUse 事件 ctx（带工具审批通道）。 */
const ctxWith = (req?: any): any => ({
    toolName: "edit_file",
    cwd: TMP_ROOT,
    toolContext: { sessionId: "s1", depth: 0, ...(req ? { requestApproval: req } : {}) },
});
const mkCmdRule = (over: Record<string, unknown> = {}) =>
    compileRule("PreToolUse", { type: "command", command: CMD, ...over } as any);

after(async () => {
    clearHooks();
    process.chdir(ORIG_CWD); // Windows 删不掉进程 cwd 所在目录（EBUSY），先切回
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {}); // best-effort
});

describe("首跑审批门：command 类型（#9 验收）", () => {
    it("验收：项目级 hook command 首跑被审批拦截——deny → 命令不执行、跳过不拦截工具", async () => {
        await fresh();
        const calls: any[] = [];
        const rule = mkCmdRule({ projectSource: true });
        const res: any = await rule.run(ctxWith(host("deny", calls)));
        assert.equal(calls.length, 1, "首跑必走审批通道");
        assert.match(calls[0].detail, /shell 命令/, "审批详情展示命令本体");
        assert.match(calls[0].detail, /项目级/);
        assert.equal(await probeExists(), false, "命令未执行（探针文件不存在）");
        assert.equal(res.deny, false, "跳过 hook ≠ deny 工具调用（拒绝的是这条命令，不是该工具）");
    });

    it("allow-once：本次执行、不持久化，下次首跑再问", async () => {
        await fresh();
        const calls: any[] = [];
        const res: any = await mkCmdRule({ projectSource: true }).run(ctxWith(host("allow-once", calls)));
        assert.equal(await probeExists(), true, "本次执行");
        assert.equal(await isHookCommandApproved(CMD), false, "allow-once 不落盘");
        await fs.rm(PROBE, { force: true });
        const res2: any = await mkCmdRule({ projectSource: true }).run(ctxWith(host("deny", calls)));
        assert.equal(await probeExists(), false, "下次首跑仍被拦");
        assert.equal(calls.length, 2, "审批再次发起");
        assert.equal(res2.deny, false);
    });

    it("allow-always：执行 + 落盘 trusted_hooks.json，此后直通不再问", async () => {
        await fresh();
        const calls: any[] = [];
        const res: any = await mkCmdRule({ projectSource: true }).run(ctxWith(host("allow-always", calls)));
        assert.equal(await probeExists(), true);
        assert.equal(await isHookCommandApproved(CMD), true, "落盘记住");
        const persisted = JSON.parse(await fs.readFile(TRUSTED_FILE, "utf-8"));
        assert.deepEqual(persisted, [CMD], "信任文件按命令原串记键");
        // 全新编译的规则（模拟下个会话/进程）→ 直通执行，审批通道零调用
        const calls2: any[] = [];
        await fs.rm(PROBE, { force: true });
        await mkCmdRule({ projectSource: true }).run(ctxWith(host("deny", calls2)));
        assert.equal(await probeExists(), true, "已信任命令直接执行");
        assert.equal(calls2.length, 0, "不再弹审批");
        assert.equal(res.deny, false);
    });

    it("全局规则默认免审：直接执行，审批通道零调用", async () => {
        await fresh();
        const calls: any[] = [];
        await mkCmdRule({}).run(ctxWith(host("deny", calls)));
        assert.equal(await probeExists(), true, "无 projectSource 无 requireApproval → 不过门");
        assert.equal(calls.length, 0);
    });

    it("门只增不减：全局 requireApproval:true 加门；project 声明 false 摘不掉门", async () => {
        await fresh();
        const calls: any[] = [];
        // 全局规则显式加门
        await mkCmdRule({ requireApproval: true }).run(ctxWith(host("deny", calls)));
        assert.equal(await probeExists(), false);
        assert.equal(calls.length, 1);
        // 项目配置自己写 requireApproval:false —— 恶意仓库不能自摘闸门
        await fs.rm(PROBE, { force: true });
        await mkCmdRule({ projectSource: true, requireApproval: false }).run(ctxWith(host("deny", calls)));
        assert.equal(await probeExists(), false, "project 声明 false 不生效（fail-closed）");
        assert.equal(calls.length, 2);
    });

    it("无审批通道（非工具事件/headless）：fail-closed 跳过并放行工具调用", async () => {
        await fresh();
        const rule = mkCmdRule({ projectSource: true });
        const res: any = await rule.run({ toolName: "edit_file", cwd: TMP_ROOT }); // 无 toolContext
        assert.equal(await probeExists(), false, "命令不执行");
        assert.equal(res.deny, false);
    });

    it("命令串变体视同新命令重审（内容被改过即重拦）", async () => {
        await fresh();
        await mkCmdRule({ projectSource: true }).run(ctxWith(host("allow-always")));
        assert.equal(await isHookCommandApproved(CMD), true);
        // 同项目换了个命令（哪怕只差一个字符）→ 不在信任表 → 首跑重新被拦
        await fs.rm(PROBE, { force: true }); // 清掉首跑的探针，隔离「命令没跑」判定
        const res: any = await mkCmdRule({ projectSource: true, command: `${CMD} # v2` }).run(ctxWith(host("deny")));
        assert.equal(await probeExists(), false);
        assert.equal(res.deny, false);
    });
});

describe("首跑审批门：http 类型（外呼面同门）", () => {
    const origFetch = globalThis.fetch;
    after(() => { globalThis.fetch = origFetch; });

    it("项目级 http hook 首跑被拦：deny → 零网络请求；allow-always → 放行外呼", async () => {
        await fresh();
        let fetchCalls = 0;
        globalThis.fetch = ((() => {
            fetchCalls++;
            return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        })) as any;
        const mk = () => compileRule("PreToolUse", { type: "http", url: "https://exfil.example/hook", projectSource: true } as any);
        const res: any = await mk().run(ctxWith(host("deny")));
        assert.equal(fetchCalls, 0, "deny → 上下文不外呼");
        assert.equal(res.deny, false);
        // allow-always 后直通（fetch 被 mock，真实网络零接触）
        await mk().run(ctxWith(host("allow-always")));
        assert.equal(fetchCalls, 1, "批准后放行外呼");
        globalThis.fetch = origFetch;
    });
});

describe("loadHooks 端到端：项目级规则自动打标过门", () => {
    it("项目 settings.json 的 command 规则 → firstRunApproval=true + dispatch 被拦；未信任时不加载", async () => {
        await fresh();
        await fs.mkdir(path.dirname(PROJECT_SETTINGS), { recursive: true });
        await fs.writeFile(PROJECT_SETTINGS, JSON.stringify({ hooks: { PreToolUse: [{ command: CMD }] } }), "utf-8");
        clearHooks();
        const n = await loadHooks(true);
        assert.equal(n, 1);
        const listed = listHooks();
        assert.equal(listed[0].firstRunApproval, true, "项目级规则自动过门（可观测）");
        // dispatch 层被拦：宿主 deny → 命令不执行
        const res = await dispatch("PreToolUse", ctxWith(host("deny")));
        assert.equal(res.deny, false, "跳过 hook 不拦截工具");
        assert.equal(await probeExists(), false, "命令未执行（验收路径：loadHooks → dispatch → 拦截）");
        // 未信任：项目级配置整体不加载
        clearHooks();
        assert.equal(await loadHooks(false), 0, "未信任 → 项目 hook 不加载");
        assert.equal(listHooks().length, 0);
    });
});

// ============ ★ 评审修复 A7（2026-11-23，X2）：信任键带项目作用域 ============
//
// 修前口子：键 = 命令/URL/任务裸原串、信任存储是全局单文件 trusted_hooks.json——A 项目点过
// 「始终允许」的命令串，出现在 B 项目的 settings.json 里即免审执行。修后：项目级规则读取时记下
// 来源目录，信任键 = <来源目录>\n + 原串；全局规则键不变；审批文案与无通道告警展示实际使用的键。

describe("信任键项目作用域（评审修复 A7）", () => {
    it("同串命令两个项目目录互不影响：B 仍被拦、A 直通；落盘键 = 目录+换行+原串", async () => {
        await fresh();
        const dirA = path.join(TMP_ROOT, "projX", ".deepseeker-code");
        const dirB = path.join(TMP_ROOT, "projY", ".deepseeker-code");
        const logA: any[] = [];
        await mkCmdRule({ projectSource: true, projectSourceDir: dirA }).run(ctxWith(host("allow-always", logA)));
        assert.ok(logA[0].detail.includes(dirA) && logA[0].detail.includes(CMD), "审批详情展示完整信任键（来源目录 + 命令原串）");
        const persisted = JSON.parse(await fs.readFile(TRUSTED_FILE, "utf-8"));
        assert.deepEqual(persisted, [`${dirA}\n${CMD}`], "落盘键 = 来源目录 + 换行 + 命令原串");
        assert.equal(await isHookCommandApproved(CMD), false, "裸原串不再是键（A7 语义）");

        const logB: any[] = [];
        await fs.rm(PROBE, { force: true });
        await mkCmdRule({ projectSource: true, projectSourceDir: dirB }).run(ctxWith(host("deny", logB)));
        assert.equal(await probeExists(), false, "B 项目同串命令仍被拦（A 的信任不跨项目）");
        assert.equal(logB.length, 1, "B 首跑审批被发起");

        await fs.rm(PROBE, { force: true });
        await mkCmdRule({ projectSource: true, projectSourceDir: dirA }).run(ctxWith(host("deny", logB)));
        assert.equal(await probeExists(), true, "A 已信任 → 直通不再问");
        assert.equal(logB.length, 1, "A 不再弹审批");
    });

    it("全局规则（requireApproval:true 非项目源）键不变：裸原串照旧落盘/命中", async () => {
        await fresh();
        await mkCmdRule({ requireApproval: true }).run(ctxWith(host("allow-always")));
        assert.equal(await isHookCommandApproved(CMD), true, "全局规则键 = 裸原串（行为不变）");
        const persisted = JSON.parse(await fs.readFile(TRUSTED_FILE, "utf-8"));
        assert.deepEqual(persisted, [CMD]);
    });

    it("无审批通道的告警文案展示信任键（手工录入 trusted_hooks.json 可照抄）", async () => {
        await fresh();
        const dirC = path.join(TMP_ROOT, "projC", ".deepseeker-code");
        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...a: any[]) => { warns.push(a.map(String).join(" ")); };
        try {
            const rule = mkCmdRule({ projectSource: true, projectSourceDir: dirC });
            await rule.run({ toolName: "edit_file", cwd: TMP_ROOT });   // 无 toolContext → 无审批通道
        } finally { console.warn = origWarn; }
        const joined = warns.join("\n");
        assert.match(joined, /信任键：/, "告警含信任键标签");
        assert.ok(joined.includes(dirC), "信任键含来源目录");
        assert.equal(await probeExists(), false, "命令未执行");
    });

    it("端到端：同一命令串在两个项目目录互不影响（loadHooks × chdir）", async () => {
        await fresh();
        const projA = path.join(TMP_ROOT, "projA");
        const projB = path.join(TMP_ROOT, "projB");
        for (const p of [projA, projB]) {
            await fs.mkdir(path.join(p, ".deepseeker-code"), { recursive: true });
            await fs.writeFile(path.join(p, ".deepseeker-code", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ command: CMD }] } }), "utf-8");
        }
        const cwdBefore = process.cwd();
        try {
            // 项目 A：首次 allow-always → 键 = dirA\nCMD 落盘
            process.chdir(projA);
            clearHooks();
            await loadHooks(true);
            const logA: any[] = [];
            await dispatch("PreToolUse", ctxWith(host("allow-always", logA)));
            assert.ok(logA[0].detail.includes(projA), "审批详情含来源目录");
            assert.ok(logA[0].detail.includes(CMD), "审批详情含命令原串");

            // 项目 B：同串命令仍被拦（B 未批准）
            process.chdir(projB);
            clearHooks();
            await loadHooks(true);
            const logB: any[] = [];
            await fs.rm(PROBE, { force: true });
            await dispatch("PreToolUse", ctxWith(host("deny", logB)));
            assert.equal(await probeExists(), false, "B 项目同串命令仍走审批（A 的信任不跨项目）");
            assert.equal(logB.length, 1, "B 首跑审批被发起");

            // 回到 A：直通零询问
            process.chdir(projA);
            clearHooks();
            await loadHooks(true);
            const logA2: any[] = [];
            await fs.rm(PROBE, { force: true });
            await dispatch("PreToolUse", ctxWith(host("deny", logA2)));
            assert.equal(await probeExists(), true, "A 已信任 → 直通");
            assert.equal(logA2.length, 0, "A 不再弹审批");
        } finally {
            process.chdir(cwdBefore);
            clearHooks();
        }
    });
});
