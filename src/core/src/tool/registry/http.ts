/**
 * @file tool/registry/http.ts
 * @description HTTP 客户端工具：http_request（全方法 + 自定义 header/body + 原始响应）+
 *  wait_http_ready（loopback-only 服务就绪等待，配套 run-stack 编排流程）。
 *
 *  与 web_fetch 的分工：
 *   - web_fetch：GET 抓「网页」→ 转 Markdown，面向「查文档/读资料」，默认拦内网（对外抓取语义）。
 *   - http_request：全方法调「接口」→ 返回原始响应（状态码 + 响应头 + body 原文，不转 Markdown），
 *     面向「本地前后端联调 / API 测试 / 调 REST 接口」。
 *
 *  SSRF 策略：复用 web.ts 的 safeFetchFollow（钉 IP 防 DNS rebinding + 协议白名单 + 重定向逐跳复检），
 *   默认 allowPrivate=true——本地联调必需放行 loopback 与内网段（含 docker 172.x、k8s 服务 IP），
 *   但云元数据端点 169.254.169.254 仍由 pinnedMetadataGuardDispatcher 硬拦（防凭证窃取）。
 */
import { toolFailure, CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { safeFetchFollow, readBodyCapped } from "./web.ts";

const HTTP_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CHARS = 16000;
const USER_AGENT = "DeepSeeker-Code-Agent/1.0 (+http_request tool)";
const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

// ============ wait_http_ready（SAFE 免审的服务就绪等待）============
// 安全红线：SAFE 免审 + 任意 URL = 审批旁路（免审外呼）。execute 内硬校验 host 必须 loopback，
// 非 loopback 一律结构化拒绝并引导走 http_request（DANGER 审批）——此校验是本工具 SAFE 资格的前提。

/** 单次探测超时与轮询间隔。 */
const READY_PROBE_TIMEOUT_MS = 3000;
const READY_POLL_INTERVAL_MS = 1000;
const READY_DEFAULT_TIMEOUT_S = 60;
const READY_MAX_TIMEOUT_S = 180;
/** 超时线索里附带的失败 body 最大字符数。 */
const READY_CLUE_CHARS = 200;

const isLoopbackHost = (host: string): boolean => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::"
        || h === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};

export const httpTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "http_request",
            description: [
                "全方法 HTTP 客户端：本地前后端联调、API 测试、调 REST 接口。返回原始响应（状态码+响应头+body 原文，不转 Markdown）。",
                "与 web_fetch 区别：web_fetch GET 抓网页转 Markdown（查文档、默认拦内网）；本工具调接口取原始响应（联调、默认放行 localhost/内网）。",
                "SSRF：始终拦云元数据端点 169.254.169.254；仅 http/https。"
            ].join(" "),
            parameters: {
                type: "object",
                properties: {
                    method: { type: "string", enum: [...ALLOWED_METHODS], description: "HTTP 方法（默认 GET）" },
                    url: { type: "string", description: "完整 http(s) URL，如 http://localhost:3000/api/login" },
                    headers: { type: "object", additionalProperties: { type: "string" }, description: "自定义请求头（键值对）。带 body 但缺 Content-Type 时默认 application/json" },
                    body: { type: "string", description: "请求体原文（POST/PUT/PATCH 用）。传 JSON 对象请先序列化为字符串" },
                    max_length: { type: "number", description: `响应 body 最大字符数（默认 ${DEFAULT_MAX_CHARS}，超出截断）` }
                },
                required: ["url"]
            },
            safetyLevel: ToolSafetyLevel.DANGER, // 对外/对内网络请求 + 可能带凭证，强制审批
            isSync: true,
            maxOutputCharacters: DEFAULT_MAX_CHARS,
            requireApproval: (args: any) => {
                const m = (args?.method || "GET").toUpperCase();
                const parts = [`⚠️【HTTP 请求审批】`, `${m} ${args?.url}`];
                if (args?.body) {
                    const b = String(args.body);
                    parts.push(`body: ${b.length > 200 ? b.slice(0, 200) + "…" : b}`);
                }
                parts.push("（将发起网络请求；默认放行 localhost/内网便于联调，仍拦云元数据；响应会进入云端模型上下文，请确认不含敏感回传）");
                return parts.join("\n");
            },
            async execute(args: any, ctx?: ToolContext) {
                const method = ((args.method as string) || "GET").toUpperCase();
                if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
                    return toolFailure(`[http_request] 不支持的方法：${args.method}（允许 ${ALLOWED_METHODS.join("/")})`);
                }
                const maxChars = args.max_length && args.max_length > 0 ? args.max_length : DEFAULT_MAX_CHARS;

                // 1. URL 解析 + 协议白名单
                let parsed: URL;
                try {
                    parsed = new URL(args.url);
                } catch {
                    return toolFailure(`[http_request] URL 不合法：${args.url}`);
                }
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    return toolFailure(`[http_request] 仅允许 http/https，拒绝 ${parsed.protocol}`);
                }

                // 2. 请求头：默认 UA + 用户自定义；带 body 但缺 Content-Type 时默认 JSON（联调常见）
                const headers: Record<string, string> = {
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json,text/plain,*/*;q=0.8",
                };
                if (args.headers && typeof args.headers === "object") {
                    for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v);
                }
                const hasContentType = Object.keys(headers).some(h => h.toLowerCase() === "content-type");
                if (args.body !== undefined && args.body !== null && !hasContentType) {
                    headers["Content-Type"] = "application/json";
                }

                // 3. 发请求：复用 web.ts safeFetchFollow（钉 IP + 重定向复检 + 协议白名单）。
                //    allowPrivate=true：本地联调放行 loopback/内网；云元数据端点由 pinnedMetadataGuardDispatcher 硬拦。
                const signals: AbortSignal[] = [AbortSignal.timeout(HTTP_TIMEOUT_MS)];
                if (ctx?.abortSignal) signals.push(ctx.abortSignal);
                try {
                    const res = await safeFetchFollow(parsed.href, headers, signals, true, {
                        method,
                        body: args.body !== undefined && args.body !== null ? String(args.body) : undefined,
                    });

                    // 4. 读响应 body 原文（不转 Markdown），字节熔断防 OOM
                    const MAX_RAW_BYTES = Math.min(maxChars * 8, 2 * 1024 * 1024);
                    const { text, truncated } = await readBodyCapped(res, MAX_RAW_BYTES);

                    // 5. 格式化：状态行 + 关键响应头 + body 原文
                    const ct = res.headers.get("content-type") || "";
                    const cl = res.headers.get("content-length");
                    const headerBits = [`content-type: ${ct || "(无)"}`];
                    if (cl) headerBits.push(`content-length: ${cl}`);
                    const body = text.slice(0, maxChars);
                    const truncNote = truncated || text.length > maxChars
                        ? `\n[... ⚠️ 响应体过大，已截断（原始约 ≥ ${MAX_RAW_BYTES} 字节或超出 max_length） ...]`
                        : "";
                    const statusMark = res.ok ? "" : "（非 2xx，请确认是否符合预期）";
                    return [
                        `[http_request | ${method} ${parsed.href} | ${res.status} ${res.statusText}]${statusMark}`,
                        `[响应头] ${headerBits.join("，")}`,
                        "",
                        body || "(空响应体)",
                        truncNote,
                    ].join("\n");
                } catch (error: any) {
                    if (error?.name === "TimeoutError") {
                        return toolFailure(`[http_request 超时]：${HTTP_TIMEOUT_MS / 1000}s 内未响应：${parsed.href}`);
                    }
                    if (error?.name === "AbortError") {
                        return `⏹️ [http_request 已中止]：用户中断：${parsed.href}`;
                    }
                    return toolFailure(`[http_request 失败 | ${method}]：${error.message}`);
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "wait_http_ready",
            description: [
                "阻塞等待本地服务就绪：1s 间隔轮询 URL 直到服务响应（run-stack 编排用——「起没起来」从猜日志变确定性判定）。",
                "仅限 loopback 地址（localhost/127.x/[::1]），其他地址直接拒绝——外部 URL 请用 http_request（走审批）。",
                "expect_status 缺省=收到任意 HTTP 响应即算就绪（端口已服务，404/503 也算；状态码会回执）；指定了则精确匹配该状态码才通过。",
                "超时时回执带最后一次状态码与 body 摘要，可当排障线索。★ SAFE 免审、可长阻塞，替代逐次 http_request 探测。",
            ].join(" "),
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "等待的本地 URL（如 http://localhost:5173 或健康端点 http://localhost:8080/actuator/health）" },
                    expect_status: { type: "number", description: "要求的 HTTP 状态码（可选，缺省任意响应即就绪）" },
                    timeout_seconds: { type: "number", description: `最长等待秒数（默认 ${READY_DEFAULT_TIMEOUT_S}，上限 ${READY_MAX_TIMEOUT_S}）` },
                },
                required: ["url"],
            },
            safetyLevel: ToolSafetyLevel.SAFE, // loopback-only 硬闸（见文件头安全红线）+ GET 语义探测，免审
            isSync: true,
            maxOutputCharacters: 2000,
            async execute(args: { url?: string; expect_status?: number; timeout_seconds?: number }, ctx?: ToolContext) {
                // 0. 参数与 loopback 硬闸
                let parsed: URL;
                try {
                    parsed = new URL(String(args?.url ?? ""));
                } catch {
                    return toolFailure(`[wait_http_ready] URL 不合法：${args?.url}`);
                }
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    return toolFailure(`[wait_http_ready] 仅允许 http/https，拒绝 ${parsed.protocol}`);
                }
                if (!isLoopbackHost(parsed.hostname)) {
                    return toolFailure(`[wait_http_ready] 仅支持本地地址（localhost/127.x/[::1]），拒绝 ${parsed.hostname}。外部 URL 请用 http_request（DANGER 审批）发起。`, 'permission');
                }
                const timeoutS = Math.min(Math.max(args?.timeout_seconds && args.timeout_seconds > 0 ? args.timeout_seconds : READY_DEFAULT_TIMEOUT_S, 1), READY_MAX_TIMEOUT_S);
                const startedAt = Date.now();
                const deadline = startedAt + timeoutS * 1000;
                const elapsedS = () => Math.round((Date.now() - startedAt) / 1000);

                // 1. 轮询：连接级失败（ECONNREFUSED）与状态不符都继续等；最后一次失败响应留 body 摘要当线索
                let lastLine = "尚未发起探测";
                let lastClue = "";
                let attempts = 0;
                let nextProgressAt = startedAt + 5000;
                while (Date.now() < deadline) {
                    if (ctx?.abortSignal?.aborted) return `⏹️ [wait_http_ready 已中止]：用户中断（已等待 ${elapsedS()}s）`;
                    attempts++;
                    let status: number | null = null;
                    try {
                        const res = await safeFetchFollow(parsed.href, { "User-Agent": USER_AGENT, "Accept": "*/*" },
                            [AbortSignal.timeout(READY_PROBE_TIMEOUT_MS)], true, { method: "GET" });
                        status = res.status;
                        if (args?.expect_status === undefined || status === args.expect_status) {
                            return `✅ 服务就绪 ${parsed.href}（HTTP ${status}${res.statusText ? " " + res.statusText : ""}，第 ${attempts} 次探测，耗时 ${elapsedS()}s）`;
                        }
                        lastLine = `HTTP ${status} ${res.statusText}（期望 ${args.expect_status}，继续等）`;
                        try {
                            lastClue = (await readBodyCapped(res, READY_CLUE_CHARS * 4)).text.slice(0, READY_CLUE_CHARS);
                        } catch { /* 线索拿不到就算了 */ }
                    } catch (e: any) {
                        lastLine = e?.name === "TimeoutError" ? "探测超时（服务未响应）" : `连接失败：${e?.message ?? e}`;
                    }
                    if (ctx?.emitProgress && Date.now() >= nextProgressAt) {
                        ctx.emitProgress(`仍在等待 ${parsed.href}（剩余 ${Math.max(Math.ceil((deadline - Date.now()) / 1000), 0)}s）：${lastLine}`);
                        nextProgressAt = Date.now() + 5000;
                    }
                    await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS));
                }
                return toolFailure(`[wait_http_ready 超时]：${timeoutS}s 内未就绪（共 ${attempts} 次探测）。最后状态：${lastLine}${lastClue ? `\n响应 body 摘要：${lastClue}` : ""}`);
            }
        }
    },
];
