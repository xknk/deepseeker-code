/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-07-20 16:18:08
 * @LastEditors: fanqianliang 2438756801@qq.com
 * @LastEditTime: 2026-07-20 16:18:15
 * @FilePath: \deepSeekCode\src\core\src\tool\registry\inspect_dependencies.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import * as fs from "fs/promises";
import * as path from "path";
import { CustomTool, ToolSafetyLevel } from "../type.ts";
import { WORKSPACE_ROOT } from "../guard.ts";

export const dependencyTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "inspect_dependencies",
            description: "读取并查看当前项目 package.json 中声明的第三方依赖包及版本清单，避免盲目引入未安装的模块。",
            parameters: {
                type: "object",
                properties: {}
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(): Promise<string> {
                try {
                    const pjsPath = path.join(WORKSPACE_ROOT, "package.json");
                    const raw = await fs.readFile(pjsPath, "utf-8");
                    const pjs = JSON.parse(raw);
                    
                    const result = {
                        dependencies: pjs.dependencies || {},
                        devDependencies: pjs.devDependencies || {}
                    };
                    
                    return JSON.stringify(result, null, 2);
                } catch (error: any) {
                    return `❌ 读取依赖清单失败，未找到 package.json 或文件格式损坏: ${error.message}`;
                }
            }
        }
    }
];
