/**
 * @file tests/compression-pretruncate.test.ts
 * @description 压缩熔断单点治理（路线 #7，2026-09-16）契约测试：
 *  - splitIntoBatches 超预算单元确定性预截断：批预算不变量（进辅助模型的每个请求 ≤ 预算）、
 *    配对完整、原消息零改写（压缩失败可重试全文）、折叠视图带 recall 检索指引、头尾保留；
 *  - ensureFitsWindow 巨型工具结果（超辅助模型窗口）→ 压缩成功、会话可续，不再 3 连败熔断；
 *  - 真连败（辅助模型持续故障）熔断文案指真根因 + 自愈指引（重试复位 / /fork / /new），
 *    不再误导性指向「网络/提供商崩溃」。
 *  辅助模型窗口用假 provider 按请求序列化体积模拟（超窗即 400 context_length_exceeded）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒惯例：dataDir 指向临时目录，防模块初始化读真实 ~/.deepseeker-code。
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-compression-pretrunc-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑，见 replay.test.ts 注）。
const { splitIntoBatches, pretruncateOversizedUnit, ensureFitsWindow, MAX_BATCH_TOKENS } =
    await import("@/agent/truncate.ts");
const { estimateTokens } = await import("@/session/contextCore.ts");
const { setActiveProvider, resetActiveProvider } = await import("@/llm/model.ts");
const { getRollingState } = await import("@/session/store.ts");

// ==================== 假 provider：按请求序列化体积模拟辅助模型窗口 ====================

/** 构造「超窗即 400」的假 provider：summarize 记录每次请求体积，超窗抛 context_length_exceeded。 */
const makeWindowedProvider = (auxWindowChars: number, opts?: { alwaysFail?: boolean; failError?: Error }) => {
    const summarizeSizes: number[] = [];
    const provider: any = {
        id: "fake", displayName: "Fake", modelLabel: "Fake",
        streamChat: async function* () { /* e2e 只走 summarize */ },
        classifyRisk: async () => "risky",
        buildAssistantMessage: (p: any) => ({ role: "assistant", content: p.content ?? "" }) as any,
        isContextLengthError: (e: any) => e?.status === 400,
        isTransientError: () => false,
        isImageUnsupportedError: () => false,
        summarize: async (messages: any[]) => {
            const size = JSON.stringify(messages).length;
            summarizeSizes.push(size);
            if (opts?.alwaysFail) throw opts.failError ?? new Error("模拟辅助模型持续故障");
            if (size > auxWindowChars) {
                const err: any = new Error(`This model's maximum context length is ${auxWindowChars} tokens`);
                err.status = 400;
                err.code = "context_length_exceeded";
                throw err;
            }
            return { choices: [{ message: { content: "Fake 摘要：完成了构造超窗口工具结果并验证压缩可续。" } }] } as any;
        },
    };
    return { provider, summarizeSizes };
};

/** 挂载假 provider 执行 fn，结束复位（防泄漏影响其它测试）。 */
const withProvider = async <T>(provider: any, fn: () => Promise<T>): Promise<T> => {
    setActiveProvider(provider);
    try {
        return await fn();
    } finally {
        resetActiveProvider();
    }
};

/** 构造含巨型工具结果的历史：assistant(tool_calls) + tool(超大输出) = 超预算不可分割单元。 */
const buildHistoryWithGiantResult = (giantContent: string): { messageArr: any[]; origToolMsg: any; origAssistantMsg: any } => {
    const origAssistantMsg = {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "run_command", arguments: '{"command":"cat huge.log"}' } }],
    };
    const origToolMsg = { role: "tool", tool_call_id: "call_1", content: giantContent };
    const messageArr = [
        { role: "system", content: "SYS" },
        { role: "system", content: "" }, // 摘要槽
        { role: "user", content: "任务背景：读大日志并总结要点" },
        origAssistantMsg,
        origToolMsg,
        { role: "assistant", content: "已读取完毕，开始整理" },
        { role: "user", content: "继续" },
    ];
    return { messageArr, origToolMsg, origAssistantMsg };
};

// ==================== 预截断契约（splitIntoBatches / pretruncateOversizedUnit） ====================

describe("splitIntoBatches 超预算单元确定性预截断", () => {
    it("巨型 ASCII 工具结果：批预算不变量成立，配对完整，原消息零改写", () => {
        const giant = "A".repeat(200_000); // ≈50K token（结构化 ÷4 口径），远超 16K 批预算与常见辅助模型窗口
        const { messageArr, origToolMsg } = buildHistoryWithGiantResult(giant);
        const toCompact = messageArr.slice(2, 6); // user + 巨型单元 + assistant（模拟 splitUntils 切出的待压缩区）

        const batches = splitIntoBatches(toCompact);

        // 不变量：进辅助模型的每个批次都在预算内
        for (const b of batches) {
            assert.ok(estimateTokens(b) <= MAX_BATCH_TOKENS, `批次超预算：${estimateTokens(b)} > ${MAX_BATCH_TOKENS}`);
        }
        // 消息一条不丢
        assert.equal(batches.flat().length, toCompact.length);
        // 配对完整：assistant(tool_calls) 与其 tool 结果同批
        const giantBatch = batches.find(b => b.some((m: any) => m.tool_call_id === "call_1"))!;
        const roles = giantBatch.map((m: any) => m.role);
        assert.ok(roles.includes("assistant") && roles.includes("tool"), `配对被拆散：${roles.join(",")}`);
        // 原消息零改写（新对象 + 原文原样）
        const folded: any = giantBatch.find((m: any) => m.role === "tool");
        assert.notEqual(folded, origToolMsg, "折叠视图必须是新对象，不得原地改写活动历史");
        assert.equal(origToolMsg.content, giant, "原消息 content 必须原样保留（压缩失败可重试全文）");
        // 折叠标记带 recall 检索指引，头尾保留
        assert.match(folded.content, /recall/, "折叠视图应指引模型经 recall 检索全文");
        assert.ok(folded.content.length < giant.length / 2, "折叠后体量应显著小于原文");
        assert.ok(folded.content.startsWith("A".repeat(64)), "应保留头部");
        assert.ok(folded.content.endsWith("A".repeat(64)), "应保留尾部");
    });

    it("CJK 重型结果 + 多工具并行单元：迭代折叠至入预算，全部工具结果保留在批内", () => {
        // 3 个并行 read 各回 8000 中文（1:1 折算 8K token/条，单元合计 24K+ > 16K 预算）
        const toolMsg = (id: string) => ({ role: "tool", tool_call_id: id, content: "错".repeat(8_000) });
        const unit: any[] = [
            {
                role: "assistant", content: null,
                tool_calls: ["a", "b", "c"].map(id => ({ id: `call_${id}`, type: "function", function: { name: "read_file", arguments: `{"path":"${id}.txt"}` } })),
            },
            toolMsg("call_a"), toolMsg("call_b"), toolMsg("call_c"),
        ];
        const batches = splitIntoBatches([unit[0], unit[1], unit[2], unit[3]]);
        for (const b of batches) {
            assert.ok(estimateTokens(b) <= MAX_BATCH_TOKENS, `批次超预算：${estimateTokens(b)}`);
        }
        const flat = batches.flat();
        assert.equal(flat.length, 4, "配对消息一条不丢");
        const foldedTools = flat.filter((m: any) => m.role === "tool");
        assert.equal(foldedTools.length, 3, "三条工具结果都应保留（保配对）");
        assert.ok(foldedTools.some((m: any) => m.content.includes("压缩预截断")), "至少最大的一条被折叠");
    });

    it("正常体量单元零改写：不误伤（无预截断标记、消息引用原样）", () => {
        const msgs: any[] = [
            { role: "user", content: "普通消息" },
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
            { role: "tool", tool_call_id: "c1", content: "普通输出" },
            { role: "assistant", content: "完成" },
        ];
        const batches = splitIntoBatches(msgs);
        const flat = batches.flat();
        assert.equal(flat.length, msgs.length);
        assert.deepEqual(flat, msgs, "正常体量消息应逐字节原样（无折叠标记、无对象拷贝）");
        for (let i = 0; i < flat.length; i++) assert.equal(flat[i], msgs[i], "引用应保持原消息对象");
    });

    it("数组 content（含贴图）超预算单元：先脱水为 string 再折叠，产出纯文本视图", () => {
        const bigText = "图".repeat(40_000); // CJK 1:1 ≈ 40K token
        const unit: any[] = [
            { role: "user", content: [{ type: "text", text: bigText }] },
        ];
        const out = pretruncateOversizedUnit(unit);
        assert.ok(estimateTokens(out) <= MAX_BATCH_TOKENS, "预截断后应入预算");
        assert.equal(typeof (out[0] as any).content, "string", "数组 content 应折叠为纯 string（text-only 辅助模型口径）");
        assert.match((out[0] as any).content, /压缩预截断/);
        assert.notEqual(out[0], unit[0], "不得改写原消息");
    });
});

// ==================== 端到端：巨型结果不再熔断 / 熔断文案指真根因 ====================

/** ensureFitsWindow 最小入参（校准系数显式给 1，排除估算噪声）。 */
const buildEvent = (sessionId: string, messageArr: any[]) => ({
    sessionId,
    messageArr,
    depth: 0,
    keepRecentUnits: 1,
    compactRatio: 0.5,   // 阈值 = 30000 × 0.5 = 15000 token，巨型单元必触发压缩
    modelWindow: 30000,
    correctionRatio: 1,
    toolsTokens: 0,
    events: (() => { }) as any,
});

describe("ensureFitsWindow 巨型工具结果：压缩成功、会话可续（不再 3 连败熔断）", () => {
    it("超辅助模型窗口的 run_command 输出 → 每次请求都落在窗口内，压缩落盘、失败计数清零", async () => {
        const { provider, summarizeSizes } = makeWindowedProvider(30_000); // 模拟 30K 字符窗的辅助模型
        const giant = "错".repeat(40_000); // CJK 1:1 ≈ 40K token，直接超窗
        const { messageArr, origToolMsg } = buildHistoryWithGiantResult(giant);

        await withProvider(provider, async () => {
            // 旧实现：巨型单元独占一批硬送 → 400 → 失败计数 +1（红）；新实现：预截断后成功（绿）
            await ensureFitsWindow(buildEvent("pretrunc-e2e-ok", messageArr));
        });

        // 每次摘要请求都落在模拟窗口内（从未发出过必然 400 的请求）
        assert.ok(summarizeSizes.length > 0, "应至少发起一次摘要请求");
        for (const s of summarizeSizes) {
            assert.ok(s <= 30_000, `摘要请求超辅助模型窗口：${s} > 30000`);
        }
        // 压缩事实落盘：历史收缩为 [system, 摘要槽, ...保留区]，失败计数清零
        assert.equal(messageArr.length, 3, `压缩后应只剩 system+摘要槽+保留区，实际 ${messageArr.length}`);
        assert.equal((messageArr[1] as any).content.includes("⟦DSC:ARCHIVE-INDEX⟧"), true, "摘要槽应为双段结构");
        const store = await getRollingState("pretrunc-e2e-ok");
        assert.equal(store.consecutiveFailures, 0, "压缩成功应清零失败计数");
        assert.ok(store.rollingSummary.includes("Fake 摘要"), "滚动摘要应包含合成产物");
        // 原消息零改写（活动历史里被归档的消息原文仍完整）
        assert.equal(origToolMsg.content, giant);
    });

    it("辅助模型持续故障 → 3 连败物理熔断，文案指真根因 + 自愈指引（不再误导为提供商崩溃）", async () => {
        const { provider } = makeWindowedProvider(30_000, {
            alwaysFail: true,
            failError: new Error("模拟辅助模型宕机"),
        });
        // ★ 体量取「超压缩阈值、低于兜底线」区间（真实熔断可达区）：17K token 超压缩阈值(15000)
        //   触发压缩，但低于兜底 0.63×30000=18900——否则每轮失败先撞「上下文超窗口」throw，轮不到熔断计数。
        const giant = "错".repeat(17_000);
        const { messageArr } = buildHistoryWithGiantResult(giant);
        const sessionId = "pretrunc-e2e-melt";

        await withProvider(provider, async () => {
            await ensureFitsWindow(buildEvent(sessionId, messageArr)); // 失败 1
            await ensureFitsWindow(buildEvent(sessionId, messageArr)); // 失败 2
            await assert.rejects(
                () => ensureFitsWindow(buildEvent(sessionId, messageArr)), // 失败 3 → 熔断
                (e: any) => {
                    assert.match(e.message, /压缩熔断/, "应保留熔断语义");
                    assert.match(e.message, /DEEP_SEEK_AUX_MODEL|辅助模型/, "应指向真实根因（辅助模型服务）");
                    assert.match(e.message, /\/fork/, "应给出 /fork 自愈指引");
                    assert.match(e.message, /\/new/, "应给出 /new 自愈指引");
                    assert.ok(!e.message.includes("请排查网络或大模型提供商是否崩溃"), "不得保留旧误导文案");
                    return true;
                },
            );
        });

        const store = await getRollingState(sessionId);
        assert.equal(store.consecutiveFailures, 3, "连败计数应落盘累计");
    });
});
