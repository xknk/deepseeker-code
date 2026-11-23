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

    it("⑤ 计划门禁（评审修复 A5 新默认）：SAFE 缺省放行、显式 false 与非 SAFE 拒绝（原「未声明即拒绝」旧默认退役）", async () => {
        const events = (() => { }) as any;
        const mkPlanCtx = (rawTools: any[]) => ({
            sessionId: 'sess_drv', cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
            llmDecisionSource: 'tool' as any, rawTools, events,
            keepRecentUnits: 6, compactRatio: 0.7, modelWindow: 128000, parentSystemPrompt: '',
            planMode: true, // runtime 档（默认）执行层门禁
        });
        const call = (id: string, rawTools: any[], name: string, args: any = { path: 'note.md' }) => processToolCall(
            { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            mkPlanCtx(rawTools) as any);
        // 1) 非 SAFE（MUTATION）未声明 → 拒（写工具不进计划期，语义不变）
        const outcome = await call('call_drv_3', [fakeWriteTool], 'fake_write_tool');
        assert.equal(outcome.ok, false, "计划期写工具应被拒");
        assert.match(outcome.resultForModel, /计划模式/, "拒绝文案引导模型转只读/提交方案");
        // 2) SAFE 未声明 → 放行（★ 新默认：只读调研是计划期的本职，V9——旧默认把 18 个 SAFE 工具全拒）
        const safeNoDecl = {
            ...fakeWriteTool,
            function: { ...fakeWriteTool.function, name: 'fake_safe_tool', safetyLevel: ToolSafetyLevel.SAFE, planAllowed: undefined, triggersUndo: undefined, autoApproval: undefined, execute: async () => 'safe ok' },
        };
        const outcomeSafe = await call('call_drv_4a', [safeNoDecl], 'fake_safe_tool');
        assert.equal(outcomeSafe.ok, true, "SAFE 未声明计划期放行（新默认）");
        assert.equal(outcomeSafe.resultForModel, 'safe ok');
        // 3) SAFE + planAllowed:false → 显式排除，拒
        const safeBlocked = {
            ...safeNoDecl,
            function: { ...safeNoDecl.function, name: 'fake_safe_blocked', planAllowed: false },
        };
        const outcomeBlocked = await call('call_drv_4b', [safeBlocked], 'fake_safe_blocked');
        assert.equal(outcomeBlocked.ok, false, "SAFE + 显式 false → 拒");
        assert.match(outcomeBlocked.resultForModel, /计划模式/);
        // 4) 非 SAFE + planAllowed:true → 显式豁免放行
        const writeAllowed = {
            ...fakeWriteTool,
            function: { ...fakeWriteTool.function, name: 'fake_write_allowed', planAllowed: true },
        };
        const outcomeAllowed = await call('call_drv_4c', [writeAllowed], 'fake_write_allowed');
        assert.equal(outcomeAllowed.ok, true, "非 SAFE + planAllowed:true 显式豁免放行");
    });

    it("⑤b 显式排除面精确钉零：planAllowed:false 的集合恰为四工具（新增有副作用的 SAFE 工具须显式登记）", async () => {
        const { agentTools } = await import("@/tool/index.ts");
        const { skillTools } = await import("@/tool/registry/skill.ts");
        const all = [...(agentTools as any[]), ...(skillTools as any[])];
        assert.ok(all.length > 20, "工具表防空转假绿");
        const excluded = all
            .filter(t => (t?.function as any)?.planAllowed === false)
            .map(t => t.function.name)
            .sort();
        assert.deepEqual(excluded,
            ["run_workflow", "spawn_agent", "stop_background_task", "wait_http_ready"],
            "显式排除面恰为四工具（花钱的子代理两件套 + 杀进程 + 联网等待）；新 SAFE 带副作用工具出现时须显式登记 false");
    });

    it("⑤c V9 十八样本端到端（planMode:true + execute 桩）：14 个 SAFE 执行、4 个显式排除被拒、非 SAFE 照旧被拒", async () => {
        const { agentTools } = await import("@/tool/index.ts");
        const { skillTools } = await import("@/tool/registry/skill.ts");
        const ALL = [...(agentTools as any[]), ...(skillTools as any[])];
        const EIGHTEEN = [
            "recall", "load_skill", "memory_read", "memory_list", "read_xlsx", "read_docx", "read_pdf",
            "get_background_output", "find_references", "inspect_dependencies", "undo_list", "worktree_status",
            "todo_write", "ask_question", "spawn_agent", "run_workflow", "stop_background_task", "wait_http_ready",
        ];
        const findTool = (name: string): any => {
            const t = ALL.find(t => t?.function?.name === name);
            assert.ok(t, `工具 ${name} 应在注册表中`);
            assert.equal(t.function.safetyLevel, ToolSafetyLevel.SAFE, `V9 前提：${name} 应为 SAFE`);
            return t;
        };
        const PLAN_ALLOWED_FALSE = new Set(["spawn_agent", "run_workflow", "stop_background_task", "wait_http_ready"]);
        // ★ 执行样本须过 #8c 运行时参数校验（计划门禁先于校验，故被拒的 4 个无需合法参数）：
        //   按各工具 schema 的 required 集合给最小合法参数。
        const ARGS: Record<string, any> = {
            recall: { query: "q" },
            load_skill: { name: "x" },
            memory_read: { name: "x" },
            memory_list: {},
            read_xlsx: { path: "a.xlsx" },
            read_docx: { path: "a.docx" },
            read_pdf: { path: "a.pdf" },
            get_background_output: { task_id: "t" },
            find_references: { path: "a.ts", line: 1, column: 1 },
            inspect_dependencies: {},
            undo_list: {},
            worktree_status: {},
            todo_write: { todos: [{ content: "c", status: "pending" }] },
            ask_question: { question: "q", options: [{ label: "a" }, { label: "b" }] },
        };
        const rawTools = EIGHTEEN.map(name => ({
            ...findTool(name),
            function: { ...(findTool(name).function as any), execute: async () => 'plan-ok' },   // execute 全换桩
        }));
        const mkCtx18 = () => ({
            sessionId: 'sess_drv_plan18', cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
            llmDecisionSource: 'tool' as any, rawTools, events: (() => { }) as any,
            keepRecentUnits: 6, compactRatio: 0.7, modelWindow: 128000, parentSystemPrompt: '',
            planMode: true,
        });
        let executed = 0;
        let rejected = 0;
        for (const name of EIGHTEEN) {
            const outcome = await processToolCall(
                { id: `call_plan18_${name}`, type: 'function', function: { name, arguments: JSON.stringify(ARGS[name] ?? {}) } },
                mkCtx18() as any);
            if (PLAN_ALLOWED_FALSE.has(name)) {
                assert.equal(outcome.ok, false, `${name} 显式排除 → 计划期拒绝`);
                assert.match(outcome.resultForModel, /计划模式/);
                rejected++;
            } else {
                assert.equal(outcome.ok, true, `${name}（SAFE 未声明 false）计划期放行执行`);
                assert.equal(outcome.resultForModel, 'plan-ok');
                executed++;
            }
        }
        assert.equal(executed, 14, "18 个 SAFE 样本中 14 个执行");
        assert.equal(rejected, 4, "4 个显式排除被拒");
        // 非 SAFE 照旧被拒（execute 桩不应触达）
        const writeStub = { ...fakeWriteTool, function: { ...fakeWriteTool.function, execute: async () => 'plan-ok' } };
        const outcomeWrite = await processToolCall(
            { id: 'call_plan18_write', type: 'function', function: { name: 'fake_write_tool', arguments: '{"path":"note.md"}' } },
            { ...mkCtx18(), rawTools: [writeStub] } as any);
        assert.equal(outcomeWrite.ok, false, "非 SAFE 工具计划期照旧被拒");
        assert.notEqual(outcomeWrite.resultForModel, 'plan-ok', "execute 未触达");
    });

            it("⑥ 全表防漂移：凡声明 primaryArg / pathArgs，必须真实存在于 parameters.properties（第 17 项补丁）", async () => {
                // 背景：allow-always 作用域、分类器围栏、保护路径检查都按【声明】取 args[主参数]。
                // 声明名与实际参数表不一致时取值为 undefined——buildScopedAllowRule 返回 null →「总是允许」静默降级
                // allow-once（安全侧 fail-closed，但功能打折）；pathArgs 漂移则让围栏取不到参而空跑。
                // 历史实例：list_dir 声明 primaryArg:'path'（参数表只有 max_depth）、move_file 声明 primaryArg:'src'
                //（实际 source/destination）——两者均由本断言钉零。
                const { agentTools } = await import("@/tool/index.ts");
                // ★ 防空转假绿：聚合数组为空/导入失败时上面的循环一次不跑，drifts 恒空 → 断言恒过。
                assert.ok((agentTools as any[]).length > 20, `agentTools 应已聚合全量工具（实际 ${(agentTools as any[]).length}）`);
                // ★ 反向锚点：至少一个工具真在声明 primaryArg（同防假绿——全仓都漏声明时本断言也该叫）
                assert.ok((agentTools as any[]).some((t) => t?.function?.primaryArg), "注册表应有工具声明 primaryArg");
                const drifts: string[] = [];
                for (const t of agentTools as any[]) {
                    const f = t?.function;
                    if (!f) continue;
                    const props: Record<string, unknown> = f.parameters?.properties ?? {};
                    const declared: Array<[string, string]> = [];
                    if (f.primaryArg) declared.push(["primaryArg", f.primaryArg]);
                    for (const p of (f.pathArgs ?? []) as string[]) declared.push(["pathArgs", p]);
                    for (const [kind, key] of declared) {
                        if (!(key in props)) {
                            drifts.push(`${f.name}: ${kind}='${key}' 不在 parameters.properties [${Object.keys(props).join(", ")}]`);
                        }
                    }
                }
                assert.deepEqual(drifts, [],
                    `声明与实际参数表漂移（会导致 allow-always 取值为 undefined 而永不生效）：\n${drifts.join("\n")}`);

                    // ★ 第 17 项补丁的两处历史漂移，逐一钉死（防回潮）：
                    const moveFile = (agentTools as any[]).find((t) => t?.function?.name === "move_file");
                    assert.equal(moveFile?.function?.primaryArg, "source",
                    "move_file 主参数必须为 source（原写 src 使 args['src'] 恒 undefined → 「总是允许」永不生效）");
                    const listDir = (agentTools as any[]).find((t) => t?.function?.name === "list_dir");
                    assert.equal(listDir?.function?.primaryArg, undefined,
                    "list_dir 不得声明 primaryArg（2026-10-21 漂移钉零；2026-11-10 path 已成为真实参数，但 SAFE 只读工具仍不需 allow-always）");
            });

            it("⑦ 敏感清单硬闸：声明 autoApproval='file' 即获得无条件硬闸——allow 规则命中也拦（评审修复 A3，2026-11-23）", async () => {
                await fs.writeFile(path.join(SANDBOX, ".env"), "ENV_SECRET=1", "utf-8");
                // allow-always 真实入内存规则集（对标 Claude Code「总是允许」的持久化路径）
                assert.equal(await addPermissionRule('global', 'allow', 'fake_write_tool(*)'), true, "通配 allow 规则已加载");
                // 硬闸在 checkPermission 之前：规则命中与否、分类器是否运行都无关——autoApproval='file'
                // 声明本身即触发 pathArgs（缺省 ['path']）逐串查内置清单。
                const outcome = await processToolCall(
                    { id: 'call_drv_5', type: 'function', function: { name: 'fake_write_tool', arguments: '{"path":".env"}' } },
                    { sessionId: 'sess_drv', cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(), llmDecisionSource: 'tool' as any, rawTools: [fakeWriteTool], events: (() => { }) as any, keepRecentUnits: 6, compactRatio: 0.7, modelWindow: 128000, parentSystemPrompt: '', planMode: false } as any);
                assert.equal(outcome.ok, false, "通配 allow 规则命中也拦（修前：审批未请求直接改写成功）");
                assert.match(outcome.resultForModel, /清单拦截/, "文件类敏感清单硬闸文案");
            });
        });
