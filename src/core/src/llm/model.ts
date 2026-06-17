/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 17:01:17
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-17 15:01:40
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\llm\providers\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Msg } from "@/session/contextCore.ts";
import { model } from "./createModel.ts"
import { MsgParams, outMsg, toolMsg } from "./type.ts";

async function chatWithModelWithTools(messages: Msg[], tools?: toolMsg[], callOpts?: { signal?: AbortSignal, onAssistantTextDelta?: (delta: string) => void }): Promise<outMsg> {
    try {
        const requestBody = {
            messages: messages,
            model: "deepseek-v4-flash",
            tool_choice: "auto", // 让模型自动选择工具
            tools: tools,
            thinking: { "type": "enabled" },
            reasoning_effort: "high",
            stream: false,
        } as MsgParams;
        const completion = await model.chat.completions.create(requestBody);
        if (completion && 'choices' in completion) {
            return completion as outMsg;
        }

        throw new Error("API 响应异常，未包含 choices 结构");
    } catch (error) {
        console.error("❌ 接口调用失败:", error);
        // 4. 必须将错误抛出，或者返回一个保底的错误对象。
        // 如果这里保持空着，函数在报错时会隐式返回 undefined，从而引发 ts(2322) 报错
        throw error;
    }
}



export default chatWithModelWithTools;
