/**
 * 本地使用日志报告（后续路线 #6「真实使用数据回路」）：跨会话/跨项目聚合日常真实负载——
 * 按天 runs/中止率/轮数/token/缓存命中/折算成本 + 工具分布 + 轮数分布 + 停止原因 + 项目分布。
 * 定位：evals 测「能不能」（合成考卷），本报告测「日常省不省」（真实负载）；两者互补构成测量优先地基。
 * 数据源：<dataDir>/usage/usage-YYYY-MM.jsonl（recordUsageRun 每 run 一行，纯本地）；
 *        selftest- 与 eval- 前缀的受控实验会话已在 readUsageRecords 读侧剔除。
 * 运行：npx tsx --tsconfig src/core/tsconfig.json scripts/usage-report.ts [--days 30]
 * 成本口径：PRICE_TABLE 单价常量表（与 task.eval.ts 同源同纪律：换价两处同步改）；近似口径看相对变化勿当账单。
 */
import { readUsageRecords, summarizeUsage, topTools, type UsageRunRecord } from "@/observability/usageLog.ts";

// —— 折算成本（美分）：与 src/core/tests/evals/task.eval.ts PRICE_TABLE 保持同价，换价两处同步改 ——
const PRICE_TABLE: Record<string, { miss: number; hit: number; output: number }> = {
    'deepseek-chat': { miss: 0.28, hit: 0.028, output: 0.42 },
    'deepseek-flash': { miss: 0.28, hit: 0.028, output: 0.42 }, // 占位：暂按 chat 档，官网出价后校准
};
const DEFAULT_PRICE = PRICE_TABLE['deepseek-chat']!;
/** 单 run 折算成本（美分）：(prompt−cached)×miss + cached×hit + completion×output */
const costCents = (r: UsageRunRecord): number => {
    const p = PRICE_TABLE[r.model] ?? DEFAULT_PRICE;
    const miss = Math.max(0, (r.promptTokens ?? 0) - (r.cachedTokens ?? 0));
    return ((miss * p.miss + (r.cachedTokens ?? 0) * p.hit + (r.completionTokens ?? 0) * p.output) / 1e6) * 100;
};

const fmt = (n: number): string => n.toLocaleString("en-US");
const padL = (s: string, w: number): string => s.padStart(w);
const padR = (s: string, w: number): string => s.padEnd(w);

// ==================== 参数 ====================
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > -1 ? Math.max(1, Number(process.argv[daysArg + 1]) || 30) : 30;

const records = await readUsageRecords(DAYS);
if (records.length === 0) {
    console.log(`近 ${DAYS} 天暂无使用日志记录（使用日志自本版本起累积，每 run 结束时落盘；跑几个真实会话后再来）。`);
    process.exit(0);
}

const total = summarizeUsage(records);
console.log(`本地使用日志报告（近 ${DAYS} 天 · ${total.firstTs?.slice(0, 16)} ~ ${total.lastTs?.slice(0, 16)}）`);
console.log(`runs ${total.runs}（主 ${total.mainRuns} / 子 ${total.subRuns}）· 主 run 轮数合计 ${total.mainRounds}（均 ${(total.mainRounds / Math.max(1, total.mainRuns)).toFixed(1)} 轮/run）· 全量 ${fmt(total.totalTokens)} tok`);
console.log("-".repeat(118));

// ==================== 按天表（token/成本=全量口径含子 agent；runs/轮数/中止=主 run 口径） ====================
const byDay = new Map<string, UsageRunRecord[]>();
for (const r of records) {
    const day = String(r.ts).slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(r);
    byDay.set(day, arr);
}
console.log("日期          runs  中止%   轮数(均/run)   prompt      cached     输出       ≈成本¢  常用工具(top3)");
let sumCost = 0;
for (const [day, rs] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = summarizeUsage(rs);
    const cost = rs.reduce((sum, r) => sum + costCents(r), 0);
    sumCost += cost;
    const abortPct = s.mainRuns ? Math.round((s.stopReasons.aborted / s.mainRuns) * 100) : 0;
    const avg = s.mainRuns ? (s.mainRounds / s.mainRuns).toFixed(1) : "0";
    const tools = topTools(s.tools, 3).map(([n, c]) => `${n}×${c}`).join(" ");
    console.log(
        `${day}  ${padL(String(s.mainRuns), 4)}  ${padL(`${abortPct}%`, 4)}  ` +
        `${padL(String(s.mainRounds), 4)} (${padL(avg, 4)})  ${padL(fmt(s.promptTokens), 10)}  ${padL(fmt(s.cachedTokens), 10)}  ${padL(fmt(s.completionTokens), 8)}  ${padL(cost.toFixed(1), 6)}  ${tools}`,
    );
}
console.log("-".repeat(118));
const totalCost = sumCost;
const hitRate = total.promptTokens ? ((total.cachedTokens / total.promptTokens) * 100).toFixed(1) : "0.0";
console.log(
    `${padR("总计", 10)}  ${padL(String(total.mainRuns), 4)}  ${padL(`${total.mainRuns ? Math.round((total.stopReasons.aborted / total.mainRuns) * 100) : 0}%`, 4)}  ` +
    `${padL(String(total.mainRounds), 4)} (${padL((total.mainRounds / Math.max(1, total.mainRuns)).toFixed(1), 4)})  ${padL(fmt(total.promptTokens), 10)}  ${padL(fmt(total.cachedTokens), 10)}  ${padL(fmt(total.completionTokens), 8)}  ${padL(totalCost.toFixed(1), 6)}`
);
console.log(`缓存命中合计：${hitRate}%（cached/prompt）；成本为近似口径（PRICE_TABLE 占价值，看相对变化勿当账单）。`);

// ==================== 轮数分布（主 run）：碎步任务 prevalence 的一把尺 ====================
const mainRuns = records.filter(r => r.depth === 0);
const bucket = (n: number): string => (n <= 1 ? "1轮" : n <= 3 ? "2-3轮" : n <= 6 ? "4-6轮" : n <= 10 ? "7-10轮" : ">10轮");
const buckets = new Map<string, number>();
for (const r of mainRuns) {
    const b = bucket(r.rounds);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
}
const bucketOrder = ["1轮", "2-3轮", "4-6轮", "7-10轮", ">10轮"];
console.log(`\n轮数分布（主 run ×${mainRuns.length}）：` + bucketOrder.map(b => `${b} ×${buckets.get(b) ?? 0}`).join(" | "));

// ==================== 工具分布 / 停止原因 / 项目分布 ====================
console.log(`工具分布 top10（全部 run，模型请求口径）：` + topTools(total.tools, 10).map(([n, c]) => `${n}×${c}`).join(", "));
const stopLine = (Object.entries(total.stopReasons) as [string, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${k} ×${n}`).join(" · ");
console.log(`停止原因（主 run）：${stopLine}`);
const byWs = new Map<string, number>();
for (const r of records) byWs.set(r.workspace, (byWs.get(r.workspace) ?? 0) + 1);
console.log(`项目分布（全部 run）：` + [...byWs.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ×${n}`).join(", "));

// ==================== 判读提示 ====================
console.log(`
判读：
- 中止率高（>30%）→ 打断频繁：用户主动纠偏属正常；等待审批不耐烦则优化审批面（/auto）。
- 平均轮数上升 → 先对照 npm run evals:task 基线，区分「任务变难」还是「轮数退化」。
- 缓存命中率走低 → 查指纹漂移：npx tsx --tsconfig src/core/tsconfig.json scripts/cache-fingerprint-report.ts`);
