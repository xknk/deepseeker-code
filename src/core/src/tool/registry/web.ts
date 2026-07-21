/**
 * @file tool/registry/web.ts
 * @description 联网类工具集：
 *  web_fetch（DANGER，对外抓取 URL → 转 Markdown，带 SSRF 防护 + 强制审批 + 长度熔断）。
 *  设计原则：零运行时依赖——用 Node 原生 fetch + 内建 dns；HTML→Markdown 走自研轻量转换器
 *  （目标是给大模型干净可读文本，不追求像素级还原；如需更强可后续替换为 turndown）。
 */
import { promises as dns } from "dns";
import { CustomTool, ToolSafetyLevel, ToolContext } from "../type.ts";
import { appConfig } from "@/config/index.ts";

// ---- 抓取相关常量 ----
const FETCH_TIMEOUT_MS = 15000; // 单次请求超时（ms）
const SEARCH_TIMEOUT_MS = 20000; // 搜索请求超时（搜索通常比抓单页慢）
const DEFAULT_MAX_CHARS = 16000; // 默认返回上限（对齐 appConfig.MAX_TOOL_RESULT_CHARS）
const USER_AGENT = "deepSeekCode-Agent/1.0 (+web_fetch tool)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"; // 搜索引擎抓取用（框架 UA 会被反爬拦截）
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/**
 * 🛡️ SSRF 防护：解析主机名，拒绝内网/回环/链路本地地址，
 *  防止大模型被诱导访问云元数据（如 169.254.169.254）或内网服务。
 *  返回 true=安全可访问，false=命中内网熔断。
 */
async function isPublicHost(hostname: string): Promise<boolean> {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // 1. 字面量主机先拦一波（localhost / .local / 云元数据域名）
    if (host === "localhost" || host.endsWith(".local") || host === "metadata.google.internal") {
        return false;
    }
    // 2. 若主机本身就是 IP，直接判定；再挡住非标准 IP 编码（十进制/十六进制/八进制）绕过
    if (isPrivateIp(host)) return false;
    if (isSuspiciousIpLiteral(host)) return false;

    // 3. DNS 解析后逐条判定（IPv4 + IPv6），任一命中内网即熔断
    try {
        const records = await dns.lookup(host, { all: true });
        if (records.length === 0) return false;
        return records.every(r => !isPrivateIp(r.address));
    } catch {
        return false; // 解析失败视为不可访问
    }
}

/** 判定一个 IP 是否属于内网/回环/链路本地/保留段 */
function isPrivateIp(ip: string): boolean {
    // IPv6
    if (ip.includes(":")) {
        return (
            ip === "::1" || // 回环
            ip === "::" ||
            ip.startsWith("fe80") || // 链路本地
            ip.startsWith("fc") || ip.startsWith("fd") // 唯一本地地址 ULA fc00::/7
        );
    }
    // IPv4
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false;
    const [a, b] = parts;
    return (
        a === 0 || // 0.0.0.0/8
        a === 10 || // 10.0.0.0/8
        a === 127 || // 127.0.0.0/8 回环
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 192 && b === 168) || // 192.168.0.0/16
        (a === 169 && b === 254) || // 169.254.0.0/16 链路本地（含云元数据 169.254.169.254）
        (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
    );
}

/**
 * 判定是否为「可疑 IP 字面量」：非标准点分十进制形式（十进制整数 / 十六进制 / 八进制 /
 * 非法段数），底层 DNS/fetch 可能解析为内网地址，isPrivateIp 却识别不出 → 一律拒绝。
 * 堵住 http://2130706433/、http://0x7f000001/、http://0177.0.0.1/ 等 SSRF 绕过。
 */
function isSuspiciousIpLiteral(host: string): boolean {
    // ★ 前置放行：含字母/连字符的普通域名（github.com、sub.domain.co.uk）绝不是 IP 字面量，
    //   直接 return false，避免误杀正常域名。只有「纯数字+点」或纯十六进制整数才可能是 IP 字面量。
    if (!/^[\d.]+$/.test(host) && !/^0x[0-9a-f]+$/i.test(host)) return false;
    // 纯十进制整数（如 2130706433 = 127.0.0.1）
    if (/^\d+$/.test(host)) return true;
    // 十六进制整数（如 0x7f000001）
    if (/^0x[0-9a-f]+$/i.test(host)) return true;
    // 点分形式：含非「1~3 位纯十进制」段（八进制 0177、十六进制段 0x7f 等），或段数 ≠ 4
    if (host.includes(".")) {
        const segs = host.split(".");
        if (segs.some(seg => !/^\d{1,3}$/.test(seg))) return true;
        if (segs.length !== 4) return true;
    }
    return false;
}

/**
 * 轻量 HTML → Markdown 转换器（自研，零依赖）。
 * 关键顺序：先剔除噪声块 → 抽标题 → 保护 pre/code → 块级转换 → 剥剩余标签 → 反转义 → 折叠换行。
 * 注意：故意不做「连续空格折叠」，以免破坏 ``` 代码块的缩进。
 */
function htmlToMarkdown(html: string): string {
    let s = html;

    // 1. 整体剔除噪声块（脚本/样式/模板/导航/页脚等）
    s = s.replace(/<(script|style|noscript|template|nav|footer|header|aside|svg|form)\b[\s\S]*?<\/\1>/gi, "");

    // 2. 抽取 <title> 备用
    const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : "";

    // 3. 保护 <pre>：转成围栏代码块（必须先于标签剥离，避免缩进被破坏）
    s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c) => {
        const code = decodeEntities(stripTags(c)).trim();
        return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    });
    // 行内 <code> → 反引号
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => `\`${decodeEntities(stripTags(c)).trim()}\``);

    // 4. 块级标签 → markdown 语法
    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, c) => `\n\n${"#".repeat(Number(lvl))} ${inline(c).trim()}\n\n`);
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, c) => `- ${inline(c).trim()}\n`);
    s = s.replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote)>/gi, "\n");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
    s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, c) => `\n${stripTags(c).split("\n").map((l: string) => `> ${l}`).join("\n")}\n`);

    // 5. 剥离所有剩余标签
    s = stripTags(s);

    // 6. 反转义 HTML 实体
    s = decodeEntities(s);

    // 7. 折叠多余换行与行尾空格（不折叠水平空格，保护代码缩进）
    s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

    return (title ? `# ${title}\n\n` : "") + s;
}

/** 行内片段转换：链接 / 加粗 / 斜体（不剥剩余标签，交给全局 stripTags） */
function inline(html: string): string {
    return html
        .replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, c) => `[${stripTags(c).trim()}](${href})`)
        .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
        .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");
}

/** 剥离所有 HTML 标签 */
function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, "");
}

/** 解码常见 HTML 实体（含数字实体 &#123; 与命名实体） */
function decodeEntities(s: string): string {
    const named: Record<string, string> = {
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
        "&#39;": "'", "&#x27;": "'", "&apos;": "'", "&nbsp;": " ",
        "&copy;": "©", "&trade;": "™", "&hellip;": "…", "&mdash;": "—", "&ndash;": "–",
        "&ensp;": " ", "&emsp;": " ", "&middot;": "·", "&bull;": "•", "&laquo;": "«", "&raquo;": "»",
        "&lrm;": "", "&rlm;": "", "&zwnj;": "", "&zwj;": ""
    };
    return s
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
        .replace(/&[a-z#0-9]+;/gi, (e) => named[e.toLowerCase()] ?? e);
}

// ============ web_search 多后端（免注册默认 + 可选升级）============
type SearchResult = { title: string; url: string; snippet: string };
type SearchResponse = { answer: string; results: SearchResult[] };

/**
 * 选择搜索后端：
 *  - 环境变量 SEARCH_PROVIDER=tavily|bing|ddg 强制指定；
 *  - 否则自动：有 TAVILY_API_KEY 用 Tavily（结果更干净），否则用 Bing（免注册默认，中国/全球皆可达）。
 *  注：DuckDuckGo 在中国大陆被墙（连接超时），故不作默认；非中国区可用 SEARCH_PROVIDER=ddg 切换。
 */
type SearchProvider = "tavily" | "bing" | "duckduckgo";
function pickSearchProvider(): SearchProvider {
    const forced = (process.env.SEARCH_PROVIDER || "").toLowerCase();
    if (forced === "tavily" && appConfig.tavilyApiKey) return "tavily";
    if (forced === "ddg" || forced === "duckduckgo") return "duckduckgo";
    if (forced === "bing") return "bing";
    return appConfig.tavilyApiKey ? "tavily" : "bing";
}

/** Tavily 后端（需 key，结果干净、带摘要） */
async function searchTavily(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse> {
    const apiKey = appConfig.tavilyApiKey;
    if (!apiKey) throw new Error("未配置 TAVILY_API_KEY");
    const res = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "basic", include_answer: true })
    });
    if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`Tavily HTTP ${res.status} ${res.statusText}${t ? ` | ${t.slice(0, 200)}` : ""}`);
    }
    const data: any = await res.json();
    return {
        answer: (data?.answer ?? "").toString().trim(),
        results: (Array.isArray(data?.results) ? data.results : []).map((r: any) => ({
            title: (r?.title ?? "(无标题)").toString().trim(),
            url: (r?.url ?? "").toString().trim(),
            snippet: (r?.content ?? "").toString().trim()
        }))
    };
}

/** Bing 后端（免注册默认：中国/全球皆可达，HTML 相对稳定、反爬较宽松） */
async function searchBing(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse> {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, {
        signal,
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }
    });
    if (!res.ok) throw new Error(`Bing HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    const results: SearchResult[] = [];
    const blocks = html.split(/<li class="b_algo"/).slice(1); // 每个有机结果块
    for (const block of blocks) {
        if (results.length >= maxResults) break;
        const linkM = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkM) continue;
        const title = decodeEntities(stripTags(linkM[2])).trim();
        const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        const snippet = snippetM ? decodeEntities(stripTags(snippetM[1])).trim() : "";
        if (title && linkM[1]) results.push({ title, url: linkM[1], snippet });
    }
    return { answer: "", results };
}

/** DuckDuckGo 后端（免注册，解析 html.duckduckgo.com；注：中国大陆被墙，仅非中国区可用） */
async function searchDuckDuckGo(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResponse> {
    const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        signal,
        headers: {
            "User-Agent": BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
        },
        body: new URLSearchParams({ q: query })
    });
    if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();

    const results: SearchResult[] = [];
    const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    const links = [...html.matchAll(linkRe)];
    const snippets = [...html.matchAll(snippetRe)];
    for (let i = 0; i < links.length && results.length < maxResults; i++) {
        const rawHref = links[i][1];
        const title = decodeEntities(stripTags(links[i][2])).trim();
        // DDG 链接形如 //duckduckgo.com/l/?uddg=<encoded 真实 url>&rut=...，提取 uddg 还原真实 URL
        let realUrl = rawHref;
        try {
            const u = new URL(rawHref.startsWith("//") ? "https:" + rawHref : rawHref);
            const uddg = u.searchParams.get("uddg");
            if (uddg) realUrl = decodeURIComponent(uddg);
        } catch { /* 非跳转链接则原样使用 */ }
        const snippet = snippets[i] ? decodeEntities(stripTags(snippets[i][1])).trim() : "";
        if (title && realUrl) results.push({ title, url: realUrl, snippet });
    }
    return { answer: "", results };
}

/** 统一格式化搜索结果（带长度熔断） */
function formatSearchResults(query: string, provider: string, resp: SearchResponse): string {
    if (resp.results.length === 0) return `[web_search | "${query}" | ${provider}]：未找到相关结果。`;
    const lines = resp.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 240)}`);
    const body = (resp.answer ? `💡 摘要: ${resp.answer}\n\n` : "") + lines.join("\n\n");
    if (body.length > DEFAULT_MAX_CHARS) {
        return [
            `[web_search | "${query}" | ${provider} | 已截断前 ${DEFAULT_MAX_CHARS} 字符]`,
            body.slice(0, DEFAULT_MAX_CHARS),
            `\n[... ⚠️ 内容过长，已隐藏剩余部分，可调小 max_results ...]`
        ].join("\n");
    }
    return `[web_search | "${query}" | ${provider}]\n${body}`;
}

export const webTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "web_fetch",
            description: "抓取指定公开 URL 的网页内容并转为干净的 Markdown 文本，用于查阅 API 文档、报错说明、官方 changelog 等外部资料。仅支持 http/https，自动拦截内网/回环/链路本地地址（防 SSRF），结果按长度熔断保护上下文。",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "要抓取的完整 http(s) URL" },
                    max_length: { type: "number", description: `返回内容的最大字符数（默认 ${DEFAULT_MAX_CHARS}，超出自动截断）` }
                },
                required: ["url"]
            },
            safetyLevel: ToolSafetyLevel.DANGER, // 对外网络请求，强制审批
            isSync: true,
            maxOutputCharacters: DEFAULT_MAX_CHARS,
            requireApproval: (args: { url: string }) =>
                `⚠️【联网抓取审批】\n目标 URL: ${args.url}\n（将发起对外网络请求，且抓取到的内容会进入云端模型上下文；请确认 URL 来源可信、不含敏感回传数据）`,
            async execute(args: { url: string; max_length?: number }, ctx?: ToolContext): Promise<string> {
                const maxChars = args.max_length && args.max_length > 0 ? args.max_length : DEFAULT_MAX_CHARS;

                // 1. URL 协议与格式校验
                let parsed: URL;
                try {
                    parsed = new URL(args.url);
                } catch {
                    return `❌ [抓取失败]：URL 格式不合法：${args.url}`;
                }
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                    return `❌ [安全熔断]：仅允许 http/https 协议，拒绝 ${parsed.protocol}`;
                }

                // 2. SSRF 防护：拦截内网/回环/链路本地主机
                const safe = await isPublicHost(parsed.hostname);
                if (!safe) {
                    return `🚨 [安全熔断]：目标主机 [${parsed.hostname}] 解析为内网/回环/链路本地地址，已阻断以防 SSRF。仅允许抓取公网地址。`;
                }

                // 3. 发起请求（超时 + 用户中止信号，任一触发即中止）
                const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
                if (ctx?.abortSignal) signals.push(ctx.abortSignal);
                try {
                    const res = await fetch(parsed.href, {
                        signal: AbortSignal.any(signals),
                        redirect: "follow",
                        headers: {
                            "User-Agent": USER_AGENT,
                            "Accept": "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8"
                        }
                    });

                    if (!res.ok) {
                        return `❌ [抓取失败]：HTTP ${res.status} ${res.statusText}（${parsed.href}）`;
                    }

                    const contentType = res.headers.get("content-type") || "";
                    const raw = await res.text();

                    // 4. 二进制/非文本内容兜底
                    if (!/(text|html|json|xml|plain|markdown)/i.test(contentType)) {
                        return `⚠️ [内容类型不支持]：目标返回 ${contentType || "未知类型"}（非文本），web_fetch 仅处理文本/HTML/JSON，已跳过。`;
                    }

                    // 5. HTML → Markdown；纯文本/JSON 原样返回
                    const isHtml = /html/i.test(contentType) || /^\s*<(html|!doctype|head|body)/i.test(raw);
                    const body = isHtml ? htmlToMarkdown(raw) : raw;

                    // 6. 长度熔断
                    if (body.length > maxChars) {
                        return [
                            `[web_fetch | ${parsed.href} | 已截断前 ${maxChars} 字符，原文共 ${body.length} 字符]`,
                            body.slice(0, maxChars),
                            `\n[... ⚠️ 内容过长，已隐藏剩余 ${body.length - maxChars} 字符，可调大 max_length 或改用更精确的 URL ...]`
                        ].join("\n");
                    }
                    return `[web_fetch | ${parsed.href}]\n${body}`;
                } catch (error: any) {
                    if (error?.name === "TimeoutError") {
                        return `❌ [抓取超时]：${FETCH_TIMEOUT_MS / 1000}s 内未响应：${parsed.href}`;
                    }
                    if (error?.name === "AbortError") {
                        return `⏹️ [已中止]：用户中断了抓取：${parsed.href}`;
                    }
                    return `❌ [抓取失败]：${error.message}`;
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "web_search",
            description: "联网搜索外部资料（API 文档、报错解法、库用法、最新信息等），返回结果列表（标题/URL/片段）。默认用 Bing（免注册、中国/全球皆可用）；配置了 TAVILY_API_KEY 会自动升级到 Tavily（结果更干净、带摘要）；可用环境变量 SEARCH_PROVIDER=bing|ddg|tavily 强制指定。查询陌生库或报错时优先用本工具替代凭记忆作答。结果按长度熔断。",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "搜索关键词" },
                    max_results: { type: "number", description: "返回结果条数（默认 5，最大 10）" }
                },
                required: ["query"]
            },
            safetyLevel: ToolSafetyLevel.DANGER, // 对外网络请求，强制审批
            isSync: true,
            maxOutputCharacters: DEFAULT_MAX_CHARS,
            requireApproval: (args: { query: string }) =>
                `⚠️【联网搜索审批】\n搜索词: ${args.query}\n（将发起对外搜索请求，结果会进入云端模型上下文）`,
            async execute(args: { query: string; max_results?: number }, ctx?: ToolContext): Promise<string> {
                const provider = pickSearchProvider();
                const maxResults = Math.max(1, Math.min(args.max_results ?? 5, 10));
                const signals: AbortSignal[] = [AbortSignal.timeout(SEARCH_TIMEOUT_MS)];
                if (ctx?.abortSignal) signals.push(ctx.abortSignal);
                try {
                    const signal = AbortSignal.any(signals);
                    const resp = provider === "tavily"
                        ? await searchTavily(args.query, maxResults, signal)
                        : provider === "duckduckgo"
                            ? await searchDuckDuckGo(args.query, maxResults, signal)
                            : await searchBing(args.query, maxResults, signal);
                    return formatSearchResults(args.query, provider, resp);
                } catch (error: any) {
                    if (error?.name === "TimeoutError") {
                        return `❌ [web_search 超时]：${SEARCH_TIMEOUT_MS / 1000}s 内未响应。`;
                    }
                    if (error?.name === "AbortError") {
                        return `⏹️ [已中止]：用户中断了搜索。`;
                    }
                    return `❌ [web_search 失败 | ${provider}]：${error.message}`;
                }
            }
        }
    }
];
