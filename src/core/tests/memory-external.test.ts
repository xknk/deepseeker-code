/**
 * @file tests/memory-external.test.ts
 * @description 外部记忆桥接单测（方案 §9 十类用例）：
 *  ① 扫描发现（含 cursor 多文件与 [外部:xx] 前缀）② 缺省静默 ③ 开关关（索引与现状逐字节一致）
 *  ④ name 保留字 ⑤ delete 拒绝 ⑥ 超限丢弃（软上限 12 + warn 一次）⑦ 共享预算（MEMORY_LIMITS 池）
 *  ⑧ 索引稳定（二次 load 逐字节相等，§5 缓存纪律守门）⑨ 覆盖语义（项目层同名覆盖）⑩ body 截断（64KB 不拒载）。
 *  外加 cursor 文件主干清洗一例（name 恒满足 NAME_RE）。
 *
 *  隔离（同 memory.test.ts 惯例）：USERPROFILE/HOME + DEEPSEEK_CODE_DATA_DIR + chdir 都必须在动态 import
 *  前就位——GLOBAL_MEMORY_DIR、project 源目录与 EXTERNAL_RULES 全是模块加载期常量。伪造的「其他 agent」
 *  外部文件全部落在临时目录，真实 ~/.claude 等全程不被触碰；本功能只读，测试也绝不回写外部文件。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { MemoryManifest } from "@/memory/registry.ts"; // 纯类型导入（编译期擦除）——不影响 env 前置顺序
import type { ToolExecuteResult } from "@/tool/type.ts";

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-mem-ext-"));
const FAKE_HOME = path.join(TMP_ROOT, "home");
const ORIG_CWD = process.cwd();
process.env.DEEPSEEKER_CODE_DATA_DIR = path.join(TMP_ROOT, "data");
process.env.USERPROFILE = FAKE_HOME; // Windows os.homedir() 主通道
process.env.HOME = FAKE_HOME; // POSIX 惯例变量（双保险）
process.chdir(TMP_ROOT); // 项目层外部来源 = <cwd>/CLAUDE.md 等；project 记忆源 = <TMP_ROOT>/.deepseeker-code/memory

const { appConfig } = await import("@/config/index.ts");
const { GLOBAL_MEMORY_DIR, loadMemories, loadExternalMemories, MAX_EXTERNAL_ITEMS } = await import("@/memory/loader.ts");
const { registerMemory, getMemory, listMemories, clearMemories, getMemoryIndex } = await import("@/memory/registry.ts");
const { memoryTools, MEMORY_LIMITS } = await import("@/tool/registry/memory.ts");

/** 写一份外部规则文件（相对 TMP_ROOT；home/ 前缀 = 伪造的 ~）。 */
const ext = (rel: string, raw: string): Promise<void> =>
    fs.mkdir(path.dirname(path.join(TMP_ROOT, rel)), { recursive: true })
        .then(() => fs.writeFile(path.join(TMP_ROOT, rel), raw, "utf-8"));

const writeOwnMemory = async (dir: string, name: string, description: string): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`, "utf-8");
};

const PROJECT_MEMORY_DIR = path.join(TMP_ROOT, ".deepseeker-code", "memory");

/** 测试间归零：清注册表 + 删自有两源 + 删全部伪造外部文件（各 it 首行调用，互不渗漏）。开关置回开。 */
const EXTERNAL_PATHS = [
    path.join(FAKE_HOME, ".claude"), path.join(FAKE_HOME, ".codex"), path.join(FAKE_HOME, ".gemini"),
    path.join(TMP_ROOT, "CLAUDE.md"), path.join(TMP_ROOT, "AGENTS.md"), path.join(TMP_ROOT, "GEMINI.md"),
    path.join(TMP_ROOT, ".cursor"), path.join(TMP_ROOT, ".github"),
];
const resetState = async (): Promise<void> => {
    clearMemories();
    appConfig.memoryExternal = true; // 缺省开（开关关用例内部自行关）
    await fs.rm(GLOBAL_MEMORY_DIR, { recursive: true, force: true });
    await fs.rm(PROJECT_MEMORY_DIR, { recursive: true, force: true });
    for (const p of EXTERNAL_PATHS) await fs.rm(p, { recursive: true, force: true });
};

/** 捕获 console（loader 的 warn/提示走 console；测试自身绝不直接外打非 ASCII 到 stdout）。 */
const captureConsole = async <T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; warns: string[] }> => {
    const logs: string[] = [];
    const warns: string[] = [];
    const oLog = console.log;
    const oWarn = console.warn;
    console.log = (m?: unknown) => logs.push(String(m));
    console.warn = (m?: unknown) => warns.push(String(m));
    try {
        return { result: await fn(), logs, warns };
    } finally {
        console.log = oLog;
        console.warn = oWarn;
    }
};

/** 取工具 execute 句柄（同 memory.test.ts 惯例）。 */
const exec = (name: string) => {
    const t = (memoryTools as any[]).find((x) => x.function.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return (args?: any): Promise<string | ToolExecuteResult> => (t.function as any).execute(args);
};
const save = exec("memory_save");
const memDelete = exec("memory_delete");

const extCount = (): number => listMemories().filter((m) => m.source === "external").length;

after(async () => {
    process.chdir(ORIG_CWD); // Windows 删不掉进程 cwd 所在目录（EBUSY），先切回
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {}); // best-effort：AV 锁等瞬态失败不红测试
});

describe("外部记忆桥接（§9 守门）", () => {
    it("① 扫描发现：全局+项目+cursor 多文件 → ext- 条目、[外部:xx] 前缀、type=reference、source=external、description≤120", async () => {
        await resetState();
        await ext("home/.claude/CLAUDE.md", "# Claude 全局规则\n\n永远用中文回复。\n");
        await ext("AGENTS.md", "AGENTS.md 无标题，首条非空行直接是正文说明。\n第二行。\n");
        await ext(".cursor/rules/db-path.md", "# 数据库路径\n\nD:\\data\n");
        const { logs } = await captureConsole(() => loadMemories(true));
        const claude = getMemory("ext-claude")!;
        assert.ok(claude, "全局 ~/.claude/CLAUDE.md → ext-claude");
        assert.equal(claude.source, "external");
        assert.equal(claude.type, "reference");
        assert.ok(claude.description.startsWith("[外部:CLAUDE.md] "), "description 带来源标注");
        assert.ok(claude.description.length <= 120, "description ≤120 字符");
        assert.equal(claude.body, "# Claude 全局规则\n\n永远用中文回复。", "body = 文件全文（trim 后）");
        const agents = getMemory("ext-agents")!;
        assert.ok(agents.description.startsWith("[外部:AGENTS.md] "), "无 # 标题 → 回退首条非空行");
        assert.ok(agents.description.includes("首条非空行直接是正文说明"));
        const cursor = getMemory("ext-cursor-db-path")!;
        assert.ok(cursor, ".cursor/rules/db-path.md → ext-cursor-<主干>");
        assert.ok(cursor.description.startsWith("[外部:db-path.md] "));
        assert.equal(getMemory("ext-codex"), undefined, "未伪造的来源静默缺席");
        assert.equal(extCount(), 3);
        assert.equal(logs.filter((l) => l.includes("外部记忆已接入")).length, 1, "首次接入 console 提示恰一次");
    });

    it("① 补：cursor 主干清洗——非法字符折为连字符；清不出的跳过并 warn", async () => {
        await resetState();
        await ext(".cursor/rules/DB_Path 规则.md", "# 规则\n\nb\n");
        await ext(".cursor/rules/纯中文.md", "# 规则\n\nb\n");
        const { warns } = await captureConsole(() => loadMemories(true));
        assert.ok(getMemory("ext-cursor-db-path"), "DB_Path 规则 → ext-cursor-db-path");
        const m = getMemory("ext-cursor-db-path")!;
        assert.match(m.name, /^[a-z0-9-]+$/, "name 恒满足 NAME_RE");
        assert.equal(getMemory("ext-cursor-"), undefined, "空主干不产出残缺名");
        assert.ok(warns.some((w) => w.includes("纯中文")), "无法命名的文件 warn 后跳过");
    });

    it("② 缺省静默：无任何外部文件 → 零条目、无 warn 噪声", async () => {
        await resetState();
        const { result, warns } = await captureConsole(() => loadMemories(true));
        assert.equal(result, 0);
        assert.equal(extCount(), 0);
        assert.deepEqual(warns, [], "无 warn 噪声");
    });

    it("③ 开关关：memoryExternal=false 时外部文件在盘上也不进索引，索引与现状逐字节一致", async () => {
        await resetState();
        await writeOwnMemory(GLOBAL_MEMORY_DIR, "own", "自有记忆");
        await ext("home/.claude/CLAUDE.md", "# 外部规则\n\n不该出现\n");
        await ext("AGENTS.md", "# 外部项目规则\n\n不该出现\n");
        appConfig.memoryExternal = false;
        await captureConsole(() => loadMemories(true));
        assert.equal(getMemory("ext-claude"), undefined);
        assert.equal(getMemory("ext-agents"), undefined);
        assert.equal(
            getMemoryIndex(),
            "- **own** (reference) — 自有记忆",
            "索引与未引入本功能的现状逐字节一致（守门钉死）",
        );
    });

    it("④ name 保留字：memory_save 申请 ext- 前缀 → toolFailure", async () => {
        await resetState();
        const out = await save({ name: "ext-x", description: "d", body: "b" });
        assert.ok(typeof out !== "string" && out.status === "failed" && out.content.startsWith("❌"), typeof out === "string" ? out : out.content);
        assert.match(out.content, /保留字/);
        assert.equal(getMemory("ext-x"), undefined, "拒绝项不进注册表");
    });

    it("⑤ delete 拒绝：memory_delete ext- 前缀 → toolFailure 含「只读」提示；来源文件原样在盘", async () => {
        await resetState();
        await ext("home/.claude/CLAUDE.md", "# 外部\n\nb\n");
        await captureConsole(() => loadMemories(true));
        assert.ok(getMemory("ext-claude"), "前置：条目已在册");
        const out = await memDelete({ name: "ext-claude" });
        assert.ok(typeof out !== "string" && out.status === "failed", typeof out === "string" ? out : out.content);
        assert.match(out.content, /只读/);
        assert.ok(getMemory("ext-claude"), "外部条目不被注销");
        const raw = await fs.readFile(path.join(FAKE_HOME, ".claude", "CLAUDE.md"), "utf-8");
        assert.equal(raw, "# 外部\n\nb\n", "只读红线：来源文件零改动");
    });

    it("⑥ 超限丢弃：>12 个外部文件 → 恰好 12 条 + 恰好一次丢弃 warn（按 mtime 丢最旧）", async () => {
        await resetState();
        const N = MAX_EXTERNAL_ITEMS + 2;
        for (let i = 0; i < N; i++) {
            const f = path.join(TMP_ROOT, ".cursor", "rules", `rule-${String(i).padStart(2, "0")}.md`);
            await fs.mkdir(path.dirname(f), { recursive: true });
            await fs.writeFile(f, `# 规则 ${i}\n\n正文\n`, "utf-8");
            const t = Date.UTC(2026, 0, 1, 0, 0, i); // mtime 递增：rule-00 最旧
            await fs.utimes(f, new Date(t), new Date(t));
        }
        const { warns } = await captureConsole(() => loadMemories(true));
        const cursors = listMemories().filter((m) => m.name.startsWith("ext-cursor-"));
        assert.equal(cursors.length, MAX_EXTERNAL_ITEMS, "恰好保留 12 条");
        assert.equal(getMemory("ext-cursor-rule-00"), undefined, "最旧被丢");
        assert.equal(getMemory("ext-cursor-rule-01"), undefined, "次旧被丢");
        assert.ok(getMemory("ext-cursor-rule-13"), "最新保留");
        const evictWarns = warns.filter((w) => w.includes("软上限"));
        assert.equal(evictWarns.length, 1, "丢弃 warn 恰好一次");
        assert.match(evictWarns[0], /rule-00/, "warn 列出被丢条目");
    });

    it("⑦ 共享预算：外部条目计入 MEMORY_LIMITS 池——条数与字节越界均拒载，自有记忆先注册先保住", async () => {
        await resetState();
        await writeOwnMemory(GLOBAL_MEMORY_DIR, "own", "自有");
        await ext("home/.claude/CLAUDE.md", "# 外部一\n\nb\n");
        await ext("home/.codex/AGENTS.md", "# 外部二\n\nb\n");
        const origCount = MEMORY_LIMITS.maxCount;
        MEMORY_LIMITS.maxCount = 2; // 自有 1 + 外部 1 = 顶；第二个外部拒载
        try {
            await captureConsole(() => loadMemories(true));
            assert.ok(getMemory("own"), "自有优先保住");
            assert.ok(getMemory("ext-claude"), "第一个外部占到最后名额");
            assert.equal(getMemory("ext-codex"), undefined, "条数越界外部拒载");
        } finally {
            MEMORY_LIMITS.maxCount = origCount;
        }
        // 字节闸：索引字节上限缩到恰好只容自有 → 所有外部拒载
        await resetState();
        await writeOwnMemory(GLOBAL_MEMORY_DIR, "own", "自有");
        await ext("home/.claude/CLAUDE.md", "# 外部一\n\nb\n");
        const origBytes = MEMORY_LIMITS.maxIndexBytes;
        MEMORY_LIMITS.maxIndexBytes = Buffer.byteLength("- **own** (reference) — 自有", "utf-8");
        try {
            await captureConsole(() => loadMemories(true));
            assert.ok(getMemory("own"));
            assert.equal(getMemory("ext-claude"), undefined, "字节越界外部拒载");
        } finally {
            MEMORY_LIMITS.maxIndexBytes = origBytes;
        }
    });

    it("⑧ 索引稳定：同一组文件二次 loadMemories → getMemoryIndex 两次输出逐字节相等（§5 缓存纪律）", async () => {
        await resetState();
        await ext("home/.claude/CLAUDE.md", "# Claude 全局规则\n\n正文一\n");
        await ext("AGENTS.md", "# 项目规则\n\n正文二\n");
        await ext(".cursor/rules/a.md", "# A\n\nb\n");
        await ext(".cursor/rules/b.md", "# B\n\nb\n");
        await captureConsole(() => loadMemories(true));
        const first = getMemoryIndex();
        await captureConsole(() => loadMemories(true)); // 全新重扫（clearMemories + 重灌）
        const second = getMemoryIndex();
        assert.ok(first && second);
        assert.equal(second, first, "两次输出逐字节相等");
        assert.ok(first.includes("[外部:CLAUDE.md]"), "外部条目在索引中带来源标注");
    });

    it("⑨ 覆盖语义：同名时项目层外部条目覆盖先注册条目（project > global 的延伸）", async () => {
        await resetState();
        await ext("CLAUDE.md", "# 项目版\n\n项目正文\n");
        // 假想同名全局条目已在册（真实清单里全局层不会产出 ext-claude-project 名，直灌注册表模拟）
        const fake: MemoryManifest = {
            name: "ext-claude-project", description: "[外部:假想全局] 旧", type: "reference",
            body: "全局旧正文", source: "external", file: "fake",
        };
        registerMemory(fake);
        await captureConsole(() => loadExternalMemories(true)); // 独立调用：不清场（loadMemories 会先 clear，种子会被洗掉）
        const m = getMemory("ext-claude-project")!;
        assert.equal(m.body, "# 项目版\n\n项目正文", "项目条目胜");
        assert.ok(m.description.startsWith("[外部:CLAUDE.md] "));
    });

    it("⑩ body 截断：>64KB 外部文件 → 截到上限载入 + warn，不拒载", async () => {
        await resetState();
        await ext("AGENTS.md", "# 大文件\n\n" + "x".repeat(64 * 1024 + 100) + "\n");
        const { warns } = await captureConsole(() => loadMemories(true));
        const m = getMemory("ext-agents")!;
        assert.ok(m, "超限不拒载");
        assert.equal(Buffer.byteLength(m.body, "utf-8"), 64 * 1024, "body 恰为 64KB 上限");
        assert.ok(warns.some((w) => w.includes("已截断")), "有截断 warn");
    });
});
