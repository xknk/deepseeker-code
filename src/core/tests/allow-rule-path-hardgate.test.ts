/**
 * @file tests/allow-rule-path-hardgate.test.ts
 * @description 评审修复施工单 A3（2026-11-23）守门：allow 规则路径归一化 + 文件类敏感清单无条件硬闸。
 *
 *  施工单证据五场景（真实工具、无桩，规则经 addPermissionRule 进真实内存规则集）：
 *   修前（评审实测）：no rule + edit_file('src/../.env') 已被清单拒；rule edit_file(src/*) 下
 *   edit_file('src/../.env') 审批未请求、.env 被改写；rule move_file(*) 下 move_file('.env' →
 *   'notes/env.txt') 零审批成功、随后可读出内容——allow 命中后分类器整段被跳过，内置清单失效。
 *   修后：硬闸在保护路径检查之后、checkPermission 之前无条件执行（autoApproval='file' 工具的
 *   pathArgs 逐串查 matchBuiltinDeny，原始串与归一化相对路径各查一次），命中即拒——与 allow 规则、
 *   分类器是否执行都无关。对照：rule edit_file(src/*) + edit_file('src/a.ts') 仍「未询问、执行」。
 *
 *  沙盒惯例：dataDir / WORKSPACE_ROOT 先于动态 import 设置（与 tool-declaration-drift.test.ts 同坑）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-a3-hardgate-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑）。
const { addPermissionRule, clearSessionPermissionRules } = await import("@/tool/permissions.ts");
const { processToolCall } = await import("@/agent/toolExecution.ts");
const { fsTools } = await import("@/tool/registry/fs.ts");
const { runWithWorkspaceRoot } = await import("@/tool/guard.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");

/** 假 provider：classifyRisk 恒 risky（fail-closed 确定化，分类器不打真实 API）。 */
const riskyProvider: any = {
    id: "fake", displayName: "Fake", modelLabel: "Fake",
    streamChat: async function* () { },
    classifyRisk: async () => "risky",
    buildAssistantMessage: (p: any) => ({ role: "assistant", content: p.content ?? "" }) as any,
    isContextLengthError: () => false,
    isTransientError: () => false,
    isImageUnsupportedError: () => false,
    summarize: async () => ({ choices: [{ message: { content: "Fake 摘要" } }] }),
};

const editFileTool = fsTools.find((t: any) => t.function.name === "edit_file")!;
const moveFileTool = fsTools.find((t: any) => t.function.name === "move_file")!;
assert.ok(editFileTool && moveFileTool, "edit_file / move_file 工具应存在");

// 防御性注入假 provider（五场景全走硬闸/规则确定性分支，分类器不应被触达；
// 万一触达也 fail-closed 'risky'，绝不打真实 API）。
setActiveProvider(riskyProvider);

const mkCtx = (rawTools: any[]): any => ({
    sessionId: "sess-a3-e2e", cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
    llmDecisionSource: "llm", signal: undefined, rawTools, events: async () => { },
    permissionMode: undefined, planMode: false,
    onUIEvent: undefined, requestApproval: undefined, requestQuestion: undefined, ideAction: undefined,
    keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000, parentSystemPrompt: "",
    contextTokensEst: undefined, readTracker: undefined, reportCost: undefined, toolCostSink: undefined,
    onAuxUsage: undefined, planWriteRejections: undefined, budgetCheck: undefined, batchBudgetChars: undefined,
});

const callEdit = (id: string, filePath: string) => runWithWorkspaceRoot(SANDBOX, () => processToolCall(
    { id, type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: filePath, old_str: "alpha", new_str: "beta" }) } },
    mkCtx([editFileTool]),
));
const callMove = (id: string, source: string, destination: string) => runWithWorkspaceRoot(SANDBOX, () => processToolCall(
    { id, type: "function", function: { name: "move_file", arguments: JSON.stringify({ source, destination }) } },
    mkCtx([moveFileTool]),
));

/** 场景夹具：src/a.ts（含 alpha）与 .env（含 ENV_SECRET=1）。 */
const seedWorkspace = async (): Promise<void> => {
    await fs.mkdir(path.join(SANDBOX, "src"), { recursive: true });
    await fs.writeFile(path.join(SANDBOX, "src", "a.ts"), "alpha\n", "utf-8");
    await fs.writeFile(path.join(SANDBOX, ".env"), "ENV_SECRET=1\n", "utf-8");
};

describe("A3 文件类敏感清单无条件硬闸（五场景，真实工具）", () => {
    it("夹具就位（无规则态）", async () => {
        await seedWorkspace();
    });

    it("场景1：no rule + edit_file('src/../.env') → 审批未请求、被内置清单拒绝（.env 未被改写）", async () => {
        const out = await callEdit("a3_s1", "src/../.env");
        assert.equal(out.ok, false, "被拒");
        assert.match(out.resultForModel, /清单拦截/, "内置敏感清单拒绝（硬闸或 runAutoCheck deny）");
        assert.equal(await fs.readFile(path.join(SANDBOX, ".env"), "utf-8"), "ENV_SECRET=1\n", ".env 未被改写");
    });

    it("场景4：no rule + move_file('.env' → 'notes/env.txt') → 被内置清单拒绝（未改名）", async () => {
        const out = await callMove("a3_s4", ".env", "notes/env.txt");
        assert.equal(out.ok, false, "被拒");
        assert.match(out.resultForModel, /清单拦截/, "内置敏感清单拒绝");
        await assert.rejects(fs.access(path.join(SANDBOX, "notes", "env.txt")), "目标文件不得存在");
        assert.equal(await fs.readFile(path.join(SANDBOX, ".env"), "utf-8"), "ENV_SECRET=1\n", ".env 仍在原位");
    });

    it("规则就位：edit_file(src/*) 与 move_file(*)（后者为手写对抗配置——生成侧永不产通配 move 规则）", async () => {
        assert.equal(await addPermissionRule("global", "allow", "edit_file(src/*)"), true);
        assert.equal(await addPermissionRule("global", "allow", "move_file(*)"), true);
    });

    it("场景2：rule edit_file(src/*) + edit_file('src/../.env') → 硬闸拒绝（修前：审批未请求、.env 被改写）", async () => {
        const out = await callEdit("a3_s2", "src/../.env");
        assert.equal(out.ok, false, "allow 规则命中不了越界串（归一化）+ 硬闸无条件拦");
        assert.match(out.resultForModel, /文件类敏感清单拦截/, "新硬闸文案（不可被 allow 规则绕过）");
        assert.equal(await fs.readFile(path.join(SANDBOX, ".env"), "utf-8"), "ENV_SECRET=1\n", ".env 未被改写");
    });

    it("场景3：rule edit_file(src/*) + edit_file('.env') → 被内置清单拒绝（规则本来也不命中根级 .env）", async () => {
        const out = await callEdit("a3_s3", ".env");
        assert.equal(out.ok, false, "被拒");
        assert.match(out.resultForModel, /清单拦截/, "内置敏感清单拒绝");
        assert.equal(await fs.readFile(path.join(SANDBOX, ".env"), "utf-8"), "ENV_SECRET=1\n", ".env 未被改写");
    });

    it("场景5：rule move_file(*) + move_file('.env' → 'notes/env.txt') → 硬闸拒绝（修前：零审批改名洗白成功）", async () => {
        const out = await callMove("a3_s5", ".env", "notes/env.txt");
        assert.equal(out.ok, false, "通配规则命中也拦（硬闸与 allow 规则无关）");
        assert.match(out.resultForModel, /文件类敏感清单拦截/, "新硬闸文案");
        await assert.rejects(fs.access(path.join(SANDBOX, "notes", "env.txt")), "洗白目标不得存在");
        assert.equal(await fs.readFile(path.join(SANDBOX, ".env"), "utf-8"), "ENV_SECRET=1\n", ".env 未被移走");
    });

    it("场景6（对照）：rule edit_file(src/*) + edit_file('src/a.ts') → 未询问、执行（正常工作流不误伤）", async () => {
        const out = await callEdit("a3_s6", "src/a.ts");
        assert.ok(!out.resultForModel.includes("清单拦截") && !out.resultForModel.includes("安全熔断"), "未询问直达执行");
        assert.equal(out.ok, true, "执行成功");
        assert.equal(await fs.readFile(path.join(SANDBOX, "src", "a.ts"), "utf-8"), "beta\n", "编辑已生效");
    });

    it("清理会话桶（防跨文件残留）", () => {
        clearSessionPermissionRules("sess-a3-e2e");
    });
});
