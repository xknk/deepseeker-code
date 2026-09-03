/**
 * @file agents/inject.ts
 * @description 把"子 Agent 目录"清单幂等注入系统提示词（message[0].content）。
 *  镜像 skills/inject.ts 的 fence 注入模式（统一走 common.injectMarkedBlock）：
 *   - 只追加到 message[0].content，绝不新增数组元素、绝不改下标 0/1
 *     （ensureSummarySlot / ensureFitsWindow 强依赖 [0]=system [1]=summary 槽）；
 *   - run 内块级比对零漂移：catalog 变化不替换 + warn，下轮重建 message[0] 时生效。
 *  缓存安全：catalog 不变时重建逐字节复现，跨轮/跨 turn 命中 DeepSeek 前缀缓存。
 */
import { injectMarkedBlock } from "@/common/index.ts";
import { getAgentCatalog } from "./registry.ts";

const AGENT_CATALOG_MARKER = "【可用子 Agent 目录】";
// ★ 切除锚点用罕用数学括号定长串，避免中文 marker 被 agent description 复述导致 split 误切（与 skills/inject 同源修复）
const AGENT_CATALOG_FENCE = "⟦DSC:AGENT_CATALOG⟧";
const AGENT_USAGE_HINT =
    "当某子任务匹配下列某个子 Agent 的专长时，调用 spawn_agent 并传入对应 name 参数（如 spawn_agent(name=\"code-reviewer\", task=\"...\"））将其委派给该声明式子 Agent；不传 name 则走默认通用子 agent。\n" +
    "委派优先原则（P1-C）：需要一大坨专用工具或独立上下文的子任务（深度 web 调研、批量 MCP 工具操作、独立 worktree 试验等），优先委派给对应子 Agent，而非在主会话堆叠调用——子 Agent 有自己的工具白名单与独立上下文，主会话保持精简、工具表保持恒定。";

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
