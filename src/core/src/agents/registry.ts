/**
 * @file agents/registry.ts
 * @description 声明式子 Agent 全局注册表：按 name 去重（覆盖语义）、提供目录清单与查找。
 *  共用的 Map/register/list/get 基座走 common/registry.ts 的 createRegistry；此处保留 agent 特化的 role 拼接目录。
 *  覆盖语义：loader 按 builtin → global → project 顺序注册，故优先级 project > global > builtin。
 */
import { createRegistry } from "@/common/registry.ts";

export type AgentSource = 'builtin' | 'global' | 'project';

export interface AgentManifest {
    /** 唯一键，[a-z0-9-]，来自 frontmatter.name */
    name: string;
    /** 一句话描述（注入【可用子 Agent 目录】，模型据此判断何时 spawn） */
    description: string;
    /** 角色标签（可选），拼入系统词；spawn 时的 args.role 可作补充 */
    role?: string;
    /**
     * 工具白名单（逗号 split 后的数组）。
     * - 非空：显式 allowlist，spawn 时替代 deny-list
     * - 空：spawn 时回退 SUBAGENT_DENYLIST（向后兼容现有 spawn_agent）
     */
    tools: string[];
    /** per-agent 模型覆盖；缺省回退全局 MODEL_NAME */
    model?: string;
    /** frontmatter 之后的 markdown 正文，作为子 agent 系统词主体 */
    body: string;
    source: AgentSource;
    /** .agent.md 所在目录（调试/溯源） */
    dir: string;
}

const agents = createRegistry<AgentManifest>();

/** 注册/覆盖一个声明式子 Agent（同名后者覆盖前者） */
export const registerAgent = agents.register;

/** 清空全部（测试 / 热重载用） */
export const clearAgents = agents.clear;

/** 列出全部声明式子 Agent */
export const listAgents = agents.list;

/** 按 name 查找（spawn_agent 调用） */
export const getAgent = agents.get;

/**
 * 拼接"子 Agent 目录"清单字符串（供注入系统提示词，每个 agent 一行）。
 * 无 agent 返回空串（injector 据此跳过注入）。
 */
export const getAgentCatalog = (): string => {
    const all = listAgents();
    if (all.length === 0) return "";
    // ★ 按 name 排序：插入序 = loader readdir 序（文件系统隐式依赖），漂移即击穿 fresh-session
    //   DeepSeek 前缀缓存（sysHash 变）——注入内容只随「注册了什么」稳定变化（与 memory 索引同法）。
    return all
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => `- ${a.name}：${a.description}${a.role ? `（角色：${a.role}）` : ""}`)
        .join("\n");
};
