/**
 * @file llm/type.ts
 * @description LLM 模块对外暴露的 OpenAI 协议类型别名，供 model.ts / summary.ts 等复用。
 */
import OpenAI from "openai";

/** 模型非流式响应类型（ChatCompletion）。 */
export type outMsg = OpenAI.Chat.ChatCompletion
/** 创建补全的请求参数类型（ChatCompletionCreateParams）。 */
export type MsgParams = OpenAI.Chat.ChatCompletionCreateParams
/** 工具定义类型（ChatCompletionTool）。 */
export type toolMsg = OpenAI.Chat.ChatCompletionTool