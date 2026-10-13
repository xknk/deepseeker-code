/**
 * @file tests/prices.test.ts
 * @description 价格表与折算（config/prices.ts，成本信任链第一环 D1）守门测试：
 *  官网价表条目 / 折算算式与缓存命中口径（非缓存输入 = prompt − cached）/ 无价模型 null（不编数）/
 *  env 覆盖（逐字段覆盖 + 未设字段回退表价 + 无效值忽略 + 三键不全不造 env-only 条目）。
 *  env 快照在模块加载时定格 → DEEP_SEEK_PRICE_* 必须先设后动态 import（同 usage-log.test.ts 惯例）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// 固定 env 场景：input=2（覆盖表价 1）、output 无效值（忽略回退）、cacheHit 未设（回退表价）
process.env.DEEP_SEEK_PRICE_INPUT = "2";
process.env.DEEP_SEEK_PRICE_OUTPUT = "not-a-number";

const { MODEL_PRICES, priceFor, calcCostYuan } = await import("@/config/prices.ts");

test("官网价表：SELECTABLE_MODELS 内两模型有条目，vision-exp 官网无价刻意无条目", () => {
    assert.deepEqual(MODEL_PRICES["deepseek-flash"], { input: 1, output: 2, cacheHit: 0.02 });
    assert.deepEqual(MODEL_PRICES["deepseek-v4-pro"], { input: 3, output: 6, cacheHit: 0.025 });
    assert.equal(MODEL_PRICES["deepseek-flash-vision-exp"], undefined);
});

test("calcCostYuan：基础算式与缓存命中口径（非缓存输入 = prompt − cached）", () => {
    // ★ 本文件顶部 env 已覆盖 input=2（快照全局生效），算式按覆盖后单价验证（公式与单价来源解耦；
    //   表价本身由 MODEL_PRICES deepEqual 测试守护）
    // 1M 未命中输入 + 1M 输出 = 1M×2(env input) + 1M×2(表 output) = 4 元
    assert.equal(calcCostYuan("deepseek-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 }), 4);
    // 0.5M 命中 + 0.5M 未命中 + 1M 输出 = 0.5M×0.02 + 0.5M×2(env input) + 1M×2 = 3.01 元
    assert.ok(Math.abs(calcCostYuan("deepseek-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 })! - 3.01) < 1e-9);
    // 全零 usage → 0（合法值，非 null）
    assert.equal(calcCostYuan("deepseek-flash", {}), 0);
    // cached > prompt 脏数据：miss 下限 0，不出现负成本
    assert.ok(calcCostYuan("deepseek-flash", { promptTokens: 100, cachedTokens: 500, completionTokens: 0 })! >= 0);
});

test("无价模型：返回 null（不编数，上层只显 token）", () => {
    assert.equal(calcCostYuan("deepseek-flash-vision-exp", { promptTokens: 1000, completionTokens: 100 }), null);
    assert.equal(calcCostYuan("unknown-model", { promptTokens: 1000 }), null);
});

test("env 覆盖：所设字段覆盖、未设字段回退表价、无效值忽略", () => {
    // input=2（env 覆盖）、output 无效值忽略（回退表价 2）、cacheHit 未设（回退表价 0.02）
    assert.deepEqual(priceFor("deepseek-flash"), { input: 2, output: 2, cacheHit: 0.02 });
    // 折算随 env 价变化：1M 未命中输入 + 1M 输出 = 2×1(env) + 2×1(表) = 4 元
    assert.equal(calcCostYuan("deepseek-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000 }), 4);
});

test("env 三键不全：无表价模型仍为 null（env-only 条目须三键全设，用户声明价才算数）", () => {
    assert.equal(priceFor("deepseek-flash-vision-exp"), null);
});
