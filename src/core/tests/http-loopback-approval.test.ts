/**
 * @file tests/http-loopback-approval.test.ts
 * @description A3（2026-11-09 审批降噪）守门测试：http_request 字面回环目标 default 档免审。
 *
 *  契约：
 *   - 127.0.0.1 / localhost / [::1]（可带端口）三种【字面】host → runAutoCheck 'allow'（确定性放行，
 *     不经分类器）；刻意不做 DNS 解析放行（isLoopbackTargetUrl 只认字面）。
 *   - 外网 / 元数据端点 / 非字面回环（127.0.0.2 / 0.0.0.0）/ 非 http(s) / 非法 URL → 'ask'
 *     （与改前 inScope 外行为逐字节一致；/auto 档同样不放大——http_request 不入分类器通道）。
 *   - 端到端 processToolCall 接线：回环目标在【未注入审批通道】的裸 ctx 下直达 execute
 *     （免审生效，无「安全熔断」审批拒绝）；云元数据目标仍走审批 → 裸 ctx 默认拒绝。
 *   - SSRF 回归：工具内元数据端点硬拦（web.ts checkHost step 0）在连接前命中——离线可测，
 *     A3 未触碰工具内 SSRF 闸。
 *
 *  沙盒惯例：dataDir / WORKSPACE_ROOT 先于动态 import 设置（与 tool-declaration-drift.test.ts 同坑）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-loopback-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑）。
const { runAutoCheck, isLoopbackTargetUrl } = await import("@/tool/autoPermission.ts");
const { httpTools } = await import("@/tool/registry/http.ts");
const { processToolCall } = await import("@/agent/toolExecution.ts");
const { runWithWorkspaceRoot } = await import("@/tool/guard.ts");

const loopbackDecl = { autoApproval: 'loopback' as const, primaryArg: 'url' };
const ctx = { cwd: SANDBOX } as any;

describe("isLoopbackTargetUrl（A3 字面回环判定）", () => {
    it("三种字面回环 host（可带端口）命中；其余一律不命中", () => {
        assert.equal(isLoopbackTargetUrl("http://localhost:3000/api/login"), true);
        assert.equal(isLoopbackTargetUrl("http://127.0.0.1:9222/json/version"), true);
        assert.equal(isLoopbackTargetUrl("http://[::1]:5173/"), true);
        assert.equal(isLoopbackTargetUrl("https://localhost/"), true);
        assert.equal(isLoopbackTargetUrl("http://127.0.0.2:3000/"), false, "刻意只认 127.0.0.1 字面");
        assert.equal(isLoopbackTargetUrl("http://0.0.0.0:3000/"), false);
        assert.equal(isLoopbackTargetUrl("http://api.example.com/v1"), false);
        assert.equal(isLoopbackTargetUrl("http://169.254.169.254/latest/meta-data/"), false);
        assert.equal(isLoopbackTargetUrl("ftp://localhost"), false, "非 http(s) 协议不命中");
        assert.equal(isLoopbackTargetUrl("not-a-url"), false);
    });
});

describe("runAutoCheck loopback 作用域（A3）", () => {
    it("回环目标 → allow（确定性放行，不经分类器）", async () => {
        assert.equal(await runAutoCheck("http_request", { url: "http://localhost:3000/api" }, ctx, false, loopbackDecl), "allow");
        assert.equal(await runAutoCheck("http_request", { url: "http://127.0.0.1:8080/health" }, ctx, false, loopbackDecl), "allow");
        assert.equal(await runAutoCheck("http_request", { url: "http://[::1]:3000/x" }, ctx, false, loopbackDecl), "allow");
    });

    it("外网 / 元数据 / 非字面回环 / 缺参 → ask；/auto 档不放大；未声明作用域恒 ask（fail-closed 回归）", async () => {
        assert.equal(await runAutoCheck("http_request", { url: "https://api.example.com/v1" }, ctx, false, loopbackDecl), "ask");
        assert.equal(await runAutoCheck("http_request", { url: "http://169.254.169.254/latest/meta-data/" }, ctx, false, loopbackDecl), "ask");
        assert.equal(await runAutoCheck("http_request", { url: "http://127.0.0.2/" }, ctx, false, loopbackDecl), "ask");
        assert.equal(await runAutoCheck("http_request", { url: "https://api.example.com/v1" }, ctx, true, loopbackDecl), "ask", "/auto 档外网仍 ask");
        assert.equal(await runAutoCheck("http_request", {}, ctx, false, loopbackDecl), "ask");
        assert.equal(await runAutoCheck("http_request", { url: "http://localhost:3000/" }, ctx, false, {}), "ask", "未声明 loopback 作用域 → 恒 ask");
    });
});

describe("processToolCall 端到端接线（A3）", () => {
    const httpRequestTool = httpTools.find(t => t.function.name === "http_request")!;
    const mkCtx = () => ({
        sessionId: "sess-loopback", cwd: SANDBOX, depth: 0, round: 1, startTime: performance.now(),
        llmDecisionSource: "tool" as any, rawTools: [httpRequestTool], events: (() => { }) as any,
        keepRecentUnits: 6, compactRatio: 0.7, modelWindow: 128000, parentSystemPrompt: "",
    });

    it("回环目标：未注入审批通道也直达 execute（免审生效，非审批拒绝）", async () => {
        const outcome = await runWithWorkspaceRoot(SANDBOX, () => processToolCall(
            { id: "call_loop_1", type: "function", function: { name: "http_request", arguments: JSON.stringify({ url: "http://127.0.0.1:9/x" }) } },
            mkCtx() as any));
        assert.ok(!outcome.resultForModel.includes("安全熔断"), "不应被审批拒绝——免审直达执行层");
        assert.match(outcome.resultForModel, /http_request 失败/, "应真实执行（本地无服务连接失败，非审批拦截）");
    });

    it("云元数据目标：仍走审批（裸 ctx → 安全熔断默认拒绝）；SSRF 工具内硬拦回归（离线）", async () => {
        const outcome = await runWithWorkspaceRoot(SANDBOX, () => processToolCall(
            { id: "call_loop_2", type: "function", function: { name: "http_request", arguments: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }) } },
            mkCtx() as any));
        assert.match(outcome.resultForModel, /安全熔断/, "外网目标未获免审 → 转人工审批 → 未注入审批通道默认拒绝");
        // SSRF 回归：绕过审批层直调 execute——工具内元数据端点硬拦在连接前命中（checkHost step 0，离线确定性）
        const res = await httpRequestTool.function.execute({ url: "http://169.254.169.254/latest/meta-data/" }, { cwd: SANDBOX } as any);
        assert.equal(res.status, "failed");
        assert.match(res.content, /元数据/, "工具内 SSRF 闸未受 A3 影响");
    });
});
