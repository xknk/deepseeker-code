/**
 * @file tests/command.test.ts
 * @description run_command 的 outputFilter 单测：验证长构建/测试日志的 toModel/toUser 分流。
 *  - toUser：恒为全文（用户回看完整日志）
 *  - toModel：≤ HEAD+TAIL(60) 行原样；超出则保留首 20 行 + 末 40 行 + 省略标注（省 token，保留 EXIT 哨兵与首尾报错）
 *  该分流是确定性纯函数，写入 message 后不变，不破坏 DeepSeek 前缀缓存。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandTools } from "@/tool/registry/command.ts";

const runCommand = commandTools.find(t => t.function.name === "run_command");
const outputFilter = runCommand?.function.outputFilter;

describe("run_command outputFilter（toModel/toUser 分流）", () => {
    it("工具已挂载 outputFilter", () => {
        assert.ok(runCommand, "run_command 工具应存在");
        assert.equal(typeof outputFilter, "function", "run_command 应挂载 outputFilter");
    });

    it("短输出（30 行 ≤ 60）：toModel 与 toUser 均为原文，不截断", () => {
        const short = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
        const r = outputFilter!(short);
        assert.equal(r.toUser, short);
        assert.equal(r.toModel, short);
    });

    it("边界 60 行：恰好不截断，toModel === toUser", () => {
        const boundary = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
        const r = outputFilter!(boundary);
        assert.equal(r.toModel, boundary);
        assert.equal(r.toUser, boundary);
    });

    it("刚超阈值 61 行：触发截断，省略中间 1 行", () => {
        const lines = Array.from({ length: 61 }, (_, i) => `line ${i}`);
        const r = outputFilter!(lines.join("\n"));
        assert.equal(r.toUser, lines.join("\n"), "toUser 恒为全文");
        assert.match(r.toModel, /已省略中间约 1 行/);
        assert.match(r.toModel, /line 0/, "保留首行");
        assert.match(r.toModel, /line 60/, "保留末行");
    });

    it("长输出（200 行）：toUser 全文，toModel 首 20 + 末 40 + 省略 140 行，且更短", () => {
        const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
        const long = lines.join("\n");
        const r = outputFilter!(long);
        assert.equal(r.toUser, long, "用户看全文");
        assert.match(r.toModel, /已省略中间约 140 行/, "200 - 20 - 40 = 140");
        assert.match(r.toModel, /line 0/, "含首部");
        assert.match(r.toModel, /line 199/, "含尾部（EXIT 哨兵与报错高发区）");
        assert.ok(r.toModel.length < r.toUser.length, "toModel 必须比 toUser 短，否则未起到省 token 作用");
        // 中段被裁：line 50 不应出现在 toModel（它在首 20 行之后、末 40 行之前）
        assert.doesNotMatch(r.toModel, /\bline 50\b/, "中段行应被裁掉");
    });
});
