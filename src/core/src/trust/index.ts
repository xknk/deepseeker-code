/**
 * @file trust/index.ts
 * @description 信任文件夹机制：启动期安全闸门的状态存储（与宿主无关，CLI/serve 可复用）。
 *
 *  首次进入未信任目录时由宿主（CLI）弹确认；信任后持久化该目录绝对路径。
 *  initEngine 据信任状态（includeProject）决定是否加载【项目级】配置——
 *  防恶意目录的 hooks（spawn 执行命令）/ CLAUDE.md（注入 system prompt）/ permissions（auto-approve）自动生效。
 */
import path from "path";
import fs from "fs/promises";
import { appConfig } from "@/config/index.ts";
import { readJSONFile, atomicWriteJSON } from "@/common/index.ts";

const TRUSTED_FILE = path.join(appConfig.dataDir, "trusted_dirs.json");

/**
 * 规范化目录绝对路径：resolve + 反斜杠转正斜杠 + Windows 盘符首字母大写。
 * 对齐 config/index.ts 的 userWorkspaceDir 规整，避免大小写/分隔符差异导致漏判或重复信任。
 */
export const normalizeDir = (dir: string): string => {
    let d = path.resolve(dir).replace(/\\/g, "/");
    if (/^[a-z]:/i.test(d)) d = d.charAt(0).toUpperCase() + d.slice(1);
    return d;
};

/** 读取已信任目录列表（每项规范化）；文件缺失/损坏返回空数组，绝不抛错阻断启动。 */
export const readTrustedDirs = async (): Promise<string[]> => {
    const list = await readJSONFile<unknown>(TRUSTED_FILE);
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === "string").map(normalizeDir);
};

/** 当前目录是否已被信任。 */
export const isTrustedDir = async (dir: string): Promise<boolean> => {
    const norm = normalizeDir(dir);
    const trusted = await readTrustedDirs();
    return trusted.includes(norm);
};

/** 标记目录为信任（去重 append + dataDir 兜底 + 原子写）。 */
export const trustDir = async (dir: string): Promise<void> => {
    const norm = normalizeDir(dir);
    const trusted = await readTrustedDirs();
    if (trusted.includes(norm)) return;
    trusted.push(norm);
    await fs.mkdir(appConfig.dataDir, { recursive: true });
    await atomicWriteJSON(TRUSTED_FILE, trusted);
};

/** 撤销目录信任（移除 + 原子写）；不在列表返回 false（无操作）。与 trustDir 对称，供「管理信任目录」命令回滚误信任。 */
export const untrustDir = async (dir: string): Promise<boolean> => {
    const norm = normalizeDir(dir);
    const trusted = await readTrustedDirs();
    const next = trusted.filter((d) => d !== norm);
    if (next.length === trusted.length) return false; // 不在信任列表
    await atomicWriteJSON(TRUSTED_FILE, next);
    return true;
};
