/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 17:39:04
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-10 17:17:15
 * @FilePath: \deepSeekCode\src\core\src\tool\index.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { CustomTool } from "./type.ts";
import { systemTools } from "./registry/system.ts";
import { createAgentTools } from "./registry/agent.ts";
// 后续扩展可以继续 import:
import { fsTools } from "./registry/fs.ts";
import { searchTools } from "./registry/search.ts";

export * from "./type.ts";

// 1. 先声明一个聚合数组
export const agentTools: CustomTool[] = [];

// 2. 动态生成 agent 协同工具，并把“获取自身”的闭包传进去
const agentSubTools = createAgentTools(() => agentTools);

// 3. 将所有分类工具 push 到最终的注册表数组中
agentTools.push(
    ...systemTools,
    ...agentSubTools,
    ...fsTools,      // 以后加了文件读写直接解构进来
    ...searchTools,  // 以后加了正则检索直接解构进来
);
