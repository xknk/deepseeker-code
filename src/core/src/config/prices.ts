/**
 * @file config/prices.ts
 * @description 模型价格表 + token→钱折算（成本信任链第一环 D1）：DeepSeek 官网人民币口径，元/百万 tokens。
 *  红线一（价格数据）：价格常量须实现者当天上官网核实——本表 2026-10-13 核实自
 *  api-docs.deepseek.com/zh-cn/quick_start/pricing（模型 & 价格页），换价须重核后再改。
 *  红线二（估算口径）：折算只用 usage 真实回传数字（prompt/completion/cached tokens），
 *  绝不用 estimateTokens——钱的数字必须可对账。
 *  红线三（不编数）：无价格条目的模型 calcCostYuan 返回 null，上层 graceful 只显 token 不显钱。
 *  env 覆盖：DEEP_SEEK_PRICE_INPUT / DEEP_SEEK_PRICE_OUTPUT / DEEP_SEEK_PRICE_CACHEHIT
 *  （元/百万，浮点；适配峰谷价/调价窗口/自建中转等场景。无效值忽略；部分设置=逐字段覆盖，
 *  三键全设可为无表价模型声明完整价格，用户声明价同样不算编数）。
 */

/** 单价三元组（元/百万 tokens）。 */
export interface ModelPrice {
    /** 输入（缓存未命中）单价。 */
    input: number;
    /** 输出单价。 */
    output: number;
    /** 输入（缓存命中）单价。 */
    cacheHit: number;
}

/**
 * 官网价（2026-10-13 核实）：deepseek-flash 缓存命中 ¥0.02 / 未命中 ¥1 / 输出 ¥2；
 * deepseek-v4-pro ¥0.025 / ¥3 / ¥6。只填 SELECTABLE_MODELS 内的模型（明确不做价格表泛化）；
 * deepseek-flash-vision-exp 官网无公开报价 → 刻意无条目（null 语义）。
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
    "deepseek-flash": { input: 1, output: 2, cacheHit: 0.02 },
    "deepseek-v4-pro": { input: 3, output: 6, cacheHit: 0.025 },
};

/** env 覆盖解析：有效非负浮点返回数值，否则 undefined（无效值静默忽略，与 DEEP_SEEK_* 家族同风格）。 */
const envPrice = (name: string): number | undefined => {
    const raw = process.env[name];
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** env 覆盖快照（模块加载时定值，与价格表同为"当天价"语义；部分设置时未设字段为 undefined → 回退表价）。 */
const ENV_OVERRIDE: Partial<ModelPrice> | null = (() => {
    const input = envPrice("DEEP_SEEK_PRICE_INPUT");
    const output = envPrice("DEEP_SEEK_PRICE_OUTPUT");
    const cacheHit = envPrice("DEEP_SEEK_PRICE_CACHEHIT");
    if (input === undefined && output === undefined && cacheHit === undefined) return null;
    return { input, output, cacheHit };
})();

/**
 * 取模型单价三元组：表价打底，env 所设字段逐项覆盖。
 * @returns 无价可用（无表价且 env 三键不全）→ null，上层只显 token 不显钱。
 */
export const priceFor = (model: string): ModelPrice | null => {
    const base = MODEL_PRICES[model];
    if (!ENV_OVERRIDE) return base ?? null;
    const input = ENV_OVERRIDE.input ?? base?.input;
    const output = ENV_OVERRIDE.output ?? base?.output;
    const cacheHit = ENV_OVERRIDE.cacheHit ?? base?.cacheHit;
    if (input === undefined || output === undefined || cacheHit === undefined) return null;
    return { input, output, cacheHit };
};

/** 折算入参（口径 = UsageSnapshot：DeepSeek 真实回传的 prompt/completion/cached tokens）。 */
export interface UsageTokens {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
}

/**
 * 按 usage 真实回传数字折算成本（元）：(未命中输入×input + 命中×cacheHit + 输出×output) / 1e6。
 * 非缓存输入 = promptTokens − cachedTokens（各分量下限 0 防御脏数据）；全零 usage → 0（合法值，非 null）。
 * @returns 无价格条目 → null（绝不编数，上层 graceful 只显 token）。
 */
export const calcCostYuan = (model: string, u: UsageTokens): number | null => {
    const p = priceFor(model);
    if (!p) return null;
    const cached = Math.max(0, u.cachedTokens ?? 0);
    const miss = Math.max(0, (u.promptTokens ?? 0) - cached);
    const completion = Math.max(0, u.completionTokens ?? 0);
    return (miss * p.input + cached * p.cacheHit + completion * p.output) / 1e6;
};
