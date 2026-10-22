/**
 * @file tests/kernel-audit-thirdbatch.test.ts
 * @description 内核审查报告（.ai-docs/Agent内核审查报告.md）第三批修复守门（2026-10-20）：
 *  - P1-5 收尾：轮边界消费点行为断言 + flush 基数=budgetSpentYuan（放在 kernel-audit-secondbatch.test.ts，与本文件同批）
 *  - I-3   CLI /undo 最小版：命令注册（结构）+ restoreLast 恢复链路端到端（行为）
 *  - I-5   分类器可见性：runAutoCheck 进度发射行为（safe/risky/快路径静默）+ 审批 detail 未放行说明（结构）
 *  - P2-14 三条架构不变式断言（后续补入本文件）
 *
 *  约定：静态 import 会先于模块体执行（env 未及设置即用真实 ~/.deepseeker-code）——
 *  故一律在 env 沙盒就位后动态 import（kernel-audit-secondbatch.test.ts 同法）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// —— 沙盒先于一切动态 import（config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-audit3-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(CORE_ROOT, rel), "utf-8");

// —— 被测模块（env 就位后动态加载）——
const fsp = await import("fs/promises");
const { appendUndoRecord } = await import("@/tool/undo/index.ts");
const { restoreLast, listUndoable } = await import("@/tool/undo/restore.ts");
const { getUndoBackupRoot } = await import("@/tool/undo/store.ts");
// ★ I-5 行为断言所需（kernel-audit-secondbatch.test.ts 同惯例：@/ 别名同 specifier → 同一模块实例）
const { runAutoCheck, isInterpreterRepoScript, isScriptRunnerCommand } = await import("@/tool/autoPermission.ts");
const { createReplayProvider } = await import("@/llm/providers/replay/index.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
// ★ P2-14 ①② 行为断言所需
const { runAgent } = await import("@/agent/runAgent.ts");
const { readTranscriptLines } = await import("@/session/transcript.ts");

/** 挂载回放 provider 执行 fn，结束复位（防泄漏影响其它测试）。riskVerdict 驱动 classifyRisk 裁决。 */
const withReplay = async <T>(script: any, fn: (p: any) => Promise<T>): Promise<{ handle: any; ret: T }> => {
    const p = createReplayProvider(script);
    setActiveProvider(p);
    try {
        const ret = await fn(p);
        return { handle: p, ret };
    } finally {
        resetActiveProvider();
    }
};

/** P2-14 夹具：SAFE 只读假工具（触发 EARLY_FINAL/TOOL_DIGEST 的「开过工」武装 + 让 tools 非空防假绿）。 */
const makeP14Tools = (): any[] => [
    {
        type: "function",
        function: {
            name: "fake_read_tool",
            description: "fake safe read",
            parameters: { type: "object", properties: {} },
            safetyLevel: "safe",
            isSync: true,
            execute: async () => "read-ok",
        },
    },
] as any[];

describe("内核审查报告第三批守门", () => {
    // ==================== I-3 CLI /undo ====================
    describe("I-3 CLI /undo 最小版", () => {
        it("命令注册（结构扫描）：命令表含 undo + App 分发 case + core restoreLast 引用 + 双语文案", () => {
            const s = readRepo("../cli/src/strings.ts");
            assert.match(s, /"fork", "undo", "usage"/, "LOCAL_COMMAND_NAMES 须注册 undo（fork 与 usage 之间）");
            assert.match(s, /cmdUndo: string/, "StringDict 须声明 cmdUndo");
            assert.match(s, /cmdUndo: "/, "zh/en 两处文案须存在");
            const app = readRepo("../cli/src/App.tsx");
            assert.match(app, /case "\/undo":/, "runLocalSlash 须分发 /undo");
            assert.match(app, /import \{ restoreLast \} from "@\/tool\/undo\/restore\.ts"/, "CLI 须引用 core restoreLast（与模型 undo_restore 同一恢复链路）");
            assert.match(app, /case "undo": return S\.cmdUndo/, "斜杠菜单描述须接上");
        });

        it("行为断言：restoreLast 恢复最近一次写；再次执行沿反向记录回走（撤销撤销）", async () => {
            const sid3 = `audit3-undo-${Date.now()}`;
            const target = path.join(SANDBOX, "undo-target.txt");
            await fsp.writeFile(target, "V1-ORIGINAL");
            // 备份 V1（模拟 beforeMutationBackup 落盘形态：backups/<undoId>/content）
            const undoId = `audit3-${Date.now()}-xxxx`;
            await fsp.mkdir(path.join(getUndoBackupRoot(sid3), undoId), { recursive: true });
            await fsp.writeFile(path.join(getUndoBackupRoot(sid3), undoId, "content"), "V1-ORIGINAL");
            await appendUndoRecord({
                undoId, toolsId: "t1", sessionId: sid3, operationType: "edit_file",
                relativePath: "undo-target.txt", backupKind: "file_content", backupPath: "",
                fileSizeBefore: 12, restored: false,
            } as any, sid3);
            // 模拟后续写操作改写磁盘
            await fsp.writeFile(target, "V2-MUTATED");
            // /undo → restoreLast：恢复 V1
            const msg1 = await restoreLast(sid3);
            assert.match(msg1, /undo 成功/);
            assert.equal(await fsp.readFile(target, "utf-8"), "V1-ORIGINAL", "磁盘恢复到备份前内容");
            // 再次 /undo：LIFO 弹栈命中反向记录 → 回走（撤销撤销 = 恢复 V2）
            const msg2 = await restoreLast(sid3);
            assert.match(msg2, /undo 成功/);
            assert.equal(await fsp.readFile(target, "utf-8"), "V2-MUTATED", "反向记录使 /undo 可逆");
        });

        it("行为断言：无可回退项时给专门提示（不抛错）", async () => {
            const msg = await restoreLast(`audit3-undo-empty-${Date.now()}`);
            assert.match(msg, /没有可回退/, "空栈提示（CLI pushInfo 直显）");
            assert.equal((await listUndoable(`audit3-undo-empty-${Date.now()}`)).length, 0);
        });
    });

    // ==================== I-5 分类器可见性 ====================
    describe("I-5 分类器可见性", () => {
        /** runAutoCheck 的最小 ToolContext：emitProgress 间谍收集进度文案。 */
        const makeCtx = (progress: string[]): any => ({
            sessionId: `audit3-i5-${Date.now()}`,
            cwd: SANDBOX,
            emitProgress: (t: string) => { progress.push(t); },
        });
        /** 命令类 decl（echo 不在 deny 清单 → 必达分类器分支）。 */
        const cmdDecl = { autoApproval: "command" as const, primaryArg: "command" };

        it("行为断言：分类器判 safe → 放行 + 前后两条进度（判定中/放行）", async () => {
            await withReplay({ turns: [], riskVerdict: "safe" }, async () => {
                const progress: string[] = [];
                const v = await runAutoCheck("run_command", { command: "echo hello" }, makeCtx(progress), false, cmdDecl);
                assert.equal(v, "allow");
                assert.ok(progress.some(t => t.includes("安全判定中")), "调用前须发「安全判定中…」进度");
                assert.ok(progress.some(t => t.includes("放行")), "完成后须回报放行结论");
            });
        });

        it("行为断言：分类器判 risky → ask（转人工）+ 进度回报未放行", async () => {
            await withReplay({ turns: [], riskVerdict: "risky" }, async () => {
                const progress: string[] = [];
                const v = await runAutoCheck("run_command", { command: "echo hello" }, makeCtx(progress), false, cmdDecl);
                assert.equal(v, "ask");
                assert.ok(progress.some(t => t.includes("安全判定中")));
                assert.ok(progress.some(t => t.includes("未放行")), "完成后须回报未放行结论");
            });
        });

        it("行为断言：文件类快路径零进度打扰（确定性放行不发「判定中」）", async () => {
            const progress: string[] = [];
            const v = await runAutoCheck("edit_file", { path: path.join(SANDBOX, "a.txt") }, makeCtx(progress), false,
                { autoApproval: "file", safetyLevel: "mutation" as any, triggersUndo: "overwrite" as any });
            assert.equal(v, "allow");
            assert.equal(progress.length, 0, "确定性快路径不刷进度（I-5 刻意只在分类器作用域发）");
        });

        it("结构扫描：autoPermission 只在分类器分支发进度；toolExecution 审批 detail 补未放行说明", () => {
            const ap = readRepo("src/tool/autoPermission.ts");
            assert.match(ap, /emitProgress\?\.\('🔒 安全判定中/, "分类器调用前须发进度");
            assert.match(ap, /emitProgress\?\.\(v === 'safe'/, "分类器返回后须回报结论");
            const te = readRepo("src/agent/toolExecution.ts");
            assert.match(te, /let autoGateAsked = false/, "autoGateAsked 旗标须声明");
            assert.match(te, /autoGateAsked = true/, "runAutoCheck 返回 'ask' 时须置位");
            assert.match(te, /if \(autoGateAsked\) detail \+=/, "审批 detail 须追加未放行说明（fail-closed 来由）");
        });
    });

    // ==================== Q12 结算单子 run 花费 ====================
    describe("Q12 run.receipt 并列展示子 run 花费", () => {
        it("结构扫描：core 发字段 + CLI/VSCode 双端渲染消费", () => {
            // 打磨计划 B 批（2026-10-22）等价改写：子账入账与 receipt 发字段移入 runLedger.ts，扫描目标随迁（正则与意图不变）
            const rl = readRepo("src/agent/runLedger.ts");
            assert.match(rl, /subCostYuanAcc \+= yuan/, "reportCost 回灌须同时记展示账（与预算圈并账、与落盘 costYuanAcc 分账）");
            assert.match(rl, /subCostYuan: subCostYuanAcc > 0/, "receipt 事件须带 subCostYuan（>0 才发，undefined 自动省略）");
            const cli = readRepo("../cli/src/useChatState.ts");
            assert.match(cli, /subCostYuan/, "CLI 渲染须消费 subCostYuan");
            assert.match(cli, /子任务 ¥/, "CLI 结算行须有子任务段");
            const ev = readRepo("../vscode/src/webview/events.js");
            assert.match(ev, /evt\.subCostYuan/, "VSCode 渲染须消费 subCostYuan");
            const st = readRepo("../vscode/src/webview/strings.js");
            assert.match(st, /evReceiptSub/, "VSCode 文案须有子任务段（zh/en 两处）");
        });
    });

    // ==================== N5 解释器×仓库脚本 供应链闸门 ====================
    describe("N5 解释器直跑仓库内脚本（仅 batch 场景纳入）", () => {
        it("行为断言：解释器+仓库内脚本路径命中；查询/外部程序/包管理器形态不误伤", () => {
            // 正样本：报告点名的绕过形态（node ./script.js / python x.py / 裸 tsc / make / cargo / go）
            for (const cmd of [
                "node ./scripts/build.js", "node server.js", "python x.py", "python3 tools/gen.py",
                "py x.py", "tsx src/main.ts", "ts-node ./a.ts", "ruby task.rb",
                "/usr/bin/python x.py", "node.exe x.js", // 路径前缀/Windows 扩展名容忍
                "tsc", "make", "make build", "cargo build", "go test ./...", // 裸跑即执行仓库定义
            ]) {
                assert.equal(isInterpreterRepoScript(cmd), true, `应命中: ${cmd}`);
            }
            // 负样本：查询 flag、内联代码、外部程序绝对路径、包管理器族（另一闸门）、普通只读
            for (const cmd of [
                "node --version", "node -v", "python -c \"print(1)\"",
                "node /usr/local/bin/x.js", "node D:\\\\tools\\\\x.js", // 绝对路径=外部程序，不属「仓库内」面
                "npm test", "pnpm build", "npx vitest", // 包管理器族归 isScriptRunnerCommand
                "ls -la", "git status", "echo done",
            ]) {
                assert.equal(isInterpreterRepoScript(cmd), false, `不应命中: ${cmd}`);
            }
            // 两闸门互不重叠：npm 族归 scriptRunner，解释器组归本判定
            assert.equal(isScriptRunnerCommand("node ./x.js"), false);
            assert.equal(isScriptRunnerCommand("npm test"), true);
        });

        it("结构扫描：batchRunner execute 包装闸门 + interpreter 逃生门 + 刻意不进交互判定链", () => {
            const br = readRepo("../cli/src/batchRunner.ts");
            assert.match(br, /wrapInterpreterGate/, "须有 execute 包装闸门");
            assert.match(br, /isInterpreterRepoScript/, "须引用判定函数");
            assert.match(br, /unlocked\.has\("interpreter"\)/, "逃生门=工单 tools: 伪槽位 interpreter");
            assert.match(br, /toolSchemas: gatedSchemas/, "包装后的表须真正注入 handleUnifiedChat");
            const te = readRepo("src/agent/toolExecution.ts");
            assert.doesNotMatch(te, /isInterpreterRepoScript/, "交互判定链零打扰（刻意不 import）");
        });
    });

    // ==================== P2-14 架构不变式断言 ====================
    describe("P2-14 架构不变式（③宿主消费矩阵已随第一批落地，此处补①②）", () => {
        it("① 计划模式两态工具表恒定（不裁表，保前缀缓存）：planMode true/false 两次 run 的 tools 逐字节一致", async () => {
            const tools = makeP14Tools();
            const runOnce = async (planMode: boolean, tag: string) => {
                const { handle, ret } = await withReplay({ turns: [{ kind: "reply" as const, content: `done ${tag}` }] }, async (p) => {
                    const message: any[] = [
                        { role: "system", content: "p14 tools 恒定断言" },
                        { role: "user", content: "读一下" },
                    ];
                    for await (const _ of runAgent(message, {
                        sessionId: `audit3-p14-${tag}-${Date.now()}`, cwd: SANDBOX, events: (async () => { }) as any,
                        toolSchemas: tools, modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
                        parentSystemPrompt: "", depth: 0, planMode,
                    })) { /* 收割即可 */ }
                    return p.calls;
                });
                return { handle, ret };
            };
            const a = await runOnce(true, "plan");
            const b = await runOnce(false, "normal");
            assert.ok(a.ret[0]?.tools?.length > 0, "tools 非空（防两侧同空假绿）");
            assert.equal(JSON.stringify(a.ret[0].tools), JSON.stringify(b.ret[0].tools),
                "planMode 两态 tools 须逐字节一致（P0-A 执行层门禁，永不裁表）");
        });

        it("② nudge 不进 message/transcript/压缩：推理时 ephemeral 尾部副本可达模型，落盘零痕迹", async () => {
            const sid14 = `audit3-p14-nudge-${Date.now()}`;
            const { handle, ret } = await withReplay({
                turns: [
                    // 轮 1：开工具（武装 TOOL_DIGEST/EARLY_FINAL 守护）
                    { kind: "reply" as const, content: null, toolCalls: [{ name: "fake_read_tool", args: {} }] },
                    // 轮 2：刚用完工具就短收尾（<30 字符、无完成声明）→ ⟦DSC:TOOL_DIGEST⟧ 拦截注入 nudge
                    { kind: "reply" as const, content: "好了。" },
                    // 轮 3：正常收尾（含完成声明）→ 放行
                    { kind: "reply" as const, content: "任务已完成：目标文件已修改并通过验证，交付内容如上。" },
                ],
            }, async (p) => {
                const message: any[] = [
                    { role: "system", content: "p14 nudge 断言" },
                    { role: "user", content: "做个小任务" },
                ];
                for await (const _ of runAgent(message, {
                    sessionId: sid14, cwd: SANDBOX, events: (async () => { }) as any,
                    toolSchemas: makeP14Tools(), modelWindow: 250000, keepRecentUnits: 5, compactRatio: 0.72,
                    parentSystemPrompt: "", depth: 0,
                })) { /* 收割即可 */ }
                return { calls: p.calls, lines: await readTranscriptLines(sid14) };
            });
            assert.equal(handle.calls.length, 3, "轮 2 被拦截续跑 → 恰 3 次推理");
            // nudge 可达模型：第 3 次推理入参尾部存在 ephemeral system 副本（⟦DSC:…⟧ 栅栏标记）
            const tail = (ret.calls[2]?.messages ?? [])as any[];
            const nudge = tail.filter((m) => m.role === "system" && String(m.content ?? "").includes("⟦DSC:"));
            assert.ok(nudge.length > 0, "续跑轮的推理入参须含 nudge 尾部副本（否则拦截等于没注入）");
            // 不进 transcript：落盘行零 nudge 痕迹（⇒ 以 transcript/message 为输入的压缩同样不可能含——
            // 压缩消费的是真实 message 数组与本落盘视图，nudge 从未进入任一者，此为机制传递而非另有通道）
            const leaked = (ret.lines as any[]).filter((l) => JSON.stringify(l).includes("⟦DSC:"));
            assert.equal(leaked.length, 0, "transcript 落盘不得含 nudge 文案（ephemeral 硬约束）");
        });
    });
});
