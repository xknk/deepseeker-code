/**
 * @file llm/providers/deepseek/client.ts
 * @description DeepSeek OpenAI SDK 客户端懒加载单例 + 模型参数（DEEP_SEEK_* env 接入）。
 *  从 llm/createModel.ts 搬迁（单一数据源迁入 provider）。所有 DeepSeek 对话（流式 / 摘要 / 分类）复用此 client。
 */
import OpenAI from "openai";

let _model: OpenAI | undefined;
/**
 * 全局共享的 OpenAI 客户端懒加载单例（DeepSeek 兼容 OpenAI 协议），首次 getModel() 时构造。
 * ★ 懒加载是硬要求而非风格：OpenAI 构造在缺 DEEP_SEEK_API_KEY 时即 throw，顶层构造会炸掉整条
 *   import 链——曾致 27/40 个测试文件在无凭证环境「加载期整文件失败」，表象像测试坏了、实为缺
 *   环境变量。按需构造后，缺 key 报错延迟到真正发起 API 调用时，模块加载零副作用（2026-09-14 修）。
 */
export const getModel = (): OpenAI =>
    (_model ??= new OpenAI({
        baseURL: process.env.DEEP_SEEK_API_URL || 'https://api.deepseek.com',
        apiKey: process.env.DEEP_SEEK_API_KEY,
        // ★ 瞬态错误自动指数退避重试（SDK 内置：408/409/429/500/502/503/504 + 连接错误），
        //   覆盖非流式 helper（summarize / classifyRisk）。★ 流式对话不在此列：stream.ts 按
        //   maxRetries: 0 关掉 SDK 层，瞬态重试单层归 streamInference 应用层（Retry-After 感知 +
        //   text.reset/abort/超长降级语义，SDK 层不具备）——两层同开会把 429 放大成 5×3=15 次请求。
        maxRetries: 4,
        timeout: 120_000, // 单次请求 120s 兜底（长上下文 / 长生成场景）
    }));

// Q-4：模型参数外置到环境变量（换模型 / 关 reasoning 不必改源码）。
export const MODEL_NAME = process.env.DEEP_SEEK_MODEL || "deepseek-flash";
/**
 * 辅助模型（摘要 / 未来 auto 审批分类器等轻量任务专用）：独立于主 agent 模型，默认 deepseek-flash（便宜快）。
 * 设 DEEP_SEEK_AUX_MODEL 覆盖。与主模型分开 —— 主 agent 可换更强模型（DEEP_SEEK_MODEL），而辅助任务仍走轻量
 * 模型以控成本。默认与主模型同为 flash（未配 DEEP_SEEK_MODEL 时）。
 */
export const AUX_MODEL_NAME = process.env.DEEP_SEEK_AUX_MODEL || "deepseek-flash";
/**
 * DeepSeek V4 reasoning_effort 合法档位（low/medium 已废弃，兼容映射为 high）。
 * 用 clamp 校验环境变量，避免「原值 truthy → 未经校验 → 被强转成合法类型」的失真
 * （如 DEEP_SEEK_REASONING_EFFORT=low 会被原样当成合法值发给 API）。非法/未设一律回落 "high"。
 */
const REASONING_EFFORTS = ["high", "max"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const clampReasoningEffort = (raw: string | undefined): ReasoningEffort =>
    raw && (REASONING_EFFORTS as readonly string[]).includes(raw) ? (raw as ReasoningEffort) : "high";
export const MODEL_REASONING_EFFORT: ReasoningEffort = clampReasoningEffort(process.env.DEEP_SEEK_REASONING_EFFORT);
/** 深度思考开关：默认开启；设 DEEP_SEEK_THINKING=0 关闭。 */
export const MODEL_THINKING_ENABLED = process.env.DEEP_SEEK_THINKING !== "0";
