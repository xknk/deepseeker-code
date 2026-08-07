/**
 * @file cli/src/prefs.ts
 * @description 用户界面偏好持久化（当前仅 locale）。存 ~/.deepseeker-code/prefs.json，复用 core 的 readJSONFile/atomicWriteJSON。
 *  与 settings.json 分离：settings.json 是 engine 声明式配置（engine/hooks/permissions/statusLine），prefs 是 UI 偏好。
 */
import path from "path";
import fs from "fs/promises";
import { appConfig } from "@/config/index.ts";
import { readJSONFile, atomicWriteJSON, type Locale } from "@/common/index.ts";

const PREFS_FILE = path.join(appConfig.dataDir, "prefs.json");

interface Prefs {
    locale?: Locale;
}

/** 读取偏好；文件缺失/损坏返回空对象，绝不抛错阻断启动。 */
export const readPrefs = async (): Promise<Prefs> => {
    const p = await readJSONFile<Prefs>(PREFS_FILE);
    return p && typeof p === "object" ? p : {};
};

/** 读取已存的 locale（未设/非法返回 null）。 */
export const readLocale = async (): Promise<Locale | null> => {
    const { locale } = await readPrefs();
    return locale === "zh" || locale === "en" ? locale : null;
};

/** 原子写偏好（read-modify-write 保留其它字段 + 目录兜底）。 */
export const writePrefs = async (patch: Partial<Prefs>): Promise<void> => {
    const cur = await readPrefs();
    await fs.mkdir(appConfig.dataDir, { recursive: true });
    await atomicWriteJSON(PREFS_FILE, { ...cur, ...patch });
};

/** 持久化 locale（writePrefs 的便捷封装）。 */
export const writeLocale = async (locale: Locale): Promise<void> => {
    await writePrefs({ locale });
};
