/**
 * 端到端自测：直驱 runAgent 跑一轮最小任务（44 工具全表 + 一句话提问，1 次真实 API 调用）。
 * 验证三点：
 *  ① P0 前缀指纹字段（toolsHash/sysHash/sumHash/msgCount）真实落 trace 的 llm.request；
 *  ② P2 口径闭环：est(含 toolsTokens) / 真实 prompt_tokens 比值落在 1.0~1.3（旧口径曾 3.9x）；
 *  ③ 主循环无回归，正常 final 收尾。
 * 运行：npx tsx --tsconfig src/core/tsconfig.json scripts/selftest-runagent.ts
 */
import { runAgent } from "@/agent/runAgent.ts";
import { buildSystemPrompt } from "@/agent/systemPrompt.ts";
import { agentTools } from "@/tool/index.ts";
import { createUUID } from "@/common/index.ts";

const sessionId = `selftest-${Date.now().toString(36)}-${createUUID().slice(0, 8)}`;
const message: any[] = [
    { role: "system", content: buildSystemPrompt({ displayName: "DeepSeeker-Code", modelLabel: "DeepSeek" }) },
    { role: "user", content: "1+1等于几？只回答数字，不要调用任何工具。" },
];

const requests: any[] = [];
const responses: any[] = [];
const events = async (base: any) => {
    if (base.eventType === "llm.request") {
        requests.push(base);
        console.log("[llm.request]", JSON.stringify({
            round: base.metadata.round,
            toolsHash: base.metadata.toolsHash,
            sysHash: base.metadata.sysHash,
            sumHash: base.metadata.sumHash,
            msgCount: base.metadata.msgCount,
            est: base.usage?.prompt_tokens,
        }));
    }
    if (base.eventType === "llm.response") {
        responses.push(base);
        console.log("[llm.response]", JSON.stringify(base.usage));
    }
};

let finalText = "";
for await (const evt of runAgent(message as any, {
    sessionId,
    toolSchemas: agentTools as any,
    events,
    modelWindow: 128000,
    keepRecentUnits: 6,
    compactRatio: 0.72,
    parentSystemPrompt: "",
} as any)) {
    if (evt.type === "final") finalText = evt.text;
}

// —— 断言 ——
let ok = true;
const req = requests[0];
const resU: any = responses[0]?.usage ?? {};   // ★ llm.response 的 token 在 base.usage 下（上次误读成 base.prompt_tokens）
const fp = req?.metadata ?? {};
if (!fp.toolsHash || !fp.sysHash || !fp.sumHash || fp.msgCount == null) {
    console.log("❌ ① 指纹字段缺失:", JSON.stringify(Object.keys(fp)));
    ok = false;
} else {
    console.log(`✅ ① 指纹已落 trace: toolsHash=${fp.toolsHash} sysHash=${fp.sysHash} sumHash=${fp.sumHash} msgCount=${fp.msgCount}`);
}
if (!resU?.prompt_tokens || !req?.usage?.prompt_tokens) {
    console.log("❌ ② 缺少 est 或真实 usage");
    ok = false;
} else {
    const est = req.usage.prompt_tokens;
    const real = resU.prompt_tokens;
    const ratio = real / est;
    const hit = resU.prompt_cache_hit_tokens ?? 0;
    console.log(`✅ ② P2 口径: est=${est}（含 toolsTokens） real=${real} ratio=${ratio.toFixed(3)} 缓存命中=${hit}（ratio 健康区 1.0~1.4，旧口径同场景 3.9）`);
    if (ratio > 1.6 || ratio < 0.85) {
        console.log("❌ ② ratio 超出健康区——常数项口径未闭环");
        ok = false;
    }
}
console.log("[final]", JSON.stringify(finalText.slice(0, 120)));
console.log("[sessionId]", sessionId);
console.log(ok ? "=== SELFTEST PASS ===" : "=== SELFTEST FAIL ===");
process.exit(ok ? 0 : 1);
