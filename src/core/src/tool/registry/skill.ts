/**
 * @file tool/registry/skill.ts
 * @description load_skill 工具：模型判断需要某技能时调用，读取该技能 SKILL.md 的完整正文。
 *
 *  设计（对标 read_project_guide 的最简形态 + Claude Code Skill 工具模式）：
 *   - 正文以标准 tool result 回填（走 runAgent 常规管道），天然受 ensureFitsWindow 压缩治理，token 经济；
 *   - 进 agentTools 后，子 agent 经 getGlobalTools() 自动继承，无需改 RunAgentOptions 透传链；
 *   - 仅在有 skill 时由 initSkills 注入（无 skill 不暴露，避免无效工具位）。
 */
import { CustomTool, ToolSafetyLevel } from "@/tool/type.ts";
import { getSkillBody } from "@/skills/registry.ts";

export const skillTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "load_skill",
            description:
                "加载指定技能的完整指令。先查看系统提示词中的【可用技能目录】，判断当前任务是否匹配某个技能；若匹配，调用本工具读取其完整内容，然后严格遵照执行。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "要加载的技能名（须与【可用技能目录】中列出的名称完全一致）" },
                },
                required: ["name"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: any): Promise<string> {
                const name = args?.name;
                if (typeof name !== "string" || !name.trim()) {
                    return "❌ [load_skill] 缺少参数 name。请先查看【可用技能目录】中的技能名。";
                }
                const body = getSkillBody(name.trim());
                if (!body) {
                    return `❌ 未找到技能：${name}。请核对【可用技能目录】中的名称拼写。`;
                }
                return body;
            },
        },
    },
];
