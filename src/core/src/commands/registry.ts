/**
 * @file commands/registry.ts
 * @description 斜杠命令全局注册表：按 name 去重（覆盖语义）、提供目录清单与正文访问器。
 *
 *  镜像 skills/registry.ts。覆盖语义：registerCommand 后注册的同名命令覆盖先注册者，
 *  loader 按 builtin → global → project 顺序注册，故优先级 project > global > builtin。
 */
export type CommandSource = 'builtin' | 'global' | 'project';

export interface CommandManifest {
    /** 命令名（唯一键，[a-z0-9-]，用户输入 /<name> 触发） */
    name: string;
    /** 一句话描述（注入系统提示词目录用） */
    description: string;
    /** 正文模板（支持 $ARGUMENTS / $1 占位符，展开后喂给模型） */
    body: string;
    /**
     * 允许使用的工具白名单（逗号分隔，frontmatter 无数组故用串）。
     * MVP 仅解析存储，不强制（强制需经 RunAgentOptions 透传并在 runAgent 过滤，列后续）。
     */
    allowedTools?: string;
    /** 指定模型（MVP 仅解析存储，不强制） */
    model?: string;
    /** .md 文件路径（调试/溯源用） */
    file: string;
    source: CommandSource;
}

const commands = new Map<string, CommandManifest>();

/** 注册/覆盖一个命令（同名后者覆盖前者） */
export const registerCommand = (m: CommandManifest): void => {
    commands.set(m.name, m);
};

/** 清空全部（测试 / 热重载用） */
export const clearCommands = (): void => {
    commands.clear();
};

/** 列出全部命令 */
export const listCommands = (): CommandManifest[] => {
    return Array.from(commands.values());
};

/** 取某命令的 manifest（expandSlashCommand 查询用） */
export const getCommand = (name: string): CommandManifest | undefined => {
    return commands.get(name);
};

/**
 * 拼接"命令目录"清单字符串（供注入系统提示词，每个命令一行）。
 * 无命令返回空串。
 */
export const getCommandCatalog = (): string => {
    const all = listCommands();
    if (all.length === 0) return "";
    return all.map(c => `- /${c.name}：${c.description}`).join("\n");
};
