/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-17 14:54:15
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-06-17 15:02:25
 * @FilePath: \lims-frontd:\code\自研\deepSeekCode\src\core\src\llm\summary.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Msg } from "@/session/contextCore.ts";
import { outMsg, MsgParams } from "./type.ts"
import { model } from "./createModel.ts"

/**
 * 非流式摘要对话：一次性返回完整 completion，供上下文压缩（滚动摘要）使用。
 * 注意：llm/model.ts 亦导出同名函数 chatWithModelWithSummary，本项目以 model.ts 版本为准；
 *       本文件为早期实现，保留以兼容历史引用。
 * @param messages 需要概括的对话上下文
 * @returns 模型的完整非流式响应
 */
export const chatWithModelWithSummary = async (messages: Msg[]): Promise<outMsg> => {
    try {
        const requestBody = {
            messages: messages,
            model: "deepseek-v4-flash",
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