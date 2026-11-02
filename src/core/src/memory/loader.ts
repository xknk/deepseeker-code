/**
 * @file memory/loader.ts
 * @description 记忆加载器：扫描 global+project 两来源扁平 *.md → 解析 frontmatter → 注册；
 *  外部记忆桥接（memoryExternal 开启时）把其他 agent 的规则/指令文件以只读 ext- 条目纳入同一注册表。
 *  镜像 outputStyles/loader.ts（扁平 *.md、parseFrontmatter、来源过滤 + 单项失败隔离），
 *  但不含 builtin 源（记忆是用户/agent 私有笔记，不随包分发）。
 *
 *  来源与优先级（同名后者覆盖前者，project > global）：
 *   - 全局：~/.deepseeker-code/memory/<name>.md     （跨项目共享：用户偏好/反馈/通用事实）
 *   - 项目：<cwd>/.deepseeker-code/memory/<name>.md （项目专属：可提交进 git 供团队共享）
 *   - 外部：见 EXTERNAL_RULES（§3 清单硬编码；只读、ext- 前缀、engine.memoryExternal 门控）
 *
 *  记忆目录在工作区沙箱外，read_file 读不到——故记忆的读写由专用 memory_* 工具管理，
 *  不复用 fs 工具（避免绕过沙箱的歧义）。
 */
import fs from "fs/promises";
import type { Dirent } from "fs";
import os from "os";
import path from "path";
import { appConfig } from "@/config/index.ts";
import { parseFrontmatter } from "@/skills/frontmatter.ts";
import { registerMemory, listMemories, clearMemories, memoryIndexLine, MEMORY_LIMITS, MemoryManifest, MemorySource, MemoryType } from "./registry.ts";
import { LoadSource, filterSources, scanSources } from "@/common/registry.ts";

/** 全局记忆目录（memory_save 默认落盘点；亦供工具复用）。 */
export const GLOBAL_MEMORY_DIR = path.join(appConfig.dataDir, "memory");

const SOURCES: LoadSource<MemorySource>[] = [
    { dir: GLOBAL_MEMORY_DIR, source: "global" },
    { dir: path.join(process.cwd(), ".deepseeker-code", "memory"), source: "project" },
];

const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** 记忆名单字符约束（与 tool/registry/memory.ts 的 NAME_RE 同语义：小写字母/数字/连字符）。 */
const NAME_RE = /^[a-z0-9-]+$/;

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
    if (!NAME_RE.test(name)) {
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

// —— 外部记忆桥接（External Memory Bridge，2026-11-02 方案 §3/§5）——

/**
 * 外部条目软上限：防规则文件大户（如 .cursor/rules 几十个）无界侵蚀共享索引预算。
 * 超限 warn 一次 + 按 mtime 丢弃最旧。外部条目同时仍受 MEMORY_LIMITS 共享池约束（§5.4）。
 */
export const MAX_EXTERNAL_ITEMS = 12;

/** 外部 description 总长上限（含 [外部:xx] 前缀）：索引行稳定性靠「定长截断 + 固定前缀 + 正文不进索引」（§5.3）。 */
const EXTERNAL_DESC_MAX_CHARS = 120;

/** 外部 body 字节上限：与 tool/registry/memory.ts 的单条 body 上限（MAX_BODY_BYTES = 64KB）同值同义。
 *  刻意不跨模块导入（tool→memory 已有反向依赖，再正向导会成环），两处注释互指，调整须同步。 */
const EXTERNAL_BODY_MAX_BYTES = 64 * 1024;

/**
 * 外部规则文件清单（§3，硬编码；勿做可配置化——对齐「功能从简」既有偏好）。
 *  - file 固定名 = 单文件来源；省略 = 收目录下全部 *.md（.cursor/rules，name 按文件主干生成）；
 *  - projectLayer = 项目层（受 includeProject 信任闸门，与 project 记忆同语义）；
 *  - 数组顺序即注册序：全局层 → 项目层，同名时后注册覆盖先注册（project > global 语义的延伸）；
 *  - 路径在模块加载期定死（与 GLOBAL_MEMORY_DIR 同惯例）——测试须先改 USERPROFILE/cwd 再动态 import。
 *  ★ 与 projectGuide 的共存：<cwd>/CLAUDE.md、AGENTS.md 已由 projectGuide 以「首个命中截断摘要（16KB）」
 *    每轮注入 system prompt；ext- 条目不重复那段，补的是两件事——全量 body 按 memory_read 召回（不截断），
 *    以及多候选全可见（projectGuide 只取 CLAUDE.md>AGENTS.md>AGENT.md 的首个命中，GEMINI.md/cursor/copilot 它不看）。
 */
interface ExternalRule {
    dir: string;
    file?: string;
    name: string | ((stem: string) => string);
    projectLayer: boolean;
}

const EXTERNAL_RULES: ExternalRule[] = [
    // 全局层（~ 下，存在才扫，缺省静默跳过）
    { dir: path.join(os.homedir(), ".claude"), file: "CLAUDE.md", name: "ext-claude", projectLayer: false },
    { dir: path.join(os.homedir(), ".codex"), file: "AGENTS.md", name: "ext-codex", projectLayer: false },
    { dir: path.join(os.homedir(), ".gemini"), file: "GEMINI.md", name: "ext-gemini", projectLayer: false },
    // 项目层（<cwd> 下）
    { dir: process.cwd(), file: "CLAUDE.md", name: "ext-claude-project", projectLayer: true },
    { dir: process.cwd(), file: "AGENTS.md", name: "ext-agents", projectLayer: true },
    { dir: process.cwd(), file: "GEMINI.md", name: "ext-gemini-project", projectLayer: true },
    { dir: path.join(process.cwd(), ".cursor", "rules"), name: (stem) => `ext-cursor-${stem}`, projectLayer: true },
    { dir: path.join(process.cwd(), ".github"), file: "copilot-instructions.md", name: "ext-copilot", projectLayer: true },
];

/** 多文件来源（cursor）的 name 后缀清洗：非 [a-z0-9] 段折叠为连字符、去首尾连字符，保证可拼出合法 name。 */
const sanitizeExternalStem = (stem: string): string =>
    stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * description 提取链（§4/§11）：文件首个 `# 标题` → 首条非空行（行首 # 剥掉）→ 文件主干兜底。
 * 只看首行级信息（正文不进索引，是索引行稳定性的组成部分）。
 */
const extractExternalTitle = (raw: string, fallbackStem: string): string => {
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
        const m = /^#\s+(.+)$/.exec(line);
        if (m) return m[1].trim();
    }
    for (const line of lines) {
        const t = line.trim();
        if (t) return t.replace(/^#+\s*/, "") || fallbackStem;
    }
    return fallbackStem;
};

/** 拼 `[外部:来源名]` 前缀 + 标题，整体定长截断（勿改为按词截断等花活——确定性即缓存安全）。 */
const buildExternalDescription = (label: string, title: string): string => {
    const full = `[外部:${label}] ${title.replace(/\s+/g, " ").trim()}`;
    return full.length > EXTERNAL_DESC_MAX_CHARS ? full.slice(0, EXTERNAL_DESC_MAX_CHARS) : full;
};

/** 字节安全截断：末尾多字节字符被切时 toString 产 U+FFFD 替换，UTF-8 合法性与确定性均有保证。 */
const truncateUtf8ToBytes = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
    const buf = Buffer.from(text, "utf-8");
    if (buf.length <= maxBytes) return { text, truncated: false };
    return { text: buf.subarray(0, maxBytes).toString("utf-8"), truncated: true };
};

/** 扫单条外部规则：目录缺失静默；单文件失败/无法命名则跳过不阻断（与 scanSources 同隔离语义）。 */
const scanExternalRule = async (rule: ExternalRule): Promise<{ item: MemoryManifest; mtimeMs: number }[]> => {
    let entries: Dirent[];
    try {
        entries = await fs.readdir(rule.dir, { withFileTypes: true });
    } catch {
        return []; // 目录不存在 → 缺省静默（§9「缺省静默」用例）
    }
    const out: { item: MemoryManifest; mtimeMs: number }[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (rule.file ? entry.name !== rule.file : !entry.name.endsWith(".md")) continue;
        const stem = entry.name.replace(/\.md$/, "");
        const file = path.join(rule.dir, entry.name);
        const name = typeof rule.name === "function"
            ? (sanitizeExternalStem(stem) ? `ext-cursor-${sanitizeExternalStem(stem)}` : "")
            : rule.name;
        if (!name || !NAME_RE.test(name)) {
            console.warn(`⚠️ [memory] 外部文件名主干无法生成合法记忆名（${file}），已跳过`);
            continue;
        }
        let raw: string;
        try {
            raw = await fs.readFile(file, "utf-8");
        } catch {
            continue; // 读失败（权限/竞删）→ 单项隔离
        }
        const body = truncateUtf8ToBytes(raw.trim(), EXTERNAL_BODY_MAX_BYTES);
        if (!body.text) continue; // 空文件等价于不存在，静默跳过
        if (body.truncated) console.warn(`⚠️ [memory] 外部文件超 ${EXTERNAL_BODY_MAX_BYTES} 字节已截断（${file}）`);
        const stat = await fs.stat(file).catch(() => null); // mtime 供软上限淘汰排序；stat 失败按 0（视为最旧先丢）
        out.push({
            item: {
                name,
                description: buildExternalDescription(rule.file ?? entry.name, extractExternalTitle(raw, stem)),
                type: "reference", // 外部二手资料的语义即参考（§4），不冒充 user/feedback 画像
                body: body.text,
                source: "external",
                file,
            },
            mtimeMs: stat?.mtimeMs ?? 0,
        });
    }
    return out;
};

let externalNoticeShown = false;

/**
 * 加载外部桥接条目（loadMemories 末步调用；独立导出供测试构造同名覆盖场景——不 clear 注册表）。
 *  - 开关门控：appConfig.memoryExternal=false → 立即返回 0，行为与未引入本功能逐字节一致（§8，守门钉死）；
 *  - ★ 缓存纪律（§5 生命线）：本函数只在 bootstrap（initMemories → loadMemories）执行一次——
 *    这是外部文件唯一一次读盘，此后 fence 重建全走内存注册表，run 间/会话间均不重读；
 *    变更生效粒度 = 进程重启（CLI 每命令新进程自然刷新；VSCode 长驻重启窗口生效——接受的代价，不是缺陷）；
 *  - 只读红线：本函数绝不写任何外部文件；写/删路径由工具层拒 ext- 前缀兜底。
 *  - 注册顺序在自有记忆之后：共享预算越界时先保住自有（「自有记忆永远优先」）。
 */
export const loadExternalMemories = async (includeProject: boolean): Promise<number> => {
    if (!appConfig.memoryExternal) return 0;
    const candidates: { item: MemoryManifest; mtimeMs: number }[] = [];
    for (const rule of EXTERNAL_RULES) {
        if (rule.projectLayer && !includeProject) continue;
        candidates.push(...await scanExternalRule(rule));
    }
    if (candidates.length === 0) return 0;
    // 软上限：超 MAX_EXTERNAL_ITEMS 按 mtime 丢最旧 + warn 一次（防 .cursor/rules 大户无界侵蚀索引预算）
    const dropped: string[] = [];
    if (candidates.length > MAX_EXTERNAL_ITEMS) {
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); // 新在前，截断到上限即「保新丢旧」
        for (const c of candidates.slice(MAX_EXTERNAL_ITEMS)) dropped.push(c.item.name);
        candidates.length = MAX_EXTERNAL_ITEMS;
    }
    // 共享预算（§5.4）：外部条目计入 MEMORY_LIMITS 池（maxCount / maxIndexBytes），越界项拒载不拒整批
    const skipped: string[] = [];
    for (const { item } of candidates) {
        const all = listMemories();
        if (all.length >= MEMORY_LIMITS.maxCount) { skipped.push(item.name); continue; }
        const curBytes = all.length === 0 ? 0 : Buffer.byteLength(all.map(memoryIndexLine).join("\n"), "utf-8");
        if (curBytes + Buffer.byteLength(memoryIndexLine(item), "utf-8") > MEMORY_LIMITS.maxIndexBytes) {
            skipped.push(item.name);
            continue;
        }
        registerMemory(item);
    }
    if (dropped.length > 0) {
        console.warn(`⚠️ [memory] 外部条目超软上限 ${MAX_EXTERNAL_ITEMS}，按 mtime 丢弃最旧 ${dropped.length} 条：${dropped.join("、")}`);
    }
    if (skipped.length > 0) {
        console.warn(`⚠️ [memory] 外部条目超共享预算（MEMORY_LIMITS：${MEMORY_LIMITS.maxCount} 条/${MEMORY_LIMITS.maxIndexBytes} 字节），拒载：${skipped.join("、")}`);
    }
    const n = candidates.length - skipped.length;
    if (n > 0 && !externalNoticeShown) {
        externalNoticeShown = true; // 每进程一次：数据流向提示（§6 隐私边界——默认关、显式开）
        console.log("🌐 [memory] 外部记忆已接入（只读）：来源文件内容将随请求发送给 DeepSeek API。关闭：settings.json engine.memoryExternal=false");
    }
    return n;
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
    await loadExternalMemories(includeProject); // 外部组（engine.memoryExternal 门控；bootstrap 读盘一次，§5）
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
