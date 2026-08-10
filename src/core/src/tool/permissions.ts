/**
 * @file tool/permissions.ts
 * @description 细粒度权限规则（对标 Claude Code 的 allow/deny/ask）。
 *
 *  在审批网关（runAgent 的 requestApproval 之前）按「工具名 + 主参数 glob」匹配规则：
 *   - allow：命中即免审批直放行（高频安全命令如 `run_command(npm test:*)` 不再反复打断）；
 *   - deny ：命中即直接拒绝（deny 作用于所有工具，含 SAFE，如拦 read_file 敏感路径）；
 *   - ask  ：命中即强制弹审批（即使 SAFE 也审；优先级高于 allow，防显式询问被宽 allow 静默放行）；
 *   - 未匹配：返回 null，走原 safetyLevel 默认（SAFE 免审 / MUTATION·DANGER 审批）。
 *
 *  规则语法：`ToolName(argGlob)`（argGlob 对工具主参数做 glob 匹配）；裸 `ToolName` 匹配该工具任意调用。
 *  优先级（按序短路）：deny > ask > allow。
 *
 *  配置来源（叠加语义，复刻 hooks/loader.ts 的 overlay 读法）：
 *   全局 ~/.deepseeker-code/settings.json + 项目级 <cwd>/.deepseeker-code/settings.json，取 permissions.{allow,deny,ask}。
 *  启动期读取并缓存编译规则（与 hooks/skills 一致）；运行期 checkPermission 纯内存查表。
 */
import fs from "fs/promises";
import path from "path";
import { appConfig } from "@/config/index.ts";
import { readJSONFile, atomicWriteJSON } from "@/common/index.ts";

export type PermissionVerdict = 'allow' | 'deny' | 'ask' | null;

/** 编译后的单条规则 */
interface CompiledRule {
    toolName: string;
    /** 主参数匹配正则；null=仅按工具名匹配（裸 ToolName） */
    argRegex: RegExp | null;
    raw: string;
}

interface PermissionRules {
    allow: CompiledRule[];
    deny: CompiledRule[];
    ask: CompiledRule[];
}

/**
 * 工具名 → 「用于 glob 匹配的主参数」字段名映射。
 * 未列出的工具：规则仅按工具名匹配（argGlob 被忽略，等价于裸 ToolName）。
 * 这是最常用、最具区分度的那个 string 参数（命令/路径/url/query/pattern）。
 */
const PRIMARY_ARG: Record<string, string> = {
    run_command: 'command',
    run_in_background: 'command',
    web_fetch: 'url',
    web_search: 'query',
    read_file: 'path',
    list_dir: 'path',
    edit_file: 'path',
    create_file: 'path',
    write_file: 'path',
    delete_path: 'path',
    notebook_edit: 'path',
    move_file: 'src',
    search_grep: 'query',
    glob: 'pattern',
};

let rules: PermissionRules = { allow: [], deny: [], ask: [] };
// 项目级配置是否受信任（initPermissions 据 bootstrap 信任闸门设置）。
// 未信任时 addPermissionRule('project', ...) 降级不落盘——重启后信任闸门会挡掉项目级配置，写了也不一致。
let trustedProject = false;

/**
 * glob→regex 缓存。语义对标 Claude Code 的 Bash 权限规则：
 *  - `X:*`（前缀语法）：匹配 X，或 X 后跟「单词边界 + 任意内容」。如 `npm test:*` 命中 `npm test`、`npm test:unit`、`npm test --watch`。
 *  - `*`（其余位置）：匹配任意字符（含空）。如 `/etc/secrets/*` 命中 `/etc/secrets/key.pem`。
 *  - 无 `*`：精确匹配。
 */
const globCache = new Map<string, RegExp>();
const globToRegex = (glob: string): RegExp => {
    const cached = globCache.get(glob);
    if (cached) return cached;
    // 转义正则元字符（保留 * 和 :，下面分别处理）
    let pat = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // X:* → 前缀边界语义：X 或 X + 单词边界 + 任意（对标 Claude Code 的 `:*` 前缀语法）
    pat = pat.replace(/:\*/g, '(?:\\b.*)?');
    // 其余 * → 任意字符
    pat = pat.replace(/\*/g, '.*');
    const re = new RegExp(`^${pat}$`);
    globCache.set(glob, re);
    return re;
};

/** DANGER 级命令执行工具：裸名 allow 规则过危险（恶意仓库投递 "run_command" 即让全部命令免审），必须带作用域。 */
const DANGER_COMMAND_TOOLS = new Set(['run_command', 'run_in_background']);

/**
 * 规则字符串解析：`ToolName(argGlob)` 或裸 `ToolName`；非法返回 null（warn）。
 * @param kind 规则类别；allow + 裸名 DANGER 命令工具 → 拒绝（要求带作用域，堵供应链投递）。
 */
export const compileRule = (raw: string, src: string, kind?: 'allow' | 'deny' | 'ask'): CompiledRule | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^([a-zA-Z0-9_]+)\((.*)\)$/);
    if (m) {
        const [, name, argGlob] = m;
        if (!argGlob) {
            console.warn(`⚠️ [permissions] 规则 "${raw}" 的参数 glob 为空（${src}），已跳过`);
            return null;
        }
        return { toolName: name, argRegex: globToRegex(argGlob), raw };
    }
    // 裸工具名：支持含 __ 的 MCP 名 + 末尾 * 通配（如 mcp__github__* 匹配该 server 所有工具）。
    //   末尾 * 作前缀通配（ruleMatches 内 toolNameMatches 处理）；含 * 但非末尾的归入括号写法 ToolName(argGlob)。
    if (/^[a-zA-Z0-9_]+\*?$/.test(trimmed)) {
        // ★ P0-2：裸名 allow 对 DANGER 命令工具过危险（恶意仓库投递即让全部命令免审）→ 强制带作用域
        if (kind === 'allow' && DANGER_COMMAND_TOOLS.has(trimmed.replace(/\*$/, ''))) {
            console.warn(`⚠️ [permissions] 拒绝裸名 allow 规则 "${raw}"（${src}）：DANGER 命令工具必须带作用域，如 run_command(npm test:*)。`);
            return null;
        }
        return { toolName: trimmed, argRegex: null, raw };
    }
    console.warn(`⚠️ [permissions] 规则 "${raw}" 格式非法（应为 ToolName / ToolName* / ToolName(argGlob)，${src}），已跳过`);
    return null;
};

/** 读取并校验全局 + 项目级配置，合并（叠加）返回 */
const readPermissionConfig = async (includeProject: boolean): Promise<PermissionRules> => {
    const merged: PermissionRules = { allow: [], deny: [], ask: [] };
    const paths = [
        path.join(appConfig.dataDir, "settings.json"),                        // 全局用户级
        ...(includeProject ? [path.join(process.cwd(), ".deepseeker-code", "settings.json")] : []), // 项目级（叠加）；未信任时省略
    ];
    for (const configPath of paths) {
        let raw: string;
        try {
            raw = await fs.readFile(configPath, "utf-8");
        } catch {
            continue; // 文件不存在 → 静默跳过
        }
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            console.warn(`⚠️ [permissions] 配置解析失败（${configPath}）: ${e.message}`);
            continue;
        }
        const block = parsed?.permissions;
        if (!block || typeof block !== "object") continue;
        for (const key of ["allow", "deny", "ask"] as const) {
            const list = block[key];
            if (!Array.isArray(list)) continue;
            for (const item of list) {
                if (typeof item !== "string") continue;
                const compiled = compileRule(item, configPath, key);
                if (compiled) merged[key].push(compiled);
            }
        }
    }
    return merged;
};

/** 工具名匹配：精确，或末尾 * 前缀通配（mcp__github__* 命中 mcp__github__ 下任意工具） */
const toolNameMatches = (pattern: string, name: string): boolean => {
    if (pattern === name) return true;
    if (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))) return true;
    return false;
};

/** 判断单条编译规则是否命中当前工具调用 */
const ruleMatches = (rule: CompiledRule, toolName: string, args: any): boolean => {
    if (!toolNameMatches(rule.toolName, toolName)) return false;
    if (rule.argRegex === null) return true; // 裸工具名：任意调用都命中（含末尾通配名）
    const argKey = PRIMARY_ARG[toolName];
    if (!argKey) return true; // 工具无主参数映射：带括号的规则退化为按名匹配
    const val = args?.[argKey];
    if (typeof val !== "string") return false;
    return rule.argRegex.test(val);
};

/**
 * 启动期加载权限规则（供 serve/index.ts 调用）。
 * 无配置 / 加载失败均静默跳过（空规则集 → 所有 checkPermission 返回 null，走默认审批流），绝不阻断启动。
 */
export const initPermissions = async (includeProject: boolean): Promise<void> => {
    trustedProject = includeProject;
    try {
        rules = await readPermissionConfig(includeProject);
        const total = rules.allow.length + rules.deny.length + rules.ask.length;
        if (total > 0) {
            console.log(`🛡️ [permissions] 已加载 ${total} 条权限规则（allow ${rules.allow.length} / deny ${rules.deny.length} / ask ${rules.ask.length}）`);
        }
    } catch (e: any) {
        console.warn(`⚠️ [permissions] 加载失败（已跳过，走默认审批流）: ${e?.message ?? e}`);
        rules = { allow: [], deny: [], ask: [] };
    }
};

/**
 * 权限裁决（运行期纯内存查表）。
 * 优先级：deny > ask > allow；都未命中返回 null（走 safetyLevel 默认）。
 * 任何异常一律返回 null（fail-safe：降级为默认审批流，绝不阻断工具执行）。
 */
export const checkPermission = (toolName: string, args: any): PermissionVerdict => {
    try {
        for (const r of rules.deny) if (ruleMatches(r, toolName, args)) return 'deny';
        for (const r of rules.ask) if (ruleMatches(r, toolName, args)) return 'ask';
        for (const r of rules.allow) if (ruleMatches(r, toolName, args)) return 'allow';
        return null;
    } catch {
        return null;
    }
};

/**
 * 列出当前已加载的权限规则（供 /permissions 可观测命令展示）。
 * @returns 三类规则的序列化视图（toolName + raw 原文），不含内部正则。
 */
export const listPermissionRules = (): { allow: { toolName: string; raw: string }[]; deny: { toolName: string; raw: string }[]; ask: { toolName: string; raw: string }[] } => {
    const proj = (rs: CompiledRule[]) => rs.map(r => ({ toolName: r.toolName, raw: r.raw }));
    return { allow: proj(rules.allow), deny: proj(rules.deny), ask: proj(rules.ask) };
};

/**
 * 构造 allow-always 持久化的 allow 规则字符串；返回 null 表示「无法安全生成作用域，不应持久化」。
 *
 *  ★ 安全优先（M5 加固）：自动生成的 allow 规则宁可窄不可宽。allow-always = 「以后这类别再问就免审」，
 *    作用域过宽 = 把 prompt 注入驱动的危险变体也静默放行（checkPermission='allow' → needApproval=false）。
 *   - 命令类（run_command/run_in_background，argKey=command）：落【精确命令串】（如 run_command(npm test)）。
 *       旧版取首 token + `:*` 写成 run_command(npm:*)，会把 `npm install <恶意包>` / `npm publish` / 链式
 *       `npm test; evil` 一并静默放行——shell 执行类工具的 allow-always 必须精确，杜绝 payload 空间。
 *       同命令带不同 flag/子命令的变体会重新审批（shell 工具的正确安全姿态）；用户若确需「一族命令免审」，
 *       可手动在 settings.json 写 run_command(npm test:*) 显式声明（globToRegex 仍支持 :*）。
 *   - 路径类（argKey=path/src）：顶层目录 + `*`（edit_file(src/*) 覆盖 src 下任意深度）；根级文件退化为精确值；
 *   - 其余（url/query/pattern 等）：精确值；
 *   - 无主参数映射 / 缺值 / 非字符串 / 空串 → 返回 null（不可安全作用域 → 不持久化，降级 allow-once；
 *       旧版回退裸 ToolName 会把该工具【所有】后续调用静默放行，对 MCP/未映射的 DANGER 工具尤其危险）。
 *  安全兜底：COMMAND_DENY 独立硬闸门（run_command/run_in_background，不依赖 allow）+ PROTECTED_WRITE_DIRS 保护路径硬拒，
 *    allow 了也拦 rm -rf / 改 .git。
 */
export const buildScopedAllowRule = (toolName: string, args: any): string | null => {
    const argKey = PRIMARY_ARG[toolName];
    const val = argKey ? args?.[argKey] : undefined;
    if (!argKey || typeof val !== 'string' || !val) return null;
    if (argKey === 'command') {
        const cmd = val.trim();
        return cmd ? `${toolName}(${cmd})` : null; // 精确命令串：杜绝跨子命令 / 链式注入的静默放行
    }
    if (argKey === 'path' || argKey === 'src') {
        // 规范化：反斜杠→正斜杠、去 ./ 前缀、去 Windows 盘符（D:），取顶层目录
        const norm = val.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[a-zA-Z]:/, '');
        const slashIdx = norm.indexOf('/');
        if (slashIdx > 0) {
            const topDir = norm.slice(0, slashIdx);
            return `${toolName}(${topDir}/*)`;
        }
        return `${toolName}(${val})`; // 根级文件（无目录段）：精确值兜底
    }
    return `${toolName}(${val})`;
};

/** 解析 settings.json 路径：global=~/.deepseeker-code，project=<cwd>/.deepseeker-code */
const resolveSettingsPath = (scope: 'global' | 'project'): string =>
    scope === 'global'
        ? path.join(appConfig.dataDir, "settings.json")
        : path.join(process.cwd(), ".deepseeker-code", "settings.json");

/**
 * 运行期新增一条权限规则并持久化（对标 CC 审批"总是允许"→写 allowlist）。
 * 读改写 settings.json（保留其它顶层字段 hooks/mcpServers 等）+ 同步 push 进内存 rules（立即生效）。
 * @param scope   'global' | 'project'；project 在未信任目录下返回 false（不落盘，避免写了不生效的不一致）
 * @param kind    'allow' | 'deny' | 'ask'
 * @param ruleStr 规则字符串（裸 ToolName 或 ToolName(argGlob)）
 * @returns true=已写入（或磁盘已存在）且内存生效；false=非法规则 / 未信任目录 / 写入异常
 */
export const addPermissionRule = async (
    scope: 'global' | 'project',
    kind: 'allow' | 'deny' | 'ask',
    ruleStr: string,
): Promise<boolean> => {
    if (scope === 'project' && !trustedProject) return false; // 未信任目录：项目级写入降级
    const compiled = compileRule(ruleStr, `runtime:addPermissionRule(${scope})`, kind);
    if (!compiled) return false; // 非法格式：不入盘不入内存（compileRule 内部已 warn）
    try {
        const file = resolveSettingsPath(scope);
        const cfg = (await readJSONFile<any>(file, {})) ?? {};
        cfg.permissions ??= {};
        const arr = Array.isArray(cfg.permissions[kind]) ? cfg.permissions[kind] : (cfg.permissions[kind] = []);
        if (!arr.includes(ruleStr)) {           // 精确字符串去重
            arr.push(ruleStr);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await atomicWriteJSON(file, cfg);   // 原子写，保留其它顶层字段
        }
        if (!rules[kind].some(r => r.raw === compiled.raw)) rules[kind].push(compiled); // 内存立即生效
        return true;
    } catch (e: any) {
        console.warn(`⚠️ [permissions] addPermissionRule 写入失败（${scope}/${kind} ${ruleStr}）: ${e?.message ?? e}`);
        return false;
    }
};
