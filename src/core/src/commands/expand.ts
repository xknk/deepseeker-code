/**
 * @file commands/expand.ts
 * @description 斜杠命令展开器（纯函数，可在 chatProcessing 的用户输入拦截点调用）。
 *
 *  规则：输入 `/name rest` 且 name 已注册 → 把命令正文模板里的 $ARGUMENTS / $1 占位符替换为
 *   rest 后返回；其余情况（非 / 开头、未知 /x、文件路径、普通文本）一律原样返回。
 *
 *  安全闸：必须先在 registry 查到 name 才展开。这样 `/usr/bin/foo` 解析出名 `usr` 但注册表无
 *   `usr` 命令 → 原样透传，不会误伤文件路径，也不产生多余告警。
 */
import { getCommand } from "./registry.ts";

/**
 * 展开斜杠命令。命中注册命令返回展开后正文；否则原样返回输入。
 * 任何异常一律返回原输入（fail-safe：绝不阻断用户输入流转）。
 */
export const expandSlashCommand = (input: string): string => {
    if (typeof input !== 'string' || !input.startsWith('/')) return input;
    // /<name> 后须为空白或行尾；name 首字符为字母，避免吞 /数字、// 等
    const m = input.match(/^\/([a-zA-Z][\w-]*)\b[\s]*(.*)$/s);
    if (!m) return input;
    const [, name, rest] = m;
    const cmd = getCommand(name);
    if (!cmd) return input; // 未注册命令 → 原样透传（含文件路径如 /usr/bin/x）
    const args = rest.trim();
    return cmd.body
        .replace(/\$ARGUMENTS\b/g, args)
        .replace(/\$1\b/g, args);
};
