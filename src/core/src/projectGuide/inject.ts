/**
 * @file projectGuide/inject.ts
 * @description 把项目指引幂等注入系统提示词（message[0].content）。
 *
 *  逐字复刻 skills/inject.ts 的 fence 幂等注入模式（统一走 common.injectMarkedBlock）：
 *   - 只追加到 message[0].content，绝不新增数组元素、绝不改下标 0/1
 *     （ensureSummarySlot / ensureFitsWindow 强依赖 [0]=system [1]=summary槽）；
 *   - run 内零漂移：指引变化不替换 + warn，下轮重建 message[0] 时生效（不支持热更新）。
 */
import { injectMarkedBlock } from "@/common/index.ts";
import { getProjectGuide } from "./loader.ts";

const PROJECT_GUIDE_MARKER = "【项目指引】";
// ★ 切除锚点用罕用数学括号定长串，避免中文 marker 被指引正文复述导致 split 误切（与 skills/inject 同源修复）
const PROJECT_GUIDE_FENCE = "⟦DSC:PROJECT_GUIDE⟧";
// ★ 优先级显式声明（2026-11-26）：此前用户指引与 SYSTEM_PROMPT 默认行为冲突时只靠注入位置（尾部
//   recency）隐性生效，模型仲裁是统计倾向非确定规则。显式声明「指引为准 + 安全边界除外」消除摇摆；
//   「除外」半句必须有——否则用户在指引里写「写文件不用审批」会让模型产生错误预期、反复撞执行层门禁。
//   改动仅静态文案：新会话即生效；旧会话 --continue 下轮重建 message[0] 时破一次前缀缓存（合理代价）。
//   例外清单（安全门禁、审批约定、工具使用协议）须与 memory/inject.ts 的尾注逐项一致，守门见
//   tests/prompt-priority-declaration.test.ts。
const PROJECT_GUIDE_HINT = "以上为项目根目录的 AI 行为指引（自动注入，可能已截断）。本指引与系统默认行为准则冲突时，以本指引为准；但安全门禁、审批约定与工具使用协议除外。需要完整内容时调用 read_project_guide。";

/**
 * 幂等注入项目指引到系统提示词。无指引 / system 槽缺失时静默跳过。
 * @param message runAgent 的上下文数组（原地修改 message[0].content）
 */
export const injectProjectGuide = (message: any[]): void => {
    const guide = getProjectGuide();
    if (!guide) return; // 无指引不动 system prompt
    // 追加/切除逻辑统一走 common.injectMarkedBlock（skills/agents/projectGuide 共用）
    injectMarkedBlock(message, PROJECT_GUIDE_FENCE, `${PROJECT_GUIDE_MARKER}\n（via ${guide.name}）\n${guide.body}\n\n${PROJECT_GUIDE_HINT}`);
};
