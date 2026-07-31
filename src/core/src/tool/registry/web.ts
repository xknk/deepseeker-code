/**
 * @file tool/registry/web.ts
 * @description 联网类工具集：
 *  web_fetch（DANGER，对外抓取 URL → 转 Markdown，带 SSRF 防护 + 强制审批 + 长度熔断）。
 *  设计原则：对外抓取走 undici fetch（钉 IP 防 DNS rebinding）+ 内建 dns；HTML→Markdown 走自研轻量转换器
 *  （目标是给大模型干净可读文本，不追求像素级还原；如需更强可后续替换为 turndown）。
 */
import { promises as dns } from "dns";
import { lookup as dnsLookupCb } from "dns";    // 回调风格，供 undici connect.lookup 钉 IP
import { Agent, fetch as undiciFetch } from "undici"; // 显式用 undici fetch：钉 IP dispatcher 选项有类型保证、不被静默吞掉
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
 * 把 IPv4 或「IPv4-mapped IPv6」归一为点分十进制 IPv4；其余（原生 IPv6 / 域名）返回 null。
 *  ★ 必须覆盖 mapped IPv6 的两种记法，否则 ::ffff:169.254.169.254 / ::ffff:a9fe:a9fe
 *    会绕过内网判定直取云元数据（SSRF）：
 *    - mixed 记法：::ffff:a.b.c.d、::a.b.c.d（URL 字面量常见）
 *    - hex 记法 ：::ffff:xxxx:xxxx（getaddrinfo 归一后通常长这样）
 */
function extractIPv4(ip: string): string | null {
    const v = ip.toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v;                              // 纯点分十进制
    const mixed = v.match(/^::(?:ffff:)?0?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // mixed 记法
    if (mixed) return mixed[1];
    const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);               // hex 记法
    if (hex) {
        const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
        return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
    return null;
}

/** 判定点分十进制 IPv4 是否属于内网/回环/链路本地/保留段（含云元数据 169.254.0.0/16）。 */
function isPrivateIpV4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
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
 * 云元数据端点判定：即便 allow_private 放行内网，这些也永远硬拦——
 * 它们是凭证窃取的 SSRF 经典目标（云实例 IAM 临时凭证）。覆盖域名与 IP 字面量（含 IPv4-mapped IPv6 变体）。
 */
function isMetadataEndpoint(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "metadata.google.internal") return true;
    return extractIPv4(host) === "169.254.169.254";
}

/**
 * 主机安全裁决结果：ok=true 可访问；ok=false 附带拦截原因 kind。
 * ★ 关键：区分「解析到内网 IP」与「DNS 解析失败」——
 *   原实现两者都无差别 return false 并套用「内网地址」文案，既误导用户，
 *   又诱导模型按文案提示重试 allow_private（DNS 失败时徒劳，制造死循环）。
 */
type HostVerdict =
    | { ok: true }
    | { ok: false; kind: 'metadata' | 'localhost' | 'private-literal' | 'suspicious-literal' | 'private-resolved' | 'dns-empty' | 'dns-failed'; detail?: string };

/**
 * 🛡️ SSRF 防护：解析主机名，拒绝内网/回环/链路本地地址，
 *  防止大模型被诱导访问云元数据（如 169.254.169.254）或内网服务。
 *  返回结构化裁决（HostVerdict），使报错能区分「内网熔断」与「DNS 失败」。
 *
 *  @param allowPrivate 本地开发/测试场景显式放行内网（127.0.0.1/localhost/内网段），
 *    跳过内网判定；但云元数据端点仍硬拦（见 isMetadataEndpoint）。
 */
async function checkHost(hostname: string, allowPrivate = false): Promise<HostVerdict> {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

    // 0. 云元数据端点：任何情况下都拦截（凭证窃取风险）
    if (isMetadataEndpoint(host)) return { ok: false, kind: 'metadata' };

    // 放行内网模式：本地抓 localhost 服务 / 内网文档等正当需求，由调用方显式开启
    if (allowPrivate) return { ok: true };

    // 1. 字面量主机先拦一波（localhost / .local）
    if (host === "localhost" || host.endsWith(".local")) {
        return { ok: false, kind: 'localhost' };
    }
    // 2. 若主机本身就是 IP，直接判定；再挡住非标准 IP 编码（十进制/十六进制/八进制）绕过
    if (isPrivateIp(host)) return { ok: false, kind: 'private-literal', detail: host };
    if (isSuspiciousIpLiteral(host)) return { ok: false, kind: 'suspicious-literal', detail: host };

    // 3. DNS 解析后逐条判定（IPv4 + IPv6），任一命中内网即熔断
    try {
        const records = await dns.lookup(host, { all: true });
        if (records.length === 0) return { ok: false, kind: 'dns-empty' };
        const bad = records.find(r => isPrivateIp(r.address));
        if (bad) return { ok: false, kind: 'private-resolved', detail: bad.address };
        return { ok: true };
    } catch (e: any) {
        // ★ DNS 解析失败（EAI_AGAIN / EAI_NODATA 等）≠ SSRF 拦截。返回准确原因，指引改用 web_search，
        //   避免模型把"DNS 失败"当成"内网熔断"而反复重试 web_fetch + allow_private（徒劳死循环）。
        return { ok: false, kind: 'dns-failed', detail: e?.code || e?.message };
    }
}

/**
 * 把主机裁决转成面向用户/模型的准确报错文案。
 * ★ 仅 private 类（确实与内网有关）才提示 allow_private；DNS 类不提 allow_private（无济于事），改指引 web_search。
 */
const formatHostBlockMessage = (hostname: string, v: Extract<HostVerdict, { ok: false }>): string => {
    const h = `[${hostname}]`;
    switch (v.kind) {
        case 'metadata':
            return `目标主机 ${h} 为云元数据端点，即便 allow_private 也拦截（防凭证窃取）`;
        case 'localhost':
            return `目标主机 ${h} 为本地地址（localhost/.local），已阻断；如需抓取本地服务请传 allow_private=true`;
        case 'private-literal':
        case 'suspicious-literal':
            return `目标主机 ${h} 本身是内网/可疑 IP 字面量（${v.detail}），已阻断 SSRF；如为正当需求请传 allow_private=true`;
        case 'private-resolved':
            return `目标主机 ${h} DNS 解析到内网/回环/链路本地地址（${v.detail}），已阻断 SSRF；如为正当本地服务请传 allow_private=true（环境变量 WEB_FETCH_ALLOW_PRIVATE=1 可全局开启）`;
        case 'dns-empty':
            return `目标主机 ${h} DNS 无解析记录（域名可能不存在或网络异常），非 SSRF 拦截；建议改用 web_search 或核对域名`;
        case 'dns-failed':
            return `目标主机 ${h} DNS 解析失败（${v.detail || '未知错误'}），非 SSRF 拦截；建议检查网络/DNS 或改用 web_search`;
    }
};

/**
 * 判定一个 IP（IPv4 / IPv6 / IPv4-mapped IPv6）是否属于内网/回环/链路本地/保留段。
 *  ★ mapped IPv6 经 extractIPv4 归一后走 v4 判定，杜绝 ::ffff:127.0.0.1 / ::ffff:a9fe:a9fe 等绕过。
 */
function isPrivateIp(ip: string): boolean {
    const v4 = extractIPv4(ip);
    if (v4) return isPrivateIpV4(v4);
    // 原生 IPv6
    if (ip.includes(":")) {
        return (
            ip === "::1" || // 回环
            ip === "::" ||
            ip.startsWith("fe80") || // 链路本地
            ip.startsWith("fc") || ip.startsWith("fd") // 唯一本地地址 ULA fc00::/7
        );
    }
    return false;
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
        // ★ 数字实体：非法码点（>0x10FFFF）或代理区（0xD800-0xDFFF）会让 fromCodePoint 抛 RangeError，
        //   恶意/异常页面可借此让 web_fetch 稳定失败；越界码点降级为空字符串。
        .replace(/&#(\d+);/g, (_m, n) => {
            const cp = Number(n);
            return cp > 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? String.fromCodePoint(cp) : "";
        })
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

// ============ SSRF 加固：手动跟随重定向 + undici 钉 IP ============
const MAX_REDIRECTS = 5;

/**
 * 🛡️ 钉 IP 的 undici dispatcher：自定义 connect.lookup ——
 *  本地解析 hostname，任一地址命中 isPrivateIp 即拒绝；把首个已校验 IP 直接交给 fetch，
 *  使其不再二次解析 DNS，彻底掐断 DNS rebinding（检查时公网、请求时内网）。
 */
const pinnedSsrfDispatcher = new Agent({
    connect: {
        lookup: ((hostname: string, opts: any, cb: any) => {
            dnsLookupCb(hostname, { all: true, ...(opts || {}) }, (err: any, addrs: any) => {
                if (err) return cb(err);
                const list: Array<{ address: string; family: number }> = Array.isArray(addrs) ? addrs : [addrs];
                if (list.length === 0) return cb(new Error("DNS 无解析结果"));
                for (const a of list) {
                    if (isPrivateIp(a.address)) {
                        return cb(new Error(`DNS 解析到内网/保留地址 ${a.address}，已阻断 SSRF`));
                    }
                }
                // ★ undici 经 opts 传入 all:true，回调须返回地址数组 [{address,family}]；旧实现返回单值
                //   (address, family) 被 node:net 误当数组取首字符 → ERR_INVALID_IP_ADDRESS（致全站 fetch 失败）。
                if (opts?.all) cb(null, list);
                else cb(null, list[0].address, list[0].family);
            });
        }) as any,
    },
});

/**
 * 🛡️ allow_private 模式专用钉 IP dispatcher：放行内网，但硬拦云元数据 IP。
 *  allow_private 下 checkHost 不做 DNS 解析（短路放行内网）；若无钉 IP 兜底，攻击者域名可在
 *  请求时 DNS rebinding 到 169.254.169.254 窃取云凭证（checkHost 仅按主机名字面量判 metadata，挡不住域名 rebinding）。
 *  此 dispatcher 解析一次、用解析 IP 直连（掐断 rebinding），并对解析结果中的云元数据 IP 硬拒。
 */
const pinnedMetadataGuardDispatcher = new Agent({
    connect: {
        lookup: ((hostname: string, opts: any, cb: any) => {
            dnsLookupCb(hostname, { all: true, ...(opts || {}) }, (err: any, addrs: any) => {
                if (err) return cb(err);
                const list: Array<{ address: string; family: number }> = Array.isArray(addrs) ? addrs : [addrs];
                if (list.length === 0) return cb(new Error("DNS 无解析结果"));
                for (const a of list) {
                    // 云元数据端点（含 IPv4-mapped IPv6 变体，经 extractIPv4 归一）即便 allow_private 也硬拦
                    if (extractIPv4(a.address) === "169.254.169.254") {
                        return cb(new Error(`DNS 解析到云元数据端点 ${a.address}，allow_private 下仍拦截（防凭证窃取）`));
                    }
                }
                // ★ undici 经 opts 传入 all:true，回调须返回地址数组 [{address,family}]；旧实现返回单值
                //   (address, family) 被 node:net 误当数组取首字符 → ERR_INVALID_IP_ADDRESS（致全站 fetch 失败）。
                if (opts?.all) cb(null, list);
                else cb(null, list[0].address, list[0].family);
            });
        }) as any,
    },
});

/**
 * 安全抓取：手动跟随重定向（不自动 follow），每一跳都重做：
 *  ① 协议白名单（仅 http/https，挡 file:/gopher: 等）；
 *  ② 拒绝 https→http 降级（防 SSL 剥离）；
 *  ③ checkHost 复检（默认挡内网；allowPrivate 时放行内网，但云元数据端点仍拦）。
 *  默认由 pinnedSsrfDispatcher 钉 IP 防 DNS rebinding；allowPrivate 时不钉（本地已知服务无需防 rebinding）。
 *  任一不合规即抛错，由调用方 catch 转友好提示。
 */
async function safeFetchFollow(
    startUrl: string,
    baseHeaders: Record<string, string>,
    signals: AbortSignal[],
    allowPrivate = false,
) {
    const startProtocol = new URL(startUrl).protocol;
    let url = startUrl;
    // 最多跟随 MAX_REDIRECTS 次重定向（Q-8：旧版 hop > MAX_REDIRECTS 多放一跳，改为 >= 对齐上限）
    for (let hop = 0; ; hop++) {
        if (hop >= MAX_REDIRECTS) throw new Error("重定向次数超出上限（疑似重定向环）");
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`仅允许 http/https 协议，拒绝 ${parsed.protocol}`);
        }
        if (startProtocol === "https:" && parsed.protocol === "http:") {
            throw new Error("拒绝 https→http 降级重定向");
        }
        const verdict = await checkHost(parsed.hostname, allowPrivate);
        if (!verdict.ok) {
            throw new Error(formatHostBlockMessage(parsed.hostname, verdict));
        }
        // ★ 用 undici fetch：dispatcher 选项有类型保证、不会被运行时静默吞掉（防 DNS rebinding 钉 IP 失效）
        const res = await undiciFetch(url, {
            method: "GET",
            signal: AbortSignal.any(signals),
            redirect: "manual",          // ★ 永不自动跟随，逐跳手判
            headers: baseHeaders,
            // ★ 始终钉 IP 防 DNS rebinding：默认拦全部内网；allow_private 改用「只拦云元数据」的 dispatcher
            //   （放行内网本地服务，但解析到 169.254.169.254 仍硬拒，掐断 rebinding 窃取云凭证）
            dispatcher: allowPrivate ? pinnedMetadataGuardDispatcher : pinnedSsrfDispatcher,
        });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) throw new Error(`重定向 ${res.status} 缺少 Location 头`);
            url = new URL(loc, url).href; // 相对 Location 据当前 URL 解析
            continue;
        }
        return res;
    }
}

/** 流式读取响应体所需的最小接口（兼容 undici / 全局 Response）。
 *  body 放宽为 any：undici 的 ReadableStream<any> 与 lib.dom 的 ReadableStream<Uint8Array> 泛型互不兼容
 *  （TS 5.x 类型化数组变革使 pipeThrough/getReader 签名冲突），收紧会触发结构性不兼容报错。 */
type FetchLikeResponse = {
    body: any;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
};

/**
 * 🛡️ OOM 防护：流式读取响应体到字节上限即停。
 *  undici/node fetch 默认无 body 上限，res.text() 会把整页（可能数 GB）一次性读入内存；
 *  在多并发会话的服务进程里，单次抓取即可 OOM 拖垮全部会话。这里逐块累计、超上限即 cancel()，
 *  把单次抓取内存钉死在 maxBytes 以内。content-type 已由调用方在调用前判定（非文本不进来）。
 */
const readBodyCapped = async (
    res: FetchLikeResponse,
    maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
    const body = res.body;
    // 无流式句柄（罕见）回退 text()，并按字节上限截断（此前 content-type 已判定为文本，风险可控）
    if (!body || typeof body.getReader !== "function") {
        const t = await res.text();
        return { text: t.length > maxBytes ? t.slice(0, maxBytes) : t, truncated: t.length > maxBytes };
    }
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let received = 0;
    let out = "";
    let truncated = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const remain = maxBytes - received;
            if (value.byteLength <= remain) {
                out += decoder.decode(value, { stream: true });
                received += value.byteLength;
            } else {
                // 最后一块超出剩余预算：截断到上限后停读
                out += decoder.decode(value.subarray(0, remain), { stream: true });
                truncated = true;
                break;
            }
        }
        out += decoder.decode(); // flush 残留字节
    } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
    }
    return { text: out, truncated };
};

export const webTools: CustomTool[] = [
    {
        type: "function",
        function: {
            name: "web_fetch",
            description: "抓取指定公开 URL 的网页内容并转为干净的 Markdown 文本，用于查阅 API 文档、报错说明、官方 changelog 等外部资料。仅支持 http/https，默认拦截内网/回环/链路本地地址（防 SSRF）；本地开发/自动化测试需抓 localhost 服务或内网页面时，传 allow_private=true 放行（云元数据端点仍拦）。",
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "要抓取的完整 http(s) URL" },
                    max_length: { type: "number", description: `返回内容的最大字符数（默认 ${DEFAULT_MAX_CHARS}，超出自动截断）` },
                    allow_private: { type: "boolean", description: "是否允许访问内网/回环地址（如 localhost:5173 本地服务、内网文档）。默认 false。也可用环境变量 WEB_FETCH_ALLOW_PRIVATE=1 全局开启。即便开启仍拦截云元数据端点（169.254.169.254 等）。" }
                },
                required: ["url"]
            },
            safetyLevel: ToolSafetyLevel.DANGER, // 对外网络请求，强制审批
            isSync: true,
            maxOutputCharacters: DEFAULT_MAX_CHARS,
            requireApproval: (args: { url: string; allow_private?: boolean }) =>
                `⚠️【联网抓取审批】\n目标 URL: ${args.url}${args.allow_private ? "\n🔓 allow_private=true：已放行内网/回环地址（云元数据端点仍拦）" : ""}\n（将发起对外网络请求，且抓取到的内容会进入云端模型上下文；请确认 URL 来源可信、不含敏感回传数据）`,
            async execute(args: { url: string; max_length?: number; allow_private?: boolean }, ctx?: ToolContext): Promise<string> {
                const maxChars = args.max_length && args.max_length > 0 ? args.max_length : DEFAULT_MAX_CHARS;
                // allow_private：参数优先，否则取全局 env 默认（WEB_FETCH_ALLOW_PRIVATE=1）
                const allowPrivate = args.allow_private ?? appConfig.webFetchAllowPrivate;

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

                // 2. SSRF 防护 + 手动跟随重定向：每跳复检 checkHost + 协议白名单 + 拒绝降级；
                //    默认 pinnedSsrfDispatcher 钉住解析 IP 防 DNS rebinding（allowPrivate 时不钉，详见 safeFetchFollow）。
                const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
                if (ctx?.abortSignal) signals.push(ctx.abortSignal);
                try {
                    const res = await safeFetchFollow(parsed.href, {
                        "User-Agent": USER_AGENT,
                        "Accept": "text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.8"
                    }, signals, allowPrivate);

                    if (!res.ok) {
                        return `❌ [抓取失败]：HTTP ${res.status} ${res.statusText}（${parsed.href}）`;
                    }

                    const contentType = res.headers.get("content-type") || "";
                    // 4. 二进制/非文本：按 header 前置判定，避免把整份二进制读入内存（OOM 防护）
                    if (!/(text|html|json|xml|plain|markdown)/i.test(contentType)) {
                        try { await (res.body as any)?.cancel?.(); } catch { /* ignore */ }
                        return `⚠️ [内容类型不支持]：目标返回 ${contentType || "未知类型"}（非文本），web_fetch 仅处理文本/HTML/JSON，已跳过。`;
                    }

                    // 5. 流式读取 + 字节熔断（OOM 防护）：原始响应逐块累计、超 MAX_RAW_BYTES 即 cancel，
                    //    把单次抓取内存钉死在上限内（防多并发会话下单页 OOM 拖垮全进程）；再转 Markdown + 字符截断。
                    const MAX_RAW_BYTES = Math.min(maxChars * 8, 2 * 1024 * 1024); // 留足 HTML→MD 膨胀余量，硬顶 2MB
                    const { text: raw, truncated: rawTruncated } = await readBodyCapped(res, MAX_RAW_BYTES);
                    const truncNote = rawTruncated
                        ? `\n[... ⚠️ 原始响应超过 ${MAX_RAW_BYTES} 字节，已在抓取阶段截断，转换后内容可能不完整 ...]`
                        : "";

                    // 6. HTML → Markdown；纯文本/JSON 原样返回
                    const isHtml = /html/i.test(contentType) || /^\s*<(html|!doctype|head|body)/i.test(raw);
                    const body = isHtml ? htmlToMarkdown(raw) : raw;

                    // 7. 长度熔断（字符级，针对最终 Markdown）
                    if (body.length > maxChars) {
                        return [
                            `[web_fetch | ${parsed.href} | 已截断前 ${maxChars} 字符，原文共 ${body.length} 字符]`,
                            body.slice(0, maxChars),
                            `\n[... ⚠️ 内容过长，已隐藏剩余 ${body.length - maxChars} 字符，可调大 max_length 或改用更精确的 URL ...]`,
                            truncNote,
                        ].join("\n");
                    }
                    return `[web_fetch | ${parsed.href}]\n${body}${truncNote}`;
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
