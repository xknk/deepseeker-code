/**
 * 缓存指纹分析：扫描全部 trace jsonl，提取每个会话首轮 llm.request 的前缀指纹与缓存命中，
 * 用于定位 fresh-session 缓存 miss 的分歧点。
 * 判读：
 *  - toolsHash 不同的会话 → 工具表分歧（env 门控漂移 / 版本迭代）——首要嫌疑；
 *  - toolsHash 同、sysHash 不同 → message[0] 注入漂移（locale/skills/memory/projectGuide）；
 *  - 全同但首轮命中低 → DS 服务端缓存 TTL/LRU 驱逐（时间间隔越久越可能），非本地问题。
 * 运行：npx tsx --tsconfig src/core/tsconfig.json scripts/cache-fingerprint-report.ts
 */
import fs from "fs";
import path from "path";
import os from "os";

const TRACE_ROOT = path.join(os.homedir(), ".deepseeker-code", "trace");
if (!fs.existsSync(TRACE_ROOT)) { console.log("trace 目录不存在"); process.exit(0); }

type Row = { session: string; file: string; toolsHash?: string; sysHash?: string; r1Real?: number; r1Hit?: number; ts: string };
const rows: Row[] = [];

const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) rows.push(...parseFile(p));
    }
};

const parseFile = (file: string): Row[] => {
    const out: Row[] = [];
    let cur: Row | null = null;
    let started = false;   // 只取每文件首个 llm.request（= round 1），round 2+ 不另立行
    let lines: string[] = [];
    try { lines = fs.readFileSync(file, "utf-8").split("\n"); } catch { return out; }
    for (const line of lines) {
        if (!line.trim()) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        if (e.eventType === "llm.request") {
            if (started) continue;
            started = true;
            const m = e.metadata ?? {};
            cur = { session: path.basename(path.dirname(file)), file: path.basename(file), toolsHash: m.toolsHash, sysHash: m.sysHash, ts: e.timestamp ?? "", r1Real: undefined, r1Hit: undefined };
        } else if (e.eventType === "llm.response" && cur && cur.r1Real == null) {
            cur.r1Real = e.usage?.prompt_tokens;
            cur.r1Hit = e.usage?.prompt_cache_hit_tokens;
        }
    }
    if (cur) out.push(cur);
    // 只要有指纹字段的才算有效行（旧 trace 无埋点）
    return out.filter(r => r.toolsHash);
};

walk(TRACE_ROOT);
// 剔除 selftest 会话（selftest-traced 等受控实验，混入会污染 toolsHash 分布统计，同 cache-by-round 惯例）
for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].session.startsWith("selftest-")) rows.splice(i, 1);
}
if (rows.length === 0) { console.log("暂无带指纹的 trace（埋点后产生的新会话才会有）。跑几个真实会话后再来。"); process.exit(0); }

console.log("session（首轮 request）                       toolsHash   sysHash     首轮命中");
console.log("-".repeat(88));
for (const r of rows) {
    const hit = r.r1Real ? `${r.r1Hit}/${r.r1Real} (${Math.round((r.r1Hit! / r.r1Real) * 100)}%)` : "?";
    console.log(`${r.session.slice(0, 40).padEnd(42)} ${r.toolsHash.padEnd(11)} ${r.sysHash.padEnd(11)} ${hit}`);
}
const byTools = new Map<string, number>();
for (const r of rows) byTools.set(r.toolsHash!, (byTools.get(r.toolsHash!) ?? 0) + 1);
console.log(`\n共 ${rows.length} 个带指纹会话；toolsHash 分布:`, [...byTools.entries()].map(([h, n]) => `${h}×${n}`).join(", "));
console.log("判读：toolsHash 多值=工具表分歧（嫌疑①）；sysHash 多值=system 注入漂移（嫌疑②）；全同仍低命中=DS 端驱逐（嫌疑③）。");

// —— 时间序视角（2026-09-15 取证后常设）：同指纹组内「首现 vs 后续」的命中规律 ——
//   经验规律（2026-09-08~09-14 实测）：组内 #1 命中 0-15%（付全价+写缓存），#2 起 96-99%；
//   间隔 ~39h+ 出现驱逐（#N=0% 后紧邻 #N+1 又恢复高命中）。首行即低命中且时间紧邻上一行 → 查指纹分歧，不是 TTL。
rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
const seen = new Map<string, number>();
console.log(`\n时间序（fresh-session 取证主视角）`);
console.log("时间序                 指纹组(tools/sys)       组内序  首轮命中");
console.log("-".repeat(90));
for (const r of rows) {
    const key = `${r.toolsHash}/${r.sysHash}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const pct = r.r1Real ? `${Math.round((r.r1Hit! / r.r1Real) * 100)}%` : "?";
    console.log(`${String(r.ts).slice(0, 19).padEnd(23)} ${key.padEnd(24)} ${`#${n}`.padEnd(8)} ${pct}  (${r.r1Hit ?? "?"}/${r.r1Real ?? "?"})`);
}
