/**
 * @file tests/sidecar.test.ts
 * @description 侧车存档共享契约（session/sidecar.ts 单点，2026-09-16 顺手登记项）+ recall 取回回环：
 *  - 写读两侧共用常量：SIDECAR_ARCHIVED_MARK 截断标记、safeSidecarId 清洗（tool_call.id 来自模型，
 *    防路径注入）、getToolOutputSidecarPath 路径拼装不得越出 tool-outputs 目录；
 *  - writeSidecarArchive：落盘 + 返回 with_full 提示；按会话总量闸淘汰最旧存档（opts.capBytes 注入）；
 *  - truncateToolResult：侧车提示拼进省略标记行（截断不再是单方面信息丢失）；
 *  - recall：with_full 取回全文 / 存档被淘汰后的明确报错 / run_id 过滤对 legacy 会话（无 run.start
 *    事件行）的兜底——修复前该场景会滤掉所有行恒不命中。
 *  沙盒惯例：dataDir 指向临时目录，防读写真实 ~/.deepseeker-code。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-sidecar-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { SIDECAR_ARCHIVED_MARK, sidecarArchivedNote, safeSidecarId, getToolOutputSidecarPath, writeSidecarArchive, SIDECAR_SESSION_CAP_BYTES }
    = await import("@/session/sidecar.ts");
const { truncateToolResult } = await import("@/agent/truncate.ts");
const { recallTools } = await import("@/tool/registry/recall.ts");
const { appendMessage, appendEvent } = await import("@/session/transcript.ts");

const recall = recallTools.find((t: any) => t.function.name === "recall")!;
// 结果视图归一：正常分支返回 string，失败分支（toolFailure）返回 { status, content } —— 统一取文本
const execRecall = async (args: any, sessionId: string): Promise<string> => {
    const r: any = await recall.function.execute(args, { sessionId } as any);
    return typeof r === "string" ? r : String(r?.content ?? r);
};

describe("侧车共享契约（session/sidecar.ts）", () => {
    it("SIDECAR_ARCHIVED_MARK 与提示行：含标记词与 with_full 指引", () => {
        assert.equal(SIDECAR_ARCHIVED_MARK, "完整原文已存档");
        const note = sidecarArchivedNote("call_1");
        assert.ok(note.includes(SIDECAR_ARCHIVED_MARK));
        assert.ok(note.includes('with_full="call_1"'));
    });

    it("safeSidecarId：合法 id 原样保留，路径注入/特殊字符全剥除", () => {
        assert.equal(safeSidecarId("call_Abc-123_X"), "call_Abc-123_X");
        assert.equal(safeSidecarId("../../etc/passwd"), "etcpasswd");
        assert.equal(safeSidecarId("..\\..\\win"), "win");
        assert.equal(safeSidecarId("call 中文 ✂️ id"), "callid");
        assert.equal(safeSidecarId(undefined), "undefined".replace(/[^A-Za-z0-9_-]/g, ""), "非字符串走 String() 兜底");
        assert.equal(safeSidecarId(""), "");
    });

    it("getToolOutputSidecarPath：落在 tool-outputs 目录内，不因 id 越界", async () => {
        const sessionId = "test-sidecar-path";
        const p = getToolOutputSidecarPath(sessionId, "../../evil");
        const dir = path.dirname(p);
        assert.ok(path.basename(dir) === "tool-outputs", "父目录应是 tool-outputs");
        const rel = path.relative(dir, p);
        assert.ok(!rel.startsWith(".."), "路径不得越出 tool-outputs");
    });
});

describe("writeSidecarArchive（写盘单点）", () => {
    const sessionId = "test-sidecar-write";

    it("落盘全文并返回 with_full 提示；文件内容逐字一致", async () => {
        const note = await writeSidecarArchive(sessionId, "call_w1", "HELLO-SIDECAR-CONTENT");
        assert.ok(note?.includes(SIDECAR_ARCHIVED_MARK) && note?.includes('with_full="call_w1"'));
        const onDisk = await fs.readFile(getToolOutputSidecarPath(sessionId, "call_w1"), "utf-8");
        assert.equal(onDisk, "HELLO-SIDECAR-CONTENT");
    });

    it("总量闸：超限淘汰最旧存档（capBytes 注入），最新档始终保留", async () => {
        const capSession = "test-sidecar-cap";
        const tick = () => new Promise(r => setTimeout(r, 30)); // 拉开 mtime，保证「最旧」判定稳定
        const a = "A".repeat(60);
        const b = "B".repeat(60);
        const c = "C".repeat(60);
        await writeSidecarArchive(capSession, "call_a", a, { capBytes: 100 });
        await tick();
        await writeSidecarArchive(capSession, "call_b", b, { capBytes: 100 }); // 60+60>100 → 淘汰 a
        await tick();
        await writeSidecarArchive(capSession, "call_c", c, { capBytes: 100 }); // 60+60>100 → 淘汰 b

        const dir = path.dirname(getToolOutputSidecarPath(capSession, "call_x"));
        const names = (await fs.readdir(dir)).sort();
        assert.deepEqual(names, ["call_c.txt"], "仅最新存档存活");
        assert.equal(await fs.readFile(path.join(dir, "call_c.txt"), "utf-8"), c);
    });

    it("缺省闸为 64MB 常量（导出值稳定，防误改数量级）", () => {
        assert.equal(SIDECAR_SESSION_CAP_BYTES, 64 * 1024 * 1024);
    });
});

describe("truncateToolResult × 侧车提示", () => {
    it("超长结果：省略标记行拼入侧车提示（含标记词与 with_full）", () => {
        const note = sidecarArchivedNote("call_t1");
        const out = truncateToolResult("x".repeat(5000), 1000, note);
        assert.ok(out.length < 5000, "应已截断");
        assert.ok(out.includes("已省略中间"), "应带省略标记");
        assert.ok(out.includes(SIDECAR_ARCHIVED_MARK) && out.includes('with_full="call_t1"'), "提示应拼进标记行");
    });

    it("未超长结果原样返回，不拼提示", () => {
        const out = truncateToolResult("short", 1000, sidecarArchivedNote("call_t2"));
        assert.equal(out, "short");
    });

    it("无侧车提示时保持旧形态（无「；」注）", () => {
        const out = truncateToolResult("y".repeat(5000), 1000);
        assert.ok(out.includes("已省略中间"));
        assert.ok(!out.includes(SIDECAR_ARCHIVED_MARK));
    });
});

describe("recall × 侧车回环", () => {
    const sessionId = "test-sidecar-recall";

    it("with_full 取回存档全文（分页尾标「全文完」）", async () => {
        await writeSidecarArchive(sessionId, "call_r1", "SECRET-RECALL-PAYLOAD");
        const out = await execRecall({ with_full: "call_r1" }, sessionId);
        assert.ok(out.includes("SECRET-RECALL-PAYLOAD"));
        assert.ok(out.includes("[全文完]"));
    });

    it("存档被总量闸淘汰后 with_full 明确报错（不臆测内容）", async () => {
        await writeSidecarArchive(sessionId, "call_gone", "z".repeat(60), { capBytes: 100 });
        await writeSidecarArchive(sessionId, "call_fresh", "y".repeat(60), { capBytes: 100 });
        const out = await execRecall({ with_full: "call_gone" }, sessionId);
        assert.ok(out.includes("未找到"));
    });

    it("命中带截断标记的工具结果 → 头部标注 ✂️ with_full 可取全文", async () => {
        await appendMessage({ sessionId, role: "user", content: "帮我跑一下构建" } as any);
        await appendMessage({
            sessionId, role: "tool", tool_call_id: "call_mark1",
            content: `构建日志前段……(已省略中间约 999 行；${sidecarArchivedNote("call_mark1")})……构建日志后段`,
        } as any);
        const out = await execRecall({ query: "构建日志" }, sessionId);
        assert.ok(out.includes("✂️"), "应标注曾截断");
        assert.ok(out.includes('with_full="call_mark1"'), "应给出取回指引");
    });
});

describe("recall run_id 过滤（legacy 会话兜底，2026-09-16）", () => {
    it("无 run.start 事件行的旧转录：run_id 过滤跳过，检索照常命中", async () => {
        const legacyId = "test-recall-legacy";
        await appendMessage({ sessionId: legacyId, role: "user", content: "部署以后一直报 ETIMEDOUT 怎么办" } as any);
        await appendMessage({ sessionId: legacyId, role: "assistant", content: "看日志是数据库连接超时" } as any);
        // 修复前：无 run.start → runId 恒空串 → runFilter 判定滤掉所有行 → 恒「未命中」
        const out = await execRecall({ query: "ETIMEDOUT", run_id: "run-xyz" }, legacyId);
        assert.ok(out.includes("命中 1 条"), `legacy 会话应照常命中：${String(out).slice(0, 200)}`);
    });

    it("有 run.start 的新转录：run_id 过滤正常限定范围", async () => {
        const id = "test-recall-runs";
        await appendEvent(id, { dscEvent: "run.start", runId: "run-aaa11111", depth: 0 });
        await appendMessage({ sessionId: id, role: "user", content: "排行榜服务连 redis 报 ETIMEDOUT" } as any);
        await appendEvent(id, { dscEvent: "run.start", runId: "run-bbb22222", depth: 0 });
        await appendMessage({ sessionId: id, role: "user", content: "换个话题，讲讲 lodash 的 groupBy" } as any);

        const inRun1 = await execRecall({ query: "ETIMEDOUT", run_id: "run-aaa" }, id);
        assert.ok(inRun1.includes("命中 1 条"), `run1 前缀应命中：${String(inRun1).slice(0, 200)}`);
        const crossRun = await execRecall({ query: "ETIMEDOUT", run_id: "run-bbb" }, id);
        assert.ok(crossRun.includes("未命中"), "run2 前缀不应命中 run1 的内容");
    });
});
