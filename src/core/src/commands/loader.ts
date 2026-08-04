/**
 * @file commands/loader.ts
 * @description 斜杠命令加载器：扫描三个来源目录 → 解析 <name>.md → 注册。
 *
 *  复刻 skills/loader 与 mcp loader 的容错骨架：
 *   - 目录不存在静默跳过；单个命令解析失败不影响其它（单项失败隔离）。
 *
 *  来源与优先级（同名后者覆盖前者，与 skills 一致）：
 *   - 内置（随包分发，最低）：src/core/src/commands/builtin/<name>.md
 *   - 全局用户级：~/.deepSeekCode/commands/<name>.md
 *   - 项目级（最高）：<cwd>/.deepSeekCode/commands/<name>.md
 *
 *  布局：扁平 <name>.md（命令是单文件 prompt 模板无附属资源，比 <name>/COMMAND.md 更易写）。
 *  frontmatter 复用 skills/frontmatter.ts 的 parseFrontmatter（结构通用，key:value + 正文）。
 *  命令不注入工具（与 skills 不同），故 initCommands 无 into 参数。
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { appConfig } from "@/config/index.ts";
import { parseFrontmatter } from "@/skills/frontmatter.ts";
import { registerCommand, listCommands, CommandManifest, CommandSource } from "./registry.ts";

/** 内置命令目录：本文件所在目录下的 builtin/ */
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");

interface ScanSource {
    dir: string;
    source: CommandSource;
}

/** 三个来源（顺序即注册顺序，决定覆盖优先级） */
const SOURCES: ScanSource[] = [
    { dir: BUILTIN_DIR, source: "builtin" },
    { dir: path.join(appConfig.dataDir, "commands"), source: "global" },
    { dir: path.join(process.cwd(), ".deepSeekCode", "commands"), source: "project" },
];

/** 命令正文大小上限：与 skills 对齐（命令单次展开非每轮注入，可宽） */
const MAX_COMMAND_BODY_BYTES = 64 * 1024;

/** 解析单个 <name>.md 为 manifest；失败返回 null（warn + 跳过） */
const parseCommandAt = async (file: string, source: CommandSource): Promise<CommandManifest | null> => {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf-8");
    } catch {
        return null;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
        console.warn(`⚠️ [commands] frontmatter 格式无效（${file}），已跳过`);
        return null;
    }
    const name = parsed.frontmatter.name;
    const description = parsed.frontmatter.description;
    // 文件名兜底：frontmatter 缺 name 时取文件名（去 .md）
    const fallbackName = path.basename(file, ".md");
    const finalName = name || fallbackName;
    if (!description) {
        console.warn(`⚠️ [commands] 缺少 description（${file}），已跳过`);
        return null;
    }
    if (!/^[a-z0-9-]+$/.test(finalName)) {
        console.warn(`⚠️ [commands] name "${finalName}" 不合法（仅允许小写字母/数字/连字符，${file}），已跳过`);
        return null;
    }
    const body = parsed.body.length > MAX_COMMAND_BODY_BYTES
        ? parsed.body.slice(0, MAX_COMMAND_BODY_BYTES) + `\n\n…[命令正文超 ${MAX_COMMAND_BODY_BYTES} 字节，已截断]`
        : parsed.body;
    return {
        name: finalName,
        description,
        body,
        allowedTools: parsed.frontmatter.allowedTools || undefined,
        model: parsed.frontmatter.model || undefined,
        file,
        source,
    };
};

/** 扫描一个来源目录下的所有 <name>.md（扁平文件，非目录） */
const scanSource = async (s: ScanSource): Promise<CommandManifest[]> => {
    let entries: any[];
    try {
        entries = await fs.readdir(s.dir, { withFileTypes: true });
    } catch {
        return []; // 目录不存在静默跳过
    }
    const result: CommandManifest[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const m = await parseCommandAt(path.join(s.dir, entry.name), s.source);
        if (m) result.push(m);
    }
    return result;
};

/** 按 includeProject 过滤来源：未信任时排除 project（防项目级命令注入）。 */
const sourcesFor = (includeProject: boolean): ScanSource[] =>
    includeProject ? SOURCES : SOURCES.filter(s => s.source !== "project");

/** 扫描并注册全部命令（按优先级顺序）；返回去重后命令数 */
export const loadCommands = async (includeProject: boolean): Promise<number> => {
    for (const s of sourcesFor(includeProject)) {
        const manifests = await scanSource(s);
        for (const m of manifests) registerCommand(m);
    }
    return listCommands().length;
};

/**
 * 启动期加载斜杠命令（供 serve/index.ts 调用）。
 * 无命令 / 加载失败均静默跳过，绝不阻断启动。
 */
export const initCommands = async (includeProject: boolean): Promise<void> => {
    try {
        const n = await loadCommands(includeProject);
        if (n > 0) console.log(`⌘ [commands] 已加载 ${n} 个斜杠命令`);
    } catch (e: any) {
        console.warn(`⚠️ [commands] 加载失败（已跳过）: ${e?.message ?? e}`);
    }
};
