/**
 * @file tests/memory.test.ts
 * @description 持久记忆系统单测（memory/loader.ts + registry.ts + inject.ts + tool/registry/memory.ts）。
 *  覆盖：loader 校验矩阵与 project>global 覆盖、registry 索引格式逐字节钉死（软契约：格式漂移=破前缀缓存）、
 *  inject fence 幂等与会话首锁、memory_save/read/list/delete 校验/落盘/注册表同步与往返保真。
 *
 *  隔离（同 usage-log.test.ts 惯例）：DEEPSEEK_CODE_DATA_DIR + chdir 都必须在动态 import 前就位——
 *  GLOBAL_MEMORY_DIR 与 project 源目录都是模块加载期常量。真实 ~/.deepseeker-code 与仓库 cwd 全程不被触碰。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { MemoryManifest } from "@/memory/registry.ts"; // 纯类型导入（编译期擦除）——不影响上面 env 前置顺序

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-memory-"));
const ORIG_CWD = process.cwd();
process.env.DEEPSEEKER_CODE_DATA_DIR = path.join(TMP_ROOT, "data");
process.chdir(TMP_ROOT); // project 源 = <TMP_ROOT>/.deepseeker-code/memory

const { GLOBAL_MEMORY_DIR, loadMemories, initMemories } = await import("@/memory/loader.ts");
const { registerMemory, getMemory, unregisterMemory, clearMemories, getMemoryIndex } = await import("@/memory/registry.ts");
const { injectMemory } = await import("@/memory/inject.ts");
const { memoryTools } = await import("@/tool/registry/memory.ts");

const PROJECT_DIR = path.join(TMP_ROOT, ".deepseeker-code", "memory");

/** 直写磁盘的记忆 .md（绕过工具，测 loader 视角）。type 省略时不含该行（测缺省值）。 */
const md = (name: string, description: string, body: string, type?: string) =>
    `---\nname: ${name}\ndescription: ${description}${type ? `\ntype: ${type}` : ""}\n---\n\n${body}\n`;

const writeFile = async (dir: string, name: string, raw: string): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.md`), raw, "utf-8");
};

/** 测试间归零：清注册表 + 删两源目录（各 it 首行调用，互不渗漏）。 */
const resetState = async (): Promise<void> => {
    clearMemories();
    await fs.rm(GLOBAL_MEMORY_DIR, { recursive: true, force: true });
    await fs.rm(PROJECT_DIR, { recursive: true, force: true });
};

/** 取工具 execute 句柄（CustomTool 接口宽松包装，单测直接断言 string）。 */
const exec = (name: string) => {
    const t = (memoryTools as any[]).find((x) => x.function.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return (args?: any): Promise<string> => (t.function as any).execute(args);
};
const save = exec("memory_save");
const memRead = exec("memory_read");
const memList = exec("memory_list");
const memDelete = exec("memory_delete");

/** 构造注册表条目（registry/inject 测试不落盘，file 为哑值）。 */
const reg = (over: Partial<MemoryManifest> = {}): MemoryManifest => ({
    name: "x", description: "d", type: "user", body: "b", source: "global", file: "f", ...over,
});

const mkMsg = (): any[] => [{ role: "system", content: "BASE" }];

after(async () => {
    process.chdir(ORIG_CWD); // Windows 删不掉进程 cwd 所在目录（EBUSY），先切回
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {}); // best-effort：AV 锁等瞬态失败不红测试
});

describe("loader：扫描与校验矩阵", () => {
    it("合法记忆全字段加载；type 缺省 reference", async () => {
        await resetState();
        await writeFile(GLOBAL_MEMORY_DIR, "typed", md("typed", "带类别", "正文A", "user"));
        await writeFile(GLOBAL_MEMORY_DIR, "untyped", md("untyped", "无类别", "正文B"));
        assert.equal(await loadMemories(true), 2);
        const typed = getMemory("typed")!;
        assert.equal(typed.description, "带类别");
        assert.equal(typed.type, "user");
        assert.equal(typed.body, "正文A");
        assert.equal(typed.source, "global");
        assert.equal(typed.file, path.join(GLOBAL_MEMORY_DIR, "typed.md"));
        assert.equal(getMemory("untyped")!.type, "reference", "type 缺省 reference");
    });

    it("project>global 同名覆盖（正文取 project 版）", async () => {
        await resetState();
        await writeFile(GLOBAL_MEMORY_DIR, "shared", md("shared", "全局版", "全局正文"));
        await writeFile(PROJECT_DIR, "shared", md("shared", "项目版", "项目正文", "project"));
        await writeFile(PROJECT_DIR, "only-proj", md("only-proj", "仅项目", "项目正文2", "project"));
        await loadMemories(true);
        const shared = getMemory("shared")!;
        assert.equal(shared.source, "project", "同名 project 覆盖 global");
        assert.equal(shared.body, "项目正文");
        assert.equal(getMemory("only-proj")!.source, "project");
    });

    it("非法文件逐项跳过（单项失败隔离，不炸整批）", async () => {
        await resetState();
        const cases: [string, string][] = [
            ["no-fence", `直接正文，无 frontmatter\n`],
            ["unclosed", `---\nname: unclosed\ndescription: d\n\nfrontmatter 未闭合\n`],
            ["no-name", `---\ndescription: 缺 name\n---\n\n正文\n`],
            ["no-desc", `---\nname: no-desc\n---\n\n正文\n`],
            ["bad-name-upper", `---\nname: BadName\ndescription: 大写非法\n---\n\n正文\n`],
            ["bad-name-underscore", `---\nname: bad_name\ndescription: 下划线非法\n---\n\n正文\n`],
            ["empty-body", `---\nname: empty-body\ndescription: 空正文\n---\n\n   \n`],
            ["bad-type", `---\nname: bad-type\ndescription: 非法类别\ntype: diary\n---\n\n正文\n`],
        ];
        for (const [name, raw] of cases) await writeFile(GLOBAL_MEMORY_DIR, name, raw);
        await writeFile(GLOBAL_MEMORY_DIR, "good-among-bad", md("good-among-bad", "坏堆里的好蛋", "正文"));
        assert.equal(await loadMemories(true), 1, "只加载唯一合法项");
        assert.ok(getMemory("good-among-bad"));
    });

    it("两源目录均不存在 → 0 条不炸", async () => {
        await resetState();
        assert.equal(await loadMemories(true), 0);
    });

    it("干净重载：磁盘删除后注册表无残留", async () => {
        await resetState();
        await writeFile(GLOBAL_MEMORY_DIR, "gone-later", md("gone-later", "将被删", "正文"));
        await loadMemories(true);
        assert.ok(getMemory("gone-later"));
        await fs.unlink(path.join(GLOBAL_MEMORY_DIR, "gone-later.md"));
        await loadMemories(true);
        assert.equal(getMemory("gone-later"), undefined, "重载后不留注册表残影");
    });

    it("initMemories(includeProject=false) → 跳过项目源（未信任闸门）", async () => {
        await resetState();
        await writeFile(GLOBAL_MEMORY_DIR, "g1", md("g1", "全局", "正文"));
        await writeFile(PROJECT_DIR, "p1", md("p1", "项目", "正文"));
        await initMemories(false);
        assert.ok(getMemory("g1"));
        assert.equal(getMemory("p1"), undefined, "未信任 → 项目记忆不加载");
    });
});

describe("registry：索引格式与注销", () => {
    it("getMemoryIndex 无记忆 → null", () => {
        clearMemories();
        assert.equal(getMemoryIndex(), null);
    });

    it("索引格式逐字节钉死 + name 排序（格式漂移=破前缀缓存的软契约）", () => {
        clearMemories();
        registerMemory(reg({ name: "zeta", description: "后注册但排后", type: "project" }));
        registerMemory(reg({ name: "alpha", description: "先注册但排前", type: "user" }));
        assert.equal(
            getMemoryIndex(),
            "- **alpha** (user) — 先注册但排前\n- **zeta** (project) — 后注册但排后",
        );
    });

    it("同名后注册覆盖先注册", () => {
        clearMemories();
        registerMemory(reg({ name: "dup", description: "旧", body: "旧正文" }));
        registerMemory(reg({ name: "dup", description: "新", body: "新正文" }));
        assert.equal(getMemory("dup")!.body, "新正文");
    });

    it("unregisterMemory：只注销目标、其余保留、未知名返回 false", () => {
        clearMemories();
        registerMemory(reg({ name: "a" }));
        registerMemory(reg({ name: "b" }));
        assert.equal(unregisterMemory("a"), true);
        assert.equal(getMemory("a"), undefined);
        assert.ok(getMemory("b"), "其余记忆保留");
        assert.equal(unregisterMemory("nope"), false);
    });
});

describe("inject：fence 语义（保 DeepSeek 前缀缓存）", () => {
    it("注入【记忆索引】标记与索引行；原 system 内容保留在前", () => {
        clearMemories();
        registerMemory(reg({ name: "m1", description: "第一条" }));
        const m = mkMsg();
        injectMemory(m);
        assert.ok(m[0].content.startsWith("BASE"), "原内容在前");
        assert.ok(m[0].content.includes("【记忆索引】"), "含标记");
        assert.ok(m[0].content.includes("- **m1** (user) — 第一条"), "含索引行");
    });

    it("幂等：同数组重复注入 → 逐字节不变", () => {
        clearMemories();
        registerMemory(reg({ name: "m1", description: "第一条" }));
        const m = mkMsg();
        injectMemory(m);
        const once = m[0].content;
        injectMemory(m);
        assert.equal(m[0].content, once, "重复注入字节稳定");
    });

    it("no-op：无记忆不动 system prompt", () => {
        clearMemories();
        const m = mkMsg();
        injectMemory(m);
        assert.equal(m[0].content, "BASE");
    });

    it("会话首锁：注册表变化后同数组字节不变；下轮重建（新数组）生效", async () => {
        await resetState();
        registerMemory(reg({ name: "old-mem", description: "旧记忆" }));
        const m = mkMsg();
        injectMemory(m);
        const once = m[0].content;
        await save({ name: "new-mem", description: "新记忆", body: "正文" }); // 注册表即时变化
        injectMemory(m);
        assert.equal(m[0].content, once, "同数组锁定不重写（缓存安全）");
        assert.ok(!m[0].content.includes("**new-mem**"), "新记忆不混入当前 run");
        const m2 = mkMsg(); // 模拟下轮 buildContextMessages 全新重建
        injectMemory(m2);
        assert.ok(m2[0].content.includes("- **new-mem** (reference) — 新记忆"), "下轮重建新索引生效");
    });
});

describe("memory_* 工具：校验、落盘与注册表同步", () => {
    it("save 默认全局源：落盘格式逐字节钉死 + 即时注册", async () => {
        await resetState();
        const out = await save({ name: "tool-saved", description: "一句话", body: "多行\n正文" });
        assert.equal(out, `✅ 已保存记忆 **tool-saved**（reference，全局源）→ ${path.join(GLOBAL_MEMORY_DIR, "tool-saved.md")}`);
        const raw = await fs.readFile(path.join(GLOBAL_MEMORY_DIR, "tool-saved.md"), "utf-8");
        assert.equal(raw, "---\nname: tool-saved\ndescription: 一句话\ntype: reference\n---\n\n多行\n正文\n");
        const m = getMemory("tool-saved")!;
        assert.equal(m.source, "global");
        assert.equal(m.body, "多行\n正文", "注册表正文 trim 后保真");
    });

    it("save project=true → 项目源", async () => {
        await resetState();
        const out = await save({ name: "proj-mem", description: "项目记忆", body: "b", type: "project", project: true });
        assert.ok(out.includes("（project，项目源）"), out);
        const raw = await fs.readFile(path.join(PROJECT_DIR, "proj-mem.md"), "utf-8");
        assert.ok(raw.includes("type: project"));
        assert.equal(getMemory("proj-mem")!.source, "project");
    });

    it("save 同名覆盖：文件与注册表都更新", async () => {
        await resetState();
        await save({ name: "dup", description: "旧描述", body: "旧正文" });
        await save({ name: "dup", description: "新描述", body: "新正文", type: "feedback" });
        const raw = await fs.readFile(path.join(GLOBAL_MEMORY_DIR, "dup.md"), "utf-8");
        assert.ok(raw.includes("description: 新描述") && raw.includes("新正文"));
        const m = getMemory("dup")!;
        assert.equal(m.description, "新描述");
        assert.equal(m.type, "feedback");
    });

    it("save 校验拒绝：name 非法 / description 空 / body 空 / type 非法 / body 超 64KB / description 超长", async () => {
        await resetState();
        const outs = [
            await save({ name: "Bad_Name", description: "d", body: "b" }),
            await save({ name: "ok-name-1", description: "", body: "b" }),
            await save({ name: "ok-name-2", description: "d", body: "   " }),
            await save({ name: "ok-name-3", description: "d", body: "b", type: "diary" }),
            await save({ name: "ok-name-4", description: "d", body: "x".repeat(64 * 1024 + 1) }),
            await save({ name: "ok-name-5", description: "x".repeat(201), body: "b" }),
        ];
        for (const o of outs) {
            assert.ok(o.startsWith("❌"), `应拒绝：${o}`);
        }
        assert.match(outs[5], /description 超过 200 字符上限/);
        const leftover = await fs.readdir(GLOBAL_MEMORY_DIR).catch(() => [] as string[]); // 目录可不存在（全拒则无人 mkdir）
        assert.equal(leftover.length, 0, "拒绝项零落盘");
        assert.equal(getMemory("ok-name-1"), undefined, "拒绝项不进注册表");
    });

    it("save description 带换行 → 压平为空格（frontmatter 单行红线）", async () => {
        await resetState();
        await save({ name: "multiline-desc", description: "第一行\n第二行", body: "b" });
        const raw = await fs.readFile(path.join(GLOBAL_MEMORY_DIR, "multiline-desc.md"), "utf-8");
        assert.match(raw, /^description: 第一行 第二行$/m, "换行压平、单行保留");
        assert.equal(getMemory("multiline-desc")!.description, "第一行 第二行");
    });

    it("read：命中返回全文；未命中提示 memory_list", async () => {
        await resetState();
        await save({ name: "readable", description: "d", body: "完整\n正文", type: "user" });
        assert.equal(await memRead({ name: "readable" }), "## readable（user）\n\n完整\n正文");
        const miss = await memRead({ name: "nope" });
        assert.ok(miss.startsWith("❌") && miss.includes("memory_list"), miss);
    });

    it("list：计数头 + 排序行；空 → 暂无记忆", async () => {
        await resetState();
        assert.equal(await memList(), "（暂无记忆）");
        await save({ name: "zz", description: "后", body: "b" });
        await save({ name: "aa", description: "前", body: "b", type: "feedback" });
        assert.equal(
            await memList(),
            "共 2 条记忆：\n- **aa** (feedback) — 前\n- **zz** (reference) — 后",
        );
    });

    it("delete：删文件 + 注销注册表；重复删 → 失败", async () => {
        await resetState();
        await save({ name: "doomed", description: "d", body: "b" });
        const out = await memDelete({ name: "doomed" });
        assert.ok(out.startsWith("✅"), out);
        await assert.rejects(() => fs.readFile(path.join(GLOBAL_MEMORY_DIR, "doomed.md"), "utf-8"));
        assert.equal(getMemory("doomed"), undefined);
        const again = await memDelete({ name: "doomed" });
        assert.ok(again.startsWith("❌"), again);
    });

    it("落盘保真：save 后重扫（loadMemories）字段一致", async () => {
        await resetState();
        await save({ name: "roundtrip", description: "往返描述", body: "往返\n正文", type: "feedback", project: true });
        await loadMemories(true); // 从磁盘全新扫描（清注册表重灌）
        const m = getMemory("roundtrip")!;
        assert.equal(m.description, "往返描述");
        assert.equal(m.body, "往返\n正文");
        assert.equal(m.type, "feedback");
        assert.equal(m.source, "project");
        assert.equal(m.file, path.join(PROJECT_DIR, "roundtrip.md"));
    });
});
