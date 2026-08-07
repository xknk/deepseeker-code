/**
 * @file tool/mcp/loader.ts
 * @description MCP 工具加载器：读取配置 → 按 transport 创建 client → 连接 server → 把每个 server
 *  的工具包装为命名空间化的 CustomTool（mcp__<server>__<tool>）→ 返回供注入 agentTools。
 *
 *  配置格式（兼容 Claude Code，扩展 type/url/headers 支持远程 transport）：
 *  {
 *    "mcpServers": {
 *      "local":  { "command": "npx", "args": ["-y", "@xxx/server"], "env": { "KEY": "..." } },
 *      "remote": { "type": "http", "url": "https://.../mcp", "headers": { "Authorization": "Bearer ..." } },
 *      "stream": { "type": "sse",  "url": "https://.../sse" }
 *    }
 *  }
 *  type 缺省：有 url→http，否则 stdio。
 *  配置路径：环境变量 MCP_CONFIG 指定，否则默认 ~/.deepseeker-code/mcp.json。无配置/无文件 → 返回空数组（静默跳过）。
 *
 *  安全：MCP server 可执行任意逻辑，包装工具默认 DANGER（每次调用需审批）。
 *  鲁棒：单个 server 连接失败不影响其它 server（仅告警 + dispose 该 client）。
 */
import fs from "fs/promises";
import path from "path";
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { appConfig } from "@/config/index.ts";
import {
    McpClient,
    McpServerConfig,
    McpStdioClient,
    McpStreamableHttpClient,
    McpSSEClient,
} from "./client.ts";

/** 持有所有已连接 client，供关闭时统一 dispose */
const clients: McpClient[] = [];

/** 工具名/服务名净化：非 [a-zA-Z0-9_] 字符替换为 _，保证 OpenAI 工具名合法 */
function sanitize(s: string): string {
    return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** 读取并校验 MCP 配置；无配置则返回空对象（静默跳过） */
async function readMcpConfig(): Promise<Record<string, McpServerConfig>> {
    const configPath = process.env.MCP_CONFIG || path.join(appConfig.dataDir, "mcp.json");
    let raw: string;
    try {
        raw = await fs.readFile(configPath, "utf-8");
    } catch {
        return {}; // 文件不存在等 → 无 MCP server，静默跳过
    }
    try {
        const parsed = JSON.parse(raw);
        const servers = parsed?.mcpServers;
        return servers && typeof servers === "object" ? servers : {};
    } catch (e: any) {
        console.warn(`⚠️ [MCP] 配置文件解析失败（${configPath}）: ${e.message}`);
        return {};
    }
}

/**
 * 按 config 的 type/url/command 选择 transport 创建 client。
 * type 缺省：有 url→http，否则 stdio；stdio 缺 command 抛错（被调用方 try/catch 捕获→跳过该 server）。
 */
function createMcpClient(name: string, cfg: McpServerConfig): McpClient {
    const type = cfg.type ?? (cfg.url ? "http" : "stdio");
    if (type === "http") return new McpStreamableHttpClient(name, cfg);
    if (type === "sse") return new McpSSEClient(name, cfg);
    if (!cfg.command) throw new Error(`MCP server "${name}" 为 stdio 但缺少 command`);
    return new McpStdioClient(name, cfg);
}

/** 把单个 MCP 工具包装为 CustomTool（仅依赖 McpClient.callTool，transport 无关） */
function wrapTool(serverName: string, rawTool: any, client: McpClient): CustomTool | null {
    if (!rawTool?.name) return null;
    const toolName = sanitize(rawTool.name);
    const namespaced = `mcp__${sanitize(serverName)}__${toolName}`;
    const inputSchema = rawTool.inputSchema && typeof rawTool.inputSchema === "object"
        ? rawTool.inputSchema
        : { type: "object", properties: {} };

    return {
        type: "function",
        function: {
            name: namespaced,
            description: `[MCP/${serverName}] ${rawTool.description || toolName}`,
            parameters: inputSchema,
            safetyLevel: ToolSafetyLevel.DANGER, // MCP server 可执行任意逻辑，默认高危
            isSync: true,
            requireApproval: (args: any) =>
                `⚠️【MCP 工具审批】\n服务: ${serverName} / 工具: ${rawTool.name}\n参数: ${JSON.stringify(args)}`,
            async execute(args: any, _ctx?: ToolContext): Promise<string> {
                const result = await client.callTool(rawTool.name, args);
                return `[MCP ${serverName}/${rawTool.name}]\n${result}`;
            },
        },
    } as CustomTool;
}

/** 按服务名找已连接 client（read/get 聚合工具按 server 名路由，无状态） */
function findClient(server: string): McpClient | undefined {
    return clients.find(c => c.serverName === server);
}

/**
 * MCP Resources 聚合工具（跨所有已连接 client；仅当某 server 声明 resources 能力时由 initMcpTools 注入）。
 * 对标 Claude Code 的 ListMcpResources / ReadMcpResource：list 给清单（SAFE 元数据），read 拉内容（DANGER——
 * server 提供内容入模型上下文是注入面，同 web_fetch）。
 * 无状态路由：read 要求传 server 名（list 输出含 server，模型回传），无需跨调用维护 uri→client 映射。
 */
const mcpResourceTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "list_mcp_resources",
            description: "列出已连接 MCP server 暴露的资源（数据源）。每条含 server/uri/name/description/mimeType。可选传 server 仅查指定服务。读取某资源内容用 read_mcp_resource（须传回 server 名）。",
            parameters: {
                type: "object",
                properties: {
                    server: { type: "string", description: "仅列出该 server 的资源（缺省列出全部已连接且支持 resources 的 server）" },
                },
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: any): Promise<string> {
                const server = args?.server;
                const out: any[] = [];
                for (const c of clients) {
                    if (server && c.serverName !== server) continue;
                    if (!c.supportsResources) continue;
                    try {
                        const rs = await c.listResources();
                        for (const r of rs) out.push({
                            server: c.serverName,
                            uri: r.uri, name: r.name,
                            description: r.description, mimeType: r.mimeType,
                        });
                    } catch (e: any) {
                        console.warn(`⚠️ [MCP] listResources "${c.serverName}" 失败（已跳过）: ${e?.message ?? e}`);
                    }
                }
                if (out.length === 0) return server ? `(server "${server}" 无资源或不支持 resources)` : "(无 MCP server 暴露资源)";
                return `[MCP resources]\n${out.map(r => `- [${r.server}] ${r.uri}（${r.name}${r.description ? `：${r.description}` : ""}${r.mimeType ? `，${r.mimeType}` : ""}）`).join("\n")}`;
            },
        },
    },
    {
        type: "function",
        function: {
            name: "read_mcp_resource",
            description: "读取指定 MCP server 的某个资源内容（按 uri）。server 与 uri 均必填——server 名来自 list_mcp_resources 的输出。返回资源文本（二进制资源置占位）。",
            parameters: {
                type: "object",
                properties: {
                    server: { type: "string", description: "资源所属的 MCP server 名（见 list_mcp_resources 输出）" },
                    uri: { type: "string", description: "资源 uri（见 list_mcp_resources 输出）" },
                },
                required: ["server", "uri"],
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: (args: any) =>
                `⚠️【MCP 资源读取审批】\n服务: ${args?.server} / uri: ${args?.uri}\n（将把 MCP server 提供的内容拉入模型上下文；请确认来源可信、不含敏感数据）`,
            async execute(args: any): Promise<string> {
                const { server, uri } = args ?? {};
                if (!server || !uri) return "❌ [read_mcp_resource] 缺少 server 或 uri。";
                const c = findClient(server);
                if (!c) return `❌ 未连接的 MCP server：${server}`;
                if (!c.supportsResources) return `❌ server "${server}" 不支持 resources。`;
                const text = await c.readResource(uri);
                return `[MCP resource ${server}${uri}]\n${text}`;
            },
        },
    },
];

/**
 * MCP Prompts 聚合工具（镜像 mcpResourceTools；仅当某 server 声明 prompts 能力时注入）。
 * list 给清单（SAFE），get 渲染并拉取消息文本（DANGER——server 撰写的 prompt 入上下文是注入面）。
 */
const mcpPromptTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "list_mcp_prompts",
            description: "列出已连接 MCP server 暴露的 prompt 模板。每条含 server/name/description/arguments。渲染某 prompt 用 get_mcp_prompt（须传回 server 名）。",
            parameters: {
                type: "object",
                properties: {
                    server: { type: "string", description: "仅列出该 server 的 prompt（缺省列出全部）" },
                },
            },
            safetyLevel: ToolSafetyLevel.SAFE,
            isSync: true,
            async execute(args: any): Promise<string> {
                const server = args?.server;
                const out: any[] = [];
                for (const c of clients) {
                    if (server && c.serverName !== server) continue;
                    if (!c.supportsPrompts) continue;
                    try {
                        const ps = await c.listPrompts();
                        for (const p of ps) out.push({
                            server: c.serverName,
                            name: p.name, description: p.description,
                            arguments: p.arguments,
                        });
                    } catch (e: any) {
                        console.warn(`⚠️ [MCP] listPrompts "${c.serverName}" 失败（已跳过）: ${e?.message ?? e}`);
                    }
                }
                if (out.length === 0) return server ? `(server "${server}" 无 prompt 或不支持 prompts)` : "(无 MCP server 暴露 prompt)";
                return `[MCP prompts]\n${out.map(p => `- [${p.server}] ${p.name}${p.description ? `：${p.description}` : ""}${Array.isArray(p.arguments) && p.arguments.length ? `（参数：${p.arguments.map((a: any) => a.name + (a.required ? "*" : "")).join(", ")}）` : ""}`).join("\n")}`;
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_mcp_prompt",
            description: "渲染并获取指定 MCP server 的某个 prompt 模板（带参数），返回其消息文本。server 与 name 必填——来自 list_mcp_prompts 输出。",
            parameters: {
                type: "object",
                properties: {
                    server: { type: "string", description: "prompt 所属 MCP server 名" },
                    name: { type: "string", description: "prompt 名（见 list_mcp_prompts 输出）" },
                    arguments: { type: "object", description: "prompt 参数（键值对，schema 见 list_mcp_prompts 的 arguments）", additionalProperties: true },
                },
                required: ["server", "name"],
            },
            safetyLevel: ToolSafetyLevel.DANGER,
            isSync: true,
            requireApproval: (args: any) =>
                `⚠️【MCP prompt 获取审批】\n服务: ${args?.server} / prompt: ${args?.name}\n（将把 MCP server 渲染的 prompt 文本拉入模型上下文；请确认来源可信）`,
            async execute(args: any): Promise<string> {
                const { server, name, arguments: pargs } = args ?? {};
                if (!server || !name) return "❌ [get_mcp_prompt] 缺少 server 或 name。";
                const c = findClient(server);
                if (!c) return `❌ 未连接的 MCP server：${server}`;
                if (!c.supportsPrompts) return `❌ server "${server}" 不支持 prompts。`;
                const text = await c.getPrompt(name, pargs);
                return `[MCP prompt ${server}/${name}]\n${text}`;
            },
        },
    },
];

/**
 * 加载所有已配置 MCP server 的工具。
 * 单个 server 失败不影响其它。返回包装后的 CustomTool[]（不含 client 句柄）。
 */
export async function loadMcpTools(): Promise<CustomTool[]> {
    // ★ 幂等：重复加载（热重载/测试反复 init）前先 dispose 旧 client 并清空，
    //   避免旧 client 句柄残留 + 工具名重复注入。
    if (clients.length > 0) {
        clients.forEach(c => { try { c.dispose(); } catch { /* ignore */ } });
        clients.length = 0;
    }
    const servers = await readMcpConfig();
    const entries = Object.entries(servers);
    if (entries.length === 0) return [];

    const tools: CustomTool[] = [];
    for (const [name, cfg] of entries) {
        const client = createMcpClient(name, cfg);
        try {
            await client.start();
            const rawTools = await client.listTools();
            for (const t of rawTools) {
                const wrapped = wrapTool(name, t, client);
                if (wrapped) tools.push(wrapped);
            }
            clients.push(client);
            const type = cfg.type ?? (cfg.url ? "http" : "stdio");
            console.log(`🔌 [MCP] 已连接 "${name}"（${type}）：${rawTools.length} 个工具`);
        } catch (e: any) {
            console.warn(`⚠️ [MCP] 连接 "${name}" 失败（已跳过）: ${e.message}`);
            try { client.dispose(); } catch { /* ignore */ }
        }
    }
    return tools;
}

/**
 * 加载 MCP 工具并合并进目标工具表（如 agentTools）。
 * 供 serve 启动时调用：await initMcpTools(agentTools)。
 */
export async function initMcpTools(into: CustomTool[]): Promise<void> {
    const mcpTools = await loadMcpTools();
    if (mcpTools.length > 0) {
        into.push(...mcpTools);
        console.log(`🔌 [MCP] 共注入 ${mcpTools.length} 个 MCP 工具`);
    }
    // ★ resources/prompts 聚合工具：仅当某 server 声明对应能力时注入（无则不占工具位，保持零污染）。
    //   镜像 initSkills「有才注入」；clients 已在 loadMcpTools 内填充、能力已在各 start() 捕获。
    if (clients.some(c => c.supportsResources)) {
        into.push(...mcpResourceTools);
        console.log(`📚 [MCP] 检测到 resources 能力，已注入 list/read_mcp_resource`);
    }
    if (clients.some(c => c.supportsPrompts)) {
        into.push(...mcpPromptTools);
        console.log(`💬 [MCP] 检测到 prompts 能力，已注入 list/get_mcp_prompt`);
    }
}

/** 关闭所有 MCP server（含远程 fetch abort / 本地子进程 kill），服务退出时调用 */
export function disposeAllMcpClients(): void {
    clients.forEach(c => { try { c.dispose(); } catch { /* ignore */ } });
    clients.length = 0;
}

/**
 * 列出已连接的 MCP server（供 /mcp 可观测命令展示）。
 * toolCount 取自 listTools（best-effort：单 server 3s 超时，失败标 -1 不阻断其余）。
 * resources/prompts 为能力旗标（即时，无网络往返——读 initialize 握手已捕获的 capabilities）。
 */
export async function listMcpClients(): Promise<{ serverName: string; toolCount: number; resources: boolean; prompts: boolean }[]> {
    const out: { serverName: string; toolCount: number; resources: boolean; prompts: boolean }[] = [];
    for (const c of clients) {
        let toolCount = -1;
        try {
            const tools = await Promise.race([
                c.listTools(),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
            ]);
            toolCount = Array.isArray(tools) ? tools.length : 0;
        } catch { /* 超时/失败：标 -1 */ }
        out.push({ serverName: c.serverName, toolCount, resources: c.supportsResources, prompts: c.supportsPrompts });
    }
    return out;
}
