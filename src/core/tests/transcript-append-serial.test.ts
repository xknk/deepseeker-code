/**
 * @file tests/transcript-append-serial.test.ts
 * @description 评审修复施工单 A4（2026-11-23，X1）守门：转录 append 按路径串行化。
 *
 *  修前向量（评审实测复现）：appendLineWithRetry 的字节水位是跨 await 的非原子读改写——同一进程两个
 *  append 重叠（agentWake 转录回退分支 vs 主 run 同文件）时，后完成者把水位写低；之后任一次落盘失败的
 *  fs.truncate(p, beforeSize) 会把此前已成功写入的行截掉（丢消息且半行损坏）。
 *  修后契约：同路径 append 串行执行（水位读改写原子）；失败不阻断后续排队；错误经本条 promise 抛出
 *  （appendMessage 如实返回 false）；截断回滚与水位语义保持（红线）。
 *
 *  失败注入：mock.method 打在共享的 fs/promises 默认导出对象上（transcript.ts 调用点为属性读取，
 *  运行时命中补丁；node 内建模块对象不受 @/ 别名双实例坑影响）。退避 sleep 50/100ms 为真实节奏。
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fsp from "fs/promises";
import os from "node:os";
import path from "node:path";

const SANDBOX = await fsp.mkdtemp(path.join(os.tmpdir(), "dsc-append-serial-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;

// ★ 全部走 "@/" 别名导入：与 core 内部代码同 specifier → 同一模块实例（tsx 双实例坑）。
const { appendMessage, appendMessages } = await import("@/session/transcript.ts");
const { getTranscriptPath } = await import("@/session/store.ts");

const fsPromises = (await import("fs/promises")).default;
const realAppend = fsp.appendFile.bind(fsp);

/** 失败注入旋钮：failAll = 全部失败（重试耗尽路径）；failNextRest = 下一批调用里失败几个。
 *  currentImpl = 可替换实现（半行注入用），缺省按旋钮放行/拒绝。 */
let failAll = false;
let failNextRest = 0;
let currentImpl: (file: any, data: any, opts: any) => Promise<unknown> = (file, data, opts) => {
    if (failAll) throw Object.assign(new Error("EFAIL mock（杀软锁盘）"), { code: "EBUSY" });
    if (failNextRest > 0) { failNextRest--; throw Object.assign(new Error("EBUSY mock"), { code: "EBUSY" }); }
    return realAppend(file, data, opts);
};
mock.method(fsPromises, "appendFile", (file: any, data: any, opts: any) => currentImpl(file, data, opts));

/** 原始文本逐行 JSON.parse（不走 readTranscriptLines 的坏行跳过——坏行必须显式暴露）。 */
const rawLines = async (sessionId: string): Promise<any[]> => {
    const text = await fsp.readFile(getTranscriptPath(sessionId), "utf-8");
    return text.split("\n").filter(s => s.trim().length > 0).map(s => JSON.parse(s));
};

const mkEntry = (i: number, pad = 0) => ({ sessionId: "", role: "user" as const, content: `msg-${i}${"x".repeat(pad)}` });

describe("转录 append 串行化（评审修复 A4）", () => {
    it("复现向量：两次并发 append 后注入一次失败 → 行数不减少、每行可解析（修前丢 1 行已成功消息）", async () => {
        const sid = "serial-vector";
        // 夹具自证：并发对里第一条必须比第二条长——修前「后完成者写低水位」的差值 > 0，失败截断必然切掉长条的尾字节
        const long = { ...mkEntry(3, 2000), sessionId: sid };
        const short = { ...mkEntry(4), sessionId: sid };
        assert.ok(Buffer.byteLength(JSON.stringify(long)) > Buffer.byteLength(JSON.stringify(short)), "夹具有效性");
        assert.equal(await appendMessage({ ...mkEntry(1), sessionId: sid } as any), true);
        assert.equal(await appendMessage({ ...mkEntry(2), sessionId: sid } as any), true);

        // 并发窗口：两条重叠（修前：后完成者把水位写低）
        await Promise.all([appendMessage(long as any), appendMessage(short as any)]);
        // 注入一次彻底失败的 append（修前：fs.truncate 到旧的小水位 → 切掉已成功写入的行尾）
        failAll = true;
        const failed = await appendMessage({ ...mkEntry(5), sessionId: sid } as any);
        failAll = false;
        assert.equal(failed, false, "失败如实回报（appendMessage 返回 false）");

        const lines = await rawLines(sid);
        assert.equal(lines.length, 4, "此前已成功写入的 4 行一条不少（修前会丢行/半行）");
        for (const l of lines) assert.ok(l && typeof l === "object", "每行均可 JSON.parse");
        // 串行 await 的两条顺序确定；并发对的入队序不等于调用序（ensureSessionsDir await 恢复序决定），
        // 断言集合完整即可——完整性才是本卡的守门点（修前此处会丢行/半行）。
        assert.deepEqual(lines.slice(0, 2).map((l: any) => String(l.content).replace(/x+$/, "")), ["msg-1", "msg-2"]);
        assert.deepEqual(
            lines.slice(2).map((l: any) => String(l.content).replace(/x+$/, "")).sort(),
            ["msg-3", "msg-4"],
        );
    });

    it("20 个并发 append：全部落盘、无半行、内容一条不少（水位保持精确）", async () => {
        const sid = "serial-20";
        const entries = Array.from({ length: 20 }, (_, i) => ({ ...mkEntry(i), sessionId: sid }));
        const results = await Promise.all(entries.map(e => appendMessage(e as any)));
        assert.ok(results.every(r => r === true), "20 条全部落盘成功");
        const lines = await rawLines(sid);
        assert.equal(lines.length, 20);
        // 注：appendMessage 在入链前先 await ensureSessionsDir，并发恢复序不等于调用序——
        // 串行链保证的是【入队序落盘 + 水位原子】，全局调用序在 A4 落点上游即不确定（修前亦然）。
        assert.deepEqual(
            [...lines.map((l: any) => l.content)].sort(),
            [...entries.map(e => e.content)].sort(),
            "20 条内容一条不少（无半行、无丢失；rawLines 逐行 JSON.parse 已隐式断言无半行）",
        );
        // 逐条串行 await：顺序确定保持（链入队序 = await 序）
        await appendMessage({ ...mkEntry(90), sessionId: sid } as any);
        await appendMessage({ ...mkEntry(91), sessionId: sid } as any);
        const after = await rawLines(sid);
        assert.equal(after.length, 22);
        assert.deepEqual(after.slice(-2).map((l: any) => l.content), ["msg-90", "msg-91"], "串行 await 顺序保持");
        // 注入失败验证水位未被并发写低：truncate 目标=文件尾，一行不丢
        failAll = true;
        await appendMessage({ ...mkEntry(99), sessionId: sid } as any);
        failAll = false;
        assert.equal((await rawLines(sid)).length, 22, "失败截断不吞此前已写入的行");
    });

    it("既有「部分写入后截断再重试」语义经串行包装保持：半行被回滚、重试恰好补全不重复", async () => {
        const sid = "serial-partial";
        assert.equal(await appendMessage({ ...mkEntry(1), sessionId: sid } as any), true);
        // 注入：第一次 appendFile 先落半截 payload 再抛错（磁盘满/中断的真实形态），此后调用放行
        let halfDone = false;
        const base = currentImpl;
        currentImpl = async (file, data, opts) => {
            if (!halfDone) {
                halfDone = true;
                const s = String(data);
                await realAppend(file, s.slice(0, Math.floor(s.length / 2)), opts);   // 半行落盘
                throw Object.assign(new Error("ENOSPC mock"), { code: "ENOSPC" });
            }
            return base(file, data, opts);   // 重试尝试走原路径（含 failAll 旋钮）
        };
        const ok = await appendMessage({ ...mkEntry(2, 300), sessionId: sid } as any);
        currentImpl = base;
        assert.equal(ok, true, "重试后成功");
        const lines = await rawLines(sid);
        assert.equal(lines.length, 2, "半行被截断回滚，恰好两行完整记录（无半行+全行）");
        assert.equal(lines[1].content, `msg-2${"x".repeat(300)}`, "重试行内容完整");
    });

    it("批量路径 appendMessages（handle 快路径）串行兼容：批内顺序落盘、计数如实", async () => {
        const sid = "serial-batch";
        const entries = [1, 2, 3].map(i => ({ ...mkEntry(i * 10), sessionId: sid }));
        const res = await appendMessages(sid, entries as any);
        assert.deepEqual(res, { written: 3, failed: 0 });
        const lines = await rawLines(sid);
        assert.equal(lines.length, 3);
        assert.deepEqual(lines.map((l: any) => l.content), entries.map(e => e.content), "批内顺序与请求序一致");
    });
});
