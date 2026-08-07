/**
 * @file statusLine/config.ts
 * @description 状态栏配置读取（P2-16，对标 Claude Code statusLine）：从 settings.json 的
 *  `statusLine` 段读 {command, padding?}。全局 ~/.deepseeker-code + 项目 <cwd>/.deepseeker-code 叠加，
 *  项目级覆盖全局（单命令语义，非数组拼接）。镜像 hooks/loader.ts 的 settings.json 读取容错骨架。
 *
 *  配置示例（settings.json）：
 *   { "statusLine": { "command": "~/.deepseeker-code/statusline.sh", "padding": 0 } }
 *  command 以 shell 执行，harness 把上下文 JSON 灌进其 stdin，stdout 首行作为底部状态栏（见 runner.ts）。
 */
import fs from "fs/promises";
import path from "path";
import { appConfig } from "@/config/index.ts";

export interface StatusLineConfig {
    /** 以 shell 执行的状态栏命令；接收 JSON stdin，stdout 首行作为状态栏文本。 */
    command: string;
    /** 可选左侧空格填充（对标 CC padding，默认 0）。 */
    padding?: number;
}

/** 从单个已解析 settings.json 提取并校验 statusLine 段；非法/缺失返回 null。 */
const parseBlock = (parsed: any): StatusLineConfig | null => {
    const block = parsed?.statusLine;
    if (!block || typeof block !== "object") return null;
    const command = block.command;
    if (typeof command !== "string" || !command.trim()) return null;
    const padding = typeof block.padding === "number" && Number.isFinite(block.padding) ? block.padding : undefined;
    return { command: command.trim(), padding };
};

/**
 * 读取状态栏配置：全局 → 项目级（后者覆盖前者）。includeProject=false 时仅读全局（未信任目录防注入）。
 * 无配置/解析失败均返回 null（调用方据此跳过子进程，零开销）。
 */
export const readStatusLineConfig = async (includeProject: boolean): Promise<StatusLineConfig | null> => {
    const paths = [
        path.join(appConfig.dataDir, "settings.json"),                                                // 全局用户级
        ...(includeProject ? [path.join(process.cwd(), ".deepseeker-code", "settings.json")] : []),      // 项目级（覆盖）；未信任时省略
    ];
    let result: StatusLineConfig | null = null;
    for (const configPath of paths) {
        let raw: string;
        try {
            raw = await fs.readFile(configPath, "utf-8");
        } catch {
            continue; // 文件不存在 → 静默跳过
        }
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch {
            continue; // 解析失败 → 静默跳过（hooks loader 会另行告警）
        }
        const cfg = parseBlock(parsed);
        if (cfg) result = cfg; // 项目级（后读）覆盖全局
    }
    return result;
};
