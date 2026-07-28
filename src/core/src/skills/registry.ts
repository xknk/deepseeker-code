/**
 * @file skills/registry.ts
 * @description Skills 全局注册表：按 name 去重（覆盖语义）、提供目录清单与正文访问器。
 *
 *  覆盖语义：registerSkill 后注册的同名 skill 覆盖先注册者。loader 按
 *  builtin → global → project 顺序注册，故优先级 project > global > builtin。
 */
export type SkillSource = 'builtin' | 'global' | 'project';

export interface SkillManifest {
    /** 技能名（唯一键，[a-z0-9-]） */
    name: string;
    /** 一句话描述（注入系统提示词目录的核心，模型据此判断何时需要） */
    description: string;
    version: number;
    /** SKILL.md 所在目录（调试/溯源用） */
    dir: string;
    /** 正文指令（load_skill 返回的内容） */
    body: string;
    source: SkillSource;
}

const skills = new Map<string, SkillManifest>();

/** 注册/覆盖一个 skill（同名后者覆盖前者） */
export const registerSkill = (m: SkillManifest): void => {
    skills.set(m.name, m);
};

/** 清空全部（测试 / 热重载用） */
export const clearSkills = (): void => {
    skills.clear();
};

/** 列出全部 skill */
export const listSkills = (): SkillManifest[] => {
    return Array.from(skills.values());
};

/** 取某 skill 的正文（load_skill 工具调用） */
export const getSkillBody = (name: string): string | undefined => {
    return skills.get(name)?.body;
};

/**
 * 拼接"技能目录"清单字符串（供注入系统提示词，每个 skill 一行）。
 * 无 skill 返回空串（injector 据此跳过注入）。
 */
export const getSkillCatalog = (): string => {
    const all = listSkills();
    if (all.length === 0) return "";
    return all.map(s => `- ${s.name}：${s.description}`).join("\n");
};
