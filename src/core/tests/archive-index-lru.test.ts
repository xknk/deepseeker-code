/**
 * @file tests/archive-index-lru.test.ts
 * @description P1-C 实体索引截断治理守门（评审修复批 2026-11-19）：
 *  ① 超长实体（>60 字符）不再整条丢弃——压缩为「前缀~哈希尾」：前缀仍是原文可检索子串（保可匹配性）、
 *     同一长实体重复提取产出同一压缩形态（跨轮去重稳定）、同前缀不同路径哈希歧义消除；
 *  ② 满编淘汰「保新弃旧」→ LRU：recall 查询命中触达（touchArchiveIndexOnQuery）+ 新归档即触达，
 *     被用过的线索满编时存活；无 usage 表退化保新弃旧（旧行为逐字节回归）。
 *  沙盒：DEEPSEEKER_CODE_DATA_DIR 在动态 import 前就位（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-idx-lru-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { extractArchiveEntities, mergeSummarySlot, parseSummarySlot, getArchiveIndexUsage, touchArchiveIndexOnQuery } =
    await import("@/agent/truncate.ts");

const extractFrom = (text: string): string[] => extractArchiveEntities([{ role: "assistant", content: text } as any]);
/** 只看长路径压缩形态（提取器对 CJK 串/路径段还有别的合法收编，与本题无关）。 */
const compressedOf = (text: string): string[] => extractFrom(text).filter((e) => /~[0-9a-f]{8}$/.test(e));

describe("P1-C ① 超长实体压缩（前缀+哈希尾）", () => {
    const LONG_PATH = "d:\\code\\自研\\deepSeekCode\\src\\core\\src\\agent\\nested\\deeper\\still\\truncate.ts"; // >60 字符

    it("超长路径不再丢弃：产出 ≤60 字符的「前缀~8位hex」压缩形态", () => {
        const ents = compressedOf(`看 ${LONG_PATH} 的逻辑`);
        assert.equal(ents.length, 1, "不再整条丢弃");
        const e = ents[0]!;
        assert.ok(e.length <= 60, `压缩形态 ≤60：${e.length}`);
        assert.match(e, /^[^~]{1,44}~[0-9a-f]{8}$/, `形态 = 前缀~哈希尾：${e}`);
        // 保可匹配性：压缩形态是原文的可检索子串（recall 按子串命中历史原文）。
        // 注：路径正则本就丢弃 `d:` 盘符前缀（`:` 不在段字符类——既有行为），故前缀自 "code\" 起。
        assert.ok(e.startsWith("code\\自研\\deepSeekCode\\src\\core\\src\\agent"));
        assert.ok(LONG_PATH.toLowerCase().includes(e.split("~")[0]!.toLowerCase()), "前缀 ⊂ 原文");
    });

    it("同一长实体重复提取 → 同一压缩形态（去重后单条，不累积）", () => {
        const a = compressedOf(`见 ${LONG_PATH}`);
        const b = compressedOf(`再读 ${LONG_PATH}`);
        assert.equal(a.length, 1);
        assert.equal(a[0], b[0], "哈希确定性：跨轮同形态");
        const merged = mergeSummarySlot("", "", [...a, ...b]);
        assert.equal(parseSummarySlot(merged).index.length, 1, "去重后单条");
    });

    it("同前缀不同长路径 → 两条不同压缩形态（哈希歧义消除）", () => {
        const p1 = "d:\\code\\自研\\deepSeekCode\\src\\core\\src\\agent\\alpha\\module-one\\deep\\parser.ts";
        const p2 = "d:\\code\\自研\\deepSeekCode\\src\\core\\src\\agent\\alpha\\module-two\\deep\\parser.ts";
        const ents = compressedOf(`${p1} 与 ${p2}`);
        assert.equal(ents.length, 2, "不被前缀截断合并");
        assert.notEqual(ents[0], ents[1]);
    });

    it("≤60 字符实体原样保留（现状不回归）", () => {
        const short = "src\\core\\src\\agent\\truncate.ts";
        assert.deepEqual(extractFrom(`改 ${short}`), [short]);
    });
});

describe("P1-C ② 满编淘汰 LRU", () => {
    const N = 120; // ARCHIVE_INDEX_MAX_ENTRIES（不导出，按规格值构造满编）
    const mkOldSlot = (sid: string): { slot: string; ents: string[] } => {
        const ents = Array.from({ length: N }, (_, i) => `entity-${String(i).padStart(3, "0")}`);
        return { slot: mergeSummarySlot("", "", ents, getArchiveIndexUsage(sid)), ents };
    };

    it("被 recall 触达的旧实体满编时存活；最久未用者先被逐出", () => {
        const sid = `lru-${Date.now()}-a`;
        const { slot, ents } = mkOldSlot(sid);
        assert.equal(parseSummarySlot(slot).index.length, N, "满编");
        // 模拟 recall 命中：query 与 entity-005 双向子串命中 → bump
        touchArchiveIndexOnQuery(sid, "entity-005");
        // 新归档 3 条 → 满 123 → LRU 逐出 3 个 tick 最小者（未触达的最早三条）
        const fresh = ["fresh-alpha", "fresh-beta", "fresh-gamma"];
        const slot2 = mergeSummarySlot(slot, "", fresh, getArchiveIndexUsage(sid));
        const idx = parseSummarySlot(slot2).index;
        assert.equal(idx.length, N, "满编不涨");
        assert.ok(idx.includes("entity-005"), "被触达的旧实体存活");
        for (const f of fresh) assert.ok(idx.includes(f), "新实体在列");
        for (const gone of ["entity-000", "entity-001", "entity-002"]) {
            assert.ok(!idx.includes(gone), `${gone}（最久未用）被逐出`);
        }
    });

    it("新归档即触达：超编时重归档实体不被当作旧档逐出", () => {
        const sid = `lru-${Date.now()}-b`;
        const { slot } = mkOldSlot(sid);
        // 重归档 2 条（已在槽内，tick 被 bump 到最新）+ 新增 3 条 → 123 > 120 → 逐出 3 个
        const re = ["entity-119", "entity-118"]; // 槽尾（最旧位置）但本轮重新归档 = 仍在服役
        const fresh = ["fresh-one", "fresh-two", "fresh-three"];
        const slot2 = mergeSummarySlot(slot, "", [...re, ...fresh], getArchiveIndexUsage(sid));
        const idx = parseSummarySlot(slot2).index;
        assert.ok(idx.includes("entity-119") && idx.includes("entity-118"), "重新归档的实体存活");
        for (const f of fresh) assert.ok(idx.includes(f), "新实体在列");
        for (const gone of ["entity-000", "entity-001", "entity-002"]) {
            assert.ok(!idx.includes(gone), `${gone}（无人问津的最旧实体）被逐出`);
        }
    });

    it("无 usage 表（旧调用形态）：退化保新弃旧，行为与旧实现一致（弃列表尾）", () => {
        const ents = Array.from({ length: N }, (_, i) => `plain-${String(i).padStart(3, "0")}`);
        const slot = mergeSummarySlot("", "", ents);
        const slot2 = mergeSummarySlot(slot, "", ["plain-new"]);
        const idx = parseSummarySlot(slot2).index;
        assert.equal(idx.length, N);
        assert.equal(idx[0], "plain-new", "新者居首");
        assert.ok(!idx.includes("plain-119"), "列表尾（最晚入档）被逐——旧实现逐字节同判");
        assert.ok(idx.includes("plain-118"), "尾前一位保留");
    });
});
