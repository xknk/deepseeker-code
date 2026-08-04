/**
 * @file smoke-auto.ts
 * @description auto permission mode 端到端真实冒烟脚本（临时，验证后可删）。
 * 运行：cd src/cli && npx tsx --tsconfig tsconfig.json smoke-auto.ts
 * 前置：DEEP_SEEK_API_KEY 已设置。
 *
 * 分两段：
 *  A) 确定性链路自检（无 LLM 依赖）：runAutoCheck 的范围限定 / 工作区围栏 / deny 清单、
 *     isProtectedWrite 路径匹配 —— 这些分支在进入 LLM 分类器之前就返回，可离线断言。
 *  B) 端到端真实 LLM 冒烟：permissionMode='auto' 下让模型创建工作区内文件，
 *     观测辅助分类器（deepseek-v4-flash）是否放行、人工审批是否被跳过、文件是否落盘。
 */
import fs from "fs";
import path from "path";
import { runAgent } from "@/agent/runAgent.ts";
import { agentTools } from "@/tool/index.ts";
import { initEngine } from "@/bootstrap.ts";
import { buildContextMessages } from "@/session/content.ts";
import { SYSTEM_PROMPT } from "@/agent/systemPrompt.ts";
import { runAutoCheck } from "@/tool/autoPermission.ts";
import { isProtectedWrite } from "@/tool/guard.ts";
import type { Msg } from "@/session/contextCore.ts";

const TARGET = "smoke-auto-check.txt";
const log = (s: string): void => console.log(s);

/** A 段：确定性分支自检（不触发 LLM 分类器）。 */
const sectionA = async (): Promise<boolean> => {
  log("=== A. 确定性链路自检（无 LLM）===");
  const cwd = process.cwd();
  const ctx: any = { cwd, abortSignal: undefined, sessionId: "smoke-unit" };
  const cases: [string, string, string, Record<string, unknown>][] = [
    ["非文件工具 run_command → ask", "run_command", "ask", { command: "echo hi" }],
    ["工作区外相对路径 → ask", "edit_file", "ask", { path: "../core/README.md" }],
    ["工作区外绝对路径 → ask", "write_file", "ask", { path: "C:/Windows/temp/x.txt" }],
    [".env 敏感文件 → deny", "edit_file", "deny", { path: ".env" }],
    ["嵌套 .env → deny", "write_file", "deny", { path: "config/secrets/.env" }],
    ["credentials 凭证 → deny", "create_file", "deny", { path: "credentials.json" }],
    ["空路径 → ask", "edit_file", "ask", { path: "" }],
    ["create_file 在工作区内 → 进分类器(非ask/deny)", "create_file", "allow", { path: "smoke-unit-probe.txt" }],
  ];
  let allOk = true;
  for (const [name, tool, expect, args] of cases) {
    let got: string;
    try {
      got = await runAutoCheck(tool, args, ctx);
    } catch (e: any) {
      got = "THROW:" + String(e?.message ?? e);
    }
    const ok = got === expect;
    if (!ok) allOk = false;
    log(`  ${ok ? "✅" : "❌"} ${name}：期望 ${expect}，实际 ${got}`);
    if (fs.existsSync(path.join(cwd, "smoke-unit-probe.txt"))) fs.rmSync(path.join(cwd, "smoke-unit-probe.txt"));
  }
  const pwCases: [string, boolean][] = [
    [".git/config", true],
    [".gitignore", false],
    [".ssh/id_rsa", true],
    ["src/App.tsx", false],
    ["../core/src/tool/guard.ts", false],
    ["C:/x/.deepSeekCode/settings.json", true],
    ["", false],
    [".gitignore.bak", false],
  ];
  for (const [p, expect] of pwCases) {
    const got = isProtectedWrite(p, cwd);
    const ok = got === expect;
    if (!ok) allOk = false;
    log(`  ${ok ? "✅" : "❌"} isProtectedWrite("${p}")：期望 ${expect}，实际 ${got}`);
  }
  return allOk;
};

/** B 段：真实 LLM 端到端 —— auto 模式下创建文件，验证分类器放行链路。 */
const sectionB = async (): Promise<boolean> => {
  log("\n=== B. 端到端真实 LLM 冒烟（permissionMode=auto）===");
  const cwd = process.cwd();
  const target = path.join(cwd, TARGET);
  if (fs.existsSync(target)) fs.rmSync(target);
  const sessionId = "smoke-auto-" + Date.now();

  const approveCalls: string[] = [];
  const tools: string[] = [];
  const requestApproval = async (_detail: string, meta: any): Promise<boolean> => {
    approveCalls.push(meta.toolName);
    return false; // 若走到人工审批则拒绝，暴露链路
  };
  const events = async (): Promise<void> => {};

  const options: any = {
    sessionId,
    cwd,
    toolSchemas: agentTools,
    events,
    onUIEvent: () => {},
    requestApproval,
    modelWindow: 128_000,
    keepRecentUnits: 12,
    compactRatio: 0.7,
    parentSystemPrompt: SYSTEM_PROMPT,
    permissionMode: "auto",
    thinkingLevel: "none",
    locale: "zh",
  };

  const fullMessages: Msg[] = (await buildContextMessages(
    sessionId,
    {
      role: "user",
      content: `【冒烟测试】请只做一件事：用 create_file 工具在当前工作目录创建文件 ${TARGET}，内容写 "hello auto mode"。不要执行其它任何工具，也不要创建其它文件。完成后用一句话确认。`,
    } as any,
    SYSTEM_PROMPT,
  )) as Msg[];

  let final = "";
  const t0 = Date.now();
  for await (const evt of runAgent(fullMessages, options)) {
    if (evt.type === "tool.start") {
      tools.push(evt.toolName);
      log(`  [tool.start] ${evt.toolName} args=${JSON.stringify(evt.args).slice(0, 140)}`);
    }
    if (evt.type === "tool.end") {
      log(`  [tool.end]   ${evt.toolName} ok=${evt.ok} result=${String(evt.result).slice(0, 140)}`);
    }
    if (evt.type === "final") final = evt.text;
  }
  const dur = ((Date.now() - t0) / 1000).toFixed(1);

  const created = fs.existsSync(target);
  const content = created ? fs.readFileSync(target, "utf8").slice(0, 60) : "";
  log("");
  log(`  耗时 ${dur}s | 工具序列: ${tools.join(" -> ") || "(无)"}`);
  log(`  人工审批调用次数: ${approveCalls.length}${approveCalls.length ? "（!! 走到了人工审批）" : "（未触发人工，分类器链路正常）"}`);
  log(`  文件已创建: ${created}${created ? `，内容: ${JSON.stringify(content)}` : ""}`);
  log(`  最终回复: ${final.slice(0, 200)}`);
  if (created) {
    fs.rmSync(target);
    log("  已清理测试文件");
  }
  const ok = created && approveCalls.length === 0;
  log(ok ? "  ✅ B 段通过：auto 分类器放行链路端到端正常" : "  ⚠️ B 段未达最优（详见日志：可能分类器判 risky 转人工，或模型未按指示执行）");
  return ok;
};

const main = async (): Promise<void> => {
  if (!process.env.DEEP_SEEK_API_KEY) {
    console.error("缺少 DEEP_SEEK_API_KEY，无法冒烟");
    process.exit(1);
  }
  const dispose = await initEngine(agentTools);
  try {
    const a = await sectionA();
    const b = await sectionB();
    log("\n===== 冒烟汇总 =====");
    log(`A 确定性自检: ${a ? "全部通过 ✅" : "存在失败 ❌（见上方日志）"}`);
    log(`B 端到端冒烟: ${b ? "通过 ✅" : "未通过 ⚠️（见上方日志）"}`);
  } finally {
    await dispose();
  }
};

main().catch((e) => {
  console.error("冒烟脚本异常:", e);
  process.exit(1);
});
