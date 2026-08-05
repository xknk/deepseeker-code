/**
 * @file skills/registry.ts
 * @description Skills 全局注册表：按 name 去重（覆盖语义）、提供目录清单与正文访问器。
 *
 *  共用的 Map/register/list/get 基座走 common/registry.ts 的 createRegistry；此处仅保留 skill 特化访问器。
 *  覆盖语义：registerSkill 后注册的同名 skill 覆盖先注册者。loader 按
 *  builtin → global → project 顺序注册，故优先级 project > global > builtin。
 */
import { createRegistry } from "@/common/registry.ts";

export type SkillSource = 'builtin' | 'global' | 'project';

export interface SkillManifest {
    /** 技能名（唯一键，[a-z0-9-]） */
    name: string;
    /** 一句话描述（注入系统提示词目录的核心，模型据此判断何时需要） */
    description: string;
    version: number;
    /** SKILL.md 所在目录（调试/溯源用） */
    dir: string;
    /** 正文指令（load_skill 返回的主体） */
    body: string;
    source: SkillSource;
    /**
     * 工具白名单（逗号 split 后的数组，来自 frontmatter allowed-tools/allowed_tools）。
     * 软约束：load_skill 返回时在 body 末尾追加「工具限定」指令，模型自律（不硬过滤 tools 数组，
     * 以保 DeepSeek 前缀缓存稳定——见 .ai-docs/下一步计划.md「关键实现约束」）。
     * 空 = 不限定。
     */
    allowedTools: string[];
    /**
     * 附加上下文（frontmatter context，可选）。load_skill 返回时作为「附加上下文」段拼入，
     * 供技能作者附带静态补充材料，而不污染 body 主体。
     */
    context?: string;
    /**
     * 触发词（逗号 split 后的数组，来自 frontmatter triggers）。
     * 拼入【可用技能目录】每行末尾，帮模型判断何时激活（如「（触发：TDD, 测试驱动）」）。空 = 不展示。
     */
    triggers: string[];
}

const skills = createRegistry<SkillManifest>();

/** 注册/覆盖一个 skill（同名后者覆盖前者） */
export const registerSkill = skills.register;

/** 清空全部 skill（测试 / 热重载用） */
export const clearSkills = skills.clear;

/** 列出全部 skill */
export const listSkills = skills.list;

/** 取某 skill 的正文（load_skill 工具调用） */
export const getSkillBody = (name: string): string | undefined => skills.get(name)?.body;

/** 取某 skill 的完整 manifest（load_skill 需读 allowedTools/context 拼装软约束指令） */
export const getSkillManifest = (name: string): SkillManifest | undefined => skills.get(name);

/**
 * 拼接"技能目录"清单字符串（供注入系统提示词，每个 skill 一行）。
 * triggers 非空时附于行尾（如「（触发：TDD, 测试驱动）」），帮模型判断何时激活。
 * 无 skill 返回空串（injector 据此跳过注入）。
 */
export const getSkillCatalog = (): string => {
    const all = listSkills();
    if (all.length === 0) return "";
    return all
        .map(s => `- ${s.name}：${s.description}${s.triggers.length ? `（触发：${s.triggers.join("、 ")}）` : ""}`)
        .join("\n");
};
