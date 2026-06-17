import OpenAI from "openai";

export type outMsg = OpenAI.Chat.ChatCompletion
export type MsgParams = OpenAI.Chat.ChatCompletionCreateParams
export type toolMsg = OpenAI.Chat.ChatCompletionTool