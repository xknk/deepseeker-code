/**
 * @file projectGuide/loader.ts
 * @description 项目指引（CLAUDE.md/AGENTS.md/AGENT.md）自动注入的数据源。
 *
 *  启动期按固定候选顺序从 WORKSPACE_ROOT 读首个命中，截断后缓存到内存；
 *  inject.ts 据此把指引拼进 system prompt（每轮自动携带），不再依赖模型主动 read_project_guide。
 *
 *  与 tool/registry/search.ts 的 read_project_guide 的关系：
 *   - 这里是「摘要」（截断版，每轮注入 system prompt）；
 *   - 工具是「全文 / 按需」（不截断，或无指引时吐骨架）。两者形成「摘要/全文」配对，省一次往返。
 */
import fs from "fs/promises";
import path from "path";
import { WORKSPACE_ROOT } from "@/tool/guard.ts";

export interface ProjectGuide {
    /** 命中的文件名（CLAUDE.md / AGENTS.md / AGENT.md） */
    name: string;
    /** 正文（可能已截断） */
    body: string;
}

/** 候选顺序与 read_project_guide 工具保持一致 */
const CANDIDATES = ["CLAUDE.md", "AGENTS.md", "AGENT.md"];
/** 每轮注入 system prompt 的体积上限：比 skill 正文（64K，仅按需）更紧（每轮都带）。 */
const MAX_GUIDE_BYTES = 16 * 1024;

let cached: ProjectGuide | null = null;

/**
 * 启动期加载项目指引（供 serve/index.ts 调用）。
 * 无指引 / 加载失败均静默跳过（缓存为 null → inject 幂等跳过），绝不阻断启动。
 */
export const initProjectGuide = async (): Promise<void> => {
    try {
        for (const name of CANDIDATES) {
            try {
                const raw = await fs.readFile(path.join(WORKSPACE_ROOT, name), "utf-8");
                const body = raw.length > MAX_GUIDE_BYTES
                    ? raw.slice(0, MAX_GUIDE_BYTES) + `\n\n…[项目指引超 ${MAX_GUIDE_BYTES} 字节已截断，完整内容可调用 read_project_guide 获取]`
                    : raw;
                cached = { name, body };
                console.log(`📖 [projectGuide] 已自动加载 ${name}（${body.length} 字节）`);
                return;
            } catch { /* 该候选不存在，尝试下一个 */ }
        }
        cached = null; // 三者皆无 → 静默（工具仍可在被调用时吐骨架）
    } catch (e: any) {
        console.warn(`⚠️ [projectGuide] 加载失败（已跳过）: ${e?.message ?? e}`);
        cached = null;
    }
};

/** 取缓存的指引（供 inject.ts 使用）；无指引返回 null */
export const getProjectGuide = (): ProjectGuide | null => cached;
