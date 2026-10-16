/**
 * @file config/prices.ts
 * @description 模型价格表 + token→钱折算（成本信任链第一环 D1）：DeepSeek 官网人民币口径，元/百万 tokens。
 *  红线一（价格数据）：价格常量须实现者当天上官网核实——本表 2026-10-16 核实自
 *  api-docs.deepseek.com/zh-cn/quick_start/pricing（模型 & 价格页），换价须重核后再改。
 *  ★ 2026-10-16 事故教训：上一版表（10-13「核实」）与官方实收差 2.7 倍、静默少报——故引入
 *    PRICES_VERIFIED_AT 日期戳 + /usage 过期提示（pricesAgeDays/PRICES_STALE_DAYS）：
 *    「价格表过期」必须可见，不允许静默错钱。表过期时的临时校准走 env 覆盖（见下）。
 *  红线二（估算口径）：折算只用 usage 真实回传数字（prompt/completion/cached tokens），
 *  绝不用 estimateTokens——钱的数字必须可对账。
 *  红线三（不编数）：无价格条目的模型 calcCostYuan 返回 null，上层 graceful 只显 token 不显钱
 *  （换新模型/模型改名不在表里 → 宁可不显示钱，也不猜一个价）。
 *  峰谷价：官网按北京时间分两档计费——工作日（不含法定节假日）9:00–12:00、14:00–18:00 为高峰，
 *  其余时段空闲（含午间 12–14、晚间、周末、节假日），空闲档 = 高峰价减半。本表两档都记、
 *  按折算时刻判档（runAgent 逐轮折算=轮内近似无偏差；历史记录折算传记录自身 ts）。
 *  法定节假日本地判不了（无节假日表）→ 节假日按工作日处理，方向=高估（预算闸偏保守，安全侧）。
 *  env 覆盖：DEEP_SEEK_PRICE_INPUT / DEEP_SEEK_PRICE_OUTPUT / DEEP_SEEK_PRICE_CACHEHIT
 *  （元/百万，浮点；适配调价窗口/自建中转等场景。无效值忽略；部分设置=逐字段覆盖，
 *  三键全设可为无表价模型声明完整价格，用户声明价同样不算编数；env 价为平价——峰谷两档同用）。
 */

/** 单价三元组（元/百万 tokens，单档）。 */
export interface ModelPrice {
    /** 输入（缓存未命中）单价。 */
    input: number;
    /** 输出单价。 */
    output: number;
    /** 输入（缓存命中）单价。 */
    cacheHit: number;
}

/** 峰谷双档价格（官网按时段计费，空闲档 = 高峰价减半）。 */
export interface TieredPrice {
    /** 空闲档：工作日 9–12/14–18 之外的时段（含周末与节假日）。 */
    idle: ModelPrice;
    /** 高峰档：工作日 9:00–12:00、14:00–18:00（北京时间）。 */
    peak: ModelPrice;
}

/**
 * 官网价（2026-10-16 核实，按当天官方账单对账验证：flash 高峰档代入仪表盘 token 分毫不差）：
 *  deepseek-flash 命中 ¥0.02/¥0.04（空闲/高峰）、未命中 ¥1/¥2、输出 ¥4/¥8；
 *  deepseek-v4-pro ¥0.15/¥0.30、¥4.5/¥9、¥13.5/¥27。
 *  只填 SELECTABLE_MODELS 内的模型（明确不做价格表泛化）；
 *  deepseek-flash-vision-exp 官网无公开报价 → 刻意无条目（null 语义）。
 */
export const MODEL_PRICES: Record<string, TieredPrice> = {
    "deepseek-flash": {
        idle: { input: 1, output: 4, cacheHit: 0.02 },
        peak: { input: 2, output: 8, cacheHit: 0.04 },
    },
    "deepseek-v4-pro": {
        idle: { input: 4.5, output: 13.5, cacheHit: 0.15 },
        peak: { input: 9, output: 27, cacheHit: 0.3 },
    },
};

/** 价格表（含峰谷时段定义）核实日期——过期提示与「换价须重核」红线的锚点。 */
export const PRICES_VERIFIED_AT = "2026-10-16";

/** 过期提示门槛（天）：超过即 /usage 显「价格表 N 天未复核」——过期必须可见，不静默错钱。 */
export const PRICES_STALE_DAYS = 30;

/** 价格表距今天数（供过期提示；核实日期写未来时按 0 算）。 */
export const pricesAgeDays = (): number =>
    Math.max(0, Math.floor((Date.now() - Date.parse(`${PRICES_VERIFIED_AT}T00:00:00Z`)) / 86_400_000));

/**
 * 北京时间峰谷判定：工作日（周一~周五）9:00–12:00、14:00–18:00 为高峰，其余空闲。
 * 北京时间 = UTC+8 无夏令时（位移后按 UTC 读数，无时区库依赖）；法定节假日判不了 → 按工作日（高估侧）。
 */
export const isBeijingPeak = (ts: Date = new Date()): boolean => {
    const bj = new Date(ts.getTime() + 8 * 3_600_000);
    const day = bj.getUTCDay(); // 0=周日 … 6=周六
    if (day === 0 || day === 6) return false;
    const h = bj.getUTCHours();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
};

/** env 覆盖解析：有效非负浮点返回数值，否则 undefined（无效值静默忽略，与 DEEP_SEEK_* 家族同风格）。 */
const envPrice = (name: string): number | undefined => {
    const raw = process.env[name];
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** env 覆盖快照（模块加载时定值；部分设置时未设字段为 undefined → 回退表价；env 价为平价，两档同用）。 */
const ENV_OVERRIDE: Partial<ModelPrice> | null = (() => {
    const input = envPrice("DEEP_SEEK_PRICE_INPUT");
    const output = envPrice("DEEP_SEEK_PRICE_OUTPUT");
    const cacheHit = envPrice("DEEP_SEEK_PRICE_CACHEHIT");
    if (input === undefined && output === undefined && cacheHit === undefined) return null;
    return { input, output, cacheHit };
})();

/**
 * 取模型单价三元组：按 ts 判峰谷档取表价，env 所设字段逐项覆盖（平价语义）。
 * @param ts 折算时刻（历史记录传记录自身时间；缺省现在）。
 * @returns 无价可用（无表价且 env 三键不全）→ null，上层只显 token 不显钱。
 */
export const priceFor = (model: string, ts?: Date): ModelPrice | null => {
    const tier = MODEL_PRICES[model];
    const base = tier ? (isBeijingPeak(ts ?? new Date()) ? tier.peak : tier.idle) : undefined;
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
 * @param ts 折算时刻（判峰谷档；缺省现在——runAgent 逐轮调用即逐轮判档，跨峰谷边界的 run 误差 ≤ 一轮）。
 * @returns 无价格条目 → null（绝不编数，上层 graceful 只显 token）。
 */
export const calcCostYuan = (model: string, u: UsageTokens, ts?: Date): number | null => {
    const p = priceFor(model, ts);
    if (!p) return null;
    const cached = Math.max(0, u.cachedTokens ?? 0);
    const miss = Math.max(0, (u.promptTokens ?? 0) - cached);
    const completion = Math.max(0, u.completionTokens ?? 0);
    return (miss * p.input + cached * p.cacheHit + completion * p.output) / 1e6;
};
