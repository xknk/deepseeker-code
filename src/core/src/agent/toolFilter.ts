/**
 * @file agent/toolFilter.ts
 * @description 工具表环境过滤：在把工具喂给大模型前，按 validateEnvironment 剔除环境不满足的工具。
 *  典型场景：web_search 未配置 TAVILY_API_KEY 时自动从工具表移除，避免模型调用后撞兜底报错白费一轮。
 *
 *  鲁棒性：validateEnvironment 抛错按【剔除】处理（宁可隐藏也不暴露可能不可用的工具）。
 */
import { ToolContext } from "@/tool/index.ts";

/**
 * 过滤工具表：保留 validateEnvironment 通过（或未声明）的工具。
 * @param tools 待过滤工具表
 * @param ctx 运行时上下文（传给 validateEnvironment）
 * @returns 通过环境断言的工具子集
 */
export async function filterByEnvironment(tools: any[], ctx: ToolContext): Promise<any[]> {
    const out: any[] = [];
    for (const t of tools) {
        const ve = t?.function?.validateEnvironment;
        if (typeof ve === 'function') {
            try {
                const ok = await ve(ctx);
                if (ok === false) continue; // 断言不通过 → 剔除
            } catch {
                continue; // 断言异常 → 剔除（防暴露不可用工具）
            }
        }
        out.push(t);
    }
    return out;
}
