/**
 * @file memory/usage.ts
 * @description 记忆使用画像存储（后续路线 #9 记忆生命周期治理③，2026-09-16）。
 *
 *  「只增不减的一行索引」是唯一随使用单调侵蚀每轮 prompt 的组件，治理的淘汰环节需要使用数据：
 *  memory_read / memory_save 时记 last-used 与读取次数，落盘 <GLOBAL_MEMORY_DIR>/.usage.json。
 *  纯观测数据——读写全程 best-effort，任何失败不阻断记忆主流程；文件损坏按空表重来。
 *
 *  为什么独立 JSON 而非写回 .md frontmatter：读操作不应改写记忆文件（mtime 漂移 / 手工编辑冲突），
 *  且 loader 扫描只收 *.md，`.usage.json` 天然不进注册表、不占索引。
 */
import fs from "fs/promises";
import path from "path";
import { GLOBAL_MEMORY_DIR } from "./loader.ts";
import { readJSONFile } from "@/common/index.ts";

const USAGE_FILE = path.join(GLOBAL_MEMORY_DIR, ".usage.json");

export interface MemoryUsageEntry {
    /** 最近一次使用（read/save）的 ISO 时间戳 */
    lastUsed: string;
    /** memory_read 累计次数（save 不计） */
    reads: number;
}

type UsageMap = Record<string, MemoryUsageEntry>;

const readUsage = async (): Promise<UsageMap> => {
    const raw = await readJSONFile<unknown>(USAGE_FILE);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as UsageMap) : {};
};

/**
 * 记一次使用（memory_save 触碰 lastUsed 供淘汰参考；memory_read 另计读取次数）。
 * best-effort：目录可建、写失败仅告警，绝不抛错阻断调用方。
 */
export const recordMemoryUse = async (name: string, kind: "read" | "save"): Promise<void> => {
    try {
        const map = await readUsage();
        const prev = map[name];
        map[name] = {
            lastUsed: new Date().toISOString(),
            reads: (prev?.reads ?? 0) + (kind === "read" ? 1 : 0),
        };
        await fs.mkdir(GLOBAL_MEMORY_DIR, { recursive: true });
        await fs.writeFile(USAGE_FILE, JSON.stringify(map, null, 2), "utf-8");
    } catch (e: any) {
        console.warn(`⚠️ [memory] 使用画像记录失败（已忽略）: ${e?.message ?? e}`);
    }
};

/** 读全部使用画像（供未来淘汰策略 / 使用画像报告；无数据返回空对象）。 */
export const getMemoryUsage = async (): Promise<UsageMap> => readUsage();
