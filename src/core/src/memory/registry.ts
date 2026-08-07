/**
 * @file memory/registry.ts
 * @description 记忆全局注册表：按 name 去重（覆盖语义）、提供索引与查找。
 *  镜像 outputStyles/registry.ts：createRegistry 基座 + project>global 覆盖优先级。
 *
 *  记忆 = 跨会话持久化的「非显然事实/用户偏好/反馈/项目约束」笔记，供 agent 召回。
 *  与 output-styles 的差异：记忆正文不整体注入系统提示词（省 token），只注入一行索引；
 *  需要全文时模型调 memory_read 按需读取（记忆目录在工作区沙箱外，read_file 读不到）。
 */
import { createRegistry } from "@/common/registry.ts";

export type MemorySource = 'global' | 'project';

/** 记忆类别（对标 Claude Code）：决定召回相关性与写入时机的语义提示。 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryManifest {
    /** 记忆名（唯一键，[a-z0-9-]+，即文件名主干） */
    name: string;
    /** 一句话描述——注入索引时展示，供模型判断是否需要 memory_read 召回 */
    description: string;
    /** 类别：user=用户画像 / feedback=工作方式反馈 / project=项目目标约束 / reference=外部资源指针 */
    type: MemoryType;
    /** 记忆正文（memory_read 返回） */
    body: string;
    source: MemorySource;
    /** 落盘绝对路径（save/delete/刷新注册表用） */
    file: string;
}

const memories = createRegistry<MemoryManifest>();

/** 注册/覆盖一条记忆（同名后者覆盖前者） */
export const registerMemory = memories.register;
/** 列出全部记忆 */
export const listMemories = memories.list;
/** 按 name 查找 */
export const getMemory = memories.get;
/** 注销一条（delete 用） */
export const unregisterMemory = (name: string): boolean => {
    const m = memories.get(name);
    if (!m) return false;
    // createRegistry 未暴露 delete，借用 clear+重灌实现单条注销
    const all = memories.list().filter((x) => x.name !== name);
    memories.clear();
    for (const x of all) memories.register(x);
    return true;
};
/** 清空全部（重载/测试用） */
export const clearMemories = memories.clear;

/**
 * 构建注入系统提示词的「记忆索引」：每条一行（name + 类别 + 描述），按 name 排序。
 * 仅注入索引（省 token）；需要全文时模型调 memory_read。无记忆返回 null（injector 据此 no-op）。
 */
export const getMemoryIndex = (): string | null => {
    const all = memories.list();
    if (all.length === 0) return null;
    return all
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => `- **${m.name}** (${m.type}) — ${m.description}`)
        .join("\n");
};
