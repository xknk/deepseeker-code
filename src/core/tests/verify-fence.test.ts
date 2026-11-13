/**
 * @file tests/verify-fence.test.ts
 * @description VERIFY_UNPROVEN 判据行为锁（T1，施工单 2026-11-13 §2.4 十用例，零 API 成本）。
 *  判据：本 run 改过代码文件（ok===true 的写工具 + 代码扩展名）→ 收尾时既无成功验证命令、
 *  文案也未交代 → 记一次 hit。三档：dry 只记账不推轮（默认）/ on 真拦 / off 全关。
 *  ★ 用例 2/5/6 是终审 Q4 改法带来的行为变化：以前「不命中」的三个场景现在都返回 hit（带 disposition）
 *    ——它们是 §5 Gate 的同源分母（would_fire 率 = fired/(fired+verified+disclaimed)）。
 *  ★ 已知漏洞故意保留（施工单 §2.3）：isVerifyCommand 对 `echo "test"` 同样放行——方向是宁多认少拦，
 *    与降噪目标一致；本注释就是防止后来者当 bug 去修的坑标。
 *  agentNudges 为纯模块：本文件不触网、不需要任何 env（verifyFenceMode 经 opts 显式注入）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createNudgeScheduler } from "@/agent/agentNudges.ts";

/** 造一个成功写工具结局（edit_file .ts 代码文件）。 */
const editOk = (s = createNudgeScheduler(), path = "src/a.ts") => s.noteToolOutcome("edit_file", { path }, true);
/** 造一个成功命令结局。 */
const cmdOk = (s: ReturnType<typeof createNudgeScheduler>, command: string) => s.noteToolOutcome("run_command", { command }, true);

describe("VERIFY_UNPROVEN（T1 dry-run 判据）", () => {
    it("用例1: 成功 edit_file(.ts) → 无命令 → final：dry 档 hit fired + injected:false；on 档 injected:true", () => {
        const dry = createNudgeScheduler({ verifyFenceMode: "dry" });
        editOk(dry);
        const hit = dry.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit, "dry 档也必须返回 hit（Gate 分母）");
        assert.equal(hit.fence, "VERIFY_UNPROVEN");
        assert.equal(hit.disposition, "fired");
        assert.equal(hit.injected, false, "dry 档不推轮");

        const on = createNudgeScheduler({ verifyFenceMode: "on" });
        editOk(on);
        const hitOn = on.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hitOn);
        assert.equal(hitOn.fence, "VERIFY_UNPROVEN");
        assert.equal(hitOn.disposition, "fired");
        assert.equal(hitOn.injected, true, "on 档真拦（推一轮）");
    });

    it("用例2: 成功编辑 → npm test 成功 → final：verified 记账不拦；同 run 再 final 不再命中（每周期只报一次）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        editOk(s);
        cmdOk(s, "npm test");
        const hit = s.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit, "verified 也必须返回 hit（Gate 分母）");
        assert.equal(hit.disposition, "verified");
        assert.equal(hit.injected, false, "已验证不拦");
        assert.equal(s.interceptFinal("改动完成，输出如下。", 3), null, "已报过，同 arm 周期不再命中");
    });

    it("用例3: 失败的 edit_file（ok:false）→ final：不命中（失败的编辑不算改过）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        s.noteToolOutcome("edit_file", { path: "src/a.ts" }, false);
        assert.equal(s.interceptFinal("改动完成，输出如下。", 2), null);
    });

    it("用例4: edit_file('README.md') → final：不命中（非代码扩展名不武装）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        s.noteToolOutcome("edit_file", { path: "README.md" }, true);
        assert.equal(s.interceptFinal("文档更新完毕。", 2), null);
    });

    it("用例5: edit_file(.ts) → git 只读子命令成功 → final：仍 fired（git checkout 不解除武装）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        editOk(s);
        cmdOk(s, "git checkout -- src/a.ts");
        const hit = s.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit);
        assert.equal(hit.disposition, "fired", "git 只读子命令不是验证，不解除武装");
    });

    it("用例6: edit_file(.ts) → finalText 含「未跑测试」：disclaimed 记账不推轮（免责预检先于拦截）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        editOk(s);
        const hit = s.interceptFinal("改动已完成，但未跑测试，建议用户自行验证后再合入。", 2);
        assert.ok(hit, "disclaimed 也必须返回 hit（Gate 分母）");
        assert.equal(hit.disposition, "disclaimed");
        assert.equal(hit.injected, false, "已交代不推轮");
    });

    it("用例7: fired 被放行后，同 run 再 final：不再命中（预算每 arm 周期 1 次）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        editOk(s);
        const hit1 = s.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit1 && hit1.disposition === "fired");
        assert.equal(s.interceptFinal("改动完成，输出如下。", 3), null, "已报过 fired，不再重复");
    });

    it("用例8: off 档全场景：不命中（连 hit 都不发；事件层零 emit 由 nudge-metering 端到端钉）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "off" });
        editOk(s);                                        // 武装路径
        assert.equal(s.interceptFinal("改动完成，输出如下。", 2), null);
        assert.equal(s.interceptFinal("未跑测试，风险自担。", 3), null);   // 免责路径也不发
        const s2 = createNudgeScheduler({ verifyFenceMode: "off" });
        editOk(s2);
        cmdOk(s2, "npm test");
        assert.equal(s2.interceptFinal("改动完成，输出如下。", 2), null);  // verified 路径也不发
    });

    it("用例9: 武装 → verified 已报过 → 再改代码 → final 无验证：再次命中 fired（arm 周期重置）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        editOk(s);
        cmdOk(s, "npm test");
        const hit1 = s.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit1 && hit1.disposition === "verified");
        editOk(s, "src/b.ts");                            // 再改代码 = 新 arm 周期（清 verifyDone + verifyReported）
        const hit2 = s.interceptFinal("改动完成，输出如下。", 3);
        assert.ok(hit2, "arm 周期重置后必须可再命中，否则一轮只算一次");
        assert.equal(hit2.disposition, "fired");
        assert.equal(hit2.injected, false);
    });

    it("用例10: on 档 fired → 下一轮 pickNudge 消费 pending（带 disposition:'fired' 供 :334 记账透传）", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "on" });
        editOk(s);
        const hit = s.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit && hit.injected, "on 档 fired injected:true");
        const pending = s.pickNudge(3);
        assert.ok(pending, "下一轮 pickNudge 必须消费 verifyPending");
        assert.match(pending.content, /⟦DSC:VERIFY_UNPROVEN⟧/, "pending 首行是 fence 行（:334 依此解析 fence）");
        assert.equal(pending.disposition, "fired", "disposition 随 pending 透传（§2.2⑤）");
        assert.match(pending.content, /已重读确认/, "文案必须显式包含「已重读确认」出口（§2.2② ★）");
        assert.equal(s.pickNudge(4), null, "pending 一次性消费");
    });

    it("红线场景: planMode 不判定 / depth>0（子 agent）不判定", () => {
        const plan = createNudgeScheduler({ verifyFenceMode: "dry", planMode: true });
        editOk(plan);
        assert.equal(plan.interceptFinal("改动完成，输出如下。", 2), null, "计划模式写操作本就被拒，不判定");

        const sub = createNudgeScheduler({ verifyFenceMode: "dry", depth: 1 });
        editOk(sub);
        assert.equal(sub.interceptFinal("改动完成，输出如下。", 2), null, "子 agent 不判定");
    });

    it("武装只认代码扩展名写工具；run_command 参数缺失/失败命令不解除", () => {
        const s = createNudgeScheduler({ verifyFenceMode: "dry" });
        s.noteToolOutcome("write_file", { path: "lib/x.py" }, true);   // write_file 同样武装
        const hit = s.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit && hit.disposition === "fired", "非 edit_file 的写工具命中 CODE_EXT 也武装");

        const s2 = createNudgeScheduler({ verifyFenceMode: "dry" });
        editOk(s2);
        s2.noteToolOutcome("run_command", {}, true);                   // 无 command 参数
        s2.noteToolOutcome("run_command", { command: "npm test" }, false); // 失败命令不算验证
        const hit2 = s2.interceptFinal("改动完成，输出如下。", 2);
        assert.ok(hit2 && hit2.disposition === "fired", "失败/缺参命令不解除武装");
    });
});
