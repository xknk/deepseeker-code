/**
 * 守护轮 400 定位探针：复现真实会话的 llm.error「400 The reasoning_content in the thinking mode
 * must be passed back to the API」（2026-09-10 用户真实会话 3 次，均在 EARLY_FINAL 守护轮）。
 *
 *  已知事实：
 *   - 全剥 + 以 user 结尾（正常轮形状）→ 200（reasoning-passthrough-probe.ts 五变体 + selftest 实证）
 *   - 真实会话只有「守护轮」400：请求 = [历史(全剥) + 草稿 assistant + 尾部临时 system nudge]，
 *     与正常轮的唯一形状差异 = 以 assistant/system 结尾（正常轮以 tool/user 结尾）。
 *  变量矩阵（全部全剥，除非注明）：
 *   W1 对照：以 user 结尾（= 正常轮，预期 200）
 *   W2 以 assistant 纯正文草稿结尾（无 nudge）
 *   W3 以 assistant 草稿 + 尾部 system nudge 结尾（= 守护轮原形状，预期复现 400）
 *   W4 同 W3 但草稿保留 reasoning（混合态：历史剥、末条留）
 *   W5 以 assistant 工具轮（content:null+tool_calls，剥）结尾——区分「纯正文草稿」与「工具轮」
 *  运行：npx tsx --tsconfig src/core/tsconfig.json scripts/reasoning-guard-probe.ts
 */
import { model } from "@/llm/providers/deepseek/client.ts";

const apiKey = process.env.DEEP_SEEK_API_KEY;
if (!apiKey) {
    console.error("❌ 未设置 DEEP_SEEK_API_KEY，无法打真实 API");
    process.exit(1);
}
const modelName = process.env.DEEP_SEEK_MODEL || "deepseek-v4-flash";
console.log(`模型: ${modelName}\n`);

const THINK = "用户问的是对当前 agent 的评价。我需要从架构、成本、可维护性三个维度组织回答，" +
    "先列缺点再给改法，最后按性价比排序。这一轮不需要调用工具，直接给分析即可。";

// 历史段：两轮工具调用（全剥，与产品 wire 一致）+ 一条长正文草稿 assistant（守护轮的被追加对象）
const history: any[] = [
    { role: "system", content: "你是编码助手。" },
    { role: "user", content: "当前 agent 的优缺点是什么？" },
    {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"src/agent/runAgent.ts"}' } }],
        // 全剥：不带 reasoning_content
    },
    { role: "tool", tool_call_id: "call_1", content: "// 模拟读到的主循环代码……" + "x".repeat(400) },
    {
        role: "assistant", content: "好的，我已经通读了主循环实现，下面给出分析。" + "分析正文。".repeat(300),   // ~1.8K 字长草稿
        // W2/W3/W5 全剥（无 reasoning_content）；W4 会在此挂回 reasoning_content
    },
];

const NUDGE = { role: "system", content: "⟦DSC:EARLY_FINAL⟧\n你上一步似乎过早收尾。请自检：任务是否真的完成？若未完成请继续推进。" };

const USER_TURN = { role: "user", content: "继续，把缺点 1 展开讲讲。" };

/** 全带版历史：工具轮 assistant 补回 reasoning_content（严格档 W6 用） */
const mkAllKept = (): any[] => {
    const h = [...history];
    h[2] = { ...h[2], reasoning_content: THINK };
    return h;
};

const mkDraft = (keepReasoning: boolean) => {
    const m: any = { ...history[4] };
    if (keepReasoning) m.reasoning_content = THINK;
    return m;
};

const variants: { name: string; messages: any[] }[] = [
    { name: "W1 对照：全剥 + 以 user 结尾（正常轮形状）", messages: [...history.slice(0, 5), USER_TURN] },
    { name: "W2 全剥 + 以 assistant 草稿结尾（无 nudge）", messages: [...history.slice(0, 5)] },
    { name: "W3 全剥 + assistant 草稿 + 尾部 system nudge（守护轮原形状）", messages: [...history.slice(0, 5), NUDGE] },
    { name: "W4 历史剥 + 草稿留 reasoning + 尾部 system nudge（混合态）", messages: [...history.slice(0, 4), mkDraft(true), NUDGE] },
    { name: "W5 全剥 + 以 assistant 工具轮结尾", messages: [...history.slice(0, 4)] },
    { name: "W6 全带 + 草稿留 reasoning + 尾部 system nudge（守护轮全带 = 修复后守护轮行为）", messages: [...mkAllKept().slice(0, 4), mkDraft(true), NUDGE] },
];

const tools = [{
    type: "function",
    function: {
        name: "read_file",
        description: "读取文件",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
}];

for (const v of variants) {
    process.stdout.write(`▶ ${v.name} ... `);
    try {
        const resp: any = await model.chat.completions.create({
            messages: v.messages,
            model: modelName,
            tools,
            tool_choice: "auto",
            thinking: { type: "enabled" },
            reasoning_effort: "high",
            stream: false,
        } as any);
        console.log(`✅ 200，prompt_tokens=${resp.usage?.prompt_tokens}`);
    } catch (e: any) {
        console.log(`❌ ${e?.status ?? "?"}：${String(e?.message ?? e).slice(0, 150)}`);
    }
}
