/**
 * @file agents/inject.ts
 * @description 把"子 Agent 目录"清单幂等注入系统提示词（message[0].content）。
 *  镜像 skills/inject.ts 的唯一标记 + split 切除模式：
 *   - 只追加到 message[0].content，绝不新增数组元素、绝不改下标 0/1
 *     （ensureSummarySlot / ensureFitsWindow 强依赖 [0]=system [1]=summary 槽）；
 *   - 用唯一标记【可用子 Agent 目录】幂等：已含则切除旧块再重接（支持清单热更新）。
 *  缓存安全：catalog 不变时 split-reappend 产出字节稳定内容，跨轮/跨 turn 命中 DeepSeek 前缀缓存。
 */
import { injectMarkedBlock } from "@/common/index.ts";
import { getAgentCatalog } from "./registry.ts";

const AGENT_CATALOG_MARKER = "【可用子 Agent 目录】";
// ★ 切除锚点用罕用数学括号定长串，避免中文 marker 被 agent description 复述导致 split 误切（与 skills/inject 同源修复）
const AGENT_CATALOG_FENCE = "⟦DSC:AGENT_CATALOG⟧";
const AGENT_USAGE_HINT =
    "当某子任务匹配下列某个子 Agent 的专长时，调用 spawn_agent 并传入对应 name 参数（如 spawn_agent(name=\"code-reviewer\", task=\"...\"））将其委派给该声明式子 Agent；不传 name 则走默认通用子 agent。";

/**
 * 幂等注入子 Agent 目录到系统提示词。无 agent / system 槽缺失时静默跳过。
 * @param message runAgent 的上下文数组（原地修改 message[0].content）
 */
export const injectAgentCatalog = (message: any[]): void => {
    const catalog = getAgentCatalog();
    if (!catalog) return; // 无声明式 agent 不动 system prompt
    // 追加/切除逻辑统一走 common.injectMarkedBlock（skills/agents/projectGuide 共用）
    injectMarkedBlock(message, AGENT_CATALOG_FENCE, `${AGENT_CATALOG_MARKER}\n${catalog}\n\n${AGENT_USAGE_HINT}`);
};
