/**
 * @file tests/run-ledger.test.ts
 * @description runLedger（agent/runLedger.ts，成本账本收拢——Agent内核打磨计划 B 批）守门测试：
 *  分/并账矩阵（五笔入账各自进正确的落盘账 + 全部进预算圈，逐笔断言）/ 入账守卫（NaN/0/负数忽略——
 *  NaN 进圈则硬截断恒 false 且静默失效）/ 观察者转发（usage 缺省仍转发 + 抛错被吞）/ 无价模型
 *  costKnown=false（receipt.costYuan=null 绝不编数）/ overHardLimit >= 1.2× 边界 / flushRelay 幂等 +
 *  基数实时读（子树完整口径，depth=2 模拟）/ 舍入红线（入账点裸浮点累计、快照点才六位舍入）/
 *  结构断言（中继基数钉在预算圈变量 + budgetYuan 调用处收窄 + 1.2× 硬线单点常量）。
 *  计价确定性：账本内部按「当时时刻」判峰谷档，金额期望值用 calcCostYuan 现算现比（调用点前后双锚，
 *  判档恰在测试瞬间翻转则跳过该笔精确比对——频率 ≈ 每日 4 次 × 微秒窗口）；DEEP_SEEK_PRICE_* /
 *  DEEP_SEEK_AUX_MODEL 在 import 前清场（env 快照模块加载时定格）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// —— env 清场先于动态 import（prices/client 的 env 快照模块加载时定格，防宿主机配置串味）——
delete process.env.DEEP_SEEK_PRICE_INPUT;
delete process.env.DEEP_SEEK_PRICE_OUTPUT;
delete process.env.DEEP_SEEK_PRICE_CACHEHIT;
delete process.env.DEEP_SEEK_AUX_MODEL;

const { createRunLedger, roundYuan6 } = await import("@/agent/runLedger.ts");
const { calcCostYuan } = await import("@/config/prices.ts");
const { AUX_MODEL_NAME } = await import("@/llm/providers/deepseek/client.ts");

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(CORE_ROOT, rel), "utf-8");

const U1 = { prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000, cached_tokens: 0 };
const U2 = { prompt_tokens: 800_000, completion_tokens: 300_000, total_tokens: 1_100_000, cached_tokens: 200_000 };

/** 入账动作前现算期望金额，动作后再算一次作判档双锚：两锚一致（常态）返回期望值，不一致（判档边界翻转）返回 null。 */
const anchoredCost = (book: () => void, model: string, u: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }): number | null => {
    const before = calcCostYuan(model, u);
    book();
    const after = calcCostYuan(model, u);
    return before != null && before === after ? before : null;
};

describe("runLedger 分账：五笔入账各进正确的落盘账", () => {
    it("addUsage：主模型 token 账入 costYuan + usageSum 逐字段累计；无价模型 costKnown=false → costYuan=null 绝不编数", () => {
        const l = createRunLedger({ model: "deepseek-flash" });
        const expect = anchoredCost(() => l.addUsage(U1), "deepseek-flash", { promptTokens: U1.prompt_tokens, completionTokens: U1.completion_tokens, cachedTokens: U1.cached_tokens });
        if (expect != null) assert.equal(l.receiptFields().costYuan, roundYuan6(expect), "落盘金额 = calcCostYuan 当时单价折算");
        assert.deepEqual(l.usageSummary(), U1, "usageSum 首笔原样");
        l.addUsage(U2);
        assert.equal(l.usageSummary()?.prompt_tokens, 1_800_000, "多轮累计（1M+0.8M）");
        assert.equal(l.usageSummary()?.cached_tokens, 200_000);
        // 无价模型：token 照常累计、钱一律不发
        const nv = createRunLedger({ model: "no-such-model-in-prices" });
        nv.addUsage(U1);
        assert.equal(nv.receiptFields().costYuan, null, "receipt 显式 null（「不知钱」，不编数）");
        assert.equal(nv.usageLogFields().costYuan, undefined, "usageLog 省略字段");
        assert.equal(nv.usageSummary()?.total_tokens, 1_500_000, "token 照常累计");
    });

    it("addToolCost/reportAuxUsage/reportSubCost 各进各的落盘账；subCost 刻意不进 usageLog（防双重计量）", () => {
        const l = createRunLedger({ model: "deepseek-flash" });
        l.addToolCost(0.005);
        l.reportSubCost(0.1);
        const auxU = { prompt_tokens: 100_000, completion_tokens: 0, total_tokens: 100_000, cached_tokens: 0 };
        const auxExpect = anchoredCost(() => l.reportAuxUsage(auxU, "compact"), AUX_MODEL_NAME, { promptTokens: 100_000, completionTokens: 0, cachedTokens: 0 });
        const rc = l.receiptFields();
        const ul = l.usageLogFields();
        assert.equal(rc.toolCostYuan, 0.005);
        assert.equal(ul.toolCostYuan, 0.005);
        assert.equal(rc.subCostYuan, 0.1, "Q12：子账并列展示");
        assert.ok(auxExpect == null || rc.auxCostYuan === roundYuan6(auxExpect), "aux 账按 AUX_MODEL_NAME 计价");
        assert.ok(!("subCostYuan" in ul), "子账绝不进 usageLog——落盘按 run 自身记账、读侧按 depth 拆分，并入即同笔钱计两次");
    });

    it("零账 run：三份快照同形于收拢前（costYuan=0 非 null、各账 ≤0 经 JSON 序列化后省略字段）", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 1 });
        assert.deepEqual(JSON.parse(JSON.stringify(l.usageLogFields())), { costYuan: 0 }, "usageLog.costYuan=0 合法值（costKnown 未被推翻）；undefined 账序列化后省略（消费方视角）");
        assert.deepEqual(JSON.parse(JSON.stringify(l.receiptFields())), { costYuan: 0 });
        assert.equal(l.usageSummary(), undefined, "空 run usageSum undefined（receipt 不发零单的门禁依据）");
    });
});

describe("runLedger 并账：五笔全部进预算圈（缺任一笔 = 该类调用打穿预算制）", () => {
    it("addUsage 并入预算圈（与落盘账同笔同额）", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 10 });
        l.addUsage(U1);
        const st = l.getBudgetStatus()!;
        assert.equal(st.budget, 10);
        assert.ok(st.spent > 0, "token 花费进预算圈");
        assert.equal(roundYuan6(st.spent), l.receiptFields().costYuan, "预算圈与落盘账同笔同额（舍入口径差内）");
    });
    it("addToolCost 并入预算圈（按次花费同为真金白银）", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 10 });
        l.addToolCost(0.005);
        assert.equal(l.getBudgetStatus()!.spent, 0.005);
    });
    it("reportAuxUsage 并入预算圈（压缩/分类调用不打穿预算）", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 10 });
        const auxU = { prompt_tokens: 100_000, completion_tokens: 0, total_tokens: 100_000, cached_tokens: 0 };
        const expect = anchoredCost(() => l.reportAuxUsage(auxU, "classify"), AUX_MODEL_NAME, { promptTokens: 100_000, completionTokens: 0, cachedTokens: 0 });
        if (expect != null) assert.equal(roundYuan6(l.getBudgetStatus()!.spent), roundYuan6(expect));
    });
    it("reportSubCost 并入预算圈 + 展示账（父预算自动继承子花费）", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 10 });
        l.reportSubCost(0.1);
        assert.equal(l.getBudgetStatus()!.spent, 0.1);
        assert.equal(l.receiptFields().subCostYuan, 0.1);
    });
    it("未武装（budgetYuan 缺省）：getBudgetStatus/budgetSnapshot 返回 null、overHardLimit 恒 false", () => {
        const l = createRunLedger({ model: "deepseek-flash" });
        l.reportSubCost(99);
        assert.equal(l.getBudgetStatus(), null);
        assert.equal(l.budgetSnapshot(), null);
        assert.equal(l.overHardLimit(), false);
    });
});

describe("runLedger 入账守卫与观察者（R14）", () => {
    it("入账守卫：NaN/0/负数/Infinity 被忽略，spent 不变（NaN 进圈 → 硬截断恒 false 静默失效）", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 10 });
        l.reportSubCost(1);
        for (const bad of [Number.NaN, 0, -0.5, Number.POSITIVE_INFINITY]) {
            l.addToolCost(bad);
            l.reportSubCost(bad);
        }
        assert.equal(l.getBudgetStatus()!.spent, 1, "预算圈零污染");
        assert.equal(l.receiptFields().toolCostYuan, undefined, "脏值不落盘");
        assert.equal(l.receiptFields().subCostYuan, 1);
        l.addUsage(undefined);
        assert.equal(l.usageSummary(), undefined, "addUsage(undefined) no-op（流式无统计轮）");
        assert.equal(l.getBudgetStatus()!.spent, 1);
    });
    it("观察者转发：usage 缺省仍转发（流式无统计轮不失联）；观察者抛错被吞不击垮", () => {
        const seen: any[] = [];
        const l = createRunLedger({ model: "deepseek-flash", onAuxUsage: (u, k) => seen.push([u, k]) });
        l.reportAuxUsage(undefined, "compact");
        assert.deepEqual(seen, [[undefined, "compact"]], "缺 usage 也必须转发（runAgent 原无条件转发语义）");
        const boom = createRunLedger({ model: "deepseek-flash", onAuxUsage: () => { throw new Error("observer boom"); } });
        assert.doesNotThrow(() => boom.reportAuxUsage(undefined, "classify"));
        assert.doesNotThrow(() => boom.reportAuxUsage({ prompt_tokens: 1 }, "classify"), "计价后转发抛错同样被吞");
    });
});

describe("runLedger 预算硬线（E2）", () => {
    it("overHardLimit：>= 语义与收拢前逐字节等价——恰 1.2× 即触发、1.19× 不触发（计划 §2.4-2「恰=1.2× 不触发」系笔误，以现状为准）", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 1 });
        l.reportSubCost(1.19);
        assert.equal(l.overHardLimit(), false);
        l.reportSubCost(0.01);
        assert.equal(l.overHardLimit(), true, "spent = budget×1.2 恰等即触发（原 runAgent >= 语义）");
    });
    it("1.2× 阈值单点常量；runAgent 不再内联硬线算式（调用处收窄与指针除外）", () => {
        const rl = readRepo("src/agent/runLedger.ts");
        assert.match(rl, /export const BUDGET_HARD_LIMIT_RATIO = 1\.2/, "硬线倍率单点定义");
        const ra = readRepo("src/agent/runAgent.ts");
        assert.ok(!/budgetYuan!?\s*\*\s*1\.2/.test(ra), "runAgent 不得再内联 budgetYuan×1.2");
    });
});

describe("runLedger 子 run 成本中继（P1-5）", () => {
    it("flushRelay：幂等只报正增量；基数实时读（含自身三账与刚回灌的 reportSubCost）", () => {
        const sinked: number[] = [];
        const l = createRunLedger({ model: "deepseek-flash", costSink: (y) => sinked.push(y) });
        l.reportSubCost(0.5);
        l.flushRelay();
        assert.deepEqual(sinked, [0.5]);
        l.flushRelay();
        assert.deepEqual(sinked, [0.5], "同基数重复 flush 幂等零副作用");
        l.addToolCost(0.25);
        l.flushRelay();
        assert.deepEqual(sinked, [0.5, 0.25], "只报正增量");
    });
    it("flushRelay 子树完整口径：孙代经子 ledger costSink 回灌父 reportSubCost 后，父 flush 报含孙代总额（depth=2 模拟）", () => {
        const rootSink: number[] = [];
        const parent = createRunLedger({ model: "deepseek-flash", costSink: (y) => rootSink.push(y) });
        const child = createRunLedger({ model: "deepseek-flash", costSink: (y) => parent.reportSubCost(y) });
        child.reportSubCost(0.3); // 孙代花费经 child 记账
        child.flushRelay();       // child 中继 → parent.reportSubCost（父预算圈即时含孙代）
        parent.flushRelay();
        assert.deepEqual(rootSink, [0.3], "孙代花费到根（旧缺陷：只报自身三账会困在中继层以下）");
        parent.addToolCost(0.2);
        parent.flushRelay();
        assert.deepEqual(rootSink, [0.3, 0.2], "父自身入账后仍只报增量");
        assert.equal(parent.receiptFields().subCostYuan, 0.3, "经中继回灌的孙代钱记展示账");
    });
    it("无 sink（主 run）：flushRelay 为 no-op 不抛", () => {
        const l = createRunLedger({ model: "deepseek-flash" });
        l.reportSubCost(5);
        assert.doesNotThrow(() => l.flushRelay());
    });
});

describe("runLedger 舍入红线（R4）", () => {
    it("入账点裸浮点累计（轨迹不改）、快照点才六位舍入——舍入下沉会漂移 1.2× 截断轮次", () => {
        const l = createRunLedger({ model: "deepseek-flash", budgetYuan: 1 });
        l.reportSubCost(0.1);
        l.reportSubCost(0.1);
        l.reportSubCost(0.1);
        const spent = l.getBudgetStatus()!.spent;
        assert.equal(spent, 0.1 + 0.1 + 0.1, "spent 与逐笔直接累加严格相等（裸浮点轨迹）");
        assert.notEqual(spent, roundYuan6(spent), "若入账点被舍入，本断言失败（0.3000…4 ≠ 0.3）");
        assert.equal(l.receiptFields().subCostYuan, 0.3, "快照输出点六位舍入");
    });
});

describe("runLedger 结构守门", () => {
    it("flushRelay 基数必须是预算圈变量（防改回自身三账丢 depth≥2 孙代）", () => {
        const rl = readRepo("src/agent/runLedger.ts");
        assert.match(rl, /relay\.flush\(budgetSpentYuan\)/, "中继基数=预算圈（子树完整口径）");
        assert.ok(!/flush\((costYuanAcc|toolCostYuanAcc|auxCostYuanAcc|subCostYuanAcc)\)/.test(rl), "禁用任何单账做基数");
    });
    it("runAgent 侧：budgetYuan 调用处收窄（R5：工厂拿不到 depth，!= null 链保留）", () => {
        const ra = readRepo("src/agent/runAgent.ts");
        assert.match(ra,
            /budgetYuan: depth === 0 && options\.budgetYuan != null && options\.budgetYuan > 0 \? options\.budgetYuan : undefined/,
            "预算圈武装条件在调用处收窄（NaN/undefined 边界与改前同判）");
    });
});
