/**
 * @file agents/frontmatter.ts
 * @description 复用 skills/frontmatter.ts 的零依赖 frontmatter 解析器。
 *  .agent.md 与 SKILL.md 同构（首行 ---，首个冒号切分），故不重写解析逻辑。
 *  agent 专属字段（tools 逗号 split / model）的类型化在 loader 构造 manifest 时完成，
 *  与 skills loader 处理 version 字段同模式。
 */
export { parseSkillFile, type ParsedSkill } from "@/skills/frontmatter.ts";
