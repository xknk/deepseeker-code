/**
 * @file scripts/round-attribution.ts
 * @description 轮数浪费归因（成本信任链 D3 可选项落地）：读 transcript 按「同文件连续编辑 / 同参重试 /
 *  重复检索」给每轮打标，统计浪费轮占比——为轮数归因供数（usage-report 给轮数总量，本脚本给质量分布）。
 *
 *  运行：npx tsx --tsconfig src/core/tsconfig.json scripts/round-attribution.ts [--days 30] [--session <id>] [--sample]
 *
 *  ★ 打标口径（纯行为信号，不嗅探工具成败——tool-failure-consistency C 规则禁 FAILED_PREFIXES 复活）：
 *  - 同参重试：相邻（同轮内相邻 / 紧邻轮）同工具同参调用。失败后重试必然同参（成功不会再来一次），
 *    是「工具失败重试」的行为级等价信号，且不需要判成败。
 *  - 编辑切分：编辑类工具同文件，同轮内第 2+ 次（应一次规划或整写）或紧邻轮再碰（应合并轮）。
 *  - 重复检索：read_file/search_grep/glob/list_dir 同参且轮距 ≤3 重复（刚看过又看，上下文还在）。
 *  浪费轮 = 轮内含 ≥1 个打标调用。三类可叠加、分开计数，占比只做粗读——打标是候选不是判决。
 */
import fs from "fs";
import path from "path";
import { appConfig } from "@/config/index.ts";

// ============ 参数 ============

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
};
const days = Number(argOf("--days") ?? 30);
const sessionFilter = argOf("--session");
const showSample = args.includes("--sample");

// ============ 轮切分与打标 ============

interface ToolCall { name: string; key: string; round: number }
interface Round { idx: number; calls: ToolCall[]; tags: Set<string> }

/** 编辑类工具（同文件连续编辑的判定域）。 */
const EDIT_TOOLS = new Set(["edit_file", "write_file", "create_file", "move_file", "notebook_edit"]);
/** 检索类工具（重复检索的判定域）。 */
const RETRIEVAL_TOOLS = new Set(["read_file", "search_grep", "glob", "list_dir"]);
/** 重复检索的轮距窗口：刚看过又看才算（整会话去重会把正常的回头查也误伤）。 */
const REPEAT_WINDOW = 3;

/** 参数归一键：检索/命令类按语义字段（pattern/path/command），编辑类按文件，解析失败退 raw 片段。 */
const callKey = (name: string, argsJson: string): string => {
    let a: any = null;
    try { a = JSON.parse(argsJson || "{}"); } catch { /* 非法参数退 raw */ }
    if (a && typeof a === "object") {
        if (name === "search_grep") return `grep:${a.pattern ?? ""}@${a.path ?? ""}`;
        if (name === "glob") return `glob:${a.pattern ?? ""}@${a.path ?? ""}`;
        if (name === "run_command") return `cmd:${String(a.command ?? "").slice(0, 200)}`;
        if (typeof a.path === "string") return `p:${a.path}`;
    }
    return `${name}:${argsJson.slice(0, 120)}`;
};

/**
 * 解析一个 transcript，切轮并打标。
 * 轮 = assistant 消息（与 usageLog rounds 同口径）；其 tool_calls 记入该轮。
 */
const attributeTranscript = (text: string): { rounds: Round[]; samplesOf: { tag: string; round: number; call: ToolCall }[] } | null => {
    const rounds: Round[] = [];
    const allCalls: ToolCall[] = []; // 时序全量（跨轮信号用）
    const samplesOf: { tag: string; round: number; call: ToolCall }[] = []; // 肇事调用流水（--sample 输出）
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m?.dscEvent || m?.role !== "assistant") continue;
        const r: Round = { idx: rounds.length + 1, calls: [], tags: new Set() };
        rounds.push(r);
        for (const tc of m.tool_calls ?? []) {
            const name = tc?.function?.name;
            if (!name) continue;
            const call: ToolCall = { name, key: callKey(name, String(tc.function.arguments ?? "")), round: r.idx };
            r.calls.push(call);
            allCalls.push(call);
        }
    }
    if (rounds.length === 0) return null;

    // 打标 1：同参重试（同轮内相邻 / 紧邻轮跨界）
    for (let i = 1; i < allCalls.length; i++) {
        const a = allCalls[i - 1];
        const b = allCalls[i];
        if (a.name === b.name && a.key === b.key && a.key !== `${b.name}:`) {
            rounds[b.round - 1].tags.add("同参重试");
            samplesOf.push({ tag: "同参重试", round: b.round, call: b });
        }
    }
    // 打标 2：编辑切分（同轮内同文件第 2+ 次 / 紧邻轮同文件再碰）
    const editCalls = allCalls.filter((c) => EDIT_TOOLS.has(c.name));
    for (let i = 1; i < editCalls.length; i++) {
        const a = editCalls[i - 1];
        const b = editCalls[i];
        if (a.key === b.key && (b.round === a.round || b.round - a.round === 1)) {
            const tag = b.round === a.round ? "编辑切分" : "编辑跨轮";
            rounds[b.round - 1].tags.add(tag);
            samplesOf.push({ tag, round: b.round, call: b });
        }
    }
    // 打标 3：重复检索（同参且轮距 ≤3；同轮内相邻由打标 1 覆盖的场合这里也会命中——分开计数无害）
    for (let i = 1; i < allCalls.length; i++) {
        const b = allCalls[i];
        if (!RETRIEVAL_TOOLS.has(b.name)) continue;
        for (let j = i - 1; j >= 0 && b.round - allCalls[j].round <= REPEAT_WINDOW; j--) {
            if (allCalls[j].name === b.name && allCalls[j].key === b.key) {
                rounds[b.round - 1].tags.add("重复检索");
                samplesOf.push({ tag: "重复检索", round: b.round, call: b });
                break;
            }
        }
    }
    return { rounds, samplesOf };
};

// ============ 枚举会话 ============

const sessionsRoot = path.join(appConfig.dataDir, "sessions");
const listTranscripts = (): { project: string; sessionId: string; file: string; mtime: number }[] => {
    const out: { project: string; sessionId: string; file: string; mtime: number }[] = [];
    let projects: string[] = [];
    try { projects = fs.readdirSync(sessionsRoot); } catch { return out; }
    const cutoff = Date.now() - days * 86_400_000;
    for (const project of projects) {
        const pDir = path.join(sessionsRoot, project);
        let ids: string[] = [];
        try { ids = fs.readdirSync(pDir); } catch { continue; }
        for (const sessionId of ids) {
            if (sessionFilter && sessionId !== sessionFilter) continue;
            const file = path.join(pDir, sessionId, `${sessionId}.jsonl`);
            let st: fs.Stats;
            try { st = fs.statSync(file); } catch { continue; }
            if (st.mtimeMs < cutoff) continue;
            out.push({ project, sessionId, file, mtime: st.mtimeMs });
        }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
};

// ============ 汇总输出 ============

const padR = (s: string, n: number): string => s.padEnd(n);
const padL = (s: string, n: number): string => s.padStart(n);

interface Row { sessionId: string; rounds: number; wasted: number; editSame: number; editCross: number; retry: number; retrieval: number }

const rows: Row[] = [];
const samples: Record<string, string[]> = { "同参重试": [], "编辑切分": [], "编辑跨轮": [], "重复检索": [] };

for (const t of listTranscripts()) {
    let text: string;
    try { text = fs.readFileSync(t.file, "utf-8"); } catch { continue; }
    const r = attributeTranscript(text);
    if (!r) continue;
    const row: Row = { sessionId: t.sessionId.slice(0, 8), rounds: r.rounds.length, wasted: 0, editSame: 0, editCross: 0, retry: 0, retrieval: 0 };
    for (const rd of r.rounds) {
        if (rd.tags.size > 0) row.wasted++;
        for (const tag of rd.tags) {
            if (tag === "编辑切分") row.editSame++;
            else if (tag === "编辑跨轮") row.editCross++;
            else if (tag === "同参重试") row.retry++;
            else if (tag === "重复检索") row.retrieval++;
        }
    }
    for (const s of r.samplesOf) {
        const bucket = samples[s.tag];
        const line = `${t.sessionId.slice(0, 8)} 轮${s.round} ${s.call.name} ${s.call.key.slice(0, 60)}`;
        if (bucket && bucket.length < 3 && !bucket.includes(line)) bucket.push(line); // 同轮多次同因去重
    }
    rows.push(row);
}

const totalRounds = rows.reduce((a, r) => a + r.rounds, 0);
const totalWasted = rows.reduce((a, r) => a + r.wasted, 0);
const total = (f: (r: Row) => number): number => rows.reduce((a, r) => a + f(r), 0);

console.log(`轮数浪费归因（transcript 行为打标，最近 ${days} 天${sessionFilter ? `，会话 ${sessionFilter}` : ""}）`);
console.log("会话        轮数  浪费轮  占比   编辑切分  编辑跨轮  同参重试  重复检索");
for (const r of rows.filter((x) => x.rounds >= 3).slice(0, 30)) {
    const pct = r.rounds ? Math.round((r.wasted / r.rounds) * 100) : 0;
    console.log(
        `${padR(r.sessionId, 12)}${padL(String(r.rounds), 4)}  ${padL(String(r.wasted), 4)}  ${padL(`${pct}%`, 4)}`
        + `  ${padL(String(r.editSame), 6)}    ${padL(String(r.editCross), 6)}    ${padL(String(r.retry), 6)}    ${padL(String(r.retrieval), 6)}`,
    );
}
console.log(`${padR("总计", 12)}${padL(String(totalRounds), 4)}  ${padL(String(totalWasted), 4)}  ${padL(totalRounds ? `${Math.round((totalWasted / totalRounds) * 100)}%` : "-", 4)}`
    + `  ${padL(String(total((r) => r.editSame)), 6)}    ${padL(String(total((r) => r.editCross)), 6)}    ${padL(String(total((r) => r.retry)), 6)}    ${padL(String(total((r) => r.retrieval)), 6)}`);
if (totalRounds === 0) console.log("（无会话数据——先产生真实会话，或用 --days 放宽窗口）");
if (showSample) {
    console.log("\n样本（每类前 3，定位用）：");
    for (const [tag, list] of Object.entries(samples)) {
        if (list.length > 0) console.log(`  ${tag}: ${list.join(" | ")}`);
    }
}
console.log("\n口径：浪费轮=轮内含≥1个打标调用；打标是候选不是判决（同轮多次编辑同文件也可能是合理分步）。三类可叠加，列计数和可大于浪费轮数。");
