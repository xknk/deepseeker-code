/**
 * @file llm/surrogateGuard.ts
 * @description 发送前孤立代理守门（2026-11-13 事故终防线）：任何进入 API 请求的消息文本，
 *  经此净剔除孤立代理对（截断劈半的 emoji 等）。
 *
 *  事故回顾：decayOldToolResults 折叠旧工具结果时裸 slice(0,500) 劈开 emoji 代理对 → 孤立高代理
 *  经 JSON.stringify 成 \udXXX → DeepSeek 解析器 400（措辞误导为 "unexpected end of hex escape"），
 *  会话每次装载必死。源头切点已全部改走 sliceHeadNoSplit/sliceTailNoSplit（session/content.ts），
 *  但「已知的切点都修了」防不住未来的新切点——本守门是结构性兜底：**不管哪里漏劈，出不了门**。
 *  命中即剔除并 warn 留痕（旁路，绝不阻断请求）。
 */

/** 剔除字符串里的孤立代理（高代理后无低代理 / 低代理前无高代理），成对代理对原样保留。
 *  ★ isWellFormed 快判（Node 20+ 原生）：绝大多数消息是良构的，命中快判零扫描零分配直接返回——
 *    本函数在两条出口通道对每条消息每轮请求都会跑，正则扫描只在真有孤立代理时才值得。
 *    （as any 旁路：core tsconfig lib < es2024 不认该方法的类型，运行时 Node 22 恒在；
 *      可选调用 + 缺省回退正则，旧运行时零风险。） */
export const stripLoneSurrogates = (s: string): string =>
    (s as { isWellFormed?: () => boolean }).isWellFormed?.() ? s
        : s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");

/**
 * 净化 chat messages 数组（浅拷贝改写，不动入参）：覆盖 content（字符串 / 多模态 parts 数组的
 * text 字段）与 tool_calls[].function.arguments（JSON 字符串）。命中剔除时 warn 一次。
 */
export const sanitizeChatMessages = <T extends any[]>(msgs: T): T => {
    let stripped = 0;
    const clean = (s: string): string => {
        const t = stripLoneSurrogates(s);
        if (t !== s) stripped++;
        return t;
    };
    const out = msgs.map((m: any) => {
        let touched = false;
        let content = m.content;
        if (typeof content === "string") {
            const t = clean(content);
            if (t !== content) { content = t; touched = true; }
        } else if (Array.isArray(content)) {
            content = content.map((p: any) => {
                if (typeof p?.text !== "string") return p;
                const t = clean(p.text);
                return t === p.text ? p : { ...p, text: t };
            });
            touched = true; // parts 数组总是换新引用（成本可忽略，避免逐 part 比对）
        }
        let toolCalls = m.tool_calls;
        if (Array.isArray(toolCalls)) {
            toolCalls = toolCalls.map((tc: any) => {
                const fn = tc?.function;
                if (typeof fn?.arguments !== "string") return tc;
                const t = clean(fn.arguments);
                return t === fn.arguments ? tc : { ...tc, function: { ...fn, arguments: t } };
            });
            touched = true;
        }
        return touched ? { ...m, content, tool_calls: toolCalls } : m;
    }) as T;
    if (stripped > 0) {
        console.warn(`⟦surrogate-guard⟧ 净除 ${stripped} 处孤立代理（截断劈半的 emoji 等——DeepSeek 会以 400 parse error 拒收；源头切点应已防劈，此处是终防线，若频发请排查新切点）`);
    }
    return out;
};
