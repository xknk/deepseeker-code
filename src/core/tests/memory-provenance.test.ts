/**
 * @file tests/memory-provenance.test.ts
 * @description P0-A 记忆安全级守门（评审修复批 2026-11-19）：
 *  ① provenance 模块语义（mark/has/reset，session 隔离、未标记会话恒 false）；
 *  ② externalContent 声明接线（processToolCall 执行层：成功才标记，失败不标记）；
 *  ③ provenanceGate 门（审批层：'confirm' 使既有 allow 规则本次失效转人工、'reject' 硬拒不发审批、
 *     无外部内容时门零作用——allow 规则照常免审）；
 *  ④ memory_save 安全级三声明（MUTATION/primaryArg/provenanceGate 分流）+ execute 层 project 源硬拒
 *     + global 源留痕 + allow-always 作用域规则零摩擦（checkPermission 命中 'allow'）。
 *  隔离（同 memory.test.ts 惯例）：DEEPSEEKER_CODE_DATA_DIR + chdir 在动态 import 前就位；
 *  权限规则用 addSessionPermissionRule（纯内存会话桶，不写盘污染项目配置）。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir；GLOBAL_MEMORY_DIR / project 源目录是模块加载期常量）——
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-memory-prov-"));
const ORIG_CWD = process.cwd();
process.env.DEEPSEEKER_CODE_DATA_DIR = path.join(TMP_ROOT, "data");
process.chdir(TMP_ROOT); // project 源 = <TMP_ROOT>/.deepseeker-code/memory，仓库 cwd 不被触碰

const { hasExternalContent, markExternalContent, resetExternalContent } = await import("@/tool/provenance.ts");
const { processToolCall } = await import("@/agent/toolExecution.ts");
const { addSessionPermissionRule, checkPermission } = await import("@/tool/permissions.ts");
const { memoryTools } = await import("@/tool/registry/memory.ts");
const { buildScopedAllowRule } = await import("@/tool/permissions.ts");
const { ToolSafetyLevel } = await import("@/tool/type.ts");
const { clearMemories } = await import("@/memory/registry.ts");

after(async () => {
    clearMemories();
    process.chdir(ORIG_CWD); // Windows 删不掉进程 cwd 所在目录（EBUSY），先切回
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// —— processToolCall 驱动（同 parallel-tool-isolation.test.ts 惯例）——
let seq = 0;
const sid = (): string => `mem-prov-${Date.now()}-${seq++}`;

const makeCtx = (rawTools: any[], over: Record<string, any> = {}): any => ({
    sessionId: sid(), cwd: TMP_ROOT, depth: 0, round: 1, startTime: performance.now(),
    llmDecisionSource: "llm", signal: undefined, rawTools, events: async () => { },
    permissionMode: undefined, planMode: false,
    onUIEvent: undefined, requestApproval: undefined, requestQuestion: undefined, ideAction: undefined,
    keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000, parentSystemPrompt: "",
    contextTokensEst: undefined, readTracker: undefined, reportCost: undefined, toolCostSink: undefined,
    onAuxUsage: undefined, planWriteRejections: undefined, budgetCheck: undefined, batchBudgetChars: undefined,
    onToolOutcome: undefined,
    ...over,
});

const tc = (id: string, name: string, args: any = {}): any =>
    ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

/** 外部内容源假工具（模拟 web_fetch：externalContent 声明 + 成功输出）。 */
const externalTool = (name: string, out = "external-page-content"): any => ({
    type: "function",
    function: {
        name, description: "fake external content source", parameters: { type: "object", properties: {} },
        safetyLevel: "safe", isSync: true, externalContent: true,
        execute: async () => out,
    },
});

describe("P0-A ① provenance 模块语义", () => {
    it("默认 false；mark 后 true；reset 后 false；未标记会话互不影响", () => {
        const a = sid(), b = sid();
        assert.equal(hasExternalContent(a), false);
        assert.equal(hasExternalContent(undefined), false, "缺 sessionId 恒 false（fail-closed 读侧）");
        markExternalContent(a);
        assert.equal(hasExternalContent(a), true);
        assert.equal(hasExternalContent(b), false, "会话隔离");
        resetExternalContent(a);
        assert.equal(hasExternalContent(a), false, "reset 清零");
    });
});

describe("P0-A ② externalContent 声明接线（执行层标记）", () => {
    it("成功执行后本会话 provenance 命中；失败不标记", async () => {
        const s = sid();
        const tools = [externalTool("prov_web", "page-text")];
        const boomTool = {
            type: "function",
            function: {
                name: "prov_boom", description: "", parameters: { type: "object", properties: {} },
                safetyLevel: "safe", isSync: true, externalContent: true,
                execute: async () => { throw new Error("boom"); },
            },
        };
        const ctx = makeCtx([tools[0], boomTool], { sessionId: s });
        await processToolCall(tc("p1", "prov_web"), ctx);
        assert.equal(hasExternalContent(s), true, "成功外部工具 → 标记");

        const s2 = sid();
        const ctx2 = makeCtx([tools[0], boomTool], { sessionId: s2 });
        const out = await processToolCall(tc("p2", "prov_boom"), ctx2);
        assert.equal(out.ok, false);
        assert.equal(hasExternalContent(s2), false, "失败不构成注入面，不标记");
    });
});

describe("P0-A ③ provenanceGate 门（审批层降权）", () => {
    /** 带 provenanceGate 的 MUTATION 假工具（形似 memory_save）。 */
    const gatedTool = (gate: any): any => ({
        type: "function",
        function: {
            name: "prov_save", description: "", parameters: { type: "object", properties: {} },
            safetyLevel: ToolSafetyLevel.MUTATION, isSync: true,
            provenanceGate: gate,
            primaryArg: "name",
            requireApproval: (args: any) => `保存 ${args?.name}`,
            execute: async () => "saved-ok",
        },
    });

    it("confirm：allow 规则在、外部内容命中 → 强制审批一次（放行后 execute 照常）", async () => {
        const s = sid();
        const rule = buildScopedAllowRule("prov_save", { name: "x" }, "name")!;
        assert.ok(addSessionPermissionRule(rule, "allow", s), "会话桶规则写入");
        assert.equal(checkPermission("prov_save", { name: "x" }, "name", s), "allow", "规则本想免审");
        markExternalContent(s);

        let approvals = 0;
        const ctx = makeCtx([gatedTool("confirm")], {
            sessionId: s,
            requestApproval: async () => { approvals++; return "allow-once"; },
        });
        const out = await processToolCall(tc("g1", "prov_save", { name: "x" }), ctx);
        assert.equal(approvals, 1, "allow 规则被 provenance 门压住，转人工一次");
        assert.equal(out.ok, true, "用户放行后 execute 照常");
        assert.equal(out.resultForModel, "saved-ok");
    });

    it("reject：硬拒不发审批、execute 不执行", async () => {
        const s = sid();
        markExternalContent(s);
        let approvals = 0;
        let executed = false;
        const tool = gatedTool("reject");
        tool.function.execute = async () => { executed = true; return "saved-ok"; };
        const ctx = makeCtx([tool], {
            sessionId: s,
            requestApproval: async () => { approvals++; return "allow-once"; },
        });
        const out = await processToolCall(tc("g2", "prov_save", { name: "x", project: true }), ctx);
        assert.equal(out.ok, false, "硬拒");
        assert.match(out.resultForModel, /provenance/);
        assert.equal(approvals, 0, "不发审批弹窗");
        assert.equal(executed, false, "execute 不执行");
    });

    it("无外部内容：门零作用，allow 规则照常免审（allow-always 日常零摩擦）", async () => {
        const s = sid();
        const rule = buildScopedAllowRule("prov_save", { name: "x" }, "name")!;
        addSessionPermissionRule(rule, "allow", s);
        assert.equal(hasExternalContent(s), false);

        let approvals = 0;
        const ctx = makeCtx([gatedTool("confirm")], {
            sessionId: s,
            requestApproval: async () => { approvals++; return "allow-once"; },
        });
        const out = await processToolCall(tc("g3", "prov_save", { name: "x" }), ctx);
        assert.equal(approvals, 0, "免审——日常 save 零摩擦");
        assert.equal(out.ok, true);
    });
});

describe("P0-A ④ memory_save 安全级与 provenance 硬拒", () => {
    const find = (n: string) => (memoryTools as any[]).find((x) => x.function.name === n)!;
    const saveTool = find("memory_save");

    it("三声明齐备：MUTATION / primaryArg=name / provenanceGate 按 project 分流", () => {
        assert.equal(saveTool.function.safetyLevel, ToolSafetyLevel.MUTATION);
        assert.equal(saveTool.function.primaryArg, "name");
        assert.equal(saveTool.function.provenanceGate({ project: true }), "reject", "project 源 = 硬拒");
        assert.equal(saveTool.function.provenanceGate({}), "confirm", "global 源 = 降权待确认");
    });

    it("requireApproval：project 源点明 git 共享；外部内容回合附 provenance 警示", () => {
        const ra = saveTool.function.requireApproval as (a: any, c?: any) => string;
        assert.match(ra({ name: "m", project: true }), /克隆者/);
        const s = sid();
        markExternalContent(s);
        try {
            assert.match(ra({ name: "m" }, { sessionId: s }), /provenance/, "global + 外部内容 → 警示");
            assert.match(ra({ name: "m", project: true }, { sessionId: s }), /provenance/);
        } finally { resetExternalContent(s); }
        assert.doesNotMatch(ra({ name: "m" }, { sessionId: sid() }), /provenance/, "无外部内容 → 无警示");
    });

    it("execute 层：project + 外部内容 → 硬拒不落盘；global + 外部内容 → 留痕写入", async () => {
        const s = sid();
        markExternalContent(s);
        const deny = await saveTool.function.execute(
            { name: "poisoned", description: "d", body: "b", project: true },
            { sessionId: s },
        );
        assert.notEqual(typeof deny, "string", "结构化失败");
        assert.equal((deny as any).status, "failed");
        assert.match((deny as any).content, /provenance 硬拒/);
        assert.equal(fs.existsSync(path.join(TMP_ROOT, ".deepseeker-code", "memory", "poisoned.md")), false, "不落盘");

        const okRet = await saveTool.function.execute(
            { name: "confirmed", description: "d", body: "b" },
            { sessionId: s },
        );
        assert.equal(typeof okRet, "string");
        assert.match(String(okRet), /已经人工确认/, "global 写入留痕");
        resetExternalContent(s);

        const clean = await saveTool.function.execute(
            { name: "plain", description: "d", body: "b", project: true },
            { sessionId: sid() },
        );
        assert.equal(typeof clean, "string", "无外部内容的 project 写入照常");
    });
});
