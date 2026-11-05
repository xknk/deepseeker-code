/**
 * @file memory/inject.ts
 * @description 把「记忆索引」幂等注入系统提示词（仅一行索引/条，省 token）。
 *  镜像 outputStyles/inject.ts：injectMarkedBlock + fence 机制（run 内锁定零漂移；跨 run 源不变
 *  则重建逐字节复现 → 不破坏前缀缓存）。
 *
 *  与 output-styles 的关键差异：记忆正文不入提示词（多则记忆动辄数 KB，且每次都带会爆缓存），
 *  只注入一行索引；模型据索引判断是否需要 memory_read 召回全文（按需加载，冷记忆零成本）。
 *
 *  ★ M2 会话级快照冻结（缓存塌方治理，2026-11-04）：带 sessionId 调用时，该会话**首次注入**时把
 *  记忆索引（或「无记忆」= null）冻结进会话级快照，后续 run 一律复用快照——会话中途写记忆
 *  （memory_write / memory_forget 改动 registry）不再改写 message[0] → 前缀缓存不被击穿
 *  （方案 A 项：实测 ¥0.58/天量级）。跨会话（新 sessionId）重新实时读，新记忆下一会话生效。
 *  容量上界 = 活跃会话数（方案已接受）；serve 宿主在 SessionEnd 释放（clearMemorySnapshot），
 *  其余宿主（CLI/VSCode 单会话进程）量级有界、无需清理。
 */
import { injectMarkedBlock } from "@/common/index.ts";
import { getMemoryIndex } from "./registry.ts";

const MEMORY_FENCE = "⟦DSC:MEMORY⟧";
const MEMORY_MARKER = "【记忆索引】";

/** 会话级记忆索引快照：sessionId → 首次注入时刻的索引（null = 冻结「无记忆」态，同样不许中途翻转）。 */
const memorySnapshots = new Map<string, string | null>();

/**
 * 幂等注入记忆索引到系统提示词。
 * @param message runAgent 上下文数组（原地改 message[0].content）
 * @param sessionId 会话 ID（缓存塌方治理 M2）：传入启用会话级快照冻结（首次注入定格，跨 run 字节恒定）；
 *                  缺省（旧调用方兼容）维持实时读，行为与旧版一致。
 * 无记忆（实时读或冻结快照为 null）→ 不注入（幂等无操作）。
 * 索引由 fence 锁定（run 内零漂移；跨 run 源不变则重建逐字节复现）→ 保 DeepSeek 隐式前缀缓存。
 */
export const injectMemory = (message: any[], sessionId?: string): void => {
    let index: string | null;
    if (sessionId === undefined) {
        index = getMemoryIndex(); // 旧调用方：实时读（行为零变化）
    } else {
        if (!memorySnapshots.has(sessionId)) {
            memorySnapshots.set(sessionId, getMemoryIndex()); // 首次注入定格（null 也是定格态）
        }
        index = memorySnapshots.get(sessionId) ?? null;
    }
    if (!index) return; // 无记忆 → 不注入
    injectMarkedBlock(message, MEMORY_FENCE, `${MEMORY_MARKER}\n${index}`);
};

/** 会话结束释放该会话的记忆快照（serve 宿主 SessionEnd 调用；防长驻进程 Map 随历史会话数无界增长）。 */
export const clearMemorySnapshot = (sessionId: string): void => {
    memorySnapshots.delete(sessionId);
};
