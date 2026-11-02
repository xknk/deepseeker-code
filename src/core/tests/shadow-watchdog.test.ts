/**
 * @file tests/shadow-watchdog.test.ts
 * @description 交互空转影子看门狗（shadowWatchdog）守门测试（影子方案 §9）：零干预零成本红线——
 *  强命中只记日志且「注入 auxAdjudicate 也不得被调」；强命中 5 分钟抑制窗、弱信号不抑制；
 *  日志行 schema；开关关闭零实例；host 接线锚点源码扫描（kernel-audit 既有风格）。
 *
 *  假时钟 + 手动 tick + writeLine 注入捕获（默认走文件，另设真文件落盘一例），禁真 sleep。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { ShadowLogLine, ShadowWatchdogOpts } from "@/agent/shadowWatchdog.ts";

const { ShadowWatchdog, shadowEnabled } = await import("@/agent/shadowWatchdog.ts");

const MIN = 60_000;

// ============ 测试具构：假时钟 + no-op 调度器 + writeLine 捕获 ============

interface Harness {
    shadow: InstanceType<typeof ShadowWatchdog>;
    lines: ShadowLogLine[];
    nowMs: () => number;
    advance: (min: number) => void;
}

const makeShadow = (over: Partial<ShadowWatchdogOpts> & { auxCalls?: string[] } = {}): Harness => {
    let cur = 1_000_000_000_000; // 假时钟起点（epoch ms）
    const lines: ShadowLogLine[] = [];
    const auxCalls = over.auxCalls ?? [];
    const shadow = new ShadowWatchdog({
        sessionId: "shadow-test",
        sampleDiff: async () => ({ net: 100, newFiles: [] }),
        writeLine: (line) => lines.push(line),
        now: () => cur,
        schedule: () => () => {}, // no-op：测试手动驱动 tick
        // 刻意注入 AUX mock：红线断言「影子永不调小模型」——实现里没有任何消费点
        auxAdjudicate: async (prompt) => { auxCalls.push(prompt); return "{}"; },
        ...over,
    } as ShadowWatchdogOpts);
    shadow.start();
    return { shadow, lines, nowMs: () => cur, advance: (min: number) => { cur += min * MIN; } };
};

/** 标准事件形状：R1 强信号（同参 edit_file ×3 跨 2 轮）在当前假时刻喂入。 */
const feedR1 = (h: Harness): void => {
    h.shadow.feed({ type: "round.start", round: 1 });
    h.shadow.feed({ type: "tool.start", toolCallId: "c1", toolName: "edit_file", args: { path: "src/a.ts", old_str: "x", new_str: "y" } });
    h.shadow.feed({ type: "tool.start", toolCallId: "c2", toolName: "edit_file", args: { path: "src/a.ts", old_str: "x", new_str: "y" } });
    h.shadow.feed({ type: "round.start", round: 2 });
    h.shadow.feed({ type: "tool.start", toolCallId: "c3", toolName: "edit_file", args: { path: "src/a.ts", old_str: "x", new_str: "y" } });
};

/** 心跳事件：只刷新 lastEventAt（R3 面不触发），不产生工具记录。 */
const beat = (h: Harness): void => h.shadow.feed({ type: "text.delta", text: "…" });

// ============ 零干预零成本红线 ============

test("强命中只记日志：R1 → strong 行；注入 auxAdjudicate 也零调用（零 API 成本硬承诺）", async () => {
    const auxCalls: string[] = [];
    const h = makeShadow({ auxCalls });
    h.advance(6); // 过起步宽限
    feedR1(h);
    await h.shadow.tick();
    assert.equal(h.lines.length, 1);
    assert.equal(h.lines[0].kind, "strong");
    assert.deepEqual(h.lines[0].rules, ["R1"]);
    assert.match(h.lines[0].evidence, /同参数调用 3 次/);
    assert.equal(auxCalls.length, 0, "影子期零 API 成本：注入的 auxAdjudicate 不得被调");
    // 多 tick 复核：继续活跃事件流，仍零 AUX 调用
    h.advance(6);
    feedR1(h);
    await h.shadow.tick();
    assert.equal(auxCalls.length, 0);
});

test("强命中 5 分钟抑制窗：同一 episode 只记一行；窗过期后新 episode 再记", async () => {
    const h = makeShadow();
    h.advance(6);
    feedR1(h);
    await h.shadow.tick(); // strong 行 #1，抑制窗至 11min
    h.advance(1);
    beat(h);
    await h.shadow.tick(); // 抑制窗内 → 不记
    h.advance(1);
    beat(h);
    await h.shadow.tick(); // 抑制窗内 → 不记
    assert.equal(h.lines.length, 1, "抑制窗防每分钟重复记同一 episode");
    h.advance(5); // 13min：抑制窗（11min）已过
    feedR1(h);   // 刷新事件时钟 + 调用仍在 10 分钟窗口内（6min 起算）
    await h.shadow.tick();
    assert.equal(h.lines.length, 2, "窗过期后新 episode 再记");
    assert.equal(h.lines[1].kind, "strong");
});

test("弱信号不抑制：R2 连续两个 tick 各记一行", async () => {
    const h = makeShadow();
    h.advance(6);
    for (const id of ["r1", "r2", "r3", "r4"]) {
        h.shadow.feed({ type: "tool.start", toolCallId: id, toolName: "read_file", args: { path: "src/a.ts", offset: 1, limit: 50 } });
    }
    await h.shadow.tick(); // weak 行 #1
    h.advance(1);
    beat(h);
    await h.shadow.tick(); // weak 行 #2（弱信号本就只作证据，不去重）
    assert.equal(h.lines.length, 2);
    assert.ok(h.lines.every((l) => l.kind === "weak" && l.rules.includes("R2")));
});

test("silence 仅记录：断流面 → silence 行（R3），永不动作；健康面 → health 行", async () => {
    const h = makeShadow();
    h.advance(6); // 零事件静默
    await h.shadow.tick();
    assert.equal(h.lines.length, 1);
    assert.equal(h.lines[0].kind, "silence");
    assert.deepEqual(h.lines[0].rules, ["R3"]);
    assert.match(h.lines[0].evidence, /断流：6 分钟无任何事件/);

    // 健康面（新文件出现）→ health 行，rules 为空（对照组，非规则命中）
    const netSrc = { value: 100, newFiles: [] as string[] };
    const h2 = makeShadow({ sampleDiff: async () => ({ net: netSrc.value, newFiles: netSrc.newFiles }) });
    h2.advance(6); beat(h2);
    await h2.shadow.tick(); // 采样 #1
    netSrc.newFiles = ["src/new-module.ts"];
    h2.advance(1); beat(h2);
    await h2.shadow.tick(); // 采样 #2 → 健康短路
    assert.equal(h2.lines.length, 1);
    assert.equal(h2.lines[0].kind, "health");
    assert.deepEqual(h2.lines[0].rules, [], "健康时间线是复核时的对照组（非规则命中）");
});

// ============ 日志行 schema（方案 §6） ============

test("日志行 schema：七字段齐备，ts 本地时区形态，runMin/round/netLines 有值", async () => {
    const h = makeShadow();
    h.advance(6);
    feedR1(h);
    await h.shadow.tick();
    const l = h.lines[0];
    assert.deepEqual(Object.keys(l).sort(), ["evidence", "kind", "netLines", "round", "rules", "runMin", "sessionId", "ts"]);
    assert.match(l.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, "本地时区 ISO（非 Z 形态）");
    assert.equal(l.sessionId, "shadow-test");
    assert.equal(typeof l.runMin, "number");
    assert.ok(l.runMin >= 6, "runMin 从 detector 起步时刻起算");
    assert.equal(l.round, 2, "round 取自事件流");
    assert.equal(l.netLines, 100, "netLines 取最近 diff 采样");
});

test("默认写盘：无 writeLine 注入时落 <rootDir>/.deepseeker-code/watchdog-shadow.jsonl", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsc-shadow-test-"));
    try {
        let cur = 1_000_000_000_000;
        const shadow = new ShadowWatchdog({
            sessionId: "file-test",
            rootDir: dir,
            sampleDiff: async () => ({ net: 5, newFiles: [] }),
            now: () => cur,
            schedule: () => () => {},
        });
        shadow.start();
        cur += 6 * MIN;
        shadow.feed({ type: "round.start", round: 1 });
        shadow.feed({ type: "tool.start", toolCallId: "c1", toolName: "edit_file", args: { path: "src/a.ts" } });
        shadow.feed({ type: "tool.start", toolCallId: "c2", toolName: "edit_file", args: { path: "src/a.ts" } });
        shadow.feed({ type: "round.start", round: 2 });
        shadow.feed({ type: "tool.start", toolCallId: "c3", toolName: "edit_file", args: { path: "src/a.ts" } });
        await shadow.tick();
        const p = path.join(dir, ".deepseeker-code", "watchdog-shadow.jsonl");
        const raw = await fs.promises.readFile(p, "utf-8");
        const parsed = raw.trim().split("\n").map((s) => JSON.parse(s) as ShadowLogLine);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].kind, "strong");
        assert.equal(parsed[0].sessionId, "file-test");
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

// ============ 开关（§8，形态对齐 DEEP_SEEK_BATCH_WATCHDOG） ============

test("开关语义：缺省开；仅值 \"0\" 关闭（关闭 = host 不创建实例、零文件写入）", () => {
    const key = "DEEP_SEEK_WATCHDOG_SHADOW";
    const saved = process.env[key];
    try {
        delete process.env[key];
        assert.equal(shadowEnabled(), true, "缺省开");
        process.env[key] = "0";
        assert.equal(shadowEnabled(), false, "值 \"0\" 关闭");
        process.env[key] = "1";
        assert.equal(shadowEnabled(), true, "其余值（含非 0）均开启");
    } finally {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
    }
});

// ============ host 接线锚点（源码扫描，kernel-audit 既有风格） ============

test("host 接线（源码扫描）：sink 尾部 feed / 审批与提问挂起暂停、解锁恢复 / runOnce 生命周期 / 开关旁路", () => {
    const HOST_SRC = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "vscode", "src", "host.ts"), "utf-8");
    assert.match(HOST_SRC, /import \{ ShadowWatchdog, shadowEnabled \} from "@\/agent\/shadowWatchdog\.ts"/);
    assert.match(HOST_SRC, /this\.shadow\?\.feed\(evt\)/, "sink 尾部全量转发（白名单外 feed 自忽略）");
    assert.match(HOST_SRC, /approval_request"[\s\S]{0,200}this\.shadow\?\.setPaused\(true\)/, "审批挂起豁免");
    assert.match(HOST_SRC, /askQuestion[\s\S]{0,400}this\.shadow\?\.setPaused\(true\)/, "提问挂起豁免");
    assert.match(HOST_SRC, /resolveApproval[\s\S]{0,300}this\.shadow\?\.setPaused\(false\)/, "审批解锁恢复");
    assert.match(HOST_SRC, /resolveQuestion[\s\S]{0,300}this\.shadow\?\.setPaused\(false\)/, "提问已答恢复");
    assert.match(HOST_SRC, /this\.shadow = shadowEnabled\(\) \? new ShadowWatchdog\(/, "开关旁路：关闭 = 零实例");
    assert.match(HOST_SRC, /this\.shadow\?\.stop\(\);\s*\n\s*this\.shadow = null;/, "runOnce finally 收尾");
});
