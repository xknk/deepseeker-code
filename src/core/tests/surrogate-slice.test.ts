/**
 * @file tests/surrogate-slice.test.ts
 * @description 防劈代理对切点助手函数级测试（2026-11-13 事故回归，session/content.ts 导出对）：
 *  sliceHeadNoSplit / sliceTailNoSplit 的边界——keep=0、全 emoji 串（切点必劈）、尾切起点恰在低代理、
 *  输入自带孤立代理时的契约（只护切缘、不清存量——存量是 surrogateGuard 出口守门的事）。
 *  补 truncateToolResult 代理对用例（此前全 ASCII，劈对回归零覆盖）。
 *  另收口「失败文案回灌模型」两处（灾难命令拦截 / 参数解析失败，2026-11-20）：failResult 文案直接
 *  进 resultForModel，即进 API 消息——裸 slice 劈出孤立代理同样能让下一次请求 400。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-surr-slice-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { sliceHeadNoSplit, sliceTailNoSplit } = await import("@/session/content.ts");
const { truncateToolResult } = await import("@/agent/truncate.ts");
const { processToolCall } = await import("@/agent/toolExecution.ts");

const loneHigh = "\ud83d";   // 孤立高代理（emoji 前半被劈）
const loneLow = "\udc4d";    // 孤立低代理（emoji 后半被劈）
const emoji = "📋";          // U+1F4CB，完整代理对 = 📋（2 个 UTF-16 码元）

/** 串内不得含孤立代理（DeepSeek 400 的直接诱因——事故形态的机器判定）。
 *  ★ 直接按码元扫原串，不走 JSON.stringify+正则：原方案的两处缺陷——①曾试图先 .replace(/\\\\/g) 摘
 *  转义反斜杠，但那是个恒等变换（什么都没防）；②串含字面 "\\ud83d" 文本（贴日志即现）时 stringify
 *  成 \\\\ud83d，正则从第二个反斜杠起仍误命中。码元直扫零误报零歧义。 */
const noLoneEscape = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && !(s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return false;
        if (code >= 0xdc00 && code <= 0xdfff && !(s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff)) return false;
    }
    return true;
};

describe("sliceHeadNoSplit", () => {
    it("基础切：纯 ASCII 与预期一致", () => {
        assert.equal(sliceHeadNoSplit("abcdef", 3), "abc");
    });

    it("keep=0 → 空串（切缘在起点，无代理可劈）", () => {
        assert.equal(sliceHeadNoSplit(`${emoji}abc`, 0), "");
    });

    it("keep 大于长度 → 原样返回", () => {
        assert.equal(sliceHeadNoSplit("ab", 99), "ab");
    });

    it("★ 切点落在代理对中间 → 回退一位，emoji 整体舍去不劈半（499+emoji 事故形态）", () => {
        const s = "x".repeat(499) + emoji + "y".repeat(300);
        const out = sliceHeadNoSplit(s, 500);   // 500 恰落在 emoji 第二码元
        assert.equal(out, "x".repeat(499), "回退到代理对之前");
        assert.ok(noLoneEscape(out), "序列化无孤立代理转义");
    });

    it("★ 全 emoji 串：切点必然劈对 → 回退保整对，结果只含完整 emoji", () => {
        const s = emoji.repeat(20);
        const out = sliceHeadNoSplit(s, 21);    // 奇数切点必劈
        assert.equal(out.length % 2, 0, "长度必为偶数（码元成对）");
        assert.equal(out, emoji.repeat(10), "恰含 10 个完整 emoji");
    });

    it("契约钉死：切缘之外的存量孤立代理不被清理（那是 surrogateGuard 出口守门的事）", () => {
        const s = `${loneLow}ab`;               // 输入本身带孤立低代理
        const out = sliceHeadNoSplit(s, 2);     // 切缘在 'a'（ASCII），不触发回退
        assert.equal(out, `${loneLow}a`, "切点助手只护切缘，不越权清存量");
    });
});

describe("sliceTailNoSplit", () => {
    it("基础切：纯 ASCII 与预期一致", () => {
        assert.equal(sliceTailNoSplit("abcdef", 3), "def");
    });

    it("keep 大于长度 → 原样返回", () => {
        assert.equal(sliceTailNoSplit("ab", 99), "ab");
    });

    it("★ 尾切起点恰在低代理 → 前进一位，不产出孤立低代理", () => {
        const s = "ab" + emoji + "yz";          // 码元: a b [高 低] y z（共 6）
        assert.equal(sliceTailNoSplit(s, 3), "yz", "keep=3 → 起点码元 3=低代理 → 前进到 4");
        assert.equal(sliceTailNoSplit(s, 4), `${emoji}yz`, "keep=4 → 起点码元 2=高代理（成对起始）→ 原样");
        assert.ok(noLoneEscape(sliceTailNoSplit(s, 3)), "序列化无孤立代理转义");
    });

    it("契约钉死：切缘上的存量孤立被前进跳过（丢弃、输出干净）；内部存量不越权清理", () => {
        // 码元: a0 b1 c2 d3 e4 [孤立低]5 f6 g7（共 8）
        const s = `abcde${loneLow}fg`;
        assert.equal(sliceTailNoSplit(s, 3), "fg", "keep=3 → 起点码元 5=孤立低 → 前进跳过（输出干净）");
        assert.equal(sliceTailNoSplit(s, 4), `e${loneLow}fg`, "keep=4 → 起点码元 4='e'（ASCII）→ 内部存量孤立原样保留");
    });
});

describe("truncateToolResult 代理对回归（此前全 ASCII 零覆盖）", () => {
    it("截断切点不劈 emoji：头尾产物序列化均无孤立代理转义", () => {
        const body = "x".repeat(499) + emoji + "y".repeat(9000) + emoji + "z".repeat(9000);
        const out = truncateToolResult(body, 500);
        assert.ok(out.length < body.length, "确实发生了截断");
        assert.ok(noLoneEscape(out), `头缘不劈：${JSON.stringify(out).slice(0, 80)}`);
    });
});

// ============ 登记级剩余调用点收口（2026-11-20，源后续路线「字符串截断劈代理对」条目①b） ============

describe("commands loader body 截断（斜杠命令正文经 expand 进上下文 = 进 API 消息）", () => {
    it("64KB 边界 emoji 不劈半：截断产物无孤立代理、截断提示在、正文前缀完整", async () => {
        const { loadCommands } = await import("@/commands/loader.ts");
        const { listCommands } = await import("@/commands/registry.ts");
        const dir = path.join(SANDBOX, "commands");   // global 源 = dataDir/commands（env 已指 SANDBOX）
        await fs.mkdir(dir, { recursive: true });
        const MAX = 64 * 1024;
        // 65535 个 'x' 后跟 emoji：裸 slice(0,65536) 切点落在 emoji 第二码元 → 孤立高代理
        const body = "x".repeat(MAX - 1) + emoji + "y".repeat(500);
        await fs.writeFile(
            path.join(dir, "surr-cmd-fixture.md"),
            `---\nname: surr-cmd-fixture\ndescription: 代理对边界截断夹具\n---\n${body}`,
            "utf-8",
        );
        await loadCommands(false);
        const cmd = listCommands().find((c: any) => c.name === "surr-cmd-fixture");
        assert.ok(cmd, "夹具命令已注册（磁盘发现链路走通）");
        assert.ok(cmd!.body.length < body.length, "确实发生了截断");
        assert.match(cmd!.body, /已截断/, "含截断说明");
        assert.ok(noLoneEscape(cmd!.body), "序列化无孤立代理转义");
        assert.ok(!cmd!.body.includes(emoji), "边界 emoji 整体舍去（不劈半）");
    });
});

// ============ 工具失败文案截断（failResult → resultForModel = 进 API 消息，2026-11-20 补收口） ============

/** 最小运行上下文（仅本组用到的字段；字段集对齐 ToolCallContext，缺省即空实现）。 */
const mkCtx = (rawTools: any[]): any => ({
    sessionId: "surr-msg", cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
    llmDecisionSource: "llm", signal: undefined, rawTools, events: async () => { },
    permissionMode: undefined, planMode: false,
    onUIEvent: undefined, requestApproval: undefined, requestQuestion: undefined, ideAction: undefined,
    keepRecentUnits: 5, compactRatio: 0.72, modelWindow: 250000, parentSystemPrompt: "",
    contextTokensEst: undefined, readTracker: undefined, reportCost: undefined, toolCostSink: undefined,
    onAuxUsage: undefined, planWriteRejections: undefined, budgetCheck: undefined, batchBudgetChars: undefined,
});

/** 假命令工具（argKind='command' 即灾难命令硬闸的判定依据；无 parameters 以跳过 schema 校验）。 */
const mkCmdTool = (executed: { v: boolean }): any => ({
    type: "function",
    function: {
        name: "fake_cmd", description: "fake command tool", parameters: undefined,
        safetyLevel: "danger", isSync: true, argKind: "command", primaryArg: "command",
        execute: async () => { executed.v = true; return "不该执行"; },
    },
});

describe("工具失败文案截断（failResult 文案回灌模型 = 进 API 消息）", () => {
    it("灾难命令拦截文案：命令里的 emoji 不被劈半，且被拒后不执行", async () => {
        const executed = { v: false };
        // "rm -rf /x" 长 9，后接 emoji：切点 100 落在某个 emoji 的代理对中间（起点 9 + 偶数偏移 = 高代理）
        const command = "rm -rf /x" + emoji.repeat(80);
        assert.ok(!noLoneEscape(command.slice(0, 100)), "夹具有效性：裸 slice(0,100) 确实劈出孤立代理");

        const out = await processToolCall(
            { id: "surr-deny", type: "function", function: { name: "fake_cmd", arguments: JSON.stringify({ command }) } },
            mkCtx([mkCmdTool(executed)]),
        );
        assert.match(out.resultForModel, /灾难命令清单拦截/, "命中灾难命令硬闸");
        assert.equal(executed.v, false, "被拒即不执行");
        assert.ok(noLoneEscape(out.resultForModel), "文案无孤立代理（否则下一次请求 400）");
    });

    it("参数解析失败文案：畸形 arguments 里的 emoji 不被劈半", async () => {
        // arguments 非法 JSON（不以 { 开头）；填充长度由夹具自证选出——保证裸切 300 确实落在 emoji 中间
        const build = (pad: number) => ({
            id: "surr-parse", type: "function",
            function: { name: "fake_cmd", arguments: "x".repeat(pad) + emoji.repeat(60) },
        });
        const pad = [190, 191, 192, 193, 194, 195, 196, 197, 198, 199]
            .find(n => !noLoneEscape(JSON.stringify(build(n)).slice(0, 300)));
        assert.notEqual(pad, undefined, "夹具有效性：存在填充长度使裸切 300 劈出孤立代理");

        const out = await processToolCall(build(pad!), mkCtx([]));
        assert.match(out.resultForModel, /参数解析失败/, "走畸形 arguments 分支");
        assert.ok(noLoneEscape(out.resultForModel), "文案无孤立代理（否则下一次请求 400）");
    });
});
