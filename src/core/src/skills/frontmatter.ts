/**
 * @file skills/frontmatter.ts
 * @description 零依赖的 SKILL.md frontmatter 解析器。
 *
 *  格式约定（刻意 KISS，不引 YAML 库）：
 *   - 文件首行必须为 `---`，其后若干 `key: value` 行，到下一个只含 `---` 的行结束；
 *   - 仅在首个冒号处切分，值可含冒号；不支持列表/嵌套/引号/多行字符串；
 *   - 正文为其后全部内容。
 *
 *  合法字段由 loader 校验（至少需 name + description）。本解析器只负责结构切分。
 */

export interface ParsedSkill {
    frontmatter: Record<string, string>;
    body: string;
}

/**
 * 解析 SKILL.md 原文。
 * @returns 成功返回 { frontmatter, body }；无闭合 frontmatter 块返回 null。
 */
export const parseSkillFile = (raw: string): ParsedSkill | null => {
    const lines = raw.split(/\r?\n/);
    if (lines.length === 0 || lines[0].trim() !== "---") return null;

    const frontmatter: Record<string, string> = {};
    let i = 1;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "---") break;
        const idx = line.indexOf(":");
        if (idx > 0) {
            const key = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (key) frontmatter[key] = value;
        }
    }
    // 未找到闭合的 --- → 格式无效
    if (i >= lines.length) return null;

    const body = lines.slice(i + 1).join("\n").trim();
    return { frontmatter, body };
};
