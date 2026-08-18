/**
 * @file config/dump.ts
 * @description dump-config（第二梯队 #5）：合并后有效配置树 + 逐字段来源标注（只读快照）。
 *
 *  输出四段：
 *  - effective     appConfig 全量生效值（机密字段只出指纹，不出明文）；
 *  - sources       逐字段来源（default / env / settings.global / settings.project）——
 *                  由 config/index.ts 模块加载期随合并过程记录（env 判定 + engine 白名单采纳），
 *                  本模块不重复推导，杜绝「dump 逻辑与合并逻辑两套实现漂移」；
 *  - envVars       字段 → 环境变量名映射（自查「这个行为受哪个变量控制」）；
 *  - settingsFiles 两个 settings.json 的探测路径与存在性（调用时现查，非加载期快照）。
 *
 *  确定性：无时间戳 / 无随机——两次调用输出逐字节一致，便于 diff 与回归断言。
 *  消费方：serve GET /api/config（本地程序化诊断入口，自动过 requireAuth）。
 */
import { existsSync } from "fs";
import path from "path";
import { appConfig, configSources, ENV_SOURCES, ConfigSource } from "./index.ts";

/** 机密字段：只呈现「前4…后4 + 长度」指纹。本地单人端点也做脱敏——防顺手截图 / 贴日志泄 key。 */
const SECRET_KEYS = new Set(["tavilyApiKey"]);

const maskSecret = (v: string): string =>
    !v ? "" : v.length <= 8 ? `[MASKED ${v.length} chars]` : `${v.slice(0, 4)}…${v.slice(-4)} [MASKED ${v.length} chars]`;

/** dump-config 输出契约（settingsFiles.exists 为调用时探测结果，其余确定性）。 */
export type ConfigDump = {
    effective: Record<string, unknown>;
    sources: Record<string, ConfigSource>;
    envVars: Record<string, string>;
    settingsFiles: Array<{ scope: ConfigSource; path: string; exists: boolean }>;
};

/**
 * 构造合并后有效配置树 + 来源标注。只读（不改 appConfig / configSources / 文件系统），
 * 非白名单未知字段不输出（appConfig 是唯一事实源）。
 */
export const dumpEffectiveConfig = (): ConfigDump => {
    const effective: Record<string, unknown> = {};
    const sources: Record<string, ConfigSource> = {};
    for (const key of Object.keys(appConfig)) {
        const v = (appConfig as Record<string, unknown>)[key];
        effective[key] = SECRET_KEYS.has(key) && typeof v === "string" ? maskSecret(v) : v;
        sources[key] = configSources[key] ?? "default";
    }
    const globalPath = path.join(appConfig.dataDir, "settings.json");
    const projectPath = path.join(process.cwd(), ".deepseeker-code", "settings.json");
    return {
        effective,
        sources,
        envVars: { ...ENV_SOURCES },
        settingsFiles: [
            { scope: "settings.global", path: globalPath, exists: existsSync(globalPath) },
            { scope: "settings.project", path: projectPath, exists: existsSync(projectPath) },
        ],
    };
};
