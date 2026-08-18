/*
 * @Author: fanqianliang 2438756801@qq.com
 * @Date: 2026-06-10 15:25:11
 * @LastEditTime: 2026-08-18 00:00:00
 * @FilePath: \deepSeekCode\src\core\src\llm\model.ts
 * @Description: LLM 门面层（薄）—— 单一职责：暴露 activeProvider + 向后兼容 re-export。
 *
 *  厂商实现（流式对话 streamChat / 摘要 summarize / 风险分类 classifyRisk / 错误分类 / assistant 消息构造
 *  buildAssistantMessage）已全部迁入 llm/providers/deepseek/，通用 agent 层只依赖 activeProvider 中性接口
 *  （见 llm/provider.ts）。本文件仅保留 re-export，使 truncate.ts / autoPermission.ts / tests 等既有导入零改动。
 *
 *  ★ Provider 选择（第二梯队 #4 ReplayProvider，2026-08-18）：
 *    - env `DEEP_SEEK_PROVIDER=replay` + `DEEP_SEEK_REPLAY_SCRIPT=<script.json>` → 启动期换装回放
 *      provider（零成本确定性回归 / 演示驱动，剧本格式见 providers/replay/index.ts）。缺省固定 DeepSeek，
 *      不设 env 时行为与改造前逐字节一致。
 *    - replay 配置非法 → 模块加载期抛错（fail-fast：宁可启动失败，绝不静默回落真实付费 API）。
 *    - 运行期可 setActiveProvider 热切换（测试注入）+ resetActiveProvider 复位（teardown）。
 *      streamInference / chatProcessing 等消费方经 import 的 ESM live binding 感知切换。
 *    - 兼容 re-export（chatWithModelWithSummary / classifyToolRisk / isXxxError）改为动态委托
 *      activeProvider——切换回放后压缩摘要/风险分类/错误分类一致走回放，不再残留 DeepSeek 快照。
 */
import { readFileSync } from "fs";
import { LLMProvider } from "./provider.ts";
import { deepseekProvider } from "./providers/deepseek/index.ts";
import { createReplayProvider, ReplayScript } from "./providers/replay/index.ts";

/**
 * 启动期按 env 解析初始 provider（缺省 DeepSeek）。
 * replay 路径：读 DEEP_SEEK_REPLAY_SCRIPT 指向的剧本 JSON（裸 turns 数组或 { turns, riskVerdict?, summarizeText? }）。
 */
const resolveInitialProvider = (): LLMProvider => {
    if (process.env.DEEP_SEEK_PROVIDER !== "replay") return deepseekProvider;
    const scriptPath = process.env.DEEP_SEEK_REPLAY_SCRIPT;
    if (!scriptPath) {
        throw new Error("DEEP_SEEK_PROVIDER=replay 需同时设置 DEEP_SEEK_REPLAY_SCRIPT=<script.json>（回放剧本路径）");
    }
    let raw: any;
    try {
        raw = JSON.parse(readFileSync(scriptPath, "utf-8"));
    } catch (e: any) {
        throw new Error(`回放剧本加载失败（${scriptPath}）: ${e?.message ?? e}`);
    }
    return createReplayProvider((Array.isArray(raw) ? { turns: raw } : raw) as ReplayScript);
};

/**
 * 当前激活的 LLM Provider（缺省 DeepSeek；env 可选 replay）。
 * 通用 agent 层（streamInference / chatProcessing）依赖此中性接口——不直接感知厂商字段，
 * 厂商差异全部收敛在 provider 实现内。let + setter：测试热切换 / env 初始化唯一赋值点。
 */
export let activeProvider: LLMProvider = resolveInitialProvider();

/** 运行期热切换 provider（测试注入回放 provider 等）。 */
export const setActiveProvider = (p: LLMProvider): void => {
    activeProvider = p;
};

/** 复位回默认厂商 provider（DeepSeek；测试 teardown 用）。 */
export const resetActiveProvider = (): void => {
    activeProvider = deepseekProvider;
};

/** 非流式摘要（向后兼容 re-export）：truncate.ts 上下文压缩继续从此导入，签名不变。
 *  动态委托 activeProvider（回放模式下压缩摘要同样确定性、不打真 API）。 */
export const chatWithModelWithSummary: typeof deepseekProvider.summarize = (messages, tools, opts) =>
    activeProvider.summarize(messages, tools, opts);

/** 工具调用风险分类器（向后兼容 re-export）：autoPermission.ts 继续从此导入。
 *  动态委托 activeProvider（回放模式默认裁决 'safe'，harness 回归免审批）。 */
export const classifyToolRisk: typeof deepseekProvider.classifyRisk = (toolName, args, detail, signal) =>
    activeProvider.classifyRisk(toolName, args, detail, signal);

/** 错误分类（向后兼容 re-export）：tests/model.test.ts 继续从此导入。
 *  动态委托 activeProvider（回放 provider 自识别注入的故障标记）。 */
export const isContextLengthError: typeof deepseekProvider.isContextLengthError = (e) =>
    activeProvider.isContextLengthError(e);
export const isTransientApiError: typeof deepseekProvider.isTransientError = (e) =>
    activeProvider.isTransientError(e);
