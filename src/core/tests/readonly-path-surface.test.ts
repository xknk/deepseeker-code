/**
 * @file tests/readonly-path-surface.test.ts
 * @description 评审修复施工单 A1（2026-11-23，S1）守门：默认模式只读免审增加【路径面】判定。
 *
 *  修前口子（向量全部实测复现）：isReadOnlyCommand 只看命令头/写选项/命令串敏感文件名——
 *  不把敏感文件名写出来即可免审读工作区外任何文件（cat ~/.aws/credentials、grep -r "" ~/.aws 等 13 条）。
 *  修后契约：
 *   - 段内路径 token（~ / $HOME / %USERPROFILE% / 绝对路径 / 含分隔符）展开解析后：
 *     出工作区（白名单 READONLY_OUTSIDE_ALLOWLIST 除外）或命中 sensitivePaths 统一清单 → 不免审；
 *   - 统一清单单一出处（sensitivePaths.ts）：fs.ts 读硬拒与命令通道共用，补齐 .envrc / .git-credentials /
 *     .pgpass / .docker/config.json / .kube / .config(gh|gcloud) 与敏感目录（.ssh/.aws/.gnupg/.kube/.azure）；
 *   - 「仍然免审」清单钉住修法的上界：工作区内相对路径读、白名单系统信息文件、含 / 的引号串参数不误伤。
 *
 *  沙盒惯例：dataDir / WORKSPACE_ROOT 先于动态 import 设置（与 tool-declaration-drift.test.ts 同坑）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-readonly-path-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑）。
const { isReadOnlyCommand, escapesWorkspaceOrSensitive } = await import("@/tool/autoPermission.ts");
const { isSensitivePath, SENSITIVE_PATH_RES } = await import("@/tool/sensitivePaths.ts");
const { commandTools } = await import("@/tool/registry/command.ts");
const { fsTools } = await import("@/tool/registry/fs.ts");
const { processToolCall } = await import("@/agent/toolExecution.ts");
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

describe("isReadOnlyCommand 路径面判定（A1 修前免审向量 → 修后不免审）", () => {
    // 修前 13 条全部 true（免审直达执行层）——施工单证据原样；修后必须 false（转人工）。
    const VECTORS = [
        "cat ~/.aws/credentials",
        "cat ~/.ssh/*",
        "cd ~/.ssh && cat *",
        "cat ~/.aws/*",
        'grep -r "" ~/.aws',
        "rg -e . ~/.ssh",
        "head -c 9999 ~/.aws/credentials",
        "sed -n 1,50p ~/.aws/credentials",
        "cat ~/.netrc",
        "cat ~/.kube/config",
        "cat ~/.docker/config.json",
        "cat ~/.git-credentials",
        "cat .envrc",   // 旧 SENSITIVE_FILE_ARG_RE 的代表性漏判：`.envrc` 无 `.env` 词边界
    ];

    it("免审向量全部转人工（isReadOnlyCommand === false）", () => {
        for (const cmd of VECTORS) {
            assert.equal(isReadOnlyCommand(cmd, SANDBOX), false, `应不免审：${cmd}`);
        }
    });

    it("对照：敏感文件名直读仍拦（旧闸保持）", () => {
        assert.equal(isReadOnlyCommand("cat ~/.ssh/id_rsa", SANDBOX), false);
        assert.equal(isReadOnlyCommand("cat .env", SANDBOX), false);
        assert.equal(isReadOnlyCommand("cat src/.env.local", SANDBOX), false);
    });

    it("仍然免审：工作区内相对路径读（修法上界，防误伤）", () => {
        assert.equal(isReadOnlyCommand("cat README.md", SANDBOX), true);
        assert.equal(isReadOnlyCommand("ls -la src", SANDBOX), true);
        assert.equal(isReadOnlyCommand('grep -rn "foo" src | head -20', SANDBOX), true);
        assert.equal(isReadOnlyCommand("cd src && git status", SANDBOX), true);
        assert.equal(isReadOnlyCommand("git diff", SANDBOX), true);
        assert.equal(isReadOnlyCommand('echo "a/b"', SANDBOX), true);
        assert.equal(isReadOnlyCommand('grep -e "http://x/y" src/a.ts', SANDBOX), true);
        assert.equal(isReadOnlyCommand("cat ./src/a.ts", SANDBOX), true);
    });

    it("工作区外白名单：POSIX 与 Windows 系统信息文件均保持免审（宁窄勿宽，白名单外照拦）", () => {
        assert.equal(isReadOnlyCommand("cat /etc/hosts", SANDBOX), true);
        assert.equal(isReadOnlyCommand('grep -r "" /proc/cpuinfo', SANDBOX), true);
        assert.equal(isReadOnlyCommand("head -5 /proc/meminfo", SANDBOX), true);
        assert.equal(isReadOnlyCommand("cat /proc/version", SANDBOX), true);
        // ★ A1 后续（2026-11-23）：Windows 等价路径（原白名单全 POSIX，Windows 主力平台形同虚设）
        assert.equal(isReadOnlyCommand("cat C:/Windows/System32/drivers/etc/hosts", SANDBOX), true);
        assert.equal(isReadOnlyCommand("type C:\\Windows\\System32\\drivers\\etc\\hosts", SANDBOX), true);
        // 白名单外的绝对路径读 → 转人工（含非 home 的敏感名变体：/etc/shadow 不在白名单）
        assert.equal(isReadOnlyCommand("cat /etc/shadow", SANDBOX), false);
        assert.equal(isReadOnlyCommand("cat /etc/passwd", SANDBOX), false);
        assert.equal(isReadOnlyCommand("cat C:/Windows/System32/config/SAM", SANDBOX), false);
    });

    it("Windows 读文件命令：type 与 cat 同档（工作区内免审、敏感/跨区照拦）", () => {
        assert.equal(isReadOnlyCommand("type README.md", SANDBOX), true);
        assert.equal(isReadOnlyCommand("type ./src/a.ts", SANDBOX), true);
        assert.equal(isReadOnlyCommand("type ~/.ssh/id_rsa", SANDBOX), false, "敏感路径仍由统一清单拦");
        assert.equal(isReadOnlyCommand("type C:/Windows/System32/drivers/etc/hosts", SANDBOX), true, "白名单内系统文件");
    });

    it("escapesWorkspaceOrSensitive：路径样 token 判定的形状契约", () => {
        assert.equal(escapesWorkspaceOrSensitive("cat ~/.aws/credentials", SANDBOX), true);
        assert.equal(escapesWorkspaceOrSensitive("git -C D:/other/repo log", SANDBOX), true);
        assert.equal(escapesWorkspaceOrSensitive("cd src && git status", SANDBOX), false);
        assert.equal(escapesWorkspaceOrSensitive("git log --oneline -5", SANDBOX), false);
        assert.equal(escapesWorkspaceOrSensitive('echo "http://x/y"', SANDBOX), false, "引号串参数含 / 不误伤");
        assert.equal(escapesWorkspaceOrSensitive("--tsconfig=src/core/tsconfig.json", SANDBOX), false, "--opt=value 相对值在工作区内");
    });
});

describe("sensitivePaths 单一清单（A1 ①：fs 读硬拒与命令通道同源）", () => {
    it("清单补齐条目命中：.envrc / .git-credentials / .pgpass / .docker / .kube / .config(gh|gcloud) / 敏感目录", () => {
        assert.equal(isSensitivePath("C:\\Users\\x\\.envrc"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.git-credentials"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.pgpass"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.docker\\config.json"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.kube\\config"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.config\\gh\\hosts.yml"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.config\\gcloud\\credentials.db"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.ssh\\id_rsa"), true);
        assert.equal(isSensitivePath("C:\\Users\\x\\.aws\\anything.txt"), true, "敏感目录下任意文件");
        assert.equal(isSensitivePath("C:\\Users\\x\\.gnupg"), true, "敏感目录本身");
    });

    it("非敏感路径不误命中", () => {
        assert.equal(isSensitivePath(path.join(SANDBOX, "src", "a.ts")), false);
        assert.equal(isSensitivePath(path.join(SANDBOX, "README.md")), false);
        assert.equal(isSensitivePath(path.join(SANDBOX, "docs", "credentials-guide.md")), false, "credentials 需路径段锚定，非子串");
    });

    it("模式数组已导出且非空（单一出处的结构钉）", () => {
        assert.ok(Array.isArray(SENSITIVE_PATH_RES) && SENSITIVE_PATH_RES.length >= 15);
    });

    it("fs 读硬拒回归：read_file 读 .env 仍被拒（委托迁移不降级）", async () => {
        await fs.writeFile(path.join(SANDBOX, ".env"), "SECRET=1", "utf-8");
        const readFile = fsTools.find((t: any) => t.function.name === "read_file")!;
        assert.ok(readFile, "read_file 工具应存在");
        const res = await runWithWorkspaceRoot(SANDBOX, () =>
            (readFile.function.execute as any)({ path: ".env" }, { cwd: SANDBOX } as any)) as any;
        const text = typeof res === "string" ? res : String(res?.content ?? "");
        assert.match(text, /拒绝|敏感/, "read_file 敏感硬拒语义保持");
    });
});

// ============ 端到端接线（真实 processToolCall + 真实 run_command 声明，execute 换计数器） ============

const realRunCommand = commandTools.find((t: any) => t.function.name === "run_command")!;

/** 真实声明 + execute 换计数器（流式协议保持：async generator + 退出码哨兵）。 */
const mkCountingCmdTool = (executed: { v: boolean }): any => ({
    ...realRunCommand,
    function: {
        ...realRunCommand.function,
        execute: async function* () { executed.v = true; yield "counted\n⟦DSC_EXIT:0⟧"; },
    },
});

const mkCtx = (rawTools: any[]): any => ({
    sessionId: "readonly-path", cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
    llmDecisionSource: "llm", signal: undefined, rawTools, events: async () => { },
    permissionMode: undefined, planMode: false,
    onUIEvent: undefined, requestApproval: undefined, requestQuestion: undefined, ideAction: undefined,
    keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000, parentSystemPrompt: "",
    contextTokensEst: undefined, readTracker: undefined, reportCost: undefined, toolCostSink: undefined,
    onAuxUsage: undefined, planWriteRejections: undefined, budgetCheck: undefined, batchBudgetChars: undefined,
});

describe("processToolCall 端到端（A1 路径面闸接线）", () => {
    it("cat ~/.aws/credentials：审批被请求（裸 ctx 默认拒绝）、未执行（修前免审直达执行层）", async () => {
        const executed = { v: false };
        setActiveProvider(riskyProvider);
        try {
            const outcome = await runWithWorkspaceRoot(SANDBOX, () => processToolCall(
                { id: "call_a1_deny", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "cat ~/.aws/credentials" }) } },
                mkCtx([mkCountingCmdTool(executed)]),
            ));
            assert.match(outcome.resultForModel, /安全熔断/, "不免审 → 转人工 → 裸 ctx 无审批通道默认拒绝");
            assert.equal(executed.v, false, "审批被请求、未执行");
        } finally { resetActiveProvider(); }
    });

    it("cat README.md（工作区内）：免审直达执行层（免审语义对工作区内保持）", async () => {
        const executed = { v: false };
        setActiveProvider(riskyProvider);
        try {
            const outcome = await runWithWorkspaceRoot(SANDBOX, () => processToolCall(
                { id: "call_a1_free", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "cat README.md" }) } },
                mkCtx([mkCountingCmdTool(executed)]),
            ));
            assert.ok(!outcome.resultForModel.includes("安全熔断"), "工作区内只读不应走审批");
            assert.equal(executed.v, true, "免审直达 execute");
        } finally { resetActiveProvider(); }
    });

    it("cat /etc/hosts（工作区外白名单）：免审直达执行层", async () => {
        const executed = { v: false };
        setActiveProvider(riskyProvider);
        try {
            const outcome = await runWithWorkspaceRoot(SANDBOX, () => processToolCall(
                { id: "call_a1_allow", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "cat /etc/hosts" }) } },
                mkCtx([mkCountingCmdTool(executed)]),
            ));
            assert.ok(!outcome.resultForModel.includes("安全熔断"), "白名单目标不应走审批");
            assert.equal(executed.v, true, "白名单免审直达 execute");
        } finally { resetActiveProvider(); }
    });
});
