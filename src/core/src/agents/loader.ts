/**
 * @file agents/loader.ts
 * @description 声明式子 Agent 加载器：扫描三来源 *.agent.md → 解析 frontmatter → 注册 → 启动期白名单校验。
 *  镜像 skills/loader.ts 的三来源 + 单项失败隔离 + initXxx 范式（容错骨架同源）。
 *
 *  来源与优先级（同名后者覆盖前者，project > global > builtin）：
 *   - 内置（随包）：src/core/src/agents/builtin/<name>.agent.md
 *   - 全局用户级：~/.deepseeker-code/agents/<name>.agent.md
 *   - 项目级（最高）：<cwd>/.deepseeker-code/agents/<name>.agent.md
 *
 *  与 skills 的差异：
 *   1) 扫描扁平文件 <name>.agent.md（非 <name>/SKILL.md）；
 *   2) initAgents 不向 into push 任何工具——声明式 agent 复用现有 spawn_agent（仅扩 name 参数），
 *      into 仅用于启动期白名单校验（剔除引用了不存在工具的条目）。
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { appConfig } from "@/config/index.ts";
import { CustomTool } from "@/tool/type.ts";
import { parseFrontmatter } from "@/skills/frontmatter.ts";
import { registerAgent, listAgents, AgentManifest, AgentSource } from "./registry.ts";
import { LoadSource, filterSources, scanSources } from "@/common/registry.ts";

/** 内置 agent 目录：本文件所在目录下的 builtin/ */
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");

/** 三个来源（顺序即注册顺序，决定覆盖优先级） */
const SOURCES: LoadSource<AgentSource>[] = [
    { dir: BUILTIN_DIR, source: "builtin" },
    { dir: path.join(appConfig.dataDir, "agents"), source: "global" },
    { dir: path.join(process.cwd(), ".deepseeker-code", "agents"), source: "project" },
];

/** 解析单个 .agent.md 为 manifest；失败返回 null（warn + 跳过） */
const parseAgentAt = async (file: string, dir: string, source: AgentSource): Promise<AgentManifest | null> => {
    let raw: string;
    try {
        raw = await fs.readFile(file, "utf-8");
    } catch {
        return null; // 读取失败静默跳过
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
        console.warn(`⚠️ [agents] frontmatter 格式无效（${file}），已跳过`);
        return null;
    }
    const { name, description, role, tools, model } = parsed.frontmatter;
    if (!name || !description) {
        console.warn(`⚠️ [agents] 缺少 name 或 description（${file}），已跳过`);
        return null;
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
        console.warn(`⚠️ [agents] name "${name}" 不合法（仅允许小写字母/数字/连字符，${file}），已跳过`);
        return null;
    }
    // tools 用逗号分隔字符串（parseFrontmatter 不支持 YAML 列表），split + trim，空/缺省为 []
    const toolList = (tools ?? "").split(",").map(t => t.trim()).filter(Boolean);
    return {
        name,
        description,
        role: role || undefined,
        tools: toolList,
        model: model || undefined,
        body: parsed.body,
        source,
        dir,
    };
};

/**
 * 启动期加载声明式子 Agent 并注册。
 * 扫描骨架走 common.scanSources（agents 扫描模式 = 扁平 *.agent.md）；白名单校验 / 项目级告警为本处特化。
 * @param into 全局工具表，仅用于启动期白名单校验（剔除引用了不存在工具的条目）。
 *   与 initSkills 不同：**不向 into push 任何工具**——声明式 agent 复用现有 spawn_agent，仅扩 name 参数。
 */
export const initAgents = async (into: CustomTool[], includeProject: boolean): Promise<void> => {
    try {
        const known = new Set(into.map((t: any) => t.function.name)); // 含 mcp__* / load_skill（已先于本步注入）
        const picked = await scanSources(
            filterSources(SOURCES, includeProject),
            (e, dir) => (e.isFile() && e.name.endsWith(".agent.md")) ? path.join(dir, e.name) : undefined,
            parseAgentAt,
        );
        for (const { item: m, file, source } of picked) {
            // 白名单校验：引用了不存在的工具 → warn 剔除（单项失败隔离，不拒绝整个 agent）
            // ★ mcp__* 条目不剔除：schemas 模式逐工具名可命中 known；dispatcher 模式运行期由
            //   runSubagent 翻译为 mcp_call/mcp_list_tools 授权（启动期全局表无这些独立名，known 不含属预期）
            if (m.tools.length > 0) {
                const unknown = m.tools.filter(t => !known.has(t) && !t.startsWith('mcp__'));
                if (unknown.length) console.warn(`⚠️ [agents] ${m.name} 声明了未知工具 [${unknown.join(", ")}]，已剔除`);
                m.tools = m.tools.filter(t => known.has(t) || t.startsWith('mcp__'));
            }
            // ★ 项目级信任告警（镜像 hooks/loader.ts）：白名单可显式授权 run_command 等高危工具，
            //   运行期 requestApproval 审批网关仍是后盾（spawn_agent 已透传，未绕过）。
            if (source === "project") {
                console.warn(`⚠️【安全提示】已加载项目级声明式子 Agent [${m.name}]（${file}）。其 tools 白名单可显式授权高危工具，请在信任该项目时启用；克隆未知仓库前请核查 .deepseeker-code/agents/。`);
            }
            registerAgent(m);
        }
        const n = listAgents().length;
        if (n > 0) console.log(`🤖 [agents] 已加载 ${n} 个声明式子 Agent`);
    } catch (e: any) {
        console.warn(`⚠️ [agents] 加载失败（已跳过）: ${e?.message ?? e}`);
    }
};
