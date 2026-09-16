/**
 * @file tool/registry/memory.ts
 * @description 记忆管理工具集：memory_save / memory_read / memory_delete。
 *
 *  为什么独立成工具而非复用 read_file/write_file：
 *   记忆目录在工作区沙箱外（~/.deepseeker-code/memory），read_file/write_file 的 resolveSafePath 会拒。
 *   这是设计而非缺陷——记忆是 agent 跨会话的私有笔记，不经工作区文件协议，单独走专用工具更清晰，
 *   也避免给通用 fs 工具开「越界写」的口子。
 *
 *  设计要点：
 *   - memory_save/read/list 均 SAFE + isSync：记忆写入是低风险元数据操作（不碰用户代码），免审批降低摩擦；
 *   - memory_delete 升 MUTATION 审批（后续路线 #9，2026-09-16）：记忆目录在工作区沙箱外，被注入的
 *     工具结果可诱导模型删除/篡改跨会话记忆，删除又不可 undo（目录不在工作区备份范围内）——删除必须人工过目；
 *   - memory_save 带条数 + 索引字节双上限（#9②）：索引是唯一逐轮注入提示词的组件，只增不减会持续
 *     侵蚀上下文，超限时拒绝保存并引导清理/合并（覆盖同名不占新名额）；
 *   - memory_save/read 记 last-used（#9③，memory/usage.ts）：供未来淘汰策略与使用画像；
 *   - memory_save 用原子写（makeTmpPath + rename，复用 fs.ts 模式）防中断产生半写文件，
 *     写后即注册进运行时注册表（无需重启即对当前会话生效）；
 *   - 仅 global+project 两落盘点，project=true 写项目目录（可提交 git 团队共享），默认 global。
 */
import fs from "fs/promises";
import path from "path";
import { toolFailure, CustomTool, ToolSafetyLevel } from "@/tool/type.ts";
import { makeTmpPath } from "./fs.ts";
import { GLOBAL_MEMORY_DIR } from "@/memory/loader.ts";
import { registerMemory, getMemory, unregisterMemory, listMemories, getMemoryIndex, memoryIndexLine, MemoryType, MemoryManifest } from "@/memory/registry.ts";
import { recordMemoryUse } from "@/memory/usage.ts";

const MAX_BODY_BYTES = 64 * 1024; // 64KB：单条记忆上限，防误灌巨量日志撑爆索引/缓存
const MAX_DESCRIPTION_CHARS = 200; // description 是唯一逐轮注入提示词的字段（索引行），限长防静默膨胀

/**
 * 记忆库总量上限（#9②，2026-09-16）：索引每轮整段注入系统提示词，无上限即无界侵蚀。
 *  - maxCount：条数上限——每条一行索引，200 条按典型行宽已是数 KB 量级，到顶先治理再新增；
 *  - maxIndexBytes：索引整体字节上限（UTF-8，含行界换行）——按 description 限长 200 字符算，
 *    200 条 CJK 满配最坏 ~130KB，字节闸先于条数闸触发，真正兜住提示词体积。
 * 非 frozen：单测需缩水上限构造越界场景（生产代码勿改）。
 */
export const MEMORY_LIMITS = { maxCount: 200, maxIndexBytes: 16 * 1024 };

const NAME_RE = /^[a-z0-9-]+$/;
const VALID_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** 计算落盘绝对路径（global 或 project 源）。 */
const memoryFilePath = (name: string, project: boolean): string =>
    project
        ? path.join(process.cwd(), ".deepseeker-code", "memory", `${name}.md`)
        : path.join(GLOBAL_MEMORY_DIR, `${name}.md`);

/** 把单行字段里的换行/回车规整成空格（frontmatter 值必须单行，否则 parseFrontmatter 错乱）。 */
const sanitizeLine = (s: unknown): string =>
    String(s ?? "").replace(/[\r\n]+/g, " ").trim();

/** 拼装记忆 .md 全文（flat frontmatter，parseFrontmatter 可读）。 */
const buildMemoryMd = (name: string, description: string, type: MemoryType, body: string): string =>
    `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body.trim()}\n`;

/** 原子写入记忆文件 + 同步注册到运行时注册表。 */
const writeAndRegister = async (
    name: string, description: string, type: MemoryType, body: string, project: boolean,
): Promise<string> => {
    const file = memoryFilePath(name, project);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = makeTmpPath(file);
    await fs.writeFile(tmp, buildMemoryMd(name, description, type, body), "utf-8");
    await fs.rename(tmp, file);
    registerMemory({ name, description, type, body: body.trim(), source: project ? "project" : "global", file });
    return file;
};

/** 索引行字节成本（UTF-8），#9② 预算计算用（与 getMemoryIndex 同一格式出处 memoryIndexLine）。 */
const indexLineBytes = (m: Pick<MemoryManifest, "name" | "type" | "description">): number =>
    Buffer.byteLength(memoryIndexLine(m), "utf-8");

export const memoryTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "memory_save",
            description:
                "保存一条持久记忆（跨会话保留）：非显然的事实、用户偏好、工作方式反馈、项目约束、外部资源指针——" +
                "「不应每次重新发现」「代码/git 不会直接告诉你」的信息。勿存会话内即抛的临时信息。" +
                "保存后记忆索引自动更新；同名记忆被覆盖。",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "唯一键，小写字母/数字/连字符（描述性 kebab-case，如 user-prefers-arrow-fns）",
                    },
                    description: {
                        type: "string",
                        description: "一句话概括（注入索引供日后判断是否召回）。勿换行，上限 200 字符",
                    },
                    body: {
                        type: "string",
                        description: "记忆正文，可多行，上限 64KB",
                    },
                    type: {
                        type: "string",
                        enum: ["user", "feedback", "project", "reference"],
                        description: "user=用户画像/偏好；feedback=工作方式反馈（含原因与做法）；project=项目目标/约束；reference=外部资源指针。默认 reference",
                    },
                    project: {
                        type: "boolean",
                        description: "true=写入项目 .deepseeker-code/memory（可提交 git 共享）；默认 false（全局，仅本机）",
                    },
                },
                required: ["name", "description", "body"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: any) {
                const name = sanitizeLine(args?.name);
                const description = sanitizeLine(args?.description);
                const body = typeof args?.body === "string" ? args.body : "";
                const type = (sanitizeLine(args?.type) as MemoryType) || "reference";
                const project = args?.project === true;
                if (!NAME_RE.test(name)) return toolFailure(`[memory_save] name 非法：仅允许小写字母/数字/连字符，收到 "${name}"。`);
                if (!description) return toolFailure("[memory_save] description 不能为空。");
                if (description.length > MAX_DESCRIPTION_CHARS) return toolFailure(`[memory_save] description 超过 ${MAX_DESCRIPTION_CHARS} 字符上限（当前 ${description.length}）。请压缩为一句话。`);
                if (!body.trim()) return toolFailure("[memory_save] body 不能为空。");
                if (!VALID_TYPES.includes(type)) return toolFailure(`[memory_save] type 非法：须 user/feedback/project/reference，收到 "${type}"。`);
                const bodyBytes = Buffer.byteLength(body, "utf-8");
                if (bodyBytes > MAX_BODY_BYTES) return toolFailure(`[memory_save] body 超过 ${MAX_BODY_BYTES} 字节上限（当前 ${bodyBytes}）。请精简或拆分。`);
                // ★ #9② 总量闸：索引逐轮整段注入提示词，只增不减会无界侵蚀上下文——超限拒绝并引导治理。
                //   覆盖同名不占新名额；字节闸只防增长（净增 ≤0 的覆盖恒放行，不阻「以缩治胀」）。
                const all = listMemories();
                const existing = getMemory(name);
                if (!existing && all.length >= MEMORY_LIMITS.maxCount) {
                    return toolFailure(`[memory_save] 记忆条数已达上限 ${MEMORY_LIMITS.maxCount}（现有 ${all.length} 条）。索引每轮注入系统提示词，只增不减会持续侵蚀上下文——请先 memory_list 检查，用 memory_delete 清理失效条目或合并相近记忆后再保存。`);
                }
                const curBytes = all.length === 0 ? 0 : Buffer.byteLength(all.map(memoryIndexLine).join("\n"), "utf-8");
                const delta = indexLineBytes({ name, type, description }) - (existing ? indexLineBytes(existing) : 0);
                if (delta > 0 && curBytes + delta > MEMORY_LIMITS.maxIndexBytes) {
                    return toolFailure(`[memory_save] 记忆索引将超字节上限（当前 ${curBytes}/${MEMORY_LIMITS.maxIndexBytes} 字节，本条净增 ${delta} 字节）。索引每轮注入系统提示词——请精简 description，或用 memory_delete 清理/合并旧记忆后再保存。`);
                }
                const file = await writeAndRegister(name, description, type, body, project);
                await recordMemoryUse(name, "save"); // #9③ 触碰 last-used（供淘汰参考；best-effort，内部不抛）
                return `✅ 已保存记忆 **${name}**（${type}${project ? "，项目源" : "，全局源"}）→ ${file}`;
            },
        },
    },
    {
        type: "function",
        function: {
            name: "memory_read",
            description:
                "读取指定记忆的完整正文。系统提示词仅注入记忆索引（一行/条，省 token）；" +
                "当索引中某条与当前任务相关、需要全文细节时，调用本工具按需召回。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "要读取的记忆名（须与记忆索引中列出的名称一致）" },
                },
                required: ["name"],
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: any) {
                const name = sanitizeLine(args?.name);
                const m = getMemory(name);
                if (!m) return toolFailure(`未找到记忆：${name}。可调用 memory_list 查看全部记忆名。`);
                await recordMemoryUse(name, "read"); // #9③ 记 last-used + 读取次数（供淘汰与使用画像；best-effort）
                return `## ${m.name}（${m.type}）\n\n${m.body}`;
            },
        },
    },
    {
        type: "function",
        function: {
            name: "memory_list",
            description: "列出全部记忆的名称、类别与描述（与系统提示词中的记忆索引等价）。用于确认现存记忆、避免重复保存。",
            parameters: { type: "object", properties: {}, required: [] },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute() {
                const all = listMemories();
                if (all.length === 0) return "（暂无记忆）";
                const lines = all.slice().sort((a, b) => a.name.localeCompare(b.name))
                    .map(memoryIndexLine); // 与系统提示词索引同一格式出处（registry.memoryIndexLine）
                return `共 ${all.length} 条记忆：\n${lines.join("\n")}`;
            },
        },
    },
    {
        type: "function",
        function: {
            name: "memory_delete",
            description: "删除指定记忆（删除磁盘文件并从运行时注册表注销，需用户审批）。仅当你确认某条记忆已失效/有误时使用。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "要删除的记忆名" },
                },
                required: ["name"],
            },
            // ★ #9①（2026-09-16）：SAFE → MUTATION。记忆目录在工作区沙箱外，被注入的工具结果可诱导
            //   删除跨会话记忆；删除又不可 undo（不在工作区备份范围）——必须人工过目。未声明
            //   autoApproval → 分类器恒 'ask' → 转人工；allow-always 经 primaryArg 落精确名作用域规则。
            safetyLevel: ToolSafetyLevel.MUTATION,
            isSync: true,
            primaryArg: "name",
            requireApproval: (args: any) => `删除持久记忆 **${sanitizeLine(args?.name)}**（跨会话生效，删除后不可恢复）`,
            async execute(args: any) {
                const name = sanitizeLine(args?.name);
                const m = getMemory(name);
                if (!m) return toolFailure(`未找到记忆：${name}（可能已被删除）。`);
                try { await fs.unlink(m.file); } catch { /* 文件已不在则忽略 */ }
                unregisterMemory(name);
                return `✅ 已删除记忆 **${name}**（${m.file}）。`;
            },
        },
    },
];
