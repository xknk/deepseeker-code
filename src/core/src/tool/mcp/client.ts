/**
 * @file tool/mcp/client.ts
 * @description MCP（Model Context Protocol）客户端：零依赖手搓 JSON-RPC 2.0，支持三种 transport。
 *
 *  统一抽象 McpClient 接口（start / listTools / callTool / dispose），三实现：
 *   - McpStdioClient：spawn 本地 server 子进程，stdin/stdout 换行分隔 JSON（v1 既有，稳定）。
 *   - McpStreamableHttpClient：现代规范（2025-03-26），逐请求 POST JSON-RPC，响应 application/json
 *     或 text/event-stream（SSE 帧按 id 路由）。走 undici fetch（与 web_fetch 同源，无新依赖）。
 *   - McpSSEClient：legacy SSE（GET 开常驻流 + POST 到 endpoint），复用 stdio 的 pending-map。
 *
 *  鲁棒性：每个请求 30s 超时；transport 断开/异常时 reject 所有 pending；非 JSON / 非响应行静默忽略。
 *  协议版本：stdio 保持 2024-11-05（不破坏既有本地 server）；http/sse 用 2025-03-26。
 */
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { fetch as undiciFetch } from "undici";

/** MCP server 配置：type 决定 transport（缺省按 command/url 推断） */
export interface McpServerConfig {
    /** 启动命令（stdio 用，如 npx / node / python） */
    command?: string;
    /** 命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem"]） */
    args?: string[];
    /** 注入子进程/请求的环境变量（如 API key） */
    env?: Record<string, string>;
    /** transport 类型；缺省：有 url→http，否则 stdio */
    type?: "stdio" | "http" | "sse";
    /** http/sse 的服务端 URL */
    url?: string;
    /** http/sse 自定义请求头（如 Authorization） */
    headers?: Record<string, string>;
}

/** transport 无关的公共接口（loader.ts 仅消费这 4 个方法 + serverName） */
export interface McpClient {
    readonly serverName: string;
    start(): Promise<void>;
    listTools(): Promise<any[]>;
    callTool(name: string, args: any): Promise<string>;
    dispose(): void;
}

interface Pending {
    resolve: (v: any) => void;
    reject: (e: any) => void;
    timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 30000;
const PROTOCOL_VERSION_STDIO = "2024-11-05";   // stdio 保持旧版本，不破坏既有本地 server
const PROTOCOL_VERSION_HTTP = "2025-03-26";    // streamable-http / SSE 需较新协议版本

/**
 * 统一的 tools/call 结果 → 文本拼接（stdio/http/sse 共用，避免重复）。
 * isError=true 时前置错误标记（防模型把报错当成功）。
 */
const joinContentText = (result: any): string => {
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n");
    if (result?.isError) {
        return `❌ [MCP 工具报错]\n${text || JSON.stringify(result)}`;
    }
    return text || JSON.stringify(result);
};

/** 客户端信息（握手用），与 serverName 解耦 */
const CLIENT_INFO = { name: "deepSeekCode", version: "1.0.0" };

/**
 * 构造安全环境变量：仅透传白名单（PATH/HOME 等基础变量），不全量透传 process.env，
 * 防宿主 DEEPSEEK_CODE_TOKEN / API key 等机密泄露给第三方 MCP server。
 * 白名单与 hooks/shellExecutor.ts 的 ENV_WHITELIST 保持一致。
 */
const MCP_ENV_WHITELIST = [
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "WORKSPACE_ROOT", "LANG", "TERM", "SHELL", "SystemRoot", "ComSpec",
];
const buildSafeEnv = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of MCP_ENV_WHITELIST) {
        const v = process.env[k];
        if (v !== undefined) out[k] = v;
    }
    return out;
};

/**
 * 📟 MCP stdio 客户端：spawn 子进程，stdin/stdout 换行分隔 JSON-RPC。
 */
/**
 * MCP client 抽象基类：listTools / callTool 三种 transport 实现完全一致（仅 request 的 transport 不同），
 * 上提至此避免重复。子类只需实现 transport 相关的 start / request / dispose + serverName。
 */
abstract class McpBaseClient implements McpClient {
    abstract readonly serverName: string;
    abstract start(): Promise<void>;
    abstract dispose(): void;
    /** transport 相关的 JSON-RPC 请求（stdio 走 stdin/stdout，http/sse 走 fetch） */
    protected abstract request(method: string, params: any): Promise<any>;

    /** 枚举 server 暴露的工具（tools/list） */
    async listTools(): Promise<any[]> {
        const result = await this.request("tools/list", {});
        return Array.isArray(result?.tools) ? result.tools : [];
    }

    /** 调用工具（tools/call），返回拼接后的文本内容 */
    async callTool(name: string, args: any): Promise<string> {
        const result = await this.request("tools/call", { name, arguments: args ?? {} });
        return joinContentText(result);
    }
}

export class McpStdioClient extends McpBaseClient {
    private proc: ChildProcess | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private rl: ReturnType<typeof createInterface> | null = null;
    /** server stderr 最近片段（消费管道防死锁 + 崩溃诊断用） */
    private stderrBuf = "";

    constructor(public readonly serverName: string, private config: McpServerConfig) { super(); }

    /** 启动子进程并完成 initialize 握手 */
    async start(): Promise<void> {
        const { command, args = [], env } = this.config;
        if (!command) throw new Error("MCP stdio 配置缺少 command");
        this.proc = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            // ★ 环境变量白名单透传（见 buildSafeEnv）：不全量透传 process.env，
            //   防宿主 DEEPSEEK_CODE_TOKEN / API key 等机密泄露给第三方 MCP server
            env: { ...buildSafeEnv(), ...env },
            // Windows 下 npx 等常需 shell 才能找到；非 Win 直接执行
            shell: process.platform === "win32",
        });
        if (!this.proc.stdin || !this.proc.stdout) {
            throw new Error("MCP server 未提供可用的 stdin/stdout");
        }

        // 换行分隔的 JSON-RPC 分帧
        this.rl = createInterface({ input: this.proc.stdout });
        this.rl.on("line", (line: string) => this.handleLine(line));

        // ★ 消费 stderr：stdio 三管道但若无人读 stderr，server 写满 ~64KB 管道后会阻塞写 →
        //   停止读 stdin → 所有 tools/list、tools/call 卡 30s 超时（死锁）。
        //   此处持续吸收 + 留最近 8KB 片段供 server 崩溃时诊断。
        this.proc.stderr?.on("data", (d: Buffer) => {
            this.stderrBuf += d.toString();
            if (this.stderrBuf.length > 8192) this.stderrBuf = this.stderrBuf.slice(-8192);
        });

        this.proc.on("error", (e) => {
            for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
            this.pending.clear();
        });
        // ★ 子进程退出（含被信号杀死——只触发 exit 不触发 error）：立即 reject 所有 pending，
        //   避免调用方挂满 30s 超时（server 崩溃后调用任意 MCP 工具会卡 30s）。
        this.proc.on("exit", (code, signal) => {
            const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
            const hint = this.stderrBuf.trim() ? `\n[stderr 尾部] ${this.stderrBuf.trim().slice(-500)}` : "";
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error(`MCP server 已退出（${reason}）${hint}`));
            }
            this.pending.clear();
        });

        // initialize 握手
        await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION_STDIO,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });
        // 握手完成通知（无 id = notification）
        this.notify("notifications/initialized", {});
    }

    /** 处理一行 JSON-RPC 消息：响应按 id 路由，其余（notification/server request）忽略 */
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

    protected request(method: string, params: any): Promise<any> {
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

    /** 关闭子进程 */
    dispose(): void {
        try { this.rl?.close(); } catch { /* ignore */ }
        try { this.proc?.stdin?.end(); } catch { /* ignore */ }
        try { this.proc?.kill(); } catch { /* ignore */ }
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("client disposed")); }
        this.pending.clear();
        this.proc = null;
        this.rl = null;
    }
}

/**
 * 🌐 MCP streamable-HTTP 客户端（现代规范）：逐请求 POST JSON-RPC，响应 application/json
 *  或 text/event-stream。无状态服务端为常见情况，故采用「同步逐请求 POST」最简模型。
 */
export class McpStreamableHttpClient extends McpBaseClient {
    private nextId = 1;
    private abort: AbortController | null = null;

    constructor(public readonly serverName: string, private config: McpServerConfig) { super(); }

    private get url(): string {
        if (!this.config.url) throw new Error("MCP HTTP 配置缺少 url");
        return this.config.url;
    }

    private baseHeaders(): Record<string, string> {
        return {
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION_HTTP,
            ...(this.config.headers || {}),
        };
    }

    async start(): Promise<void> {
        this.abort = new AbortController();
        await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION_HTTP,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });
        this.notify("notifications/initialized", {});
    }

    private notify(method: string, params: any): void {
        // 通知：无 id，fire-and-forget（失败忽略——通知本就无响应可等）
        undiciFetch(this.url, {
            method: "POST",
            headers: { ...this.baseHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method, params }),
            signal: this.abort?.signal,
        }).catch(() => { /* 通知失败不影响主流程 */ });
    }

    protected async request(method: string, params: any): Promise<any> {
        const id = this.nextId++;
        const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        // 每请求独立超时信号：与 dispose 的 abort 合并
        const signals: AbortSignal[] = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
        if (this.abort?.signal) signals.push(this.abort.signal);
        const res = await undiciFetch(this.url, {
            method: "POST",
            headers: { ...this.baseHeaders(), "Content-Type": "application/json" },
            body,
            signal: AbortSignal.any(signals),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`MCP HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("text/event-stream") && res.body) {
            return await this.readSseResponse(res.body as any, id);
        }
        // application/json：单个 JSON-RPC 对象
        const msg = await res.json() as any;
        if (msg?.error) throw new Error(msg.error.message || `MCP error ${JSON.stringify(msg.error)}`);
        return msg?.result;
    }

    /** 解析 SSE 响应流，取首个携带匹配 id 的 JSON-RPC 帧 */
    private async readSseResponse(stream: ReadableStream<Uint8Array>, expectedId: number): Promise<any> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let dataLines: string[] = [];
        const flush = (): any | undefined => {
            if (dataLines.length === 0) return undefined;
            const text = dataLines.join("\n");
            dataLines = [];
            let msg: any;
            try { msg = JSON.parse(text); } catch { return undefined; } // 非 JSON 帧跳过
            if (msg?.id === expectedId) {
                if (msg.error) throw new Error(msg.error.message || `MCP error ${JSON.stringify(msg.error)}`);
                return msg.result;
            }
            return undefined;
        };
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 1);
                    if (line.startsWith("data:")) {
                        dataLines.push(line.slice(5).trimStart());
                    } else if (line.trim() === "") {
                        const hit = flush();
                        if (hit !== undefined) return hit;
                    }
                }
            }
            const hit = flush();
            if (hit !== undefined) return hit;
        } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
        }
        throw new Error(`MCP HTTP SSE 流结束，未拿到 id=${expectedId} 的响应`);
    }

    dispose(): void {
        try { this.abort?.abort(); } catch { /* ignore */ }
        this.abort = null;
    }
}

/**
 * 📡 MCP legacy SSE 客户端：GET 开常驻事件流（server→client），client→server 经 endpoint POST。
 *  响应经 GET 流按 id 路由（复用 stdio 的 pending-map）。legacy 协议，尽力实现。
 */
export class McpSSEClient extends McpBaseClient {
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private endpoint: string | null = null;
    private abort: AbortController | null = null;
    private endpointReady: Promise<void>;
    private resolveEndpoint!: () => void;

    constructor(public readonly serverName: string, private config: McpServerConfig) {
        super();
        // endpoint 到达信号：start() 中等它 resolve 后再发 initialize
        this.endpointReady = new Promise((resolve) => { this.resolveEndpoint = resolve; });
    }

    private get baseUrl(): string {
        if (!this.config.url) throw new Error("MCP SSE 配置缺少 url");
        return this.config.url;
    }

    async start(): Promise<void> {
        this.abort = new AbortController();
        const res = await undiciFetch(this.baseUrl, {
            method: "GET",
            headers: { Accept: "text/event-stream", ...(this.config.headers || {}) },
            signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`MCP SSE 连接失败：HTTP ${res.status}`);
        // 常驻读流：路由响应（按 id）+ 捕获 endpoint 事件
        this.readStream(res.body as any);
        // 等 endpoint 事件，限时 30s（防异常 SSE server 连上却不发 endpoint 导致 start 永久挂起）
        await Promise.race([
            this.endpointReady,
            new Promise<void>((_, reject) => setTimeout(
                () => reject(new Error("MCP SSE 等待 endpoint 事件超时")),
                REQUEST_TIMEOUT_MS,
            )),
        ]);
        await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION_HTTP,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });
        this.notify("notifications/initialized", {});
    }

    /** 常驻 SSE 读流：解析事件帧，endpoint 事件记下 POST 目标，其余按 JSON-RPC id 路由 */
    private readStream = (stream: ReadableStream<Uint8Array>): void => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let dataLines = "";
        let eventName = "";
        const processEvent = () => {
            const payload = dataLines;
            dataLines = "";
            if (eventName === "endpoint" && payload) {
                // endpoint 的 data 是 POST 目标（可能是相对 URL，按 baseUrl 解析）
                // ★ SSRF 防护：server 单方面指定的 POST endpoint 必须与 baseUrl 同 host，
                //   否则恶意 server 可诱导把带 Authorization 头的 JSON-RPC POST 转发到内网任意端点。
                try {
                    const u = new URL(payload, this.baseUrl);
                    const baseHost = new URL(this.baseUrl).host;
                    if (u.host !== baseHost) {
                        console.warn(`⚠️ [MCP SSE] server 指定的 endpoint host "${u.host}" 与 baseUrl "${baseHost}" 不一致，已拒绝（防 SSRF/凭据泄露）`);
                        return;
                    }
                    this.endpoint = u.toString();
                    this.resolveEndpoint();
                } catch { /* 非法 endpoint 忽略 */ }
                return;
            }
            // 默认：JSON-RPC 响应，按 id 路由
            let msg: any;
            try { msg = JSON.parse(payload); } catch { return; }
            if (msg?.id === undefined) return;
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || `MCP error ${JSON.stringify(msg.error)}`));
            else p.resolve(msg.result);
        };
        (async () => {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let idx: number;
                    while ((idx = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 1);
                        if (line.startsWith("data:")) {
                            dataLines += line.slice(5).replace(/^\s/, "");
                        } else if (line.startsWith("event:")) {
                            eventName = line.slice(6).trim();
                        } else if (line.trim() === "") {
                            if (dataLines) { processEvent(); eventName = ""; }
                        }
                    }
                }
            } catch { /* 流断开/abort：静默，pending 由超时/dispose 兜底 */ }
            finally {
                // 流结束：reject 所有未决 pending（server 已断）
                for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("MCP SSE 流已关闭")); }
                this.pending.clear();
            }
        })();
    };

    private notify(method: string, params: any): void {
        if (!this.endpoint) return; // endpoint 未就绪时不发通知
        undiciFetch(this.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(this.config.headers || {}) },
            body: JSON.stringify({ jsonrpc: "2.0", method, params }),
            signal: this.abort?.signal,
        }).catch(() => { /* 通知失败不影响主流程 */ });
    }

    protected request(method: string, params: any): Promise<any> {
        if (!this.endpoint) return Promise.reject(new Error("MCP SSE endpoint 尚未就绪"));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）: ${method}`));
                }
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            undiciFetch(this.endpoint!, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...(this.config.headers || {}) },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                signal: this.abort?.signal,
            }).catch((e) => {
                if (this.pending.has(id)) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new Error(`MCP SSE POST 失败: ${e?.message ?? e}`));
                }
            });
        });
    }

    dispose(): void {
        try { this.abort?.abort(); } catch { /* ignore */ }
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("client disposed")); }
        this.pending.clear();
        this.abort = null;
    }
}
