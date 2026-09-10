/**
 * 协议探针：V4 thinking 模式下，历史轮 reasoning_content 的「最小回传集」验证。
 *
 *  背景：官方文档说 thinking 模式下含工具调用的 assistant 轮「后续必须完整回传 reasoning_content，
 *  否则 400」。但没说清「完整」是指【全部历史】还是【当前 turn】。取证（scripts/reasoning-share.ts）
 *  实测历史思考记录占了每轮请求的 ~25%，若协议只要求最近一轮，剥掉历史就是免费减负。
 *
 *  方法：编一段两轮工具调用的 thinking 对话（第 1 轮=历史、第 2 轮=最近），4 种剥法各发一次真请求：
 *   V0 全部回传（= 现状，基线，必须成功，否则说明探针本身搭错了）
 *   V1 只剥历史轮、保留最近轮（★ 若成功 = 找到最小回传集，可落地省 ~25%）
 *   V2 全剥（若也成功 = 协议根本不强制，收益更大；若失败 = 最近轮必须带）
 *   V3 只留历史、剥最近轮（对照：定位 400 到底卡在哪个轮）
 *  成本：每条请求 ~1-2K token，4 条 = 几分钱。
 *  运行：npx tsx --tsconfig src/core/tsconfig.json scripts/reasoning-passthrough-probe.ts
 */
import { model } from "@/llm/providers/deepseek/client.ts";

const apiKey = process.env.DEEP_SEEK_API_KEY;
if (!apiKey) {
    console.error("❌ 未设置 DEEP_SEEK_API_KEY，无法打真实 API");
    process.exit(1);
}
const modelName = process.env.DEEP_SEEK_MODEL || "deepseek-v4-flash";
const baseURL = process.env.DEEP_SEEK_API_URL || "https://api.deepseek.com";
// 复用产品同款 client（同 env、同超时）；SDK 的自动重试只针对瞬态错误，400 类校验错误不会重试，
// 不影响探针判读。client = model.ts 供 deepseek provider 用的同一个单例。
const client = model;

console.log(`模型: ${modelName}\n地址: ${baseURL}\n`);

// —— 两段伪造的思考记录（够长以便从 usage 里量出差异；中文 ≈1 字/token）——
const THINK_OLD = "用户让我算 2+2。这是个加法运算，我应该调用 calc 工具来完成，表达式就是 2+2。" +
    "调用前我先确认参数格式：expr 是字符串，填 2+2 即可。工具返回后我再把结果交给下一步乘法使用。" +
    "这一步不需要向用户额外解释，直接调工具最干净。如果工具出错我再降级心算并说明。";
const THINK_LATEST = "拿到上一步结果 4。现在要乘以 10，继续用 calc 工具，表达式 4*10。" +
    "参数同样走 expr 字符串。拿到结果后再按用户要求总结成一句话，注意把两步运算都说清楚。" +
    "这一轮结束后就应该有最终答案了，不要再发起新的工具调用。";

// —— 两轮工具调用的对话：assistant#1 = 历史轮、assistant#2 = 最近轮 ——
// ★ 用产品真实形态：纯工具轮 content = null（buildAssistantMessage 产出 content: contentBuf || null）。
//   2026-09-10 首轮探针用 content: "" 时四个变体全 200（含全剥）；案底 400 是 content: null 形态——
//   本轮把 content 形态作为变量钉进来。
type Msg = { role: string; content: string | null; reasoning_content?: string; tool_calls?: any[]; tool_call_id?: string };
const baseConversation: (Msg & { tag?: "old" | "latest" })[] = [
    { role: "system", content: "你是计算助手，所有计算必须调用 calc 工具完成。" },
    { role: "user", content: "帮我算 2+2，然后把结果乘以 10。" },
    {
        role: "assistant", content: null, reasoning_content: THINK_OLD, tag: "old",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "calc", arguments: '{"expr":"2+2"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "4" },
    {
        role: "assistant", content: null, reasoning_content: THINK_LATEST, tag: "latest",
        tool_calls: [{ id: "call_2", type: "function", function: { name: "calc", arguments: '{"expr":"4*10"}' } }],
    },
    { role: "tool", tool_call_id: "call_2", content: "40" },
    { role: "user", content: "把两步的结果总结成一句话告诉我。" },
];

const tools = [{
    type: "function",
    function: {
        name: "calc",
        description: "四则运算计算器",
        parameters: {
            type: "object",
            properties: { expr: { type: "string", description: "算式，如 2+2" } },
            required: ["expr"],
        },
    },
}];

// 剥法矩阵：剥 reasoning 时 content 兜底成 ""（emptyFallback）与否，是第二个变量
const variants = [
    { name: "V0 全部回传（现状基线）", keepOld: true, keepLatest: true, emptyFallback: false },
    { name: "V1 剥历史轮（content 保持 null）", keepOld: false, keepLatest: true, emptyFallback: false },
    { name: "V2 剥历史轮 + content 兜底空串", keepOld: false, keepLatest: true, emptyFallback: true },
    { name: "V3 全剥（content 保持 null）", keepOld: false, keepLatest: false, emptyFallback: false },
    { name: "V4 全剥 + content 兜底空串", keepOld: false, keepLatest: false, emptyFallback: true },
];

const results: { name: string; ok: boolean; status: string; promptTokens?: number; detail: string }[] = [];

for (const v of variants) {
    const messages = baseConversation.map((m) => {
        const strip = (m.tag === "old" && !v.keepOld) || (m.tag === "latest" && !v.keepLatest);
        if (!strip) return m;
        const { reasoning_content, ...rest } = m;
        return v.emptyFallback && rest.content === null ? { ...rest, content: "" } : rest;
    });
    process.stdout.write(`▶ ${v.name} ... `);
    try {
        const resp: any = await client.chat.completions.create({
            messages: messages as any,
            model: modelName,
            tools: tools as any,
            tool_choice: "auto",
            thinking: { type: "enabled" },
            reasoning_effort: "high",
            stream: false,
        } as any);
        const content = resp.choices?.[0]?.message?.content ?? "";
        results.push({
            name: v.name, ok: true, status: "200",
            promptTokens: resp.usage?.prompt_tokens,
            detail: `回复前 40 字：${String(content).replace(/\n/g, " ").slice(0, 40)}`,
        });
        console.log(`✅ 200，prompt_tokens=${resp.usage?.prompt_tokens}`);
    } catch (e: any) {
        const status = e?.status ?? "?";
        const msg = String(e?.message ?? e).slice(0, 120);
        results.push({ name: v.name, ok: false, status: String(status), detail: msg });
        console.log(`❌ ${status}：${msg}`);
    }
}

// —— 结论判读（矩阵：剥 reasoning × content 形态）——
const byName = (frag: string) => results.find((r) => r.name.includes(frag))!;
const v0 = byName("V0"), v1 = byName("V1"), v2 = byName("V2"), v3 = byName("V3"), v4 = byName("V4");

console.log("\n" + "=".repeat(70));
if (!v0.ok) {
    console.log("⚠️ 连基线 V0 都失败——探针本身没搭对（对话形态/模型/参数问题），以下判读无效。");
    console.log(`   V0 错误：${v0.detail}`);
} else if (v1.ok) {
    // 产品形态（content null）下剥历史轮直接成功——content 形态无关紧要
    console.log("✅ 结论：产品真实形态（content:null）下剥历史轮也 200 —— 剥历史 reasoning 安全，直接落地。");
    if (v3.ok) console.log("   且全剥（V3）也收——协议实际不强制回传任何历史思考记录。");
} else if (v2.ok) {
    // content null + 无 reasoning 会 400，但兜底空串就收 —— 案底 400 的真正条件被钉死
    console.log("✅ 结论钉死：400 的真正条件 = 【content:null 且无 reasoning_content】的工具轮；");
    console.log("   剥 reasoning 时把 content 兜底成空串（\"\"）即可安全剥除 —— 落地方案：剥离器顺带改写 content。");
} else {
    console.log("❌ 结论：content null 形态下剥历史/全剥都 400 —— 案底复现，协议按最严格口径执行，");
    console.log(`   V1 错误：${v1.detail}`);
    console.log(`   V2 错误：${v2.detail}`);
}
const v0p = v0.promptTokens, vBest = [v1, v2, v3, v4].filter((r) => r.ok && r.promptTokens).sort((a, b) => a.promptTokens! - b.promptTokens!)[0];
if (v0.ok && vBest?.promptTokens) {
    const saved = v0p! - vBest.promptTokens;
    console.log(`   体积对照：V0=${v0p} tok → 最省可行 V=${vBest.promptTokens} tok（省 ${saved} tok，占 ${(((saved) / v0p!) * 100).toFixed(1)}%）`);
}
