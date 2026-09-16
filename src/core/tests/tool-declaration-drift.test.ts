/**
 * @file tests/tool-declaration-drift.test.ts
 * @description 工具策略声明化防漂移断言（后续路线 #8a，2026-09-16）。
 *  契约：**新增一个工具只声明、不动任何名单**，undo 备份 / 权限作用域 / 分类器作用域 / 计划门禁即全部生效。
 *  五处按名硬编码中心名单（MUTATION_TOOLS / AUTO_SCOPE 系列 / PRIMARY_ARG / PLAN_ALLOWED_TOOLS /
 *  move_file 特判）已物理删除——本测试用假想写工具 fake_write_tool 证明「只声明」路径端到端成立，
 *  且未声明的工具 fail-closed（多审一次），不再静默降级。
 *
 *  沙盒惯例：dataDir / WORKSPACE_ROOT 先于动态 import 设置（appConfig 与 guard 的 WORKSPACE_ROOT
 *  在模块加载期固化，ESM 静态 import 会先于赋值求值——同 replay.test.ts 的坑）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-decl-drift-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑）。
const { beforeMutationBackup } = await import("@/tool/undo/backup.ts");
const { checkPermission, buildScopedAllowRule, addPermissionRule } = await import("@/tool/permissions.ts");
const { runAutoCheck } = await import("@/tool/autoPermission.ts");
const { processToolCall } = await import("@/agent/toolExecution.ts");
const { ToolSafetyLevel } = await import("@/tool/index.ts");
const { runWithWorkspaceRoot } = await import("@/tool/guard.ts");

/** 假想写工具：只声明，不碰任何名单（名单已物理删除，想碰也没有）。 */
const fakeWriteTool: any = {
    type: "function",
    function: {
        name: "fake_write_tool",
        description: "测试用假想写工具（不实际执行）",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        execute: async () => "ok",
        isSync: true,
        safetyLevel: ToolSafetyLevel.MUTATION,
        // ★ 全部策略靠声明携带：
        triggersUndo: 'overwrite',      // → undo 写前备份 + 保护路径检查 + 串行调度屏障
        primaryArg: 'path',             // → 权限规则作用域主参数
        autoApproval: 'file',           // → 分类器 file 类作用域（围栏 + 敏感文件 deny）
        planAllowed: false,             // → 计划期拒绝（显式 false，与缺省同义）
    },
};

describe("工具策略声明化防漂移（#8a：新增工具只声明不动名单，五处消费点全生效）", () => {
    it("① undo：声明 triggersUndo='overwrite' 即获得写前备份（原 MUTATION_TOOLS 名单退役）", async () => {
        await fs.writeFile(path.join(SANDBOX, "note.md"), "原内容", "utf-8");
        // 覆盖场景：原文件存在 → file_content 全文快照
        const rec = await runWithWorkspaceRoot(SANDBOX, () =>
            beforeMutationBackup('overwrite', 'fake_write_tool', { path: 'note.md' }, 'call_drv_1', 'sess_drv'));
        assert.ok(rec, "应产出备份记录（名单外工具不再被 MUTATION_TOOLS 拒之门外）");
        assert.equal(rec!.operationType, 'fake_write_tool');
        assert.equal(rec!.backupKind, 'file_content', "原文件存在 → 全文快照");
        assert.equal(rec!.relativePath, 'note.md');
        // 新建场景：原文件不存在 → creation_marker（overwrite 策略自动识别）
        const rec2 = await runWithWorkspaceRoot(SANDBOX, () =>
            beforeMutationBackup('overwrite', 'fake_write_tool', { path: 'brand_new.md' }, 'call_drv_2', 'sess_drv'));
        assert.ok(rec2);
        assert.equal(rec2!.backupKind, 'creation_marker', "原文件不存在 → creation_marker（回退=删除新建文件）");
    });

    it("②③ 权限：声明 primaryArg='path' 即获得作用域匹配与 allow-always 持久化（原 PRIMARY_ARG 名单退役）", async () => {
        // allow-always 落盘路径：buildScopedAllowRule 按声明主参数构造作用域
        const rule = buildScopedAllowRule('fake_write_tool', { path: 'src/a.ts' }, 'path');
        assert.equal(rule, 'fake_write_tool(src/*)', "路径类主参数 → 顶层目录作用域");
        // 规则匹配：checkPermission 读声明主参数做 glob 匹配（经 addPermissionRule 真实入内存规则集）
        const persisted = await addPermissionRule('global', 'allow', 'fake_write_tool(src/*)');
        assert.equal(persisted, true, "规则应成功编译入内存");
        assert.equal(checkPermission('fake_write_tool', { path: 'src/deep/b.md' }, 'path'), 'allow',
            "带作用域规则按声明主参数命中 src/* 深层路径");
        // 未传 primaryArg（调用方漏传声明）→ 规则匹配退化为裸名比较（现状语义，见 plan「缺省 = 规则退化为
        // 裸名匹配」）：作用域规则 fake_write_tool(src/*) 命中该工具的全部调用，即「漏声明变宽」风险面——
        // 这正是声明必须显式携带、注册表声明缺失会在 review 中显眼的原因。
        assert.equal(checkPermission('fake_write_tool', { path: 'src/deep/b.md' }), 'allow',
            "未传声明 → 作用域规则退化为裸名匹配（文档化的「漏声明变宽」语义，非 fail-closed）");
    });

    it("④ 分类器：声明 autoApproval='file' 即进入 file 类作用域（原 AUTO_SCOPE 名单退役）", async () => {
        const ctx = { cwd: SANDBOX, abortSignal: undefined } as any;
        const fileDecl = { autoApproval: 'file' as const, primaryArg: 'path' };
        // 敏感文件 deny 是确定性分支（不触达辅助模型分类器）：能到 deny = 已过 inScope 关 + 围栏按声明取参
        assert.equal(await runAutoCheck('fake_write_tool', { path: '.env' }, ctx, false, fileDecl), 'deny',
            "进 file 作用域 + 敏感文件清单硬拒（若范围外则应是 ask，故 deny 证明声明生效）");
        // 工作区外 → 围栏 ask（确定性）
        assert.equal(await runAutoCheck('fake_write_tool', { path: '../outside.txt' }, ctx, false, fileDecl), 'ask',
            "工作区外路径 → 围栏转人工");
        // 未声明 autoApproval → 恒 ask（fail-closed：漏声明不再静默获得分类器作用域）
        assert.equal(await runAutoCheck('fake_write_tool', { path: '.env' }, ctx, false, {}), 'ask',
            "漏声明 → 恒转人工审批（原名单机制的静默放行/漏接在此变为显式 ask）");
    });

    it("⑤ 计划门禁：未声明 planAllowed（false/缺省）→ 计划期执行层拒绝（原 PLAN_ALLOWED_TOOLS 名单退役）", async () => {
        const events = (() => { }) as any;
        const baseCtx = {
            sessionId: 'sess_drv', cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
            llmDecisionSource: 'tool' as any, rawTools: [fakeWriteTool], events,
            keepRecentUnits: 6, compactRatio: 0.7, modelWindow: 128000, parentSystemPrompt: '',
            planMode: true, // runtime 档（默认）执行层门禁
        };
        const outcome = await processToolCall(
            { id: 'call_drv_3', type: 'function', function: { name: 'fake_write_tool', arguments: '{"path":"note.md"}' } },
            baseCtx as any);
        assert.equal(outcome.ok, false, "计划期写工具应被拒");
        assert.match(outcome.resultForModel, /计划模式/, "拒绝文案引导模型转只读/提交方案");
        // 对照：声明 planAllowed:true 的只读工具在计划期放行进入执行
        const readOnlyTool = {
            ...fakeWriteTool,
            function: { ...fakeWriteTool.function, name: 'fake_read_tool', safetyLevel: ToolSafetyLevel.SAFE, planAllowed: true, triggersUndo: undefined, autoApproval: undefined, execute: async () => 'read ok' },
        };
        const outcome2 = await processToolCall(
            { id: 'call_drv_4', type: 'function', function: { name: 'fake_read_tool', arguments: '{"path":"note.md"}' } },
            { ...baseCtx, rawTools: [readOnlyTool] } as any);
        assert.equal(outcome2.ok, true, "声明 planAllowed:true 的工具计划期可用");
        assert.equal(outcome2.resultForModel, 'read ok');
    });
});
