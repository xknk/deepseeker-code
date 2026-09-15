import * as fs from "fs/promises";
import * as path from "path";
import { toolFailure, CustomTool, ToolSafetyLevel } from "../type.ts";
import { getActiveWorkspaceRoot } from "../guard.ts";

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
                    const pjsPath = path.join(getActiveWorkspaceRoot(), "package.json");
                    const raw = await fs.readFile(pjsPath, "utf-8");
                    const pjs = JSON.parse(raw);
                    
                    const result = {
                        dependencies: pjs.dependencies || {},
                        devDependencies: pjs.devDependencies || {}
                    };
                    
                    return JSON.stringify(result, null, 2);
                } catch (error: any) {
                    return toolFailure(`读取依赖清单失败，未找到 package.json 或文件格式损坏: ${error.message}`);
                }
            }
        }
    }
];
