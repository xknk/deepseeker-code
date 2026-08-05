/**
 * @file hooks/httpExecutor.ts
 * @description 声明式 hook 的 http 执行类型：把 hook 上下文 JSON POST 到用户配置的 url，返回结构化结果。
 *
 *  与 shellExecutor（command 类型）对称：后者 spawn shell 命令，本模块发起 HTTP 请求。
 *
 *  ★ SSRF 策略（刻意与 web_fetch 不同）：
 *    web_fetch 抓的是【模型可控】URL（提示词里任意链接），必须套钉 IP / 内网拦截 / 重定向手判等重甲。
 *    本模块的 url 来自用户 settings.json（与 command 同信任模型——用户显式配置、非模型可控），故
 *    【不套】web_fetch 那套 SSRF 重甲，仅由 loader.validateRule 强制 http(s) 协议 + 本模块超时 + 响应体截断。
 *    如需访问内网 webhook（公司内部审计服务），用户自行配置即可，无需 allow_private 闸门。
 *
 *  安全护栏（与 shellExecutor 同口径）：
 *   - 超时：AbortSignal.timeout（默认 30s，loader 按事件梯度注入）；超时/中止不抛错，resolve 带 error。
 *   - 响应体截断：复用 shellExecutor.MAX_STDIN_FIELD（~4KB），防大响应污染 hook 决策视图。
 *   - 不抛错：网络失败/超时/DNS 异常一律 resolve 为 { ok:false, error }，由 compileRule 按 denyOnNonZero 决策。
 */
import { MAX_STDIN_FIELD } from "./shellExecutor.ts";

export interface HttpHookInput {
    url: string;
    /** HTTP method，缺省 POST（webhook 语义：提交上下文供对端决策） */
    method?: string;
    /** 自定义请求头（与默认 content-type:application/json 合并，调用方优先） */
    headers?: Record<string, string>;
    /** 请求体（hook 上下文，JSON 序列化后发出；undefined 则不发 body） */
    body?: any;
    timeoutMs?: number;
}

export interface HttpHookResult {
    /** 网络层是否成功（false = fetch 抛错/超时/中止/DNS 失败） */
    ok: boolean;
    /** HTTP 状态码（ok=false 时为 0） */
    status: number;
    /** 响应体（已截断 ~4KB） */
    responseBody: string;
    /** 失败原因（仅 ok=false 时） */
    error?: string;
}

const truncateBody = (s: string): string => {
    if (s.length <= MAX_STDIN_FIELD) return s;
    return s.slice(0, MAX_STDIN_FIELD) + `…[响应截断，共 ${s.length} 字符]`;
};

/**
 * 执行一次 http hook 请求。网络失败/超时均不抛错（resolve 带错误信息），由 compileRule 按 denyOnNonZero 决策。
 */
export const executeHttpHook = async (input: HttpHookInput): Promise<HttpHookResult> => {
    const method = (input.method || "POST").toUpperCase();
    const timeoutMs = input.timeoutMs ?? 30_000;
    try {
        const res = await fetch(input.url, {
            method,
            headers: { "content-type": "application/json", ...(input.headers ?? {}) },
            body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        return { ok: true, status: res.status, responseBody: truncateBody(text) };
    } catch (e: any) {
        const name = e?.name ?? "";
        if (name === "TimeoutError") return { ok: false, status: 0, responseBody: "", error: `请求超时（>${timeoutMs}ms）` };
        if (name === "AbortError") return { ok: false, status: 0, responseBody: "", error: "请求被中止" };
        return { ok: false, status: 0, responseBody: "", error: e?.message ?? String(e) };
    }
};
