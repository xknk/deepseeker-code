/**
 * @file outputStyles/loader.ts
 * @description 输出风格加载器（P2-16）：扫描三来源扁平 *.md → 解析 frontmatter → 注册。
 *  镜像 commands/loader.ts（扁平 *.md、parseFrontmatter、三来源 + 单项失败隔离）。
 *
 *  来源与优先级（同名后者覆盖前者，project > global > builtin）：
 *   - 内置：src/core/src/outputStyles/builtin/<name>.md
 *   - 全局：~/.deepseeker-code/output-styles/<name>.md
 *   - 项目：<cwd>/.deepseeker-code/output-styles/<name>.md
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { appConfig } from "@/config/index.ts";
import { parseFrontmatter } from "@/skills/frontmatter.ts";
import { registerOutputStyle, listOutputStyles, OutputStyleManifest, OutputStyleSource } from "./registry.ts";
import { LoadSource, filterSources, scanSources } from "@/common/registry.ts";

const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");

const SOURCES: LoadSource<OutputStyleSource>[] = [
    { dir: BUILTIN_DIR, source: "builtin" },
    { dir: path.join(appConfig.dataDir, "output-styles"), source: "global" },
    { dir: path.join(process.cwd(), ".deepseeker-code", "output-styles"), source: "project" },
];

/** 解析单个风格 .md 为 manifest；失败返回 null（warn + 跳过） */
const parseStyleAt = async (file: string, _dir: string, source: OutputStyleSource): Promise<OutputStyleManifest | null> => {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf-8");
    } catch {
        return null;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
        console.warn(`⚠️ [output-styles] frontmatter 格式无效（${file}），已跳过`);
        return null;
    }
    const name = parsed.frontmatter.name;
    const description = parsed.frontmatter.description;
    if (!name || !description) {
        console.warn(`⚠️ [output-styles] 缺少 name 或 description（${file}），已跳过`);
        return null;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
        console.warn(`⚠️ [output-styles] name "${name}" 不合法（仅允许小写字母/数字/连字符，${file}），已跳过`);
        return null;
    }
    if (!parsed.body.trim()) {
        console.warn(`⚠️ [output-styles] 正文为空（${file}），已跳过`);
        return null;
    }
    return { name, description, body: parsed.body.trim(), source };
};

/** 扫描并注册全部风格（按优先级顺序）；返回去重后数量。 */
export const loadOutputStyles = async (includeProject: boolean): Promise<number> => {
    const picked = await scanSources(
        filterSources(SOURCES, includeProject),
        (e, dir) => (e.isFile() && e.name.endsWith(".md")) ? path.join(dir, e.name) : undefined,
        parseStyleAt,
    );
    for (const { item } of picked) registerOutputStyle(item);
    return listOutputStyles().length;
};

/** 启动期加载输出风格（供 serve/index.ts 调用）。无配置/加载失败均静默跳过。 */
export const initOutputStyles = async (includeProject: boolean): Promise<void> => {
    try {
        const n = await loadOutputStyles(includeProject);
        if (n > 0) console.log(`🎨 [output-styles] 已加载 ${n} 个输出风格（/output-style 切换）`);
    } catch (e: any) {
        console.warn(`⚠️ [output-styles] 加载失败（已跳过）: ${e?.message ?? e}`);
    }
};
