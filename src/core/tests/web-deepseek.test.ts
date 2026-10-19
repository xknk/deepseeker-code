/**
 * @file tests/web-deepseek.test.ts
 * @description DeepSeek Search/Fetch 后端（tool/registry/web.ts）守门测试（2026-10-19 接入，方案见
 *  .ai-docs/DeepSeek搜索抓取接入方案.md）：
 *  请求字段钉死（count 非 max_results——写错被服务端静默忽略）/ 钳位 1-50 / 字段映射（summary→snippet 槽）/
 *  输出体积预算整条截断（不触发全局熔断拦腰）/ 失败文案切换指引（不静默回退）/ 按次成本上报（成功才计）/
 *  fetch 后端熔断与 site: 引导 / local 缺省零改动（无 key 回退 bing）。
 *  沙盒：env 在 import 前设置（appConfig import 期读取；pickSearchProvider 动态读 env）→ 全动态 import
 *  （同 usage-log.test.ts 惯例）。node --test 每文件独立进程，env 篡改不跨文件泄漏。
 *  mock 全局 fetch 截 API 调用：web.ts 的 DeepSeek 后端走全局 fetch（undici fetch 仅用于 local 抓取）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

process.env.DEEPSEEKER_CODE_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-web-ds-"));
process.env.SEARCH_PROVIDER = "deepseek";
process.env.DEEP_SEEK_API_KEY = "sk-test-ds-keys";

const { webTools, searchDeepseek } = await import("@/tool/registry/web.ts");

// ---- 全局 fetch mock：记录调用 + 按 handler 出牌 ----
type MockReply = { status?: number; statusText?: string; body?: any; text?: string };
let handler: ((url: string, init: any) => MockReply) | null = null;
const calls: Array<{ url: string; init: any }> = [];
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (!handler) throw new Error(`unexpected fetch: ${u}`);
    const h = handler(u, init);
    const status = h.status ?? 200;
    const bodyText = h.text !== undefined ? h.text : JSON.stringify(h.body ?? {});
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: h.statusText ?? "",
        json: async () => JSON.parse(bodyText),
        text: async () => bodyText,
    };
};

// ---- 工具与 ctx ----
const searchTool = webTools.find((t) => (t.function as any).name === "web_search")!;
const fetchTool = webTools.find((t) => (t.function as any).name === "web_fetch")!;
let sinked: number[] = [];
const makeCtx = () => ({
    sessionId: "selftest-web-ds", depth: 0, keepRecentUnits: 0, compactRatio: 0, modelWindow: 0,
    parentSystemPrompt: "", events: async () => {},
    toolCostSink: (yuan: number) => { sinked.push(yuan); },
}) as any;
const text = (r: any) => (typeof r === "string" ? r : r.content);
const ok200 = { status: 200 };

test("searchDeepseek：POST /tools/search + Bearer 鉴权 + count 字段钉死（非 max_results）+ 钳位上限 50", async () => {
    calls.length = 0;
    handler = () => ({ ...ok200, body: { results: [{ title: "T", url: "https://a.example/x", summary: "长摘要", snippet: "短摘要" }] } });
    await searchDeepseek("q", 99, AbortSignal.timeout(1000));
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/tools/search"), `路径错：${calls[0].url}`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Authorization"], "Bearer sk-test-ds-keys");
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(body), ["query", "count"], "请求体字段必须恰为 query+count（官方无其他必填）");
    assert.equal(body.count, 50, "钳位上限 50");
    assert.equal("max_results" in body, false, "字段名必须是 count——max_results 会被服务端静默忽略返回缺省 10 条");
});

test("searchDeepseek：钳位下限 1；字段映射 summary→snippet 槽、title/url 直映、缺字段降级不炸", async () => {
    const resp = await searchDeepseek("q", 0, AbortSignal.timeout(1000));
    assert.equal(JSON.parse(calls[calls.length - 1].init.body).count, 1, "钳位下限 1");
    handler = () => ({
        ...ok200,
        body: {
            results: [
                { title: "标题A", url: "https://a.example/1", summary: "SUMMARY-A", snippet: "SNIPPET-A", authority: 3, date: "2026-10-01" },
                { title: "", url: "https://b.example/2" },          // 缺标题 → 跳过
                { title: "标题C" },                                  // 缺 URL → 跳过
                null,                                                // 脏元素 → 跳过
            ]
        }
    });
    const r = await searchDeepseek("q", 5, AbortSignal.timeout(1000));
    assert.equal(r.results.length, 1, "缺字段/脏元素降级跳过");
    assert.equal(r.results[0].title, "标题A");
    assert.equal(r.results[0].url, "https://a.example/1");
    assert.equal(r.results[0].snippet, "SUMMARY-A", "summary（面向模型）进 snippet 槽——snippet（~200 字面向前端）仅作缺省兜底");
    assert.equal(r.answer, "", "顶层无 answer 字段");
});

test("web_search execute：deepseek 标签 + summary 直出到输出 + 成功才上报按次成本 0.005", async () => {
    sinked = [];
    handler = () => ({ ...ok200, body: { results: [{ title: "SQLite WAL", url: "https://sqlite.org/wal.html", summary: "PRAGMA journal_mode=WAL 即答案" }] } });
    const out = text(await searchTool.function.execute({ query: "sqlite wal" }, makeCtx()));
    assert.ok(out.includes('[web_search | "sqlite wal" | deepseek]'), `输出标签错：${out.slice(0, 80)}`);
    assert.ok(out.includes("PRAGMA journal_mode=WAL"), "summary 必须直出（放宽切片，240 字切片会白映射）");
    assert.deepEqual(sinked, [0.005], "成功调用恰好上报一次按次成本");
});

test("输出体积预算：超预算整条丢弃，不触发全局熔断拦腰截断", async () => {
    handler = () => ({
        ...ok200,
        body: { results: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, url: `https://e.example/${i}`, summary: "S".repeat(2500) })) }
    });
    const r = await searchDeepseek("q", 10, AbortSignal.timeout(1000));
    // 预算 14000：2500/条 → 保留 5 条后余 1500 < 2500 → 第 6 条整条丢弃（首条恒保留）
    assert.equal(r.results.length, 5, "按 summary 长度预算整条截断");
    const out = text(await searchTool.function.execute({ query: "q", max_results: 10 }, makeCtx()));
    assert.ok(!out.includes("已截断前"), "不得触发 formatSearchResults 全局熔断（拦腰截尾）");
    assert.ok(out.length <= 16000, `输出须在 16K 上限内：${out.length}`);
});

test("失败不静默回退：HTTP 500 → 结构化失败 + SEARCH_PROVIDER=bing 切换指引；失败不计费", async () => {
    sinked = [];
    handler = () => ({ status: 500, statusText: "Internal Server Error", text: "boom" });
    const r: any = await searchTool.function.execute({ query: "x" }, makeCtx());
    assert.equal(r.status, "failed");
    assert.ok(r.content.includes("[web_search 失败 | deepseek]"));
    assert.ok(r.content.includes("SEARCH_PROVIDER=bing"), "失败文案须附切换指引");
    assert.deepEqual(sinked, [], "失败调用不上报按次成本");
});

test("无 DEEP_SEEK_API_KEY：forced deepseek 静默落回 bing（零成本回退位，对齐 forced-tavily 现状语义）", async () => {
    delete process.env.DEEP_SEEK_API_KEY;
    try {
        calls.length = 0;
        handler = (u) => (u.includes("bing.com") ? { ...ok200, text: "<html></html>" } : { status: 500, text: "should not hit ds" });
        const out = text(await searchTool.function.execute({ query: "x" }, makeCtx()));
        assert.ok(out.includes("| bing]"), `无 key 应回退 bing：${out.slice(0, 80)}`);
        assert.ok(calls.every((c) => c.url.includes("bing.com")), "不得触碰 DeepSeek 端点");
    } finally {
        process.env.DEEP_SEEK_API_KEY = "sk-test-ds-keys";
    }
});

test("web_fetch backend=deepseek：请求体恰 {url} + 正文直出 + max_length 熔断 + 按次成本 0.005", async () => {
    sinked = [];
    handler = (u) => u.endsWith("/tools/fetch")
        ? { ...ok200, body: { title: "页面标题", content: "C".repeat(5000) } }
        : { status: 500, text: "wrong endpoint" };
    const out = text(await fetchTool.function.execute({ url: "https://ifeng.example/article", backend: "deepseek", max_length: 100 }, makeCtx()));
    const last = calls[calls.length - 1];
    assert.ok(last.url.endsWith("/tools/fetch"));
    assert.deepEqual(Object.keys(JSON.parse(last.init.body)), ["url"], "官方请求体仅 url 一个字段（render/format 均不存在）");
    assert.ok(out.includes("页面标题"));
    assert.ok(out.includes("已截断前 100 字符"), "套现有长度熔断");
    assert.deepEqual(sinked, [0.005]);
});

test("0 命中 + site:带路径误用签名 → 当场给纠正模板（防误判索引没有而连环空转）", async () => {
    handler = () => ({ ...ok200, body: { results: [] } }); // API 对坏语法恒 0 条（A/B 实锤），模拟同响应
    const out = text(await searchTool.function.execute({ query: "site:zhuanlan.zhihu.com/p/37196599" }, makeCtx()));
    assert.ok(out.includes("0 命中"), `须点破是语法问题：${out}`);
    assert.ok(out.includes("site:zhuanlan.zhihu.com 页面标题"), "纠正模板须用剥好路径的 host");
    assert.ok(!out.includes("site:zhuanlan.zhihu.com/p/37196599 端"), "纠正查询不得复现带路径形态");
    // 无 site: 或 site:域名（合法形态）的 0 命中维持原过强文案不变
    const out2 = text(await searchTool.function.execute({ query: "完全不存在的冷门词组组合xyz" }, makeCtx()));
    assert.ok(out2.includes("未找到相关结果"), "无误用签名的 0 命中维持原文案");
});

test("web_fetch backend=deepseek 失败：404 → 引导 web_search site: 语法（不做自动切换）", async () => {
    sinked = [];
    handler = () => ({ status: 404, statusText: "Not Found", text: "failed to fetch URL" });
    const r: any = await fetchTool.function.execute({ url: "https://zhuanlan.zhihu.example/p/1", backend: "deepseek" }, makeCtx());
    assert.equal(r.status, "failed");
    assert.ok(r.content.includes("[抓取失败 | deepseek]"));
    assert.ok(r.content.includes("web_search") && r.content.includes("site:"), "失败引导须指 web_search site: 语法");
    // 引导须带可照抄的动态示例（2026-10-19 A/B 实锤：无示例时模型把路径塞进 site: → 0 命中 → 连环空转）
    assert.ok(r.content.includes("site:zhuanlan.zhihu.example 页面标题"), "示例须用失败 URL 的 hostname 现场拼好 site: 前缀");
    assert.ok(!r.content.includes("site:zhuanlan.zhihu.example/p/1"), "site: 后不得带路径（钉死 A/B 实锤的误用形态）");
    assert.deepEqual(sinked, [], "失败不计费");
});

test("local 缺省零改动：backend 缺省走本机路径（SSRF 拦 localhost），不触碰 DeepSeek 端点", async () => {
    calls.length = 0;
    handler = () => ({ status: 500, text: "local path must not fetch via global fetch mock" });
    const r: any = await fetchTool.function.execute({ url: "http://localhost:5173/x" }, makeCtx());
    assert.equal(calls.length, 0, "local 路径走 undici（不被本 mock 截获），更不许碰 DeepSeek API");
    assert.ok(text(r).includes("本地地址") && text(r).includes("allow_private"), `local SSRF 文案须原样：${text(r)}`);
});
