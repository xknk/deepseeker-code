/**
 * @file llm/createModel.ts
 * @description 创建并导出全局共享的 OpenAI SDK 客户端实例。
 *  通过环境变量 DEEP_SEEK_API_URL / DEEP_SEEK_API_KEY 配置接入点与密钥，
 *  默认指向 DeepSeek 官方 API。所有对话（流式 / 摘要）均复用此单例 client。
 */
import OpenAI from "openai";

/** 全局共享的 OpenAI 客户端单例（DeepSeek 兼容 OpenAI 协议）。 */
export const model = new OpenAI({
    baseURL: process.env.DEEP_SEEK_API_URL || 'https://api.deepseek.com',
    apiKey: process.env.DEEP_SEEK_API_KEY,
    // ★ 瞬态错误自动指数退避重试（SDK 内置：408/409/429/500/502/503/504 + 连接错误），
    //   避免单次 429 限流 / 网关抖动 / 网络超时直接终止整轮 agent（长任务几十轮工具调用体验极差）。
    //   注：SDK 重试已覆盖瞬态错误，runAgent 不再叠加第二层重试（否则会放大负载）。
    maxRetries: 4,
    timeout: 120_000, // 单次请求 120s 兜底（长上下文 / 长生成场景）
});