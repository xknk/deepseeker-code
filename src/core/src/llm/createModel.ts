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
});