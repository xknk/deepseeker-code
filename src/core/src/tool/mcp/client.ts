/**
 * @file tool/mcp/client.ts
 * @description MCP（Model Context Protocol）stdio 客户端：零依赖手搓 JSON-RPC 2.0。
 *  职责：spawn 一个本地 MCP server 子进程，通过 stdin/stdout 的换行分隔 JSON 消息完成
 *  initialize 握手 → tools/list 枚举工具 → tools/call 调用工具。
 *
 *  v1 范围：仅 stdio 传输 + tools 能力；不实现 resources / prompts / sampling / SSE / notifications 主动处理。
 *  鲁棒性：每个请求 30s 超时；子进程 error 时 reject 所有 pending；非 JSON / 非响应行静默忽略。
 */
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";

export interface McpServerConfig {
    /** 启动命令（如 npx / node / python） */
    command: string;
    /** 命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem"]） */
    args?: string[];
    /** 注入子进程的环境变量（如 API key） */
    env?: Record<string, string>;
}

interface Pending {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30000;
const PROTOCOL_VERSION = "2024-11-05";

export class McpStdioClient {
    private proc: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();

    constructor(public readonly serverName: string, private config: McpServerConfig) {}

    /** 启动子进程并完成 initialize 握手 */
    async start(): Promise<void> {
        const { command, args = [], env } = this.config;
        this.proc = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...env },
            // Windows 下 npx 等常需 shell 才能找到；非 Win 直接执行
            shell: process.platform === "win32",
        });
        if (!this.proc.stdin || !this.proc.stdout) {
            throw new Error("MCP server 未提供可用的 stdin/stdout");
        }

        // 换行分隔的 JSON-RPC 分帧
        const rl = createInterface({ input: this.proc.stdout });
        rl.on("line", (line: string) => this.handleLine(line));

        this.proc.on("error", (e) => {
            for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
            this.pending.clear();
        });
        // ★ 子进程退出（含被信号杀死——只触发 exit 不触发 error）：立即 reject 所有 pending，
        //   避免调用方挂满 30s 超时（旧版缺此监听，server 崩溃后调用任意 MCP 工具会卡 30s）。
        this.proc.on("exit", (code, signal) => {
            const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error(`MCP server 已退出（${reason}）`));
            }
            this.pending.clear();
        });

        // initialize 握手
        await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "deepSeekCode", version: "1.0.0" },
        });
        // 握手完成通知（无 id = notification）
        this.notify("notifications/initialized", {});
    }

    /** 处理一行 JSON-RPC 消息：响应按 id 路由，其余（notification/server request）v1 忽略 */
    private handleLine(line: string): void {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: any;
        try { msg = JSON.parse(trimmed); } catch { return; }
        if (msg?.id === undefined) return; // notification / server→client request，v1 不处理
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || `MCP error ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
    }

    private send(obj: any): void {
        if (!this.proc?.stdin?.writable) throw new Error("MCP server stdin 不可写（进程可能已退出）");
        this.proc.stdin.write(JSON.stringify(obj) + "\n");
    }

    private notify(method: string, params: any): void {
        this.send({ jsonrpc: "2.0", method, params });
    }

    private request(method: string, params: any): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）: ${method}`));
                }
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.send({ jsonrpc: "2.0", id, method, params });
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    /** 枚举 server 暴露的工具（tools/list） */
    async listTools(): Promise<any[]> {
        const result = await this.request("tools/list", {});
        return Array.isArray(result?.tools) ? result.tools : [];
    }

    /** 调用工具（tools/call），返回拼接后的文本内容 */
    async callTool(name: string, args: any): Promise<string> {
        const result = await this.request("tools/call", { name, arguments: args ?? {} });
        const content = Array.isArray(result?.content) ? result.content : [];
        const text = content
            .filter((c: any) => c?.type === "text" && typeof c.text === "string")
            .map((c: any) => c.text)
            .join("\n");
        if (result?.isError) {
            return `❌ [MCP 工具报错]\n${text || JSON.stringify(result)}`;
        }
        return text || JSON.stringify(result);
    }

    /** 关闭子进程 */
    dispose(): void {
        try { this.proc?.stdin?.end(); } catch { /* ignore */ }
        try { this.proc?.kill(); } catch { /* ignore */ }
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("client disposed")); }
        this.pending.clear();
        this.proc = null;
    }
}
