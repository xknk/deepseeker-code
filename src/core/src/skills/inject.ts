/**
 * @file skills/inject.ts
 * @description 把"技能目录"清单幂等注入系统提示词（message[0].content）。
 *
 *  追加 + 唯一标记模式，幂等统一走 common.injectMarkedBlock（P0-B 会话首锁）：
 *   - 只追加到 message[0].content，绝不新增数组元素、绝不改下标 0/1
 *     （ensureSummarySlot / ensureFitsWindow 强依赖 [0]=system [1]=summary槽）；
 *   - run 内块级比对零漂移：清单变化不替换 + warn，下轮重建 message[0] 时生效
 *     （替换会击穿 DeepSeek 前缀缓存，已废弃早期「切除旧块再重接」的热更新方案）。
 */
import { injectMarkedBlock } from "@/common/index.ts";
import { getSkillCatalog } from "./registry.ts";

const SKILL_CATALOG_MARKER = "【可用技能目录】";
// ★ 切除锚点用罕用数学括号定长串（与 command.ts EXIT_SENTINEL 同风格），正文/描述极不可能出现，
//   避免中文 marker（【可用技能目录】）被 skill description 复述导致 split 误切除其后全部注入。
const SKILL_CATALOG_FENCE = "⟦DSC:SKILL_CATALOG⟧";
const SKILL_USAGE_HINT = "当你判断当前任务匹配某个技能时，调用 load_skill 工具加载其完整指令，然后严格遵照执行。";

/**
 * 幂等注入技能目录到系统提示词。无 skill / system 槽缺失时静默跳过。
 * @param message runAgent 的上下文数组（原地修改 message[0].content）
 */
export const injectSkillCatalog = (message: any[]): void => {
    const catalog = getSkillCatalog();
    if (!catalog) return; // 无 skill 不动 system prompt
    // 追加/切除逻辑统一走 common.injectMarkedBlock（skills/agents/projectGuide 共用）
    injectMarkedBlock(message, SKILL_CATALOG_FENCE, `${SKILL_CATALOG_MARKER}\n${catalog}\n\n${SKILL_USAGE_HINT}`);
};
