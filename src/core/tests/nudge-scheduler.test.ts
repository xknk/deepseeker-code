/**
 * @file tests/nudge-scheduler.test.ts
 * @description agentNudges 调度器表驱动行为锁（P1-4 characterization test：只锁现状、不改机制）。
 *  覆盖六类 nudge 的触发 / 预算 / 优先级 + 两次事故回归钉：
 *  - 2026-09-11「你好」事故：纯寒暄的 final 绝不被 EARLY_FINAL 拦截（按信号武装）；
 *  - 2026-08-11「连续 final」事故：实质长总结绝不被 TOOL_DIGEST 拦截（限长保护）。
 *  agentNudges 为零依赖纯模块：本文件不触网、不需要任何 env。
 *  断言锚点用各 nudge 的 fence + 动态片段（轮次/路径/检索词）——文案整段改动会红，
 *  这正是目的：措辞调整必须 conscious 地更新本文件。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createNudgeScheduler } from "@/agent/agentNudges.ts";

const FENCE = {
    PLAN_FIRST: "⟦DSC:PLAN_FIRST⟧",
    PHANTOM: "⟦DSC:PHANTOM⟧",
    EARLY_FINAL: "⟦DSC:EARLY_FINAL⟧",
    TOOL_DIGEST: "⟦DSC:TOOL_DIGEST⟧",
    NUDGE: "⟦DSC:NUDGE⟧",
    REPEAT: "⟦DSC:REPEAT_RETRIEVAL⟧",
    TODO_INCOMPLETE: "⟦DSC:TODO_INCOMPLETE⟧",
} as const;

const readCall = (path: string) => ({ function: { name: "read_file", arguments: JSON.stringify({ path }) } });
const grepCall = (query: string) => ({ function: { name: "search_grep", arguments: JSON.stringify({ query }) } });
const editCall = (path: string) => ({ function: { name: "edit_file", arguments: JSON.stringify({ path }) } });
const todoCall = (todos: Array<{ content: string; status: string }>) =>
    ({ function: { name: "todo_write", arguments: JSON.stringify({ todos }) } });

/** ≥20 字、含「多个文件」标记（looksComplex 命中）且非 QUERY_LEAD 开头的首条 prompt 样例。 */
const COMPLEX_PROMPT = "请帮我实现一个完整的用户登录功能模块，涉及多个文件的组织与鉴权流程";
/** ≥30 字、不含任何 looksComplete 完成词的 final 样例（EARLY_FINAL 命中 / TOOL_DIGEST 限长放行共用）。 */
const LONG_INCOMPLETE = "接口返回了 500 错误，堆栈显示数据库连接失败，初步判断是配置文件里的连接串写错了导致的，还在排查";

describe("PLAN_FIRST（首轮规划引导）", () => {
    it("非平凡实现任务 → 第 1 轮注入，且仅一次", () => {
        const s = createNudgeScheduler({ firstPrompt: COMPLEX_PROMPT });
        const m = s.pickNudge(1)!;
        assert.ok(m.content.startsWith(FENCE.PLAN_FIRST));
        assert.equal(s.pickNudge(1), null, "仅一次（planFirstSent 后不再发）");
    });

    it("计划模式不引导", () => {
        const s = createNudgeScheduler({ firstPrompt: COMPLEX_PROMPT, planMode: true });
        assert.equal(s.pickNudge(1), null);
    });

    it("寒暄 / 短句 / 问句不引导（<20 字或 QUERY_LEAD 开头）", () => {
        for (const p of ["你好", "解释一下 React useEffect 依赖数组机制与最佳实践", "帮我看看这个文件"]) {
            assert.equal(createNudgeScheduler({ firstPrompt: p }).pickNudge(1), null, p);
        }
    });

    it("优先级最高：第 1 轮压过已设好的 REPEAT pending", () => {
        const s = createNudgeScheduler({ firstPrompt: COMPLEX_PROMPT });
        s.noteToolCall(1, [readCall("a.ts"), readCall("a.ts"), readCall("a.ts")]);
        assert.ok(s.pickNudge(1)!.content.startsWith(FENCE.PLAN_FIRST));
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.REPEAT), "pending 顺延到下一轮消费");
    });
});

describe("TOOL_DIGEST（工具消化收尾守护）", () => {
    it("消化期内空手收尾（空文本）→ 拦，且优先于 PHANTOM", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal("", 2), true);
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.TOOL_DIGEST));
    });

    it("消化期内短文本无完成声明 → 拦", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal("好的", 2), true);
        assert.ok(s.pickNudge(3)!.content.startsWith(FENCE.TOOL_DIGEST));
    });

    it("实质长总结（≥30 字）放行 —— 2026-08-11 连续 final 事故回归钉", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal(LONG_INCOMPLETE, 3), false);
    });

    it("含完成声明的短文本放行（looksComplete 豁免）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal("已全部完成", 2), false);
    });

    it("消化窗外（距上次工具 >2 轮）不拦", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal("好的", 4), false);
    });

    it("消化窗内最多拦 2 次，出窗即放行", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal("嗯", 2), true);
        assert.equal(s.interceptFinal("嗯", 3), true);
        assert.equal(s.interceptFinal("嗯", 4), false, "第 3 次已出消化窗（4-1>2）");
    });
});

describe("PHANTOM（空回复守护）", () => {
    it("空 content 无工具史 → 拦", () => {
        const s = createNudgeScheduler();
        assert.equal(s.interceptFinal("", 1), true);
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.PHANTOM));
    });

    it("连续空包最多拦 2 次，第 3 次放行", () => {
        const s = createNudgeScheduler();
        assert.equal(s.interceptFinal("", 1), true);
        assert.equal(s.interceptFinal("", 2), true);
        assert.equal(s.interceptFinal("", 3), false);
    });

    it("工具调用后预算重置；重置后空包落进消化窗 → 由 TOOL_DIGEST 接管", () => {
        const s = createNudgeScheduler();
        assert.equal(s.interceptFinal("", 1), true);
        s.noteToolCall(2, [readCall("a.ts")]);
        assert.equal(s.interceptFinal("", 3), true);
        assert.ok(s.pickNudge(4)!.content.startsWith(FENCE.TOOL_DIGEST), "消化窗内空包归 TOOL_DIGEST 管");
    });
});

describe("EARLY_FINAL（早收尾守护）", () => {
    it("开工后 2 轮内的长文本无完成声明 → 拦（带轮次号）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal(LONG_INCOMPLETE, 2), true);
        const m = s.pickNudge(2)!;
        assert.ok(m.content.startsWith(FENCE.EARLY_FINAL));
        assert.ok(m.content.includes("仅 2 轮"));
    });

    it("整个 run 最多拦 1 次（死循环保险，不随工具调用重置）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal(LONG_INCOMPLETE, 2), true);
        assert.equal(s.interceptFinal(LONG_INCOMPLETE, 2), false, "预算已用尽");
    });

    it("纯寒暄无工具史不拦 —— 2026-09-11「你好」事故回归钉", () => {
        const s = createNudgeScheduler({ firstPrompt: "你好" });
        assert.equal(s.interceptFinal("你好呀！很高兴见到你，有什么我可以帮你的吗？", 1), false);
    });

    it("复杂任务未开工也拦（文本-only 逃避干活）", () => {
        const s = createNudgeScheduler({ firstPrompt: COMPLEX_PROMPT });
        assert.equal(s.interceptFinal("好的明白了", 1), true);
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.EARLY_FINAL));
    });

    it("子代理 noEarlyFinal 不拦 EARLY，但短文本仍被 TOOL_DIGEST 接管（开关只关 EARLY）", () => {
        const s = createNudgeScheduler({ noEarlyFinal: true });
        s.noteToolCall(1, [readCall("a.ts")]);
        assert.equal(s.interceptFinal("先这样", 2), true);
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.TOOL_DIGEST));
    });
});

describe("TODO_INCOMPLETE（todo 完成度守卫，2026-09-16）", () => {
    it("本 run 未碰过 todo_write → 永不拦（武装条件）", () => {
        const s = createNudgeScheduler();
        assert.equal(s.interceptFinal(LONG_INCOMPLETE, 5), false, "无 todo 史不拦");
    });

    it("todo_write 后 final 仍有未完成项 → 拦一次，文案带未完成项与前 3 项列举", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [todoCall([
            { content: "实现登录接口", status: "completed" },
            { content: "补齐鉴权中间件", status: "in_progress" },
            { content: "写集成测试", status: "pending" },
        ])]);
        // LONG_INCOMPLETE（≥30 字）在 round 3 已出 EARLY_FINAL 窗、超 TOOL_DIGEST 限长 → 落到 TODO 守卫
        assert.equal(s.interceptFinal(LONG_INCOMPLETE, 3), true);
        const m = s.pickNudge(3)!;
        assert.ok(m.content.startsWith(FENCE.TODO_INCOMPLETE));
        assert.ok(m.content.includes("2 项未完成"));
        assert.ok(m.content.includes("补齐鉴权中间件") && m.content.includes("写集成测试"), "应列举未完成项");
        assert.ok(!m.content.includes("实现登录接口"), "已完成项不进列举");
    });

    it("清单全部 completed → 放行（不拦真实收尾）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [todoCall([
            { content: "任务A", status: "completed" },
            { content: "任务B", status: "completed" },
        ])]);
        assert.equal(s.interceptFinal("已全部完成，总结如下。", 3), false);
    });

    it("预算 1 次：拦截消费后第二次 final 放行（死循环保险）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [todoCall([{ content: "未竟之事", status: "pending" }])]);
        assert.equal(s.interceptFinal("已全部完成", 2), true);
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.TODO_INCOMPLETE));
        assert.equal(s.interceptFinal("已全部完成", 3), false, "预算已用尽");
    });

    it("中途 todo_write 全勾 → 快照以最后一次为准，放行", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [todoCall([{ content: "未竟之事", status: "pending" }])]);
        s.noteToolCall(2, [todoCall([{ content: "未竟之事", status: "completed" }])]);
        assert.equal(s.interceptFinal("已全部完成", 4), false);
    });

    it("优先级：TODO pending 高于 REPEAT（同轮双命中时先消费 TODO）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [
            todoCall([{ content: "未竟之事", status: "pending" }]),
            readCall("a.ts"), readCall("a.ts"), readCall("a.ts"),
        ]);
        assert.equal(s.interceptFinal("已全部完成", 2), true);
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.TODO_INCOMPLETE));
        assert.ok(s.pickNudge(3)!.content.startsWith(FENCE.REPEAT), "REPEAT pending 顺延消费");
    });
});

describe("pickNudge —— 周期自评与 pending 优先级", () => {
    it("第 41 / 81 轮周期 nudge（含轮次号），其余轮无", () => {
        const s = createNudgeScheduler();
        assert.equal(s.pickNudge(40), null);
        const m = s.pickNudge(41)!;
        assert.ok(m.content.startsWith(FENCE.NUDGE));
        assert.ok(m.content.includes("约 41 轮"));
        assert.equal(s.pickNudge(42), null);
        assert.ok(s.pickNudge(81)!.content.startsWith(FENCE.NUDGE));
    });

    it("pending 优先级：TOOL_DIGEST > REPEAT_RETRIEVAL > 周期", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts"), readCall("a.ts"), readCall("a.ts")]);
        assert.equal(s.interceptFinal("", 1), true);
        assert.ok(s.pickNudge(2)!.content.startsWith(FENCE.TOOL_DIGEST));
        assert.ok(s.pickNudge(3)!.content.startsWith(FENCE.REPEAT));
        assert.equal(s.pickNudge(4), null);
    });
});

describe("REPEAT_RETRIEVAL（重复检索检测）", () => {
    it("同路径第 3 次读取才触发（前两次属正常浏览）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        s.noteToolCall(2, [readCall("a.ts")]);
        assert.equal(s.pickNudge(3), null);
        s.noteToolCall(3, [readCall("a.ts")]);
        const m = s.pickNudge(4)!;
        assert.ok(m.content.startsWith(FENCE.REPEAT));
        assert.ok(m.content.includes("a.ts") && m.content.includes("第 3 次"));
    });

    it("改后重读合法：edit_file 重置该路径计数与 nudge 记录", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts")]);
        s.noteToolCall(2, [readCall("a.ts")]);
        s.noteToolCall(3, [editCall("a.ts")]);
        s.noteToolCall(4, [readCall("a.ts")]);
        s.noteToolCall(5, [readCall("a.ts")]);
        assert.equal(s.pickNudge(6), null, "重置后 2 次不触发");
        s.noteToolCall(6, [readCall("a.ts")]);
        assert.ok(s.pickNudge(7)!.content.startsWith(FENCE.REPEAT));
    });

    it("grep 同词第 2 次即触发；检索词归一（大小写 / 连续空白）", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [grepCall("Foo Bar")]);
        assert.equal(s.pickNudge(2), null);
        s.noteToolCall(2, [grepCall("foo  bar")]);
        const m = s.pickNudge(3)!;
        assert.ok(m.content.startsWith(FENCE.REPEAT));
        assert.ok(m.content.includes("foo bar"));
    });

    it("同一路径整个 run 只 nudge 一次", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts"), readCall("a.ts"), readCall("a.ts")]);
        assert.ok(s.pickNudge(2));
        s.noteToolCall(2, [readCall("a.ts"), readCall("a.ts"), readCall("a.ts")]);
        assert.equal(s.pickNudge(3), null, "已 nudge 过的路径不再重复");
    });

    it("单槽：待消费期间新命中不覆盖，消费后下次读取可再触发", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts"), readCall("a.ts"), readCall("a.ts")]);
        s.noteToolCall(2, [readCall("b.ts"), readCall("b.ts"), readCall("b.ts")]);
        assert.ok(s.pickNudge(3)!.content.includes("a.ts"), "仍是先到的 a.ts");
        s.noteToolCall(4, [readCall("b.ts")]);
        assert.ok(s.pickNudge(5)!.content.includes("b.ts"), "b.ts 第 4 次读取再触发");
    });

    it("REPEAT_NUDGE_MAX=3：推满 3 次后不再推", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("a.ts"), readCall("a.ts"), readCall("a.ts")]);
        assert.ok(s.pickNudge(2));
        s.noteToolCall(3, [readCall("b.ts"), readCall("b.ts"), readCall("b.ts")]);
        assert.ok(s.pickNudge(4));
        s.noteToolCall(5, [readCall("c.ts"), readCall("c.ts"), readCall("c.ts")]);
        assert.ok(s.pickNudge(6));
        s.noteToolCall(7, [readCall("d.ts"), readCall("d.ts"), readCall("d.ts")]);
        assert.equal(s.pickNudge(8), null, "预算 3 次已用尽");
    });

    it("路径归一：盘符大小写与反斜杠视为同一文件", () => {
        const s = createNudgeScheduler();
        s.noteToolCall(1, [readCall("d:\\src\\Foo.ts")]);
        s.noteToolCall(2, [readCall("D:/src/Foo.ts")]);
        assert.equal(s.pickNudge(3), null);
        s.noteToolCall(3, [readCall("D:\\src\\Foo.ts")]);
        const m = s.pickNudge(4)!;
        assert.ok(m.content.includes("D:/src/Foo.ts"));
    });
});

/**
 * 判定词表钉（2026-09-15，后续路线 #2 顺手项）：looksComplete / looksComplex 的词表是
 * 「文案即协议」软契约——注释自己承认关键词覆盖不可靠（TOOL_DIGEST 已因漏判改长度阈值）。
 * 改词表 = 改守护触发行为，必须 conscious 更新本镜像；此处逐字钉源码声明行，任何增删词都红。
 */
describe("判定词表钉（防静默漂移）", () => {
    // 行尾归一化（源文件 CRLF / 镜像 LF）：比较只关心词表内容，不关心行尾
    const source = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/agent/agentNudges.ts"),
        "utf8",
    ).replace(/\r\n/g, "\n");

    const PINNED_DECLARATIONS: Array<[string, string]> = [
        ["COMPLEX_VERBS（looksComplex 动词表）", "const COMPLEX_VERBS = /实现|新增|添加|重构|改造|迁移|重写|拆分|升级|开发|编写|构建|集成|支持|完善|implement|refactor|migrate|rewrite|rebuild|restructure|split|upgrade|integrate|develop/i;"],
        ["COMPLEX_OBJECTS（looksComplex 对象表）", "const COMPLEX_OBJECTS = /功能|模块|系统|架构|流程|机制|组件|服务|页面|接口|能力|特性|面板|feature|module|system|architecture|pipeline|component|service|page|api\\b|interface|panel|workflow|endpoint/i;"],
        ["COMPLEX_MARKERS（looksComplex 显式标记表）", "const COMPLEX_MARKERS = /多个文件|多文件|整体|全套|端到端|从零|重新设计|一整套|跨[^，。\\s]{1,6}|multiple files|multi-file|end-to-end|from scratch|across\\s+\\S+/i;"],
        ["QUERY_LEAD（问答开头豁免表）", "const QUERY_LEAD = /^(请)?\\s*(解释|说明|查(一下|询)?|搜索|搜一下|怎么看|如何(用|使用|配置|启动)|怎么用|为什么|是什么|帮我看看|分析一下|检查|review|对比|评价)/i;"],
        ["looksComplete（完成声明词表）", "const looksComplete = (text: string): boolean =>\n    /已完成|已修改|已创建|已删除|已重构|已实现|已修复|已替换|已更新|已配置|已验证|已提交|已全部|全部完成|改造完成|修改完成|实现完成|测试通过|总结(一下)?|以上就是|done|finished|completed/i.test(text || \"\");"],
    ];

    for (const [name, pinned] of PINNED_DECLARATIONS) {
        it(`${name} 逐字一致（改动须 conscious 更新此镜像）`, () => {
            assert.ok(source.includes(pinned), `词表已漂移：${name}\n期望逐字包含：\n${pinned}`);
        });
    }
});
