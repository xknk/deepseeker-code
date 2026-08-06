/**
 * @file outputStyles/inject.ts
 * @description 把选用的输出风格 persona 幂等注入系统提示词（P2-16）。
 *  镜像 skills/agents/projectGuide 的 injectMarkedBlock 模式（fence 机制，会话内不变 → 不破坏前缀缓存）。
 */
import { injectMarkedBlock } from "@/common/index.ts";
import { getOutputStyle } from "./registry.ts";

const OUTPUT_STYLE_FENCE = "⟦DSC:OUTPUT_STYLE⟧";
const OUTPUT_STYLE_MARKER = "【输出风格】";

/**
 * 幂等注入输出风格到系统提示词。
 * @param message runAgent 上下文数组（原地改 message[0].content）
 * @param styleName 用户选用的风格名；未设/未命中 manifest → 不注入（幂等无操作）。
 *   风格不变时注入块字节稳定（injectMarkedBlock fence 机制）→ 保 DeepSeek 隐式前缀缓存。
 */
export const injectOutputStyle = (message: any[], styleName?: string): void => {
    if (!styleName) return;
    const style = getOutputStyle(styleName);
    if (!style) return; // 未命中（拼写错/已卸载）→ 不注入，保持中性默认
    injectMarkedBlock(message, OUTPUT_STYLE_FENCE, `${OUTPUT_STYLE_MARKER}（${style.name}）\n${style.body}`);
};
