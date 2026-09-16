/**
 * @file tests/summary-checkpoint.test.ts
 * @description 检查点式摘要（agent/truncate.ts，借 pi 的 checkpoint/SUMMARIZATION+UPDATE 语义）契约测试：
 *  - batchSummaryPrompt 状态序（完成了什么→正在做什么→下一步/受阻）+ 贴尾框定（为保留区补背景）；
 *  - checkpointPrompt 双语义（生成/更新）各自的固定格式骨架与规则（缺段会静默劣化续接质量）；
 *  - extractArchiveEntities 版本号形态过滤（UA 碎片不再挤占实体索引名额）；
 *  - parseSummarySlot 对检查点式叙述（"## " 分节）的宽容解析（格式漂移不炸槽结构）；
 *  - mergeSummarySlot 空行合并（索引先行落位、叙述原样）——检查点路线的合并点契约。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒惯例：dataDir 指向临时目录，防模块初始化读真实 ~/.deepseeker-code。
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-summary-checkpoint-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const {
    batchSummaryPrompt, checkpointPrompt, mergeSummarySlot,
    extractArchiveEntities, parseSummarySlot,
} = await import("@/agent/truncate.ts");

describe("batchSummaryPrompt（批次摘要指令）", () => {
    it("基础版：状态序 + 实体保留 + 不臆测三要素齐全", () => {
        const p = batchSummaryPrompt(false);
        assert.ok(p.includes("完成了什么"), "应有「完成了什么」状态序起点");
        assert.ok(p.includes("下一步"), "应含「下一步」——行式摘要的检查点语义来源");
        assert.ok(p.includes("报错关键词"), "应保留实体名要求（recall 查询词来源）");
        assert.ok(p.includes("(细节已归档)"), "不确定感显式化要求不得丢");
    });

    it("贴尾版：附加「为保留区补背景」框定；非贴尾版不含（防框定滥加）", () => {
        const tail = batchSummaryPrompt(true);
        const base = batchSummaryPrompt(false);
        assert.ok(tail.includes("保留区"), "贴尾版应点明保留区");
        assert.ok(!base.includes("保留区"), "非贴尾版不得混入框定（框定只属于末批）");
        assert.ok(tail.length > base.length, "贴尾版是基础版的超集");
    });
});

describe("checkpointPrompt（检查点合成指令 · 生成/更新双语义）", () => {
    const SECTIONS = ["## 目标", "## 约束与偏好", "## 进度", "### 已完成", "### 进行中", "### 受阻", "## 关键决策", "## 下一步", "## 关键上下文"];

    it("两个变体都带完整格式骨架（缺段即静默丢类信息，须钉死）", () => {
        for (const p of [checkpointPrompt(false), checkpointPrompt(true)]) {
            for (const section of SECTIONS) {
                assert.ok(p.includes(section), `缺少分节：${section}`);
            }
            assert.ok(p.includes("实体名"), "应要求原样保留实体名（recall 查询词来源）");
            assert.ok(p.includes("recall"), "应告知细节可经 recall 检索");
            assert.ok(/不超过 \d+ 字/.test(p), "应有输出字数预算（防合成结果膨胀吃窗口）");
        }
    });

    it("更新语义（有旧检查点）：含双段标记与合并规则；不含生成期专属措辞", () => {
        const p = checkpointPrompt(true);
        assert.ok(p.includes("⟦DSC:ARCHIVE-INDEX⟧") && p.includes("⟦DSC:ARCHIVE-NOTES⟧"), "应向合成模型说明双段结构（索引段勿动）");
        assert.ok(p.includes("既有检查点"), "应指明在旧检查点基础上合并改写");
        assert.ok(p.includes("刷新到最新状态"), "应含进度状态迁移规则（In Progress→Done 的检查点语义）");
        assert.ok(p.includes("过期细节可删除"), "应允许丢弃被取代的过期信息（分级保留的关键）");
        assert.ok(!p.includes("(细节已归档)"), "更新语义不应混入生成期措辞");
    });

    it("生成语义（首轮）：从归档行直接整理；不含更新期专属措辞", () => {
        const p = checkpointPrompt(false);
        assert.ok(p.includes("(细节已归档)"), "不确定感显式化要求不得丢");
        assert.ok(!p.includes("既有检查点"), "生成语义不应引用不存在的旧检查点");
    });
});

describe("mergeSummarySlot 空行合并（检查点路线的索引先行落位）", () => {
    it("noteLine 为空：仅合并实体索引，叙述原样保留、无尾随换行", () => {
        const old = [
            "⟦DSC:ARCHIVE-INDEX⟧ 提示行：",
            "old.ts | fn1",
            "⟦DSC:ARCHIVE-NOTES⟧",
            "## 目标",
            "保持不变",
        ].join("\n");
        const merged = mergeSummarySlot(old, "", ["new.ts", "old.ts", "fn1"]);
        const { index, notes } = parseSummarySlot(merged);
        assert.deepEqual(index, ["new.ts", "old.ts", "fn1"], "新实体优先、去重合并");
        assert.ok(notes.includes("## 目标") && notes.includes("保持不变"), "叙述段（检查点）不得被空行合并改动");
        assert.ok(!notes.endsWith("\n"), "空 noteLine 不留尾随换行");
    });
});

describe("extractArchiveEntities 版本号形态过滤", () => {
    const extractFrom = (text: string) => extractArchiveEntities([{ role: "assistant", content: text } as any]);

    it("UA 碎片（末段纯数字/点）不再混入索引", () => {
        const ents = extractFrom(
            "请求头 User-Agent: Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML) Chrome/152.0.0.0 Safari/537.36",
        );
        const bad = ents.filter((e: string) => /^[\d.]+$/.test(e.split(/[\\/]/).pop() ?? ""));
        assert.equal(bad.length, 0, `不应有版本号形态实体，实际：${bad.join(" | ")}`);
        assert.equal(ents.some((e: string) => e.includes("537.36")), false, "AppleWebKit/537.36 应被过滤");
        assert.equal(ents.some((e: string) => e.includes("152.0.0.0")), false, "Chrome/152.0.0.0 应被过滤");
    });

    it("真实文件路径与反引号强调词不受影响", () => {
        const ents = extractFrom("读取 src/agent/truncate.ts 并检查 `compactSlotNarrative` 的行为");
        assert.ok(ents.includes("src/agent/truncate.ts"), "带扩展名的真实路径必须保留");
        assert.ok(ents.includes("compactSlotNarrative"), "反引号强调词必须保留");
    });
});

describe("extractArchiveEntities 中文会话召回增强（路线 #10①）", () => {
    const extractFrom = (text: string) => extractArchiveEntities([{ role: "assistant", content: text } as any]);

    it("中文连续实体串入索引（未加任何引号的散文实体，≤14 字整段收录）", () => {
        const ents = extractFrom("上游网关连接超时，检查负载均衡配置后重试即可恢复");
        assert.ok(ents.includes("上游网关连接超时"), `中文实体应入索引：${ents.join(" | ")}`);
    });

    it("超长中文句段（>14 字）不做实体（散文切片是噪声）", () => {
        const ents = extractFrom("这一段是很长的中文散文叙述不应该被切进实体索引里面去因为它们不是名词性检索词");
        const long = ents.filter((e: string) => e.length > 14);
        assert.equal(long.length, 0, `不应有超长实体：${long.join(" | ")}`);
    });

    it("中文文件路径入索引（路径段含 CJK）", () => {
        const ents = extractFrom("修改了 src/工具/解析器.ts 的实现");
        assert.ok(ents.includes("src/工具/解析器.ts"), `中文路径应入索引：${ents.join(" | ")}`);
    });

    it("双引号报错原文入索引；中文引号「」同样收", () => {
        const ents = extractFrom('接口返回 "Internal server error: db pool exhausted"，前端提示「加载失败」');
        assert.ok(ents.includes("Internal server error: db pool exhausted"), `双引号报错原文应入索引：${ents.join(" | ")}`);
        assert.ok(ents.includes("加载失败"), "中文引号实体应入索引");
    });

    it("单引号无空白错误码入索引；带空白的撇号散文误报不收", () => {
        const ents = extractFrom("请求失败 'ECONNRESET'，先查重试配置；另外英文缩写 don't 之类的撇号串不算 t 恰好这不是实体 break");
        assert.ok(ents.includes("ECONNRESET"), `错误码应入索引：${ents.join(" | ")}`);
        assert.equal(ents.some((e: string) => e.includes(" ")), false, "带空白的单引号串（撇号散文误报）不应入索引");
    });

    it("URL 入索引（截到空白/中文标点止）", () => {
        const ents = extractFrom("接口文档见 https://example.com/docs/api-guide?v=2#auth ，按第 3 节改");
        assert.ok(ents.includes("https://example.com/docs/api-guide?v=2#auth"), `URL 应入索引：${ents.join(" | ")}`);
    });

    it("大小写归一去重：README.md 与 readme.md 只占一个名额（recall 检索本身大小写不敏感）", () => {
        const ents = extractFrom("改 docs/README.md 时同步检查 docs/readme.md 的链接");
        const hits = ents.filter((e: string) => e.toLowerCase().endsWith("readme.md"));
        assert.equal(hits.length, 1, `大小写变体应合并为一个名额：${hits.join(" | ")}`);
        assert.ok(ents.includes("docs/README.md"), "保留首个原始写法");
    });

    it("含竖线的候选拒收（不破坏索引的 | 分隔格式）", () => {
        const ents = extractFrom('表格行 "a | b" 这类内容不能进索引');
        assert.equal(ents.some((e: string) => e.includes("|")), false, `含 | 的实体应拒收：${ents.join(" | ")}`);
    });

    it("argsText 只扫高置信三类：JSON 双引号键名与中文片段不灌索引，路径照收", () => {
        const ents = extractArchiveEntities([
            {
                role: "assistant", content: "",
                tool_calls: [{
                    id: "c1", type: "function",
                    function: { name: "edit_file", arguments: '{"path":"src/注释文件.ts","old_str":"旧的实现说明","new_str":"新的实现说明附更详细注释"}' },
                }],
            } as any,
        ]);
        assert.ok(!ents.some((e: string) => e === "path" || e === "old_str" || e === "new_str"), `JSON 键名不得入索引：${ents.join(" | ")}`);
        assert.ok(!ents.includes("旧的实现说明"), "args 中文片段不入索引（edit 中文注释场景防泛滥）");
        assert.ok(ents.includes("src/注释文件.ts"), "args 里的文件路径仍要入索引");
    });

    it("mergeSummarySlot 跨轮合并同口径大小写归一（README.md 与 readme.md 不再累积双份）", () => {
        const old = "⟦DSC:ARCHIVE-INDEX⟧ 指引行\nREADME.md | src/a.ts\n⟦DSC:ARCHIVE-NOTES⟧\n- 笔记";
        const merged = mergeSummarySlot(old, "", ["readme.md", "new.ts"]);
        const { index } = parseSummarySlot(merged);
        const hits = index.filter((e) => e.toLowerCase() === "readme.md");
        assert.equal(hits.length, 1, `跨轮合并应大小写归一：${index.join(" | ")}`);
    });
});

describe("decayOldToolResults 衰减折叠提示指向 recall（路线 #10②）", () => {
    it("折叠提示包含 recall 指引与确切 with_full=tool_call_id，不再只说重新调用工具", async () => {
        const { decayOldToolResults } = await import("@/session/content.ts");
        const longText = "x".repeat(800); // > BOUNDARY_TOOL_KEEP_CHARS(500) 才触发折叠
        const msgs: any[] = [];
        for (let i = 0; i < 8; i++) {
            msgs.push({ role: "user", content: `u${i}` });
            msgs.push({ role: "assistant", content: "", tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "search_grep", arguments: "{}" } }] });
            msgs.push({ role: "tool", tool_call_id: `call_${i}`, content: longText });
        }
        const out = decayOldToolResults(msgs);
        const decayed = out.filter((m: any) => m.role === "tool" && String(m.content).includes("已折叠"));
        assert.ok(decayed.length > 0, "超出保留区的旧工具结果应被折叠");
        for (const m of decayed) {
            const c = String(m.content);
            assert.ok(c.includes("recall"), "折叠提示应指向 recall 工具");
            assert.match(c, new RegExp(`with_full="${(m as any).tool_call_id}"`), "应给出 with_full 与该结果确切的 tool_call_id");
            assert.ok(c.length < 1500, "折叠视图应有界（保留头 + 提示）");
        }
        // 保留区最近单元不折叠
        assert.equal(out.some((m: any) => m.role === "tool" && m.tool_call_id === "call_7" && m.content === longText), true, "最近单元全文保留");
    });
});

describe("parseSummarySlot 对检查点式叙述的宽容解析", () => {
    it("「## 」分节叙述不破坏槽结构：索引与叙述各自完整取回", () => {
        const slot = [
            "⟦DSC:ARCHIVE-INDEX⟧ 精确细节可用 recall 工具检索本会话全量历史；以下为归档实体索引（检索关键词线索）：",
            "src/agent/truncate.ts | compactSlotNarrative",
            "⟦DSC:ARCHIVE-NOTES⟧",
            "## 目标",
            "修复压缩自收敛的信息丢失问题",
            "## 进度",
            "### 已完成",
            "- [x] 改走检查点重渲染",
            "## 下一步",
            "1. 跑守护测试",
        ].join("\n");
        const { index, notes } = parseSummarySlot(slot);
        assert.deepEqual(index, ["src/agent/truncate.ts", "compactSlotNarrative"], "索引段按 | 切分无损");
        assert.ok(notes.includes("## 目标") && notes.includes("- [x] 改走检查点重渲染"), "检查点式叙述原样保留在叙述段");
        assert.ok(!notes.includes("ARCHIVE-INDEX"), "叙述段不得混入索引标记");
    });
});
