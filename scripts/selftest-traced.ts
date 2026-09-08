/**
 * 带 trace 落盘的缓存实验会话：接真实 emitTrace 路径，积累「带前缀指纹」的 trace，
 * 供 scripts/cache-fingerprint-report.ts 做跨会话缓存分析。
 *
 * 用法：npx tsx --tsconfig src/core/tsconfig.json scripts/selftest-traced.ts [工作目录] [提问]
 *  - 工作目录不同 → userWorkspaceDir 不同 → 记忆索引/projectGuide 注入不同 → sysHash 不同（真实分歧源）；
 *  - 提问不同 → user 消息字节不同 → 定位「user 消息之前的稳定前缀」占比（反推 tools/messages 序列化顺序）。
 * ★ chdir 必须先于 import：userWorkspaceDir 在 appConfig 模块求值时定格，静态 import 会被提升。
 */
const targetCwd = process.argv[2] || process.cwd();
const question = process.argv[3] || "1+1等于几？只回答数字，不要调用任何工具。";
process.chdir(targetCwd);

const { runAgent } = await import("@/agent/runAgent.ts");
const { buildSystemPrompt } = await import("@/agent/systemPrompt.ts");
const { agentTools } = await import("@/tool/index.ts");
const { createUUID } = await import("@/common/index.ts");
const { emitTrace } = await import("@/observability/trace.ts");

const sessionId = `selftest-${Date.now().toString(36)}-${createUUID().slice(0, 8)}`;
console.log(`[cwd] ${process.cwd()}\n[sessionId] ${sessionId}\n[q] ${question}`);

// 与宿主同构：events → emitTrace 落盘（旁路容错由 emitTrace 自理）+ 控制台摘要
const events = async (base: any) => {
    await emitTrace(base);
    if (base.eventType === "llm.request") {
        console.log(`[llm.request] round=${base.metadata.round} toolsHash=${base.metadata.toolsHash} sysHash=${base.metadata.sysHash} est=${base.usage?.prompt_tokens}`);
    }
    if (base.eventType === "llm.response") {
        const u = base.usage ?? {};
        console.log(`[llm.response] real=${u.prompt_tokens} hit=${u.prompt_cache_hit_tokens ?? 0} (${u.prompt_tokens ? Math.round(((u.prompt_cache_hit_tokens ?? 0) / u.prompt_tokens) * 100) : 0}%)`);
    }
};

await emitTrace({ sessionId, eventType: "session.start" as any, metadata: { depth: 0, decisionSource: "user", ok: true } } as any);

let finalText = "";
for await (const evt of runAgent(
    [
        { role: "system", content: buildSystemPrompt({ displayName: "DeepSeeker-Code", modelLabel: "DeepSeek" }) },
        { role: "user", content: question },
    ] as any,
    {
        sessionId,
        toolSchemas: agentTools as any,
        events,
        modelWindow: 128000,
        keepRecentUnits: 6,
        compactRatio: 0.72,
        parentSystemPrompt: "",
    } as any,
)) {
    if (evt.type === "final") finalText = evt.text;
}

await emitTrace({ sessionId, eventType: "session.end" as any, metadata: { depth: 0, decisionSource: "user", ok: true } } as any);
console.log("[final]", JSON.stringify(finalText.slice(0, 80)));
process.exit(0);
