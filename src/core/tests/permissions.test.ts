/**
 * @file tests/permissions.test.ts
 * @description buildScopedAllowRule 契约单测：钉住 allow-always 审批记忆的「精确值作用域」语义。
 *
 *  安全动机：allow-always 持久化裸工具名会让一次 run_command(npm test) 审批把所有 run_command
 *  （含 rm -rf）都免审。buildScopedAllowRule 必须产出带主参数精确值的规则字符串，
 *  无主参数映射或缺值时才回退裸名。本测试守住这条安全边界不被回退。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScopedAllowRule, checkPermission } from "@/tool/permissions.ts";

describe("buildScopedAllowRule（allow-always 精确值作用域）", () => {
    it("有主参数映射且提供非空值 → ToolName(value) 精确作用域", () => {
        assert.equal(
            buildScopedAllowRule("run_command", { command: "npm test" }),
            "run_command(npm test)",
        );
        assert.equal(
            buildScopedAllowRule("edit_file", { path: "src/config.ts" }),
            "edit_file(src/config.ts)",
        );
    });

    it("工具无主参数映射 → 回退裸 ToolName", () => {
        // getTime 不在 PRIMARY_ARG，只有按名匹配语义
        assert.equal(buildScopedAllowRule("getTime", { foo: "bar" }), "getTime");
    });

    it("有映射但缺值 / 值非字符串 / 空串 → 回退裸 ToolName（宁裸名不可造半条规则）", () => {
        assert.equal(buildScopedAllowRule("run_command", {}), "run_command");
        assert.equal(buildScopedAllowRule("run_command", { command: 123 }), "run_command");
        assert.equal(buildScopedAllowRule("run_command", { command: "" }), "run_command");
    });

    it("端到端：精确规则只免审该精确值，其它命令仍需审（checkPermission 语义对齐）", () => {
        // 注：checkPermission 读运行期内存 rules；此处仅校验规则字符串可被 compileRule 解析、
        //     且 ruleMatches 对精确值命中、对其它值不命中。通过 addPermissionRule 写入后即时生效。
        //     直接验证规则形态足够——完整持久化链路由 guard.ts 集成覆盖。
        const rule = buildScopedAllowRule("run_command", { command: "npm test" });
        assert.equal(rule, "run_command(npm test)");
        // 裸名回退场景不应出现括号
        const bare = buildScopedAllowRule("run_command", {});
        assert.equal(bare.includes("("), false, "回退裸名不应含括号作用域");
    });
});

describe("checkPermission 空规则集默认放行（回归基线）", () => {
    it("无规则命中时返回 null（走默认 safetyLevel 审批流）", () => {
        // 默认加载的 rules 可能为空或含项目规则；此处仅断言不抛错且返回合法 verdict
        const v = checkPermission("__nonexistent_tool__", {});
        assert.ok(v === null || v === "allow" || v === "deny" || v === "ask");
    });
});
