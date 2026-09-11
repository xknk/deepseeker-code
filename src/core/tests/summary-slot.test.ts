/**
 * @file tests/summary-slot.test.ts
 * @description 摘要槽不变式守护测试（guardian test）。
 *  硬约定：message[0] = 系统提示词、message[1] = 滚动摘要槽——被 ensureFitsWindow / recall /
 *  前缀指纹（streamInference prefixFingerprint）/ P0-4 前缀缓存策略强依赖，错位会以
 *  「压缩错位、缓存击穿」这类隐蔽方式炸掉而非直接报错。
 *  唯一执行点：truncate.ts 的 ensureSummarySlot（运行时断言 + 自愈）。本测试钉住其契约：
 *  ①空数组建双槽 ②非 system 头部补 system ③占位是「插入」不吞消息 ④幂等不重复。
 *  谁动了前两个下标的约定或 ensureSummarySlot 的自愈语义，本测试立刻红。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 沙盒惯例：dataDir 指向临时目录，防模块初始化读真实 ~/.deepseeker-code。
// env 必须在 import core 之前设置 → 动态 import（ESM 静态 import 提升会先执行模块初始化，同 checkpoint 测试惯例）。
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "dsc-summary-slot-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

const { ensureSummarySlot } = await import("@/agent/truncate.ts");

const msg = (role: string, content: string) => ({ role, content } as any);

describe("ensureSummarySlot 槽位不变式守护（message[0]=system / message[1]=摘要槽）", () => {
    it("空数组：建出双槽（system 占位 + 摘要槽占位）", () => {
        const arr: any[] = [];
        ensureSummarySlot(arr);
        assert.equal(arr.length, 2, "应恰好建出 2 个槽位");
        assert.equal(arr[0].role, "system", "message[0] 必须为 system");
        assert.equal(arr[1].role, "system", "message[1] 必须为 system（摘要槽）");
    });

    it("头部非 system：unshift 补 system，原有消息完整保留、顺序不变", () => {
        const arr = [msg("user", "hello"), msg("assistant", "hi")];
        ensureSummarySlot(arr);
        assert.equal(arr.length, 4, "补 1 个 system + 1 个摘要槽，原 2 条不丢");
        assert.equal(arr[0].role, "system");
        assert.equal(arr[1].role, "system");
        assert.equal(arr[2].content, "hello", "原 user 消息不得丢失");
        assert.equal(arr[3].content, "hi");
    });

    it("message[0]=system 但 message[1] 非 system：摘要槽插入而非覆盖", () => {
        const arr = [msg("system", "SYSTEM_PROMPT"), msg("user", "q1"), msg("assistant", "a1")];
        ensureSummarySlot(arr);
        assert.equal(arr.length, 4, "插入摘要槽，原消息不丢");
        assert.equal(arr[0].role, "system");
        assert.equal(arr[0].content, "SYSTEM_PROMPT", "既有系统提示词不得被占位覆写");
        assert.equal(arr[1].role, "system", "message[1] 必须补成摘要槽");
        assert.equal(arr[2].content, "q1", "原 user 消息后移但保留");
        assert.equal(arr[3].content, "a1");
    });

    it("已合规（双 system 头）：幂等 no-op，不重复插槽", () => {
        const arr = [msg("system", "SYSTEM_PROMPT"), msg("system", "SUMMARY"), msg("user", "q")];
        ensureSummarySlot(arr);
        assert.equal(arr.length, 3, "合规数组不得增删任何消息");
        assert.equal(arr[0].content, "SYSTEM_PROMPT");
        assert.equal(arr[1].content, "SUMMARY", "既有摘要槽内容不得被占位覆写");
    });

    it("幂等性：连续调用两次结果与一次相同（防调用点重排后重复插槽）", () => {
        const arr = [msg("user", "q")];
        ensureSummarySlot(arr);
        ensureSummarySlot(arr);
        assert.equal(arr.length, 3, "1 条原消息 + 双槽，第二次调用应为 no-op");
        assert.equal(arr[0].role, "system");
        assert.equal(arr[1].role, "system");
        assert.equal(arr[2].content, "q", "原 user 消息保留");
        assert.equal(arr.filter((m) => m.role === "system").length, 2, "system 消息恰好 2 条（双槽），不得累积");
    });
});
