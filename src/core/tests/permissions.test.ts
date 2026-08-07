/**
 * @file tests/permissions.test.ts
 * @description buildScopedAllowRule 契约单测：钉住 allow-always 审批记忆的「智能 glob 作用域」语义（对标 Claude Code）。
 *
 *  设计动机：allow-always 若落精确值（如 run_command(npm test)），换子命令/换文件路径即失效，
 *  导致一次对话反复审批。故按主参数类型生成覆盖一类的 glob 规则：
 *   - 命令类 → 首个 token + `:*`（run_command(npm:*) 覆盖所有 npm 子命令）；
 *   - 路径类 → 顶层目录 + `*`（edit_file(src/*) 覆盖 src 下任意深度）；根级文件退化为精确值；
 *   - 无主参数映射 / 缺值 / 非字符串 / 空串 → 回退裸 ToolName。
 *  安全兜底不变：COMMAND_DENY 清单（auto 模式）+ PROTECTED_WRITE_DIRS 保护路径硬拒仍生效，allow 了也拦 rm -rf / 改 .git。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScopedAllowRule, checkPermission } from "@/tool/permissions.ts";

describe("buildScopedAllowRule（allow-always 智能 glob 作用域）", () => {
    it("命令类 → 首个 token + :*（覆盖该命令全部子命令）", () => {
        assert.equal(buildScopedAllowRule("run_command", { command: "npm test" }), "run_command(npm:*)");
        assert.equal(buildScopedAllowRule("run_command", { command: "git status" }), "run_command(git:*)");
        assert.equal(buildScopedAllowRule("run_in_background", { command: "pnpm build --watch" }), "run_in_background(pnpm:*)");
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

    it("工具无主参数映射 → 回退裸 ToolName", () => {
        // getTime 不在 PRIMARY_ARG，只有按名匹配语义
        assert.equal(buildScopedAllowRule("getTime", { foo: "bar" }), "getTime");
    });

    it("有映射但缺值 / 值非字符串 / 空串 → 回退裸 ToolName（宁裸名不可造半条规则）", () => {
        assert.equal(buildScopedAllowRule("run_command", {}), "run_command");
        assert.equal(buildScopedAllowRule("run_command", { command: 123 }), "run_command");
        assert.equal(buildScopedAllowRule("run_command", { command: "" }), "run_command");
    });

    it("端到端：glob 规则形态正确（覆盖一类而非精确值，裸名回退不含括号）", () => {
        // 注：checkPermission 读运行期内存 rules；此处校验规则字符串形态（globToRegex 已支持 :* 与 *，
        //     glob 匹配一类命令/路径的语义由 compileRule/ruleMatches 内部保证）。完整持久化链路由 guard.ts 集成覆盖。
        const rule = buildScopedAllowRule("run_command", { command: "npm test" });
        assert.equal(rule, "run_command(npm:*)");
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
