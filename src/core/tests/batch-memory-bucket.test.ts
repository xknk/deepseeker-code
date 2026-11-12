/**
 * @file tests/batch-memory-bucket.test.ts
 * @description 记忆策略窄口径 ① 桶回落守门（2026-11-12，路线 #12）：批处理会话（挂机 worktree 激活态）
 *  里 agent 写 memory，落点必须钉在基座桶/全局目录、绝不落 worktree 临时路径——worktree 一删记忆就散
 *  是方案 ① 点名的 ★ 坑。现状实现（memoryFilePath = 全局目录 / process.cwd()，不经 getActiveCwd/
 *  活动工作区）天然满足；本文件把该不变量钉死防回归（谁把落点改成活动工作区，这里立刻红）。
 *
 *  覆盖：跨仓票形态（session worktree = 临时目录 + runWithSessionContext 激活）→ memory_save
 *  默认全局源 / project=true 基座项目源，两落点都在 worktree 之外、worktree 零残留；
 *  写→注册表可读（基座桶可读）→ 磁盘重载可命中 → 下一票（新 sessionId）索引注入可命中
 *  （方案 ① 验收链：写→收拢→次票索引可命中）。
 *
 *  隔离（同 memory.test.ts 惯例）：DEEPSEEK_CODE_DATA_DIR + chdir 必须在动态 import 前就位——
 *  GLOBAL_MEMORY_DIR 与 project 源目录是模块加载期常量；与生产同 specifier（@/ 前缀，防双实例假绿）。
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-batch-membucket-"));
const ORIG_CWD = process.cwd();
process.env.DEEPSEEKER_CODE_DATA_DIR = path.join(TMP_ROOT, "data");
process.chdir(TMP_ROOT); // 基座仓 = TMP_ROOT：project 源 = <TMP_ROOT>/.deepseeker-code/memory

const { GLOBAL_MEMORY_DIR, loadMemories } = await import("@/memory/loader.ts");
const { clearMemories, getMemory, getMemoryIndex } = await import("@/memory/registry.ts");
const { injectMemory } = await import("@/memory/inject.ts");
const { memoryTools } = await import("@/tool/registry/memory.ts");
const { runWithSessionContext } = await import("@/tool/guard.ts");
const { setSessionWorktree, clearSessionWorktree } = await import("@/tool/worktree/sessionRegistry.ts");

const PROJECT_DIR = path.join(TMP_ROOT, ".deepseeker-code", "memory");

/** 模拟跨仓票的临时 worktree（smoke 用最小句柄——注册表只消费 .path）。 */
const WT_PATH = path.join(TMP_ROOT, "wt-tmp-bucket-sim");
const SESSION_ID = "batch-bucket-test-1";

/** memory_save 工具 execute 句柄（单测直调，同 memory.test.ts 惯例）。 */
const memorySave = (args?: any): Promise<string> => {
    const t = (memoryTools as any[]).find((x) => x.function.name === "memory_save")!;
    return t.function.execute(args) as Promise<string>;
};

/** 在「批处理会话 + worktree 激活」语境下调 memory_save（等价 runOneTask 里 agent 的调用语境）。 */
const saveInBatchSession = (args: Record<string, unknown>): Promise<string> =>
    runWithSessionContext(SESSION_ID, () => memorySave(args) as Promise<string>);

after(async () => {
    clearSessionWorktree(SESSION_ID);
    process.chdir(ORIG_CWD); // Windows 删不掉进程 cwd 所在目录（EBUSY），先切回
    await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => { }); // best-effort：AV 锁等瞬态失败不红测试
});

describe("桶回落：worktree 激活态写 memory 不落临时桶（★ 坑防回归）", () => {
    it("默认全局源：落全局目录、worktree 零残留、注册表可读", async () => {
        clearMemories();
        await fs.mkdir(WT_PATH, { recursive: true });
        setSessionWorktree(SESSION_ID, { path: WT_PATH } as any); // 模拟 runOneTask 的 setSessionWorktree
        const out = await saveInBatchSession({ name: "wt-fallback-global", description: "跨票可复用的坑", body: "该仓测试必须 pnpm 而非 npm", type: "project" });
        assert.ok(typeof out === "string" && out.startsWith("✅"), String(out));
        // 基座侧（全局目录）可读：磁盘 + 注册表双验
        const file = path.join(GLOBAL_MEMORY_DIR, "wt-fallback-global.md");
        const raw = await fs.readFile(file, "utf-8");
        assert.ok(raw.includes("该仓测试必须 pnpm 而非 npm"));
        assert.equal(getMemory("wt-fallback-global")!.body, "该仓测试必须 pnpm 而非 npm");
        // 临时桶零残留：worktree 下不得出现任何记忆落盘
        assert.ok(!out.includes(WT_PATH), `落点不在 worktree：${out}`);
        const wtDeep = await fs.readdir(path.join(WT_PATH, ".deepseeker-code")).then((e) => e, () => null);
        assert.ok(wtDeep === null || wtDeep.length === 0, "worktree 内无 .deepseeker-code 记忆残留（临时桶不存在）");
    });

    it("project=true：落基座仓项目源（process.cwd()=基座，非活动工作区）", async () => {
        const out = await saveInBatchSession({ name: "wt-fallback-proj", description: "基座项目记忆", body: "正文", type: "project", project: true });
        assert.ok(typeof out === "string" && out.startsWith("✅"), String(out));
        const raw = await fs.readFile(path.join(PROJECT_DIR, "wt-fallback-proj.md"), "utf-8");
        assert.ok(raw.includes("基座项目记忆"));
        assert.ok(!out.includes(WT_PATH), "落点不在 worktree");
        assert.equal(getMemory("wt-fallback-proj")!.source, "project");
    });

    it("方案 ① 验收链：写 → 注册表可读 → 磁盘重载可命中 → 次票（新 sessionId）索引注入可命中", async () => {
        // 注册表即时可读（同批内下一票的语义：runner 进程不重启）
        assert.ok(getMemoryIndex()!.includes("wt-fallback-global"));
        const m1: any[] = [{ role: "system", content: "BASE" }];
        injectMemory(m1, "batch-bucket-test-next-ticket"); // 新 sessionId = 下一票的全新会话
        assert.ok(m1[0].content.includes("- **wt-fallback-global** (project) — 跨票可复用的坑"), "次票索引命中第一票沉淀");
        // 跨批（runner 重启）语义：磁盘重载后仍然命中
        const n = await loadMemories(true);
        assert.ok(n >= 2, "两条都已落盘可加载");
        assert.ok(getMemoryIndex()!.includes("**wt-fallback-proj**"), "重载后基座项目源也命中");
    });
});
