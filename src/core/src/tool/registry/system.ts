/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 16:14:32
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-10 16:14:39
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\getTime.ts
 * @Description: 测试工具，测试工具注册表是否正常工作
 */
import { CustomTool } from "../type.ts";

export const systemTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "getTime",
            description: "返回当前服务器的日期与时间（本地时区）",
            parameters: {
                type: "object",
                properties: {
                    location: { type: "string", description: "城市名称，如 Beijing" },
                },
                required: ["location"],
            },
            async execute() {
                return new Date().toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "medium" });
            },
        },
    },
];
