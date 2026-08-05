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
import { getSkillManifest } from "@/skills/registry.ts";

/**
 * 把 skill manifest 拼装为 load_skill 的返回内容：
 *   body（正文）+ context（附加上下文段，若有）+ allowedTools（工具限定软约束指令，若有）。
 *
 * ★ allowed-tools 软约束：不硬过滤 tools 数组（保 DeepSeek 前缀缓存稳定），而是在末尾追加限定指令让模型自律。
 */
const assembleSkillContent = (m: { body: string; context?: string; allowedTools: string[] }): string => {
    let out = m.body;
    if (m.context) out += `\n\n## 附加上下文\n${m.context}`;
    if (m.allowedTools.length > 0) {
        out += `\n\n⚠️【工具限定】本技能激活期间，仅允许调用以下工具：${m.allowedTools.join("、 ")}。请勿调用列表外的工具。`;
    }
    return out;
};

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
                const manifest = getSkillManifest(name.trim());
                if (!manifest) {
                    return `❌ 未找到技能：${name}。请核对【可用技能目录】中的名称拼写。`;
                }
                return assembleSkillContent(manifest);
            },
        },
    },
];
