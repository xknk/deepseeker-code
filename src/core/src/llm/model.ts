/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 17:01:17
 * @LastEditTime: 2026-08-10 10:00:00
 * @FilePath: \deepSeekCode\src\core\src\llm\model.ts
 * @Description: LLM 门面层（薄）—— 单一职责：暴露 activeProvider + 向后兼容 re-export。
 *
 *  厂商实现（流式对话 streamChat / 摘要 summarize / 风险分类 classifyRisk / 错误分类 / assistant 消息构造
 *  buildAssistantMessage）已全部迁入 llm/providers/deepseek/，通用 agent 层只依赖 activeProvider 中性接口
 *  （见 llm/provider.ts）。本文件仅保留 re-export，使 truncate.ts / autoPermission.ts / tests 等既有导入零改动。
 */
import { deepseekProvider } from "./providers/deepseek/index.ts";

/**
 * 当前激活的 LLM Provider（未来按 env 选 provider 的接入点；当前固定 DeepSeek）。
 * 通用 agent 层（streamInference）依赖此中性接口——不直接感知 DeepSeek 的 reasoning_content 等厂商字段，
 *  厂商差异（思考字段、thinking 参数、错误分类、身份文本）全部收敛在 provider 实现内。
 */
export const activeProvider = deepseekProvider;

/** 非流式摘要（向后兼容 re-export）：truncate.ts 上下文压缩继续从此导入，签名不变。 */
export const chatWithModelWithSummary = deepseekProvider.summarize;

/** 工具调用风险分类器（向后兼容 re-export）：autoPermission.ts 继续从此导入。
 *  provider 对象内名为 classifyRisk，此处按旧名 classifyToolRisk 暴露，保持调用方零改动。 */
export const classifyToolRisk = deepseekProvider.classifyRisk;

/** 错误分类（向后兼容 re-export）：tests/model.test.ts 继续从此导入。
 *  provider 内名为 isTransientError，此处按旧名 isTransientApiError 暴露，保持测试零改动。 */
export const isContextLengthError = deepseekProvider.isContextLengthError;
export const isTransientApiError = deepseekProvider.isTransientError;
