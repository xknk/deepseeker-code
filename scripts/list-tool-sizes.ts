/** 列出全部工具 schema 尺寸（总字节 + description 字节），定位瘦身目标。 */
import { agentTools } from "@/tool/index.ts";

const rows = agentTools.map((t: any) => ({
    n: t.function.name,
    tot: Buffer.byteLength(JSON.stringify({ type: t.type, function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } }), "utf8"),
    d: Buffer.byteLength(String(t.function?.description ?? ""), "utf8"),
})).sort((a, b) => b.tot - a.tot);

let sum = 0, dsum = 0;
for (const r of rows) { sum += r.tot; dsum += r.d; console.log(String(r.tot).padStart(5), String(r.d).padStart(5), r.n); }
console.log("TOTAL", sum, "DESC-ONLY", dsum);
