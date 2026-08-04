/**
 * @file skills/loader.ts
 * @description Skills 加载器：扫描三个来源目录 → 解析 SKILL.md → 注册 → 注入 load_skill 工具。
 *
 *  复刻 MCP loader 四件套（readMcpConfig/wrapTool/loadMcpTools/initMcpTools）的容错骨架：
 *   - 目录不存在静默跳过；单个 skill 解析失败不影响其它（单项失败隔离）。
 *
 *  来源与优先级（同名后者覆盖前者）：
 *   - 内置（随包分发，最低）：src/core/src/skills/builtin/<name>/SKILL.md
 *   - 全局用户级：~/.deepSeekCode/skills/<name>/SKILL.md
 *   - 项目级（最高）：<cwd>/.deepSeekCode/skills/<name>/SKILL.md
 *
 *  注入：仅有 skill 时才把 load_skill 工具 push 进 agentTools（无 skill 不占工具位）。
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { appConfig } from "@/config/index.ts";
import { CustomTool } from "@/tool/type.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { registerSkill, listSkills, SkillManifest, SkillSource } from "./registry.ts";
import { skillTools } from "@/tool/registry/skill.ts";
import { LoadSource, filterSources, scanSources } from "@/common/registry.ts";

/** 内置 skill 目录：本文件所在目录下的 builtin/ */
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");

/** 三个来源（顺序即注册顺序，决定覆盖优先级） */
const SOURCES: LoadSource<SkillSource>[] = [
    { dir: BUILTIN_DIR, source: "builtin" },
    { dir: path.join(appConfig.dataDir, "skills"), source: "global" },
    { dir: path.join(process.cwd(), ".deepSeekCode", "skills"), source: "project" },
];

/** SKILL 正文大小上限：防异常大 SKILL.md 先整文塞进 tool result 再被压缩（Q-12）。 */
const MAX_SKILL_BODY_BYTES = 64 * 1024;

/** 解析单个 SKILL.md 为 manifest；失败返回 null（warn + 跳过） */
const parseSkillAt = async (skillFile: string, dir: string, source: SkillSource): Promise<SkillManifest | null> => {
    let raw: string;
    try {
        raw = await fs.readFile(skillFile, "utf-8");
    } catch {
        return null; // 无 SKILL.md 静默跳过
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
        console.warn(`⚠️ [skills] frontmatter 格式无效（${skillFile}），已跳过`);
        return null;
    }
    const name = parsed.frontmatter.name;
    const description = parsed.frontmatter.description;
    if (!name || !description) {
        console.warn(`⚠️ [skills] 缺少 name 或 description（${skillFile}），已跳过`);
        return null;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
        console.warn(`⚠️ [skills] name "${name}" 不合法（仅允许小写字母/数字/连字符，${skillFile}），已跳过`);
        return null;
    }
    const version = Number(parsed.frontmatter.version);
    // Q-12：正文超限截断（虽有 ensureFitsWindow 兜底，但在加载期即限定，避免超大正文污染 tool result）
    const body = parsed.body.length > MAX_SKILL_BODY_BYTES
        ? parsed.body.slice(0, MAX_SKILL_BODY_BYTES) + `\n\n…[SKILL 正文超 ${MAX_SKILL_BODY_BYTES} 字节，已截断]`
        : parsed.body;
    return {
        name,
        description,
        version: Number.isFinite(version) && version > 0 ? version : 1,
        dir,
        body,
        source,
    };
};

/** 扫描并注册全部 skill（按优先级顺序）；返回去重后技能数。
 *  扫描骨架（readdir 容错 + 单项失败隔离）走 common.scanSources；skills 的扫描模式 = 子目录/SKILL.md。 */
export const loadSkills = async (includeProject: boolean): Promise<number> => {
    const picked = await scanSources(
        filterSources(SOURCES, includeProject),
        (e, dir) => e.isDirectory() ? path.join(dir, e.name, "SKILL.md") : undefined,
        parseSkillAt,
    );
    for (const { item } of picked) registerSkill(item);
    return listSkills().length;
};

/**
 * 启动期加载 skills 并注入 load_skill 工具（供 serve/index.ts 调用）。
 * 仅有 skill 时才注入 load_skill；无 skill / 加载失败均静默跳过。
 */
export const initSkills = async (into: CustomTool[], includeProject: boolean): Promise<void> => {
    try {
        const n = await loadSkills(includeProject);
        if (n > 0) {
            // 防御重复注入（热重载场景）
            const hasLoadSkill = into.some(t => (t.function as any).name === "load_skill");
            if (!hasLoadSkill) into.push(...skillTools);
            console.log(`🧩 [skills] 发现 ${n} 个技能，已注入 load_skill 工具`);
        }
    } catch (e: any) {
        console.warn(`⚠️ [skills] 加载失败（已跳过）: ${e?.message ?? e}`);
    }
};
