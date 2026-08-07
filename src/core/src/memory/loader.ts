/**
 * @file memory/loader.ts
 * @description 记忆加载器：扫描 global+project 两来源扁平 *.md → 解析 frontmatter → 注册。
 *  镜像 outputStyles/loader.ts（扁平 *.md、parseFrontmatter、来源过滤 + 单项失败隔离），
 *  但不含 builtin 源（记忆是用户/agent 私有笔记，不随包分发）。
 *
 *  来源与优先级（同名后者覆盖前者，project > global）：
 *   - 全局：~/.deepseeker-code/memory/<name>.md     （跨项目共享：用户偏好/反馈/通用事实）
 *   - 项目：<cwd>/.deepseeker-code/memory/<name>.md （项目专属：可提交进 git 供团队共享）
 *
 *  记忆目录在工作区沙箱外，read_file 读不到——故记忆的读写由专用 memory_* 工具管理，
 *  不复用 fs 工具（避免绕过沙箱的歧义）。
 */
import fs from "fs/promises";
import path from "path";
import { appConfig } from "@/config/index.ts";
import { parseFrontmatter } from "@/skills/frontmatter.ts";
import { registerMemory, listMemories, clearMemories, MemoryManifest, MemorySource, MemoryType } from "./registry.ts";
import { LoadSource, filterSources, scanSources } from "@/common/registry.ts";

/** 全局记忆目录（memory_save 默认落盘点；亦供工具复用）。 */
export const GLOBAL_MEMORY_DIR = path.join(appConfig.dataDir, "memory");

const SOURCES: LoadSource<MemorySource>[] = [
    { dir: GLOBAL_MEMORY_DIR, source: "global" },
    { dir: path.join(process.cwd(), ".deepseeker-code", "memory"), source: "project" },
];

const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** 解析单个记忆 .md 为 manifest；失败返回 null（warn + 跳过，单项失败隔离） */
const parseMemoryAt = async (file: string, _dir: string, source: MemorySource): Promise<MemoryManifest | null> => {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf-8");
    } catch {
        return null;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
        console.warn(`⚠️ [memory] frontmatter 格式无效（${file}），已跳过`);
        return null;
    }
    const name = parsed.frontmatter.name;
    const description = parsed.frontmatter.description;
    if (!name || !description) {
        console.warn(`⚠️ [memory] 缺少 name 或 description（${file}），已跳过`);
        return null;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
        console.warn(`⚠️ [memory] name "${name}" 不合法（仅允许小写字母/数字/连字符，${file}），已跳过`);
        return null;
    }
    if (!parsed.body.trim()) {
        console.warn(`⚠️ [memory] 正文为空（${file}），已跳过`);
        return null;
    }
    const type = (parsed.frontmatter.type as MemoryType) || 'reference';
    if (!VALID_TYPES.includes(type)) {
        console.warn(`⚠️ [memory] type "${parsed.frontmatter.type}" 非法（须 user/feedback/project/reference，${file}），已跳过`);
        return null;
    }
    return { name, description, type, body: parsed.body.trim(), source, file };
};

/** 扫描并注册全部记忆（按优先级顺序）；返回去重后数量。 */
export const loadMemories = async (includeProject: boolean): Promise<number> => {
    clearMemories(); // 干净重载：memory_save 会直接改注册表，重载前清空防「磁盘已删但注册表残留」
    const picked = await scanSources(
        filterSources(SOURCES, includeProject),
        (e, dir) => (e.isFile() && e.name.endsWith(".md")) ? path.join(dir, e.name) : undefined,
        parseMemoryAt,
    );
    for (const { item } of picked) registerMemory(item);
    return listMemories().length;
};

/** 启动期加载记忆（供 bootstrap 调用）。无配置/加载失败均静默跳过。 */
export const initMemories = async (includeProject: boolean): Promise<void> => {
    try {
        const n = await loadMemories(includeProject);
        if (n > 0) console.log(`🧠 [memory] 已加载 ${n} 条记忆`);
    } catch (e: any) {
        console.warn(`⚠️ [memory] 加载失败（已跳过）: ${e?.message ?? e}`);
    }
};
