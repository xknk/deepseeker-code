/**
 * @file skills/inject.ts
 * @description 把"技能目录"清单幂等注入系统提示词（message[0].content）。
 *
 *  复刻 planMode 的追加 + 唯一标记模式（agent/planMode.ts:23 + runAgent.ts:74-80）：
 *   - 只追加到 message[0].content，绝不新增数组元素、绝不改下标 0/1
 *     （ensureSummarySlot / ensureFitsWindow 强依赖 [0]=system [1]=summary槽）；
 *   - 用唯一标记【可用技能目录】幂等：已含则切除旧块再重接（支持清单热更新）。
 */
import { getSkillCatalog } from "./registry.ts";

const SKILL_CATALOG_MARKER = "【可用技能目录】";
const SKILL_USAGE_HINT = "当你判断当前任务匹配某个技能时，调用 load_skill 工具加载其完整指令，然后严格遵照执行。";

/**
 * 幂等注入技能目录到系统提示词。无 skill / system 槽缺失时静默跳过。
 * @param message runAgent 的上下文数组（原地修改 message[0].content）
 */
export const injectSkillCatalog = (message: any[]): void => {
    const catalog = getSkillCatalog();
    if (!catalog) return; // 无 skill 不动 system prompt

    const sys = message[0];
    if (!sys || sys.role !== 'system' || typeof sys.content !== 'string') return;

    // 幂等：已含标记则切除旧块（取标记之前的全部内容）再重接，支持清单热更新
    if (sys.content.includes(SKILL_CATALOG_MARKER)) {
        sys.content = sys.content.split(SKILL_CATALOG_MARKER)[0].trimEnd();
    }

    sys.content += `\n\n${SKILL_CATALOG_MARKER}\n${catalog}\n\n${SKILL_USAGE_HINT}`;
};
