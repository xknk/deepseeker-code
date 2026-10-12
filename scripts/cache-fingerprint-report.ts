/**
 * 缓存指纹分析：扫描全部 trace jsonl，提取每个 run（主/子，按事件 sessionId 分组）首个 llm.request 的
 * 前缀指纹与缓存命中，用于定位 fresh-session 缓存 miss 的分歧点。
 * 读侧注意：子 run 事件与主 run 混在主会话的 trace 文件里（store.ts getFileName 按 __sub__ 溯源主 ID 归并落盘，
 * 防多子代理并发写冲突的刻意设计），故必须按 sessionId 分组建行——「每文件首个 request」写法会把子 run 全部误跳过。
 * 判读：
 *  - 同 depth 内 toolsHash 不同的 run → 工具表分歧（env 门控漂移 / 版本迭代）——首要嫌疑；
 *    主(depth 0)/子(depth >0) toolsHash 不同是设计使然（子代理工具集本就不同），不算漂移；
 *  - toolsHash 同、sysHash 不同 → message[0] 注入漂移（locale/skills/memory/projectGuide）；
 *  - 全同但首轮命中低 → DS 服务端缓存 TTL/LRU 驱逐（时间间隔越久越可能），非本地问题。
 * 运行：npx tsx --tsconfig src/core/tsconfig.json scripts/cache-fingerprint-report.ts
 */
import fs from "fs";
import path from "path";
import os from "os";

const TRACE_ROOT = path.join(os.homedir(), ".deepseeker-code", "trace");
if (!fs.existsSync(TRACE_ROOT)) { console.log("trace 目录不存在"); process.exit(0); }

type Row = { session: string; depth: number; toolsHash?: string; sysHash?: string; r1Real?: number; r1Hit?: number; ts: string };
const rows: Row[] = [];

const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) rows.push(...parseFile(p));
    }
};

const parseFile = (file: string): Row[] => {
    // 按 sessionId 分组建行：每 run 取首个 llm.request（round 2+ 不另立）；response 按同 sessionId 回填首轮命中
    const bySession = new Map<string, Row>();
    let lines: string[] = [];
    try { lines = fs.readFileSync(file, "utf-8").split("\n"); } catch { return []; }
    for (const line of lines) {
        if (!line.trim()) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        const sid = String(e.sessionId ?? "");
        if (!sid) continue;
        if (e.eventType === "llm.request") {
            if (bySession.has(sid)) continue;
            const m = e.metadata ?? {};
            bySession.set(sid, { session: sid, depth: Number(m.depth ?? 0), toolsHash: m.toolsHash, sysHash: m.sysHash, ts: e.timestamp ?? "", r1Real: undefined, r1Hit: undefined });
        } else if (e.eventType === "llm.response") {
            const row = bySession.get(sid);
            if (row && row.r1Real == null) {
                row.r1Real = e.usage?.prompt_tokens;
                row.r1Hit = e.usage?.prompt_cache_hit_tokens;
            }
        }
    }
    // 只要有指纹字段的才算有效行（旧 trace 无埋点）
    return [...bySession.values()].filter(r => r.toolsHash);
};

/** 长 sessionId 压缩显示：主 id 取前 8 位，子段以 sub: 前缀接在父后（108f0b89>sub:43475a5c） */
const shortId = (sid: string): string => {
    const [head, ...subs] = sid.split("__sub__");
    return [head.slice(0, 8), ...subs.map(s => `sub:${s.slice(0, 8)}`)].join(">");
};

walk(TRACE_ROOT);
// 剔除 selftest 会话（selftest-traced 等受控实验，混入会污染 toolsHash 分布统计，同 cache-by-round 惯例）
for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].session.startsWith("selftest-")) rows.splice(i, 1);
}
if (rows.length === 0) { console.log("暂无带指纹的 trace（埋点后产生的新会话才会有）。跑几个真实会话后再来。"); process.exit(0); }

console.log("session（每 run 首个 request）    depth  toolsHash   sysHash     首轮命中");
console.log("-".repeat(92));
for (const r of rows) {
    const hit = r.r1Real ? `${r.r1Hit}/${r.r1Real} (${Math.round((r.r1Hit! / r.r1Real) * 100)}%)` : "?";
    console.log(`${shortId(r.session).padEnd(34)} ${`d${r.depth}`.padEnd(6)} ${(r.toolsHash ?? "").padEnd(11)} ${(r.sysHash ?? "").padEnd(11)} ${hit}`);
}
// toolsHash 分布按 depth 分组：主/子代理工具表天然不同，混在一起统计会把设计差异误报成「工具表分歧」
for (const d of [...new Set(rows.map(r => r.depth))].sort((a, b) => a - b)) {
    const rs = rows.filter(r => r.depth === d);
    const byTools = new Map<string, number>();
    for (const r of rs) byTools.set(r.toolsHash!, (byTools.get(r.toolsHash!) ?? 0) + 1);
    console.log(`\ndepth ${d}（${rs.length} 个 run）toolsHash 分布:`, [...byTools.entries()].map(([h, n]) => `${h}×${n}`).join(", "));
}
console.log(`\n判读：同 depth 内 toolsHash 多值=工具表分歧（嫌疑①）；sysHash 多值=system 注入漂移（嫌疑②）；全同仍低命中=DS 端驱逐（嫌疑③）。`);

// —— 时间序视角（2026-09-15 取证后常设）：同指纹组内「首现 vs 后续」的命中规律 ——
//   经验规律（2026-09-08~09-14 实测）：组内 #1 命中 0-15%（付全价+写缓存），#2 起 96-99%；
//   间隔 ~39h+ 出现驱逐（#N=0% 后紧邻 #N+1 又恢复高命中）。首行即低命中且时间紧邻上一行 → 查指纹分歧，不是 TTL。
rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
const seen = new Map<string, number>();
console.log(`\n时间序（fresh-session 取证主视角；key 含 depth，主/子指纹天然不同组不算漂移）`);
console.log("时间序                 d  指纹组(tools/sys)       组内序  首轮命中");
console.log("-".repeat(92));
for (const r of rows) {
    const key = `${r.toolsHash}/${r.sysHash}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const pct = r.r1Real ? `${Math.round((r.r1Hit! / r.r1Real) * 100)}%` : "?";
    console.log(`${String(r.ts).slice(0, 19).padEnd(23)} ${String(r.depth).padEnd(2)} ${key.padEnd(24)} ${`#${n}`.padEnd(8)} ${pct}  (${r.r1Hit ?? "?"}/${r.r1Real ?? "?"})`);
}
