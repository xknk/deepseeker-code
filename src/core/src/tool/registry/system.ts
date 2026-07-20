/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-10 16:14:32
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-15 16:38:27
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\system.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
/**
 * @file tool/registry/system.ts
 * @description 系统类工具集。getTime：返回服务器当前日期时间（本地时区）。
 */
import { CustomTool, ToolSafetyLevel } from "../type.ts";

/** 系统类工具集（getTime，详见上方 @file 说明）。 */
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
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute() {
                return new Date().toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "medium" });
            },
        },
    },
];
