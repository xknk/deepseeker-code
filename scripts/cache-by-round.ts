/**
 * 缓存命中率 × 对话阶段分析：把全部 trace 的 llm.response 按会话聚合、按时间排序，
 * 分三个桶统计首轮缓存命中率——
 *  coldStart ：会话首个 llm.response（首次发文，固定前缀首次进缓存）；
 *  newRun    ：round=1 但非会话首个（用户在同一会话发了新指令 → 跨 run 续接，
 *              命中高=buildContextMessages 跨 run 重建字节稳定；命中低=有源漂移击穿）；
 *  midRun    ：round≥2（run 内续轮，增量命中，理论上应最高）。
 * 运行：npx tsx --tsconfig src/core/tsconfig.json scripts/cache-by-round.ts
 */
import fs from "fs";
import path from "path";
import os from "os";

const TRACE_ROOT = path.join(os.homedir(), ".deepseeker-code", "trace");
type Ev = { session: string; ts: number; round: number; prompt: number; hit: number };
const events: Ev[] = [];

const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) parseFile(p);
    }
};

const parseFile = (file: string) => {
    let lines: string[] = [];
    try { lines = fs.readFileSync(file, "utf-8").split("\n"); } catch { return; }
    const session = path.basename(path.dirname(file));
    for (const line of lines) {
        if (!line.includes('"llm.response"')) continue;
        let e: any; try { e = JSON.parse(line); } catch { continue; }
        const u = e.usage ?? {};
        if (!u.prompt_tokens) continue;
        events.push({
            session,
            ts: Date.parse(e.timestamp ?? "") || 0,
            round: e.metadata?.round ?? 0,
            prompt: u.prompt_tokens,
            hit: u.prompt_cache_hit_tokens ?? 0,
        });
    }
};

walk(TRACE_ROOT);
// 按会话聚合 + 时间排序，剔除我打的 selftest 会话（受控实验，不代表真实负载）
const bySession = new Map<string, Ev[]>();
for (const e of events) {
    if (e.session.startsWith("selftest-")) continue;
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session)!.push(e);
}

type Bucket = { n: number; prompt: number; hit: number; ratios: number[] };
const mkBucket = (): Bucket => ({ n: 0, prompt: 0, hit: 0, ratios: [] });
const buckets: Record<string, Bucket> = { coldStart: mkBucket(), newRun: mkBucket(), midRun: mkBucket() };

for (const [, evs] of bySession) {
    evs.sort((a, b) => a.ts - b.ts);
    evs.forEach((e, i) => {
        const b = i === 0 ? buckets.coldStart : (e.round === 1 ? buckets.newRun : buckets.midRun);
        b.n++; b.prompt += e.prompt; b.hit += e.hit;
        b.ratios.push(e.prompt ? e.hit / e.prompt : 0);
    });
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const stat = (name: string, b: Bucket) => {
    if (b.n === 0) { console.log(`${name.padEnd(10)} 无样本`); return; }
    const sorted = [...b.ratios].sort((a, x) => a - x);
    const median = sorted[Math.floor(sorted.length / 2)];
    const low = sorted.filter(r => r < 0.5).length;
    const missed = ((b.prompt - b.hit) / 1000).toFixed(0);
    console.log(`${name.padEnd(10)} 轮数=${String(b.n).padStart(5)}  加权命中=${pct(b.hit / b.prompt).padStart(7)}  中位=${pct(median).padStart(7)}  低命中轮占比=${pct(low / b.n).padStart(6)}  miss绝对量=${missed}K tok`);
};
console.log(`共 ${bySession.size} 个真实会话、${events.filter(e => !e.session.startsWith("selftest-")).length} 轮 llm.response\n`);
console.log("阶段        样本      加权命中率   中位命中率   低命中轮占比   miss绝对量");
console.log("-".repeat(78));
stat("coldStart", buckets.coldStart);
stat("newRun", buckets.newRun);
stat("midRun", buckets.midRun);
console.log("\n判读：midRun 应≈99%+（run 内增量）；newRun 低 → 跨 run 重建存在字节漂移（记忆/技能目录/locale 等），是后续对话唯一的优化面；coldStart 低属已知（版本/env/目录漂移击穿固定块）。");

// —— newRun 明细钻取：每个 run 边界一行，看低命中是系统性还是集中在个别会话/时点 ——
console.log("\nnewRun 明细（run 边界逐条）：");
console.log("session(前20)".padEnd(22) + "时间".padEnd(21) + "prompt".padStart(8) + "  命中率");
for (const [sess, evs] of [...bySession.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    evs.sort((a, b) => a.ts - b.ts);
    evs.forEach((e, i) => {
        if (i === 0 || e.round !== 1) return;
        const t = new Date(e.ts).toISOString().slice(5, 19).replace("T", " ");
        const bar = "█".repeat(Math.round((e.hit / e.prompt) * 20));
        console.log(`${sess.slice(0, 20).padEnd(22)}${t.padEnd(21)}${String(e.prompt).padStart(8)}  ${pct(e.hit / e.prompt).padStart(6)} ${bar}`);
    });
}
