/**
 * @file tests/prices.test.ts
 * @description 价格表与折算（config/prices.ts，成本信任链第一环 D1）守门测试：
 *  官网峰谷双档价表 / 峰谷时段判定（isBeijingPeak）/ 折算算式与缓存命中口径（非缓存输入 = prompt − cached）/
 *  官方账单对账回归钉（2026-10-16 事故：旧表少报 2.7 倍，本钉防再犯）/ 无价模型 null（不编数）/
 *  env 覆盖（逐字段覆盖 + 未设字段回退表价 + 无效值忽略 + 三键不全不造 env-only 条目）。
 *  env 快照在模块加载时定格 → DEEP_SEEK_PRICE_* 必须先设后动态 import（同 usage-log.test.ts 惯例）。
 *  ★ 峰谷测试全部传显式 ts（判档锚定），不依赖测试运行时刻——任何时间跑结果恒定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// 固定 env 场景：input=2（覆盖表价）、output 无效值（忽略回退）、cacheHit 未设（回退表价）
process.env.DEEP_SEEK_PRICE_INPUT = "2";
process.env.DEEP_SEEK_PRICE_OUTPUT = "not-a-number";

const { MODEL_PRICES, priceFor, calcCostYuan, isBeijingPeak, pricesAgeDays, PRICES_VERIFIED_AT } = await import("@/config/prices.ts");

// 判档锚点（2026-10-16 = 周五；北京时间 = UTC+8）：09:30 高峰 / 12:30 空闲
const PEAK_TS = new Date("2026-10-16T01:30:00Z"); // 北京周五 09:30
const IDLE_TS = new Date("2026-10-16T04:30:00Z"); // 北京周五 12:30（午间空闲档）

test("官网峰谷价表：两模型 idle/peak 双档条目，vision-exp 官网无价刻意无条目", () => {
    assert.deepEqual(MODEL_PRICES["deepseek-flash"], {
        idle: { input: 1, output: 4, cacheHit: 0.02 },
        peak: { input: 2, output: 8, cacheHit: 0.04 },
    });
    assert.deepEqual(MODEL_PRICES["deepseek-v4-pro"], {
        idle: { input: 4.5, output: 13.5, cacheHit: 0.15 },
        peak: { input: 9, output: 27, cacheHit: 0.3 },
    });
    assert.equal(MODEL_PRICES["deepseek-flash-vision-exp"], undefined);
});

test("isBeijingPeak：工作日 9–12/14–18 高峰，边界、午间、晚间与周末均空闲", () => {
    const at = (iso: string): boolean => isBeijingPeak(new Date(iso));
    // 周五（2026-10-16）
    assert.equal(at("2026-10-16T01:30:00Z"), true); // 09:30 高峰
    assert.equal(at("2026-10-16T03:59:00Z"), true); // 11:59 高峰（末分钟）
    assert.equal(at("2026-10-16T04:00:00Z"), false); // 12:00 整 → 午间空闲
    assert.equal(at("2026-10-16T05:59:00Z"), false); // 13:59 空闲（末分钟）
    assert.equal(at("2026-10-16T06:00:00Z"), true); // 14:00 整 → 高峰
    assert.equal(at("2026-10-16T09:59:00Z"), true); // 17:59 高峰（末分钟）
    assert.equal(at("2026-10-16T10:00:00Z"), false); // 18:00 整 → 空闲
    assert.equal(at("2026-10-16T00:59:00Z"), false); // 08:59 空闲（首分钟前）
    // 周末（2026-10-17 周六 / 10-18 周日）：高峰时段内也按空闲
    assert.equal(at("2026-10-17T02:00:00Z"), false); // 周六 10:00
    assert.equal(at("2026-10-18T07:00:00Z"), false); // 周日 15:00
});

test("calcCostYuan：算式与缓存命中口径（非缓存输入 = prompt − cached；空闲档锚点 + env input=2）", () => {
    // ★ 本文件顶部 env 已覆盖 input=2（快照全局生效），算式按覆盖后单价验证（公式与单价来源解耦；
    //   表价本身由 MODEL_PRICES deepEqual 测试守护）
    // 空闲档：1M 未命中输入 + 1M 输出 = 1M×2(env input) + 1M×4(表 idle output) = 6 元
    assert.equal(calcCostYuan("deepseek-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 }, IDLE_TS), 6);
    // 空闲档：0.5M 命中 + 0.5M 未命中 + 1M 输出 = 0.5M×0.02 + 0.5M×2(env) + 1M×4 = 5.01 元
    assert.ok(Math.abs(calcCostYuan("deepseek-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 }, IDLE_TS)! - 5.01) < 1e-9);
    // 高峰档（同 token）：输出 4→8，未命中输入 env=2 恰与表 peak 相同 → 2 + 8 = 10 元
    assert.equal(calcCostYuan("deepseek-flash", { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 }, PEAK_TS), 10);
    // 全零 usage → 0（合法值，非 null）
    assert.equal(calcCostYuan("deepseek-flash", {}, IDLE_TS), 0);
    // cached > prompt 脏数据：miss 下限 0，不出现负成本
    assert.ok(calcCostYuan("deepseek-flash", { promptTokens: 100, cachedTokens: 500, completionTokens: 0 }, IDLE_TS)! >= 0);
});

test("对账回归钉（2026-10-16 事故）：官方仪表盘 flash 高峰档实收 ¥0.53，本表代入须分毫不差", () => {
    // 事故回放：batch 会话 09:43–09:47（周五高峰档）真实 usage——官方按高峰价收 ¥0.53，
    // 旧表（命中 0.02/未命中 1/输出 2）算出 ¥0.19，少报 2.7 倍。新表代入：
    // miss 78,259×2 + hit 2,278,528×0.04 + out 35,025×8 = ¥0.5279（仪表盘 ¥0.53 的未取整原值）
    const c = calcCostYuan("deepseek-flash",
        { promptTokens: 2_356_787, completionTokens: 35_025, cachedTokens: 2_278_528 },
        new Date("2026-10-16T01:48:10Z")); // 落盘记录原 ts（北京 09:48 高峰档）
    assert.ok(c !== null && Math.abs(c - 0.527859) < 1e-4, `对账失败：算出 ${c}，官方 ¥0.53`);
});

test("无价模型：返回 null（不编数，上层只显 token；换新模型不在表里也不会猜价）", () => {
    assert.equal(calcCostYuan("deepseek-flash-vision-exp", { promptTokens: 1000, completionTokens: 100 }, IDLE_TS), null);
    assert.equal(calcCostYuan("unknown-model", { promptTokens: 1000 }, IDLE_TS), null);
});

test("env 覆盖：所设字段覆盖（平价，两档同用）、未设字段回退表价（随档）、无效值忽略", () => {
    // input=2（env 覆盖，两档同值）、output 无效值忽略（回退表价）、cacheHit 未设（回退表价）
    assert.deepEqual(priceFor("deepseek-flash", IDLE_TS), { input: 2, output: 4, cacheHit: 0.02 });
    assert.deepEqual(priceFor("deepseek-flash", PEAK_TS), { input: 2, output: 8, cacheHit: 0.04 });
    // env 覆盖字段跨档不变（平价语义），未覆盖字段随档切换
    assert.equal(priceFor("deepseek-flash", IDLE_TS)!.input, priceFor("deepseek-flash", PEAK_TS)!.input);
    assert.notEqual(priceFor("deepseek-flash", IDLE_TS)!.output, priceFor("deepseek-flash", PEAK_TS)!.output);
});

test("env 三键不全：无表价模型仍为 null（env-only 条目须三键全设，用户声明价才算数）", () => {
    assert.equal(priceFor("deepseek-flash-vision-exp", IDLE_TS), null);
});

test("价格表日期戳：可解析且账龄非负（过期提示的锚点，见 /usage 的 N 天未复核提示）", () => {
    const at = Date.parse(`${PRICES_VERIFIED_AT}T00:00:00Z`);
    assert.ok(Number.isFinite(at), `PRICES_VERIFIED_AT 不可解析：${PRICES_VERIFIED_AT}`);
    assert.ok(pricesAgeDays() >= 0);
});
