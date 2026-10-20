/**
 * @file tests/kernel-audit-firstbatch.test.ts
 * @description 内核审查报告（.ai-docs/Agent内核审查报告.md）第一批修复守门（2026-10-20）：
 *  - P0-1  firstPrompt 取「当前轮」用户输入（resolveFirstPrompt 纯函数 + PLAN_FIRST/EARLY_FINAL 语义回归）
 *  - P0-2  辅助模型用量回调贯通（summarize opts.onAuxUsage / classifyRisk 第 5 参 / runAutoCheck 透传）
 *  - P0-3  auto 档文件类二元快路径：三条件缺一不可 + LLM 分类器整体退出文件类（零调用断言）+ 命令类照旧
 *  - P1-8′ run_in_background 进子代理/挂机两条 denylist
 *  - N1    text.reset 宿主消费矩阵（core 发、CLI/webview/batch 三宿主消费）
 *
 *  约定：runAutoCheck 判定测试经 setActiveProvider 注入假 provider 并**记录 classifyRisk 调用次数**——
 *  「文件类零分类调用」是 P0-3 的行为红线（不只放行结果对，分类器退出文件类才是本裁定）。
 *  宿主文件（src/cli、src/vscode）在 core 包之外，直接 import 会踩 @/ 别名双 tsconfig 坑，
 *  消费矩阵与 CLI denylist 用源码文本扫描核对（tool-failure-consistency.test.ts 同法）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { resolveFirstPrompt } from "@/agent/runAgent.ts";
import { createNudgeScheduler } from "@/agent/agentNudges.ts";
import { runAutoCheck, type AutoApprovalDecl } from "@/tool/autoPermission.ts";
import { compactBatch } from "@/agent/truncate.ts";
import { classifyToolRisk, setActiveProvider, resetActiveProvider } from "@/llm/model.ts";
import { SUBAGENT_DENYLIST } from "@/agent/subagent.ts";
import { ToolSafetyLevel } from "@/tool/type.ts";

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(CORE_ROOT, rel), "utf-8");

/** 审查报告里的基准场景：首条复杂实现任务 + 第 2 轮寒暄（多轮对话，消息数组非空）。 */
const CONV = [
    { role: "system", content: "SYS" },
    { role: "system", content: "" }, // 摘要槽
    { role: "user", content: "请把整个认证模块重构一遍，涉及多个文件的改造与端到端流程梳理" },
    { role: "assistant", content: "好的，我先看一下现状。" },
    { role: "user", content: "谢谢，先不用" },
] as any[];

/** 假 provider：记录 classifyRisk 调用次数与第 5 参（onAuxUsage）、summarize 收到的 opts。 */
const makeCountingProvider = (verdict: "safe" | "risky" = "safe") => {
    const state = {
        classifyCalls: 0,
        lastOnAuxUsage: undefined as unknown,
        lastSummarizeOpts: undefined as any,
    };
    const provider: any = {
        id: "fake", displayName: "Fake", modelLabel: "Fake",
        streamChat: async function* () { /* 本文件只走 summarize/classifyRisk */ },
        classifyRisk: async (...a: any[]) => { state.classifyCalls++; state.lastOnAuxUsage = a[4]; return verdict; },
        buildAssistantMessage: (p: any) => ({ role: "assistant", content: p.content ?? "" }) as any,
        isContextLengthError: () => false,
        isTransientError: () => false,
        isImageUnsupportedError: () => false,
        summarize: async (_m: any, _t: any, opts: any) => { state.lastSummarizeOpts = opts; return { choices: [{ message: { content: "Fake 摘要" } }] }; },
    };
    return { provider, state };
};

/** 挂载假 provider 执行 fn，结束复位（compression-pretruncate.test.ts 同法，防泄漏影响其它测试）。 */
const withProvider = async <T>(provider: any, fn: () => Promise<T>): Promise<T> => {
    setActiveProvider(provider);
    try { return await fn(); } finally { resetActiveProvider(); }
};

// —— P0-3 decl 夹具：逐字段镜像 registry 真实声明（fs.ts / background.ts），改声明须同步此处 ——
const EDIT_DECL: AutoApprovalDecl = { autoApproval: "file", pathArgs: ["path"], primaryArg: "path", safetyLevel: ToolSafetyLevel.MUTATION, triggersUndo: "overwrite" };
const DELETE_DECL: AutoApprovalDecl = { autoApproval: "file", pathArgs: ["path"], primaryArg: "path", safetyLevel: ToolSafetyLevel.DANGER, triggersUndo: "delete" };
const MOVE_DECL: AutoApprovalDecl = { autoApproval: "file", pathArgs: ["source", "destination"], primaryArg: "src", safetyLevel: ToolSafetyLevel.MUTATION };
const CMD_DECL: AutoApprovalDecl = { autoApproval: "command", primaryArg: "command", safetyLevel: ToolSafetyLevel.DANGER };
const ctxBase = { cwd: process.cwd() } as any;

describe("内核审查报告第一批守门", () => {
    // ==================== P0-1 ====================
    describe("P0-1 firstPrompt 取当前轮（resolveFirstPrompt）", () => {
        it("回退扫描从末尾取最近一条非空 user——多轮对话取到寒暄轮而非首条复杂轮", () => {
            assert.equal(resolveFirstPrompt(CONV, {}), "谢谢，先不用");
        });
        it("显式 currentUserText 优先（宿主定型传入）", () => {
            assert.equal(resolveFirstPrompt(CONV, { currentUserText: "谢谢" }), "谢谢");
        });
        it("depth 门：subagent 恒空串（PLAN_FIRST 对子 run 是病理，不得绕过）", () => {
            assert.equal(resolveFirstPrompt(CONV, { depth: 1, currentUserText: "谢谢" }), "");
        });
        it("空文本 user（纯贴图/空输入）跳过，继续向前找", () => {
            const conv = [
                { role: "system", content: "SYS" },
                { role: "user", content: "真实任务描述" },
                { role: "user", content: "" },
            ] as any[];
            assert.equal(resolveFirstPrompt(conv, {}), "真实任务描述");
        });
        it("语义回归：寒暄轮不再误触发 PLAN_FIRST / EARLY_FINAL（旧 find-从头 bug 的病理场景）", () => {
            // firstPrompt 解析为寒暄 → looksComplex 不命中 → 首轮无 PLAN_FIRST、第 2 轮收尾不拦
            const fixed = createNudgeScheduler({ firstPrompt: resolveFirstPrompt(CONV, {}) });
            assert.equal(fixed.pickNudge(1), null, "寒暄轮首轮不得注入 PLAN_FIRST");
            assert.equal(fixed.interceptFinal("谢谢", 2), false, "寒暄轮第 2 轮收尾不得被 EARLY_FINAL 拦截");
            // 对照组：同一调度器语义下，首条确实是复杂任务 → PLAN_FIRST 照常触发（修复不砍功能）
            const complex = createNudgeScheduler({ firstPrompt: "请把整个认证模块重构一遍，涉及多个文件的改造与端到端流程梳理" });
            const nudge = complex.pickNudge(1);
            assert.ok(nudge, "复杂首条仍须触发 PLAN_FIRST");
            assert.match(String(nudge?.content ?? ""), /enter_plan_mode/);
        });
    });

    // ==================== P0-3 ====================
    describe("P0-3 auto 档文件类二元快路径", () => {
        it("三条件全中（file + MUTATION + overwrite undo）→ 确定性 allow，且分类器零调用", async () => {
            const { provider, state } = makeCountingProvider("safe");
            await withProvider(provider, async () => {
                const v = await runAutoCheck("edit_file", { path: "src/a.ts" }, ctxBase, false, EDIT_DECL);
                assert.equal(v, "allow");
                assert.equal(state.classifyCalls, 0, "文件类必须整体退出 LLM 分类器（快路径是确定性的）");
            });
        });
        it("create 类（triggersUndo='create'）同享快路径", async () => {
            const { provider, state } = makeCountingProvider("safe");
            await withProvider(provider, async () => {
                const v = await runAutoCheck("create_file", { path: "src/b.ts" }, ctxBase, false,
                    { ...EDIT_DECL, triggersUndo: "create" });
                assert.equal(v, "allow");
                assert.equal(state.classifyCalls, 0);
            });
        });
        it("delete_path（DANGER + delete undo）→ ask 转人工，且绝不回落分类器（二元分类红线）", async () => {
            const { provider, state } = makeCountingProvider("safe"); // 即便分类器会说 safe 也不许问它
            await withProvider(provider, async () => {
                const v = await runAutoCheck("delete_path", { path: "src/c.ts" }, ctxBase, false, DELETE_DECL);
                assert.equal(v, "ask");
                assert.equal(state.classifyCalls, 0, "「!triggersUndo → 分类器」式回落是被报告明令禁止的实现");
            });
        });
        it("move_file（无 undo 兜底）→ ask 转人工，分类器零调用", async () => {
            const { provider, state } = makeCountingProvider("safe");
            await withProvider(provider, async () => {
                const v = await runAutoCheck("move_file", { source: "a.txt", destination: "b.txt" }, ctxBase, false, MOVE_DECL);
                assert.equal(v, "ask");
                assert.equal(state.classifyCalls, 0);
            });
        });
        it("敏感文件 deny / 工作区外 ask，先于快路径（围栏与 deny 清单语义不变）", async () => {
            const { provider, state } = makeCountingProvider("safe");
            await withProvider(provider, async () => {
                assert.equal(await runAutoCheck("edit_file", { path: ".env" }, ctxBase, false, EDIT_DECL), "deny");
                assert.equal(await runAutoCheck("edit_file", { path: "../outside.txt" }, ctxBase, false, EDIT_DECL), "ask");
                assert.equal(state.classifyCalls, 0);
            });
        });
        it("命令类照旧走分类器：safe → allow、onAuxUsage 透传（P0-2 贯通）", async () => {
            const { provider, state } = makeCountingProvider("safe");
            await withProvider(provider, async () => {
                const aux = () => { };
                const v = await runAutoCheck("run_command", { command: "pnpm build" }, { cwd: process.cwd(), onAuxUsage: aux } as any, false, CMD_DECL);
                assert.equal(v, "allow");
                assert.equal(state.classifyCalls, 1, "命令类仍由分类器判定（P0-3 只收窄文件类）");
                assert.equal(state.lastOnAuxUsage, aux, "runAutoCheck 必须把 ctx.onAuxUsage 传给 classifyToolRisk");
            });
        });
        it("分类器 risky → ask（fail-closed 语义不变）", async () => {
            const { provider } = makeCountingProvider("risky");
            await withProvider(provider, async () => {
                assert.equal(await runAutoCheck("run_command", { command: "pnpm build" }, ctxBase, false, CMD_DECL), "ask");
            });
        });
        it("undo 兜底与审批解耦（结构不变式）：备份门只看 !denied && triggersUndo——快路径 allow 同样触发备份", () => {
            // processToolCall 集成需全工具表 + ALS workspace + undo 盘，此处钉结构：备份门在审批分支之外、
            // 只由 denied 与 triggersUndo 决定——快路径把 needApproval 关掉并不会跳过备份。
            const tex = readRepo("src/agent/toolExecution.ts");
            assert.match(tex, /if \(!denied && matchedTool\.function\.triggersUndo\) \{[\s\S]{0,200}beforeMutationBackup/);
        });
    });

    // ==================== P0-2 ====================
    describe("P0-2 辅助模型用量回调贯通", () => {
        it("compactBatch 把 onAuxUsage 传入 summarize opts（truncate → provider 链路）", async () => {
            const { provider, state } = makeCountingProvider();
            await withProvider(provider, async () => {
                const aux = () => { };
                await compactBatch([{ role: "user", content: "x" }] as any, undefined, false, aux);
                assert.equal(state.lastSummarizeOpts?.onAuxUsage, aux, "压缩批次必须携带 onAuxUsage，否则 aux 花费漏出成本账");
            });
        });
        it("classifyToolRisk 第 5 参透传 activeProvider.classifyRisk（model.ts 门面）", async () => {
            const { provider, state } = makeCountingProvider();
            await withProvider(provider, async () => {
                const aux = () => { };
                await classifyToolRisk("run_command", { command: "pnpm build" }, "", undefined, aux);
                assert.equal(state.lastOnAuxUsage, aux);
            });
        });
        it("400 降级压缩不漏账（streamInference 的 ensureFitsWindow 透传 onAuxUsage，runAgent 注入 reportAuxUsage）", () => {
            // context_length 降级路径的强制压缩同样烧辅助模型钱——集成驱动要伪造超长 400，成本高，
            // 按本文件宿主矩阵同法用结构断言钉透传链：少任何一环，该路径 aux 花费就静默漏出 run 账本。
            const si = readRepo("src/agent/streamInference.ts");
            assert.match(si, /onAuxUsage\?:\s*AuxUsageReporter/, "StreamInferenceContext 须声明 onAuxUsage 字段");
            assert.match(si, /await ensureFitsWindow\(\{[\s\S]{0,600}?onAuxUsage:\s*ctx\.onAuxUsage/, "降级路径 ensureFitsWindow 须透传 onAuxUsage");
            const ra = readRepo("src/agent/runAgent.ts");
            assert.match(ra, /yield\* streamInference\(\{[\s\S]{0,400}?onAuxUsage:\s*reportAuxUsage/, "runAgent 调 streamInference 须注入 reportAuxUsage");
        });
    });

    // ==================== P1-8′ ====================
    describe("P1-8′ run_in_background 收权", () => {
        it("SUBAGENT_DENYLIST 含 run_command / delete_path / run_in_background（直接可断言的导出）", () => {
            for (const n of ["run_command", "delete_path", "run_in_background"]) {
                assert.ok(SUBAGENT_DENYLIST.has(n), `SUBAGENT_DENYLIST 缺 ${n}`);
            }
        });
        it("BATCH_DEFAULT_DENYLIST 同步收权（CLI 宿主源码扫描，core 外文件不 import）", () => {
            const src = readRepo("../cli/src/batchRunner.ts");
            assert.match(src, /BATCH_DEFAULT_DENYLIST = new Set\(\["run_command", "delete_path", "run_in_background"\]\)/);
        });
    });

    // ==================== N1 ====================
    describe("N1 text.reset 宿主消费矩阵", () => {
        it("core 发（streamInference 两处重试点）", () => {
            const src = readRepo("src/agent/streamInference.ts");
            assert.match(src, /type: ['"]text\.reset['"]/);
        });
        it("CLI 宿主消费（useChatState 有专属 case）", () => {
            assert.match(readRepo("../cli/src/useChatState.ts"), /case ["']text\.reset["']/);
        });
        it("webview 宿主消费（events.js 有专属 case）", () => {
            assert.match(readRepo("../vscode/src/webview/events.js"), /case ["']text\.reset["']/);
        });
        it("挂机宿主消费（batchRunner 丢弃已累积 finalText）", () => {
            assert.match(readRepo("../cli/src/batchRunner.ts"), /text\.reset/);
        });
    });
});
