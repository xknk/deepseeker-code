/**
 * @file projectGuide/inject.ts
 * @description 把项目指引幂等注入系统提示词（message[0].content）。
 *
 *  逐字复刻 skills/inject.ts 的「追加 + 唯一标记」幂等模式：
 *   - 只追加到 message[0].content，绝不新增数组元素、绝不改下标 0/1
 *     （ensureSummarySlot / ensureFitsWindow 强依赖 [0]=system [1]=summary槽）；
 *   - 用唯一标记【项目指引】幂等：已含则切除旧块再重接（支持热更新）。
 */
import { getProjectGuide } from "./loader.ts";

const PROJECT_GUIDE_MARKER = "【项目指引】";
// ★ 切除锚点用罕用数学括号定长串，避免中文 marker 被指引正文复述导致 split 误切（与 skills/inject 同源修复）
const PROJECT_GUIDE_FENCE = "⟦DSC:PROJECT_GUIDE⟧";
const PROJECT_GUIDE_HINT = "以上为项目根目录的 AI 行为指引（自动注入，可能已截断）。需要完整内容时调用 read_project_guide。";

/**
 * 幂等注入项目指引到系统提示词。无指引 / system 槽缺失时静默跳过。
 * @param message runAgent 的上下文数组（原地修改 message[0].content）
 */
export const injectProjectGuide = (message: any[]): void => {
    const guide = getProjectGuide();
    if (!guide) return; // 无指引不动 system prompt

    const sys = message[0];
    if (!sys || sys.role !== 'system' || typeof sys.content !== 'string') return;

    // 幂等：按 FENCE 锚点切除旧块再重接（FENCE 罕用，不会被正文复述误触发）
    if (sys.content.includes(PROJECT_GUIDE_FENCE)) {
        sys.content = sys.content.split(PROJECT_GUIDE_FENCE)[0].trimEnd();
    }

    sys.content += `\n\n${PROJECT_GUIDE_FENCE}\n${PROJECT_GUIDE_MARKER}\n（via ${guide.name}）\n${guide.body}\n\n${PROJECT_GUIDE_HINT}`;
};
