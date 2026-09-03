/**
 * @file memory/inject.ts
 * @description 把「记忆索引」幂等注入系统提示词（仅一行索引/条，省 token）。
 *  镜像 outputStyles/inject.ts：injectMarkedBlock + fence 机制（run 内锁定零漂移；跨 run 源不变
 *  则重建逐字节复现 → 不破坏前缀缓存）。
 *
 *  与 output-styles 的关键差异：记忆正文不入提示词（多则记忆动辄数 KB，且每次都带会爆缓存），
 *  只注入一行索引；模型据索引判断是否需要 memory_read 召回全文（按需加载，冷记忆零成本）。
 */
import { injectMarkedBlock } from "@/common/index.ts";
import { getMemoryIndex } from "./registry.ts";

const MEMORY_FENCE = "⟦DSC:MEMORY⟧";
const MEMORY_MARKER = "【记忆索引】";

/**
 * 幂等注入记忆索引到系统提示词。
 * @param message runAgent 上下文数组（原地改 message[0].content）
 * 无记忆（getMemoryIndex 返回 null）→ 不注入（幂等无操作）。
 * 索引由 fence 锁定（run 内零漂移；跨 run 源不变则重建逐字节复现）→ 保 DeepSeek 隐式前缀缓存。
 */
export const injectMemory = (message: any[]): void => {
    const index = getMemoryIndex();
    if (!index) return; // 无记忆 → 不注入
    injectMarkedBlock(message, MEMORY_FENCE, `${MEMORY_MARKER}\n${index}`);
};
