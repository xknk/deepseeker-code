/**
 * 取证：历史轮 reasoning_content 在 prompt 中的占比（DS thinking 模式工具轮回传协议的成本面）。
 *
 *  背景：V4 thinking 模式下含工具调用的 assistant 轮必须完整回传 reasoning_content，否则 API 400。
 *  「裁剪历史 reasoning 只留最近一轮」直觉上省钱，但在 DS 隐式前缀缓存下历史 reasoning 一旦进过前缀
 *  即 cache hit（1/10 价），贸然裁剪反而从被裁消息起击穿整个后缀——唯一净赚场景是「冷恢复全量
 *  re-prefill」。本脚本量化真实会话里它的体量，给「是否值得做协议最小回传集探针」提供依据。
 *
 *  口径（字符近似 token；reasoning 偏散文、历史混结构，作占比判定足够）：
 *   - lastView : 活动窗口（最后一次 compaction 归档边界之后）的静态构成占比——最后一轮 prompt 的样子；
 *   - burden   : 跨轮重发负担占比——活动窗口内每条消息按「其后的推理轮数」加权（窗口内第 i 条会被
 *                后续 N-i 轮反复携带），等价于逐轮占比的按轮平均。压缩归档的消息不再重发，不计。
 *  运行：npx tsx --tsconfig src/core/tsconfig.json scripts/reasoning-share.ts
 */
import fs from "fs";
import path from "path";
import os from "os";

const DATA_DIR = process.env.DEEPSEEKER_CODE_DATA_DIR || path.join(os.homedir(), ".deepseeker-code");
const SESSIONS_ROOT = path.join(DATA_DIR, "sessions");

const lenOf = (v: any): number => (typeof v === "string" ? v.length : 0);

/** 消息的「进 prompt 字符量」：文本视图 + 工具调用参数（多模态 image part 不计，另计数量提示失真）。 */
const msgChars = (m: any): { chars: number; images: number; reasoning: number } => {
    let chars = 0;
    let images = 0;
    const c = m.content;
    if (typeof c === "string") chars += c.length;
    else if (Array.isArray(c)) {
        for (const p of c) {
            if (typeof p?.text === "string") chars += p.text.length;
            else if (p?.image_url) images++;
        }
    }
    if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) chars += lenOf(tc?.function?.name) + lenOf(tc?.function?.arguments);
    }
    chars += lenOf(m.tool_call_id) + lenOf(m.name);
    const reasoning = m.role === "assistant" ? lenOf(m.reasoning_content) : 0;
    return { chars, images, reasoning };
};

type SessionStat = {
    session: string;
    msgs: number;
    assistants: number;
    compacted: boolean;
    reasoningChars: number;
    totalChars: number;
    lastViewRatio: number;
    burdenRatio: number;
    images: number;
};

const stats: SessionStat[] = [];

const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) parseFile(p, e.name.replace(/\.jsonl$/, ""));
    }
};

const parseFile = (file: string, session: string) => {
    let lines: any[] = [];
    try {
        lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => {
            try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
    } catch { return; }
    // 活动窗口 = 最后一次 compaction 事件后的消息（与 buildContextMessages 的 archivedMessageCount 切片同向）
    let archived = 0;
    for (const l of lines) if (l?.dscEvent === "compaction" && typeof l.archivedMessageCount === "number") archived = l.archivedMessageCount;
    const compacted = lines.some((l) => l?.dscEvent === "compaction");
    const msgs = lines.filter((l) => typeof l?.role === "string").slice(archived);
    if (msgs.length === 0) return;

    // 逐消息量化 + 跨轮重发加权：窗口内第 i 条消息会被其后每轮推理携带（近似 N-i 轮）
    const n = msgs.length;
    let reasoningChars = 0;
    let totalChars = 0;
    let weightedReasoning = 0;
    let weightedTotal = 0;
    let images = 0;
    let assistants = 0;
    for (let i = 0; i < n; i++) {
        const { chars, images: img, reasoning } = msgChars(msgs[i]);
        totalChars += chars + reasoning;           // 总量含 reasoning（占比 = reasoning / 实际进 prompt 的全部）
        reasoningChars += reasoning;
        weightedTotal += (chars + reasoning) * (n - i);
        weightedReasoning += reasoning * (n - i);
        images += img;
        if (msgs[i].role === "assistant") assistants++;
    }
    stats.push({
        session,
        msgs: n,
        assistants,
        compacted,
        reasoningChars,
        totalChars,
        lastViewRatio: totalChars > 0 ? reasoningChars / totalChars : 0,
        burdenRatio: weightedTotal > 0 ? weightedReasoning / weightedTotal : 0,
        images,
    });
};

if (!fs.existsSync(SESSIONS_ROOT)) {
    console.log(`未找到会话目录：${SESSIONS_ROOT}`);
    process.exit(0);
}
walk(SESSIONS_ROOT);

// 过滤受控实验会话（selftest-*，不代表真实负载）
const real = stats.filter((s) => !s.session.startsWith("selftest-"));
if (real.length === 0) { console.log("无真实会话样本"); process.exit(0); }

const withReasoning = real.filter((s) => s.reasoningChars > 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const kChars = (x: number) => `${(x / 1000).toFixed(0)}K`;

console.log(`共 ${real.length} 个真实会话（活动窗口口径），其中 ${withReasoning.length} 个含 reasoning_content（thinking 模式工具轮）\n`);

// 聚合（按会话体量加权，突出大上下文会话的成本面）
const agg = (rows: SessionStat[], key: "lastViewRatio" | "burdenRatio") => {
    const wTotal = rows.reduce((a, s) => a + s.totalChars, 0);
    if (wTotal === 0) return 0;
    if (key === "lastViewRatio") return rows.reduce((a, s) => a + s.reasoningChars, 0) / wTotal;
    return rows.reduce((a, s) => a + s.burdenRatio * s.totalChars, 0) / wTotal;
};
console.log("口径            全体会话(体量加权)   仅含思考会话(体量加权)   中位");
console.log("-".repeat(72));
const median = (rows: SessionStat[], key: "lastViewRatio" | "burdenRatio") => {
    const v = rows.map((s) => s[key]).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
};
console.log(`lastView       ${pct(agg(real, "lastViewRatio")).padStart(10)}      ${pct(agg(withReasoning, "lastViewRatio")).padStart(10)}      ${pct(median(withReasoning, "lastViewRatio"))}`);
console.log(`burden(重发)   ${pct(agg(real, "burdenRatio")).padStart(10)}      ${pct(agg(withReasoning, "burdenRatio")).padStart(10)}      ${pct(median(withReasoning, "burdenRatio"))}`);

// 明细：体量足够的会话（assistants≥5，滤掉 2-4 轮小会话的噪声）按「绝对重发成本」降序前 15
const heavy = withReasoning.filter((s) => s.assistants >= 5);
console.log(`\n明细（≥5 个 assistant 轮的会话共 ${heavy.length} 个，按绝对重发成本降序前 15；压缩会话标 [C]）:`);
console.log("session(前28)".padEnd(30) + "消息".padStart(5) + "assistant".padStart(10) + "reasoning".padStart(11) + "总量".padStart(8) + "  lastView  burden");
for (const s of [...heavy].sort((a, b) => b.burdenRatio * b.totalChars - a.burdenRatio * a.totalChars).slice(0, 15)) {
    console.log(
        `${(s.compacted ? "[C]" : "   ") + s.session.slice(0, 25).padEnd(28).padStart(28)}` +
        `${String(s.msgs).padStart(5)}${String(s.assistants).padStart(10)}${kChars(s.reasoningChars).padStart(11)}${kChars(s.totalChars).padStart(8)}` +
        `  ${pct(s.lastViewRatio).padStart(8)}  ${pct(s.burdenRatio).padStart(6)}`,
    );
}

console.log("\n判读：burden(重发) 是「缓存命中时历史 reasoning 每轮的实际占比」（×1/10 价后为真实成本面）；");
console.log("lastView/burden 仅在「冷恢复全量 re-prefill」时按 miss 价全额生效。若 burden < 15%，裁剪历史");
console.log("reasoning 的收益盖不过前缀击穿（从被裁消息起全 re-prefill），维持现状不动；若显著 > 15%，");
console.log("再与 DS 协议确认「最小回传集」（是否可只回传当前 turn 的 reasoning_content）。");
