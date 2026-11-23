/**
 * @file tests/b4-slice-boundaries.test.ts
 * @description 评审修复施工单 B4（2026-11-23）守门：三处裸 slice 改防劈代理对，各一个边界用例
 *  （截断点正好落在代理对中间）。
 *   ① recall.snippetAround：窗口两端 sliceTailNoSplit / sliceHeadNoSplit——切缘 emoji 整体舍去；
 *   ② recall with_full 分页：页尾切点安全化 + full_offset 按【实际取出长度】推进——各页拼接恒等于原文；
 *   ③ skills/loader 正文截断：sliceHeadNoSplit（与 commands/loader 对齐），常量正名 CHARS（码元口径）。
 *  孤立代理随工具结果回灌模型 = 下一次 API 请求 400（2026-11-13 事故形态）。
 *
 *  沙盒惯例：dataDir 先于动态 import（仓库惯例）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-b4-slice-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑）。
const { snippetAround } = await import("@/tool/registry/recall.ts");
const { recallTools } = await import("@/tool/registry/recall.ts");
const { getToolOutputSidecarPath } = await import("@/session/sidecar.ts");
const { loadSkills } = await import("@/skills/loader.ts");
const { listSkills, clearSkills } = await import("@/skills/registry.ts");
const { loadOutputStyles } = await import("@/outputStyles/loader.ts");
const { listOutputStyles, clearOutputStyles } = await import("@/outputStyles/registry.ts");
const { truncateGuideBody } = await import("@/projectGuide/loader.ts");
const { buildExternalDescription } = await import("@/memory/loader.ts");

const emoji = "📋";   // U+1F4CB，代理对占 2 个 UTF-16 码元

/** 码元直扫孤立代理（DeepSeek 400 直接诱因的机器判定，surrogate-slice.test.ts 同款）。 */
const noLoneSurrogate = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && !(s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return false;
        if (c >= 0xdc00 && c <= 0xdfff && !(s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff)) return false;
    }
    return true;
};

describe("B4-① snippetAround 窗口两端防劈代理对", () => {
    it("切点落在代理对中间：emoji 整体舍去、输出无孤立代理、命中与标记保持", () => {
        // 匹配位 index=820 → start=700，窗口 [700,1400)；emoji 高代理恰在码元 1399——裸 slice(700,1400) 必劈
        const text = "x".repeat(820) + "KEYWORD" + "z".repeat(572) + emoji + "y".repeat(30);
        assert.ok(text.charCodeAt(1399) >= 0xd800, "夹具有效性：码元 1399 = 代理对高半（裸切劈半）");
        const out = snippetAround(text, /KEYWORD/i, 700);
        assert.ok(noLoneSurrogate(out), "输出无孤立代理");
        assert.ok(!out.includes(emoji), "切缘 emoji 整体舍去（不劈半）");
        assert.match(out, /KEYWORD/, "命中关键词在窗口内");
        assert.match(out, /^…/, "头省略号（start>0）");
        assert.match(out, /片段截断，完整内容可用 with_full/, "尾标记保持");
    });
});

describe("B4-② with_full 分页防劈代理对 + 推进量按实际长度", () => {
    const SID = "b4-sidecar-sess";
    const FULL = "x".repeat(13_999) + emoji + "y".repeat(600);   // 首页裸切点 14000 = 代理对中间

    it("首页切点安全化（14000→13999）、返回的 full_offset 为安全切点；两页拼接 == 原文", async () => {
        const p = getToolOutputSidecarPath(SID, "b4sid");
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, FULL, "utf-8");

        const recall = recallTools.find((t: any) => t.function.name === "recall")!;
        const ctx = { sessionId: SID, cwd: SANDBOX } as any;
        const page1 = await (recall.function.execute as any)({ with_full: "b4sid", full_offset: 0 }, ctx) as string;
        assert.ok(noLoneSurrogate(page1), "首页无孤立代理（裸切必劈）");
        assert.ok(!page1.slice(0, page1.indexOf("[未完") ?? undefined).includes(emoji), "切缘 emoji 整体舍去");
        const m1 = page1.match(/full_offset=(\d+)/)!;
        const nextOff = Number(m1[1]);
        assert.equal(nextOff, 13_999, "推进量 = 实际取出长度（安全切点，非固定步长 14000）");

        const page2 = await (recall.function.execute as any)({ with_full: "b4sid", full_offset: nextOff }, ctx) as string;
        assert.match(page2, /全文完/, "第二页即末页");
        // 分页不变量：两页正文拼接恒等于原文（emoji 不丢不重）。正文 = 响应头「]\n\n」之后、尾标记之前。
        const bodyOf = (page: string, endMark: string): string =>
            page.slice(page.indexOf("]\n\n") + 3, page.indexOf(endMark));
        const body1 = bodyOf(page1, "\n\n[未完");
        const body2 = bodyOf(page2, "\n\n[全文完");
        assert.equal(body1 + body2, FULL, "各页拼接 == 原文（emoji 完整保留在第二页）");
    });
});

describe("B4-③ skills 正文截断防劈代理对（与 commands/loader 对齐）", () => {
    it("64K 切点落在代理对中间：正文无孤立代理、emoji 整体舍去、截断标记在", async () => {
        await clearSkills();
        const dir = path.join(SANDBOX, "skills", "b4-emoji-skill");   // global 源 = dataDir/skills（env 已指 SANDBOX）
        await fs.mkdir(dir, { recursive: true });
        const body = "x".repeat(65_535) + emoji + "y".repeat(100);    // 裸切点 65536 = 代理对中间
        await fs.writeFile(path.join(dir, "SKILL.md"),
            `---\nname: b4-emoji-skill\ndescription: B4 边界夹具\n---\n${body}`, "utf-8");
        const n = await loadSkills(false);
        assert.ok(n >= 1, "夹具技能已加载");
        const loaded = listSkills().find((s: any) => s.name === "b4-emoji-skill")!;
        assert.ok(loaded, "技能已注册");
        const out = (loaded as any).body as string;
                assert.ok(noLoneSurrogate(out), "截断产物无孤立代理");
                assert.ok(!out.includes(emoji), "切缘 emoji 整体舍去（不劈半）");
                assert.match(out, /已截断/, "截断标记在");
                assert.ok(out.length < body.length, "确实发生了截断");
            });
        });

        describe("B4-④ outputStyles 正文截断防劈代理对（与 skills/loader 对齐，B4 补完）", () => {
            it("64K 切点落在代理对中间：正文无孤立代理、emoji 整体舍去、截断标记在", async () => {
                clearOutputStyles();
                const dir = path.join(SANDBOX, "output-styles");   // global 源 = dataDir/output-styles（扁平 *.md，env 已指 SANDBOX）
                await fs.mkdir(dir, { recursive: true });
                const body = "x".repeat(65_535) + emoji + "y".repeat(100);    // 裸切点 65536 = 代理对中间
                // 夹具自证：裸 slice 确实劈出孤立代理（否则本条用例无效）
                assert.ok(!noLoneSurrogate(body.slice(0, 64 * 1024)), "夹具自证：裸切点在代理对中间");
                await fs.writeFile(path.join(dir, "b4-emoji-style.md"),
                    `---\nname: b4-emoji-style\ndescription: B4 输出风格边界夹具\n---\n${body}`, "utf-8");
                const n = await loadOutputStyles(false);
                assert.ok(n >= 1, "夹具风格已加载");
                const loaded = listOutputStyles().find((s: any) => s.name === "b4-emoji-style")!;
                assert.ok(loaded, "风格已注册");
                const out = (loaded as any).body as string;
                assert.ok(noLoneSurrogate(out), "截断产物无孤立代理（修复前裸 slice 会劈半 → 下一次请求 400）");
                assert.ok(!out.includes(emoji), "切缘 emoji 整体舍去（不劈半）");
                assert.match(out, /已截断/, "截断标记在");
                assert.ok(out.length < body.length, "确实发生了截断");
            });
        });

        describe("B4-⑤ 其余进 system prompt 的 loader 截断（B4 补完）", () => {
            it("projectGuide 16K 切点落在代理对中间：无孤立代理、emoji 整体舍去、标记在", () => {
                const raw = "x".repeat(16_383) + emoji + "y".repeat(2000);   // 裸切点 16384 = 代理对中间（尾巴够长，截断后必然变短）
                assert.ok(!noLoneSurrogate(raw.slice(0, 16 * 1024)), "夹具自证：裸切点在代理对中间");
                const out = truncateGuideBody(raw);
                assert.ok(noLoneSurrogate(out), "截断产物无孤立代理（指引每轮进 system prompt）");
                assert.ok(!out.includes(emoji), "切缘 emoji 整体舍去");
                assert.match(out, /字符已截断/);
                assert.ok(out.length < raw.length, "确实发生了截断");
                assert.equal(truncateGuideBody("short"), "short", "未超限原样返回（幂等，不动字节）");
            });

            it("memory 外部描述 120 字符切点落在代理对中间：无孤立代理、守定长上限", () => {
                const title = "a".repeat(112) + emoji;   // 前缀 `[外部:x] ` 占 7 码元 → 切点 120 落在 emoji 中间
                const full = `[外部:x] ${title}`;
                assert.ok(!noLoneSurrogate(full.slice(0, 120)), "夹具自证：裸切点在代理对中间");
                const out = buildExternalDescription("x", title);
                assert.ok(noLoneSurrogate(out), "描述进 system prompt 记忆索引 → 不得含孤立代理");
                assert.ok(out.length <= 120, "仍守定长上限");
            });
        });
