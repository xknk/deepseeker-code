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
 *  配置路径：环境变量 MCP_CONFIG 指定，否则默认 ~/.deepSeekCode/mcp.json。无配置/无文件 → 返回空数组（静默跳过）。
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
}

/** 关闭所有 MCP server（含远程 fetch abort / 本地子进程 kill），服务退出时调用 */
export function disposeAllMcpClients(): void {
    clients.forEach(c => { try { c.dispose(); } catch { /* ignore */ } });
    clients.length = 0;
}
