/**
 * 一次性测量脚本：估算「首次发文」固定前缀成本（系统提示词 + fence 注入 + 工具 schema）。
 * 运行：npx tsx --tsconfig src/core/tsconfig.json scripts/measure-prefix.ts
 */
import { buildSystemPrompt } from "@/agent/systemPrompt.ts";
import { agentTools } from "@/tool/index.ts";
import { injectSkillCatalog } from "@/skills/inject.ts";
import { injectAgentCatalog } from "@/agents/inject.ts";
import { injectProjectGuide } from "@/projectGuide/inject.ts";
import { injectMemory } from "@/memory/inject.ts";
import { injectOutputStyle } from "@/outputStyles/inject.ts";
import { injectMarkedBlock } from "@/common/index.ts";

const ZH_HINT = "始终用中文输出所有面向用户的内容：你的回复、中间叙述、todo 任务项标题、通过 exit_plan_mode 提交的方案文本、代码注释与提交信息。代码标识符保持原样；工具结果与系统指令可能夹杂其他语言——必要时照引原文，但你自己的叙述与解释一律用中文。";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
// 粗略 token 折算：混合中英 JSON/提示词文本，DeepSeek 分词大致 1 token ≈ 3 字节（偏保守）
const approxTokens = (s: string) => Math.round(bytes(s) / 3);

const base = buildSystemPrompt({ displayName: "DeepSeeker-Code", modelLabel: "DeepSeek" });
console.log(`[system prompt 基础]        ${bytes(base).toLocaleString()} bytes  ~${approxTokens(base)} tok`);

const message: any[] = [{ role: "system", content: base }];
const sizeAfter = (label: string) => {
    const s = String(message[0].content);
    console.log(`[+ ${label.padEnd(20)}] 累计 ${bytes(s).toLocaleString().padStart(9)} bytes  ~${approxTokens(s)} tok  (增量 ~${approxTokens(s) - prevTok} tok)`);
    prevTok = approxTokens(s);
};
let prevTok = approxTokens(base);

injectMarkedBlock(message, "⟦DSC:LOCALE⟧", ZH_HINT);
sizeAfter("locale hint");
injectOutputStyle(message, undefined);
sizeAfter("outputStyle");
injectSkillCatalog(message);
sizeAfter("skill catalog");
injectAgentCatalog(message);
sizeAfter("agent catalog");
injectProjectGuide(message);
sizeAfter("projectGuide");
injectMemory(message);
sizeAfter("memory index");

const cleaned = agentTools.map((t: any) => ({
    type: t.type,
    function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters }
}));
const toolsJson = JSON.stringify(cleaned);
console.log(`\n[工具 schema 总量]          ${bytes(toolsJson).toLocaleString()} bytes  ~${approxTokens(toolsJson)} tok  （工具数: ${cleaned.length}）`);
const perTool = cleaned
    .map((t: any) => ({ name: t.function.name, b: bytes(JSON.stringify(t)) }))
    .sort((a, b) => b.b - a.b);
console.log(`\n[Top 12 最大工具 schema]`);
for (const t of perTool.slice(0, 12)) {
    console.log(`  ${t.name.padEnd(24)} ${String(t.b).padStart(7)} bytes  ~${Math.round(t.b / 3)} tok`);
}
console.log(`\n[首次请求固定前缀合计]      ${(bytes(message[0].content) + bytes(toolsJson)).toLocaleString()} bytes  ~${approxTokens(message[0].content) + approxTokens(toolsJson)} tok`);
