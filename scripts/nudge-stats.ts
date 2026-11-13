/**
 * nudge 计量报表（T1，施工单 2026-11-13 §2.7）：读 <dataDir>/trace/ 全量 JSONL，按 fence 聚合
 * nudge.injected 事件，出「fence × injected × disposition」计数表。
 * 用途：① 机制台账的季度复核入口（连续 90 天 0 次 → 候选删除判据的数据源）；
 *      ② VERIFY_UNPROVEN Gate 决策矩阵（施工单 §5）的唯一统计口径——
 *        would_fire 率 = fired/(fired+verified+disclaimed)，免责吃掉比例 = disclaimed/(fired+disclaimed)。
 * 手动跑，不进 CI：npx tsx --tsconfig src/core/tsconfig.json scripts/nudge-stats.ts
 * 旁路数据容错：坏行/坏文件跳过不计（trace 是旁路 JSONL，允许尾部半行）。
 */
import fs from "fs";
import path from "path";
import { getTracePath } from "@/observability/store.ts";

/** 递归收集 trace 目录下全部 .jsonl（结构：trace/<workspace>/<主会话id>/*.jsonl，子 run 共写主文件）。 */
const listJsonl = (dir: string, out: string[] = []): string[] => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const ent of ents) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) listJsonl(abs, out);
        else if (ent.name.endsWith(".jsonl")) out.push(abs);
    }
    return out;
};

type Row = { fence: string; injected: boolean; disposition: string };
const rows: Row[] = [];
for (const file of listJsonl(getTracePath())) {
    let text: string;
    try { text = fs.readFileSync(file, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const e = JSON.parse(line);
            if (e?.eventType === "nudge.injected") {
                rows.push({ fence: String(e?.metadata?.fence ?? "UNKNOWN"), injected: !!e?.metadata?.injected, disposition: String(e?.metadata?.disposition ?? "-") });
            }
        } catch { /* 坏行跳过（旁路 JSONL 允许尾部半行） */ }
    }
}

if (rows.length === 0) {
    console.log("暂无 nudge.injected 事件（计量埋点自 2026-11-13 起累积；跑几个真实会话后再来）。");
    process.exit(0);
}

const padR = (s: string, w: number): string => s.padEnd(w);
const padL = (s: string, w: number): string => s.padStart(w);

// —— 表 1：按 fence × injected 聚合（机制台账复核口径：连续 90 天 0 次 → 候选删除）——
const byFence = new Map<string, { fire: number; dry: number }>();
for (const r of rows) {
    const cell = byFence.get(r.fence) ?? { fire: 0, dry: 0 };
    if (r.injected) cell.fire++; else cell.dry++;
    byFence.set(r.fence, cell);
}
console.log(`nudge.injected 计量报表（共 ${rows.length} 条，trace 根 = ${getTracePath()}）`);
console.log("");
console.log("【按 fence】（fired=true 真注入 / dry=false 本该注入或已解除）");
console.log(padR("fence", 20) + padL("injected:true", 14) + padL("injected:false", 15) + padL("合计", 8));
for (const [fence, c] of [...byFence.entries()].sort((a, b) => (b.fire + b.dry) - (a.fire + a.dry))) {
    console.log(padR(fence, 20) + padL(String(c.fire), 14) + padL(String(c.dry), 15) + padL(String(c.fire + c.dry), 8));
}

// —— 表 2：VERIFY_UNPROVEN 按 disposition 聚合（Gate 决策矩阵口径，施工单 §5）——
const v = rows.filter((r) => r.fence === "VERIFY_UNPROVEN");
const disp = { fired: 0, verified: 0, disclaimed: 0 } as Record<string, number>;
for (const r of v) if (r.disposition in disp) disp[r.disposition]!++;
console.log("");
console.log("【VERIFY_UNPROVEN Gate 口径】");
if (v.length === 0) {
    console.log("  暂无 VERIFY_UNPROVEN 事件（dry 档跑真实改码会话后累积）。");
} else {
    const total = disp.fired! + disp.verified! + disp.disclaimed!;
    const wouldFire = total > 0 ? disp.fired! / total : 0;
    const disclaimShare = (disp.fired! + disp.disclaimed!) > 0 ? disp.disclaimed! / (disp.fired! + disp.disclaimed!) : 0;
    console.log(`  fired=${disp.fired}  verified=${disp.verified}  disclaimed=${disp.disclaimed}`);
    console.log(`  would_fire 率   = ${disp.fired}/${total} = ${(wouldFire * 100).toFixed(1)}%   （Gate：≥10% 开 / 5%~10% 再观察 / <5% 砍判定）`);
    console.log(`  免责吃掉比例    = ${disp.disclaimed}/${disp.fired + disp.disclaimed} = ${(disclaimShare * 100).toFixed(1)}%   （≥80% → 只留 dry）`);
    console.log("  裁决动作写进 .ai-docs/机制台账.md 的 VERIFY_UNPROVEN 行（勿凭单日数据下结论，需跑满一周）。");
}
