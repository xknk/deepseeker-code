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

/**
 * 记忆来源：global/project = 自有记忆（memory_save 可写落盘）；
 * external = 外部桥接条目（loader 从其他 agent 的规则/指令文件只读接入，ext- 前缀，工具层拒写拒删）。
 */
export type MemorySource = 'global' | 'project' | 'external';

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
 * 记忆索引行格式（单一出处）：memory_list 与预算计算（tool/registry/memory.ts 的索引字节上限）
 * 必须与此逐字节一致——格式漂移 = 破前缀缓存 / 预算失准。格式本身由 memory.test.ts 钉死。
 */
export const memoryIndexLine = (m: Pick<MemoryManifest, "name" | "type" | "description">): string =>
    `- **${m.name}** (${m.type}) — ${m.description}`;

/**
 * 记忆库总量上限（#9②，2026-09-16）：索引每轮整段注入系统提示词，无上限即无界侵蚀。
 *  - maxCount：条数上限——每条一行索引，200 条按典型行宽已是数 KB 量级，到顶先治理再新增；
 *  - maxIndexBytes：索引整体字节上限（UTF-8，含行界换行）——按 description 限长 200 字符算，
 *    200 条 CJK 满配最坏 ~130KB，字节闸先于条数闸触发，真正兜住提示词体积。
 * 非 frozen：单测需缩水上限构造越界场景（生产代码勿改）。
 * 位置说明：原在 tool/registry/memory.ts；外部记忆桥接（loader.loadExternalMemories）加载期要按
 * 同一预算拒载（外部条目计入共享池），上移到注册表让「索引格式 + 预算」同源，工具层再导出保测试路径。
 */
export const MEMORY_LIMITS = { maxCount: 200, maxIndexBytes: 16 * 1024 };

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
        .map(memoryIndexLine)
        .join("\n");
};
