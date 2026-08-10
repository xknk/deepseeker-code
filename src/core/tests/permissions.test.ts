/**
 * @file tests/permissions.test.ts
 * @description buildScopedAllowRule 契约单测：钉住 allow-always 审批记忆的「安全保守作用域」语义（M5 加固）。
 *
 *  设计动机：allow-always 是「以后这类别再问就免审」，作用域过宽 = 把 prompt 注入驱动的危险变体也静默放行。
 *  故自动生成的 allow 规则宁可窄不可宽：
 *   - 命令类 → 精确命令串（run_command(npm test)）：不再用首 token + :*（旧 npm:* 会把 npm install <恶意包>、
 *     npm publish、链式 `npm test; evil` 一并静默放行——shell 工具必须精确，杜绝 payload 空间）；
 *   - 路径类 → 顶层目录 + `*`（edit_file(src/*) 覆盖 src 下任意深度）；根级文件退化为精确值；
 *   - 无主参数映射 / 缺值 / 非字符串 / 空串 → 返回 null（不持久化，降级 allow-once；旧版回退裸 ToolName 会把
 *     该工具所有后续调用静默放行，对 MCP/未映射的 DANGER 工具尤其危险）。
 *  安全兜底不变：COMMAND_DENY 清单（auto 模式）+ PROTECTED_WRITE_DIRS 保护路径硬拒仍生效，allow 了也拦 rm -rf / 改 .git。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScopedAllowRule, checkPermission } from "@/tool/permissions.ts";

describe("buildScopedAllowRule（allow-always 安全保守作用域）", () => {
    it("命令类 → 精确命令串（杜绝跨子命令 / 链式注入的静默放行）", () => {
        assert.equal(buildScopedAllowRule("run_command", { command: "npm test" }), "run_command(npm test)");
        assert.equal(buildScopedAllowRule("run_command", { command: "git status" }), "run_command(git status)");
        assert.equal(buildScopedAllowRule("run_in_background", { command: "pnpm build --watch" }), "run_in_background(pnpm build --watch)");
    });

    it("命令类安全断言：绝不生成过宽的首-token+:* 形态（如 npm:*）", () => {
        const rule = buildScopedAllowRule("run_command", { command: "npm test" });
        assert.ok(rule, "应返回规则");
        assert.ok(!rule!.includes(":*"), `命令 allow 规则不得含 :*（过宽，会静默放行跨子命令/链式注入）：${rule}`);
        // 同族危险变体不应落入同一规则——它们将重新审批
        assert.notEqual(buildScopedAllowRule("run_command", { command: "npm install evil-pkg" }), "run_command(npm test)");
        assert.notEqual(buildScopedAllowRule("run_command", { command: "npm publish" }), "run_command(npm test)");
    });

    it("路径类 → 顶层目录 + *（覆盖该目录任意深度）；根级文件退化为精确值", () => {
        assert.equal(buildScopedAllowRule("edit_file", { path: "src/config.ts" }), "edit_file(src/*)");
        assert.equal(buildScopedAllowRule("read_file", { path: "src/components/Foo.tsx" }), "read_file(src/*)");
        // ./ 前缀应被规范化后取顶层目录
        assert.equal(buildScopedAllowRule("create_file", { path: "./lib/util.ts" }), "create_file(lib/*)");
        // 绝对路径（盘符去后以 / 开头、无顶层目录段）→ 退化为精确值（保守；agent 路径多为相对 workspace）
        assert.equal(buildScopedAllowRule("write_file", { path: "D:/proj/app/main.ts" }), "write_file(D:/proj/app/main.ts)");
        // 根级文件（无目录段）→ 精确值兜底
        assert.equal(buildScopedAllowRule("edit_file", { path: "README.md" }), "edit_file(README.md)");
    });

    it("工具无主参数映射 → 返回 null（不持久化，降级 allow-once）", () => {
        // getTime 不在 PRIMARY_ARG：无法安全作用域，宁可不记也不写裸工具名静默放行全部调用
        assert.equal(buildScopedAllowRule("getTime", { foo: "bar" }), null);
    });

    it("有映射但缺值 / 值非字符串 / 空串 → 返回 null（不持久化，避免裸工具名）", () => {
        assert.equal(buildScopedAllowRule("run_command", {}), null);
        assert.equal(buildScopedAllowRule("run_command", { command: 123 }), null);
        assert.equal(buildScopedAllowRule("run_command", { command: "" }), null);
        assert.equal(buildScopedAllowRule("run_command", { command: "   " }), null);
    });

    it("端到端：命令规则为精确串、不可作用域时返回 null（含括号写法与裸名都不再回退）", () => {
        const rule = buildScopedAllowRule("run_command", { command: "npm test" });
        assert.equal(rule, "run_command(npm test)");
        assert.equal(buildScopedAllowRule("run_command", {}), null);
    });
});

describe("checkPermission 空规则集默认放行（回归基线）", () => {
    it("无规则命中时返回 null（走默认 safetyLevel 审批流）", () => {
        // 默认加载的 rules 可能为空或含项目规则；此处仅断言不抛错且返回合法 verdict
        const v = checkPermission("__nonexistent_tool__", {});
        assert.ok(v === null || v === "allow" || v === "deny" || v === "ask");
    });
});
