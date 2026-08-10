/**
 * @file llm/createModel.ts
 * @description 兼容门面：DeepSeek 的 OpenAI SDK 客户端单例 + 模型参数已迁至
 *  llm/providers/deepseek/client.ts（单一数据源）。本文件仅作 re-export，保持 cli / vscode 包对
 *  "@/llm/createModel" 路径的既有导入不变（零改动迁移）。
 *
 *  迁移背景：原 createModel.ts 的 client 构造 + DEEP_SEEK_* env 解析是厂商耦合，按 provider 抽象
 *  收敛进 llm/providers/deepseek/ 后，通用层不再直接 import client 细节。外部包（cli/vscode 读模型名、
 *  思考开关用于展示与初始化）保留旧路径即可，无需感知 provider 重构。
 */
export {
    model,
    MODEL_NAME,
    AUX_MODEL_NAME,
    MODEL_REASONING_EFFORT,
    MODEL_THINKING_ENABLED,
} from "./providers/deepseek/client.ts";
