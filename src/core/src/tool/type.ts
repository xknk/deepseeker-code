/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 16:10:19
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-10 16:10:28
 * @FilePath: \deepSeekCode\src\core\src\tool\type.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import OpenAI from "openai";
import { RunAgentEvents } from "@/agent/type.ts";

export interface ToolContext {
    sessionId: string;
    abortSignal?: AbortSignal;
    depth: number;
    keepRecentUnits: number;
    compactRatio: number;
    modelWindow: number;
    parentSystemPrompt: string;
    events: RunAgentEvents;
}

export type CustomTool = OpenAI.Chat.Completions.ChatCompletionTool & {
    function: {
        execute: (args: any, ctx?: ToolContext) => Promise<string> | AsyncGenerator<string>;
    };
};

export const MAX_AGENT_DEPTH = 3;
