/**
 * @file cli/src/preload-config.ts
 * @description CLI 启动最早的配置预加载：同步读取 ~/.deepseeker-code/config.json，把连接/模型/运行时字段
 *  回填到 process.env.DEEP_SEEK_*（仅当 env 未设时——环境变量优先级最高，作为逃生通道）。
 *
 *  ★ 必须是 main.tsx 的第一个 import（在任何 core 模块求值之前执行）。core 模块（config/index.ts、
 *    createModel.ts 等）在加载期就把 env 拍成定值（如 parallelSafeTools、OpenAI client 的 apiKey），
 *    而它们经 prefs.ts / @/trust 被 main.tsx 静态 import——ESM 按声明序 depth-first post-order 求值，
 *    本文件作为「纯叶子 + 首条 import」必先于它们求值，从而保证 env 在 core 定值前已回填。
 *  ★ 严禁 import core 或 @/common（会拖入 config/index.ts 求值图，反而把回填时机推后）。仅用 node 内置。
 *
 *  容错：文件缺失静默跳过；解析失败打 stderr 警告（不污染 Ink 的 stdout 行追踪）；绝不抛错阻断启动。
 *  映射逻辑抽成纯函数 applyConfigToEnv 便于单测；本文件仅负责「读文件 + 调用它」的副作用编排。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** config.json 的可选字段（连接 / 模型 / 运行时）。boolean 反向字段（thinking / parallelSafeTools）默认开。 */
export interface UserConfig {
    apiKey?: string;
    apiUrl?: string;
    model?: string;
    auxModel?: string;
    reasoningEffort?: string;
    thinking?: boolean;
    parallelSafeTools?: boolean;
    streamIdleTimeoutMs?: number;
    workflowConcurrency?: number;
    workflowMaxSteps?: number;
}

/**
 * 把 config.json 字段回填到 env（纯函数，便于单测）。
 *  优先级：env（已设）> cfg 字段 > core 默认。仅在 env 未设（undefined 或 ""）时回填；"0" 视为已设、不覆盖。
 *  boolean 反向字段（默认开）：true / 缺省不干预（让 core 默认生效），仅 false 写 "0"。
 *  mutate 入参 env（默认 process.env），返回它以便测试断言。
 */
export const applyConfigToEnv = (cfg: UserConfig, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
    /** 仅当 env 未设（undefined 或空串）时写入；"0" 是合法的显式关闭，不算未设。 */
    const setEnv = (envKey: string, value: unknown): void => {
        if (value === undefined || value === null) return;
        const cur = env[envKey];
        if (cur !== undefined && cur !== "") return; // 环境变量优先（逃生通道）
        const s = typeof value === "string" ? value : String(value);
        if (s === "") return;
        env[envKey] = s;
    };
    // 字符串 / 数字类：直传（core 侧各自容错——reasoningEffort 由 clampReasoningEffort 校验，数字由 Number()||默认）
    setEnv("DEEP_SEEK_API_KEY", cfg.apiKey);
    setEnv("DEEP_SEEK_API_URL", cfg.apiUrl);
    setEnv("DEEP_SEEK_MODEL", cfg.model);
    setEnv("DEEP_SEEK_AUX_MODEL", cfg.auxModel);
    setEnv("DEEP_SEEK_REASONING_EFFORT", cfg.reasoningEffort);
    setEnv("DEEP_SEEK_STREAM_IDLE_TIMEOUT_MS", cfg.streamIdleTimeoutMs);
    setEnv("DEEP_SEEK_WORKFLOW_CONCURRENCY", cfg.workflowConcurrency);
    setEnv("DEEP_SEEK_WORKFLOW_MAX_STEPS", cfg.workflowMaxSteps);
    // 布尔反向（默认开）：仅 false 写 "0"；true/缺省不干预（让 core 默认值生效，避免 "1" 盖掉其它意图）
    if (cfg.thinking === false) setEnv("DEEP_SEEK_THINKING", "0");
    if (cfg.parallelSafeTools === false) setEnv("DEEP_SEEK_PARALLEL_SAFE_TOOLS", "0");
    return env;
};

/**
 * 数据目录（与 config/index.ts 同款推导，但此处不能 import 它——鸡生蛋：dataDir 决定 config.json 的位置）。
 *  DEEPSEEKER_CODE_DATA_DIR env 优先，否则 ~/.deepseeker-code。
 */
const dataDir = process.env.DEEPSEEKER_CODE_DATA_DIR
    ? path.resolve(process.env.DEEPSEEKER_CODE_DATA_DIR)
    : path.join(os.homedir(), ".deepseeker-code");

/** 同步读取 config.json。文件缺失静默；解析失败打 stderr 警告。绝不抛错。 */
const loadConfigFile = (): UserConfig => {
    const cfgPath = path.join(dataDir, "config.json");
    let raw: string;
    try {
        raw = readFileSync(cfgPath, "utf-8");
    } catch {
        return {}; // 文件缺失：静默（首次使用最常见，config.json 尚未创建）
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as UserConfig) : {};
    } catch (e: any) {
        // 解析失败：config.json 写坏了。打 stderr（不污染 Ink 的 stdout 行追踪），不阻断启动。
        console.error(`⚠️ [config] 配置文件解析失败（${cfgPath}）：${e?.message ?? e}，已忽略该文件。`);
        return {};
    }
};

applyConfigToEnv(loadConfigFile());
