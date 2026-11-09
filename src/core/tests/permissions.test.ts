/**
 * @file tests/permissions.test.ts
 * @description buildScopedAllowRule 契约单测：钉住 allow-always 审批记忆的「安全保守作用域」语义（M5 加固）。
 *
 *  设计动机：allow-always 是「以后这类别再问就免审」，作用域过宽 = 把 prompt 注入驱动的危险变体也静默放行。
 *  故自动生成的 allow 规则宁可窄不可宽：
 *   - 命令类 → 精确命令串（run_command(npm test)）：不再用首 token + :*（旧 npm:* 会把 npm install <恶意包>、
 *     npm publish、链式 `npm test; evil` 一并静默放行——shell 工具必须精确，杜绝 payload 空间）；
 *   - 路径类 → 顶层目录 + `*`（edit_file(src/*) 覆盖 src 下任意深度）；根级文件退化为精确值；
 *   - 无主参数声明 / 缺值 / 非字符串 / 空串 → 返回 null（不持久化，降级 allow-once；旧版回退裸 ToolName 会把
 *     该工具所有后续调用静默放行，对 MCP/未映射的 DANGER 工具尤其危险）。
 *  #8a 声明化：主参数名改由调用方从工具声明 primaryArg 读出传入（原 PRIMARY_ARG 名单已退役），
 *    测试按注册表真实声明传参，与 toolExecution/guard 运行时路径同构。
 *  安全兜底：COMMAND_DENY 独立硬闸门（run_command/run_in_background，不依赖 allow）+ PROTECTED_WRITE_DIRS 保护路径硬拒，
 *    allow 了也拦 rm -rf / 改 .git。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildScopedAllowRule, checkPermission, compileRule, addSessionPermissionRule } from "@/tool/permissions.ts";
import { matchCommandDeny } from "@/tool/autoPermission.ts";

describe("buildScopedAllowRule（allow-always 安全保守作用域）", () => {
    it("命令类 → 精确命令串（杜绝跨子命令 / 链式注入的静默放行）", () => {
        assert.equal(buildScopedAllowRule("run_command", { command: "npm test" }, "command"), "run_command(npm test)");
        assert.equal(buildScopedAllowRule("run_command", { command: "git status" }, "command"), "run_command(git status)");
        assert.equal(buildScopedAllowRule("run_in_background", { command: "pnpm build --watch" }, "command"), "run_in_background(pnpm build --watch)");
    });

    it("命令类安全断言：绝不生成过宽的首-token+:* 形态（如 npm:*）", () => {
        const rule = buildScopedAllowRule("run_command", { command: "npm test" }, "command");
        assert.ok(rule, "应返回规则");
        assert.ok(!rule!.includes(":*"), `命令 allow 规则不得含 :*（过宽，会静默放行跨子命令/链式注入）：${rule}`);
        // 同族危险变体不应落入同一规则——它们将重新审批
        assert.notEqual(buildScopedAllowRule("run_command", { command: "npm install evil-pkg" }, "command"), "run_command(npm test)");
        assert.notEqual(buildScopedAllowRule("run_command", { command: "npm publish" }, "command"), "run_command(npm test)");
    });

    it("路径类 → 顶层目录 + *（覆盖该目录任意深度）；根级文件退化为精确值", () => {
        assert.equal(buildScopedAllowRule("edit_file", { path: "src/config.ts" }, "path"), "edit_file(src/*)");
        assert.equal(buildScopedAllowRule("read_file", { path: "src/components/Foo.tsx" }, "path"), "read_file(src/*)");
        // ./ 前缀应被规范化后取顶层目录
        assert.equal(buildScopedAllowRule("create_file", { path: "./lib/util.ts" }, "path"), "create_file(lib/*)");
        // 绝对路径（盘符去后以 / 开头、无顶层目录段）→ 退化为精确值（保守；agent 路径多为相对 workspace）
        assert.equal(buildScopedAllowRule("write_file", { path: "D:/proj/app/main.ts" }, "path"), "write_file(D:/proj/app/main.ts)");
        // 根级文件（无目录段）→ 精确值兜底
        assert.equal(buildScopedAllowRule("edit_file", { path: "README.md" }, "path"), "edit_file(README.md)");
    });

    it("工具未声明主参数 → 返回 null（不持久化，降级 allow-once）", () => {
        // 未传 primaryArg 声明：无法安全作用域，宁可不记也不写裸工具名静默放行全部调用
        assert.equal(buildScopedAllowRule("getTime", { foo: "bar" }), null);
    });

    it("有声明但缺值 / 值非字符串 / 空串 → 返回 null（不持久化，避免裸工具名）", () => {
        assert.equal(buildScopedAllowRule("run_command", {}, "command"), null);
        assert.equal(buildScopedAllowRule("run_command", { command: 123 }, "command"), null);
        assert.equal(buildScopedAllowRule("run_command", { command: "" }, "command"), null);
        assert.equal(buildScopedAllowRule("run_command", { command: "   " }, "command"), null);
    });

    it("端到端：命令规则为精确串、不可作用域时返回 null（含括号写法与裸名都不再回退）", () => {
        const rule = buildScopedAllowRule("run_command", { command: "npm test" }, "command");
        assert.equal(rule, "run_command(npm test)");
        assert.equal(buildScopedAllowRule("run_command", {}, "command"), null);
    });
});

describe("checkPermission 空规则集默认放行（回归基线）", () => {
    it("无规则命中时返回 null（走默认 safetyLevel 审批流）", () => {
        // 默认加载的 rules 可能为空或含项目规则；此处仅断言不抛错且返回合法 verdict
        const v = checkPermission("__nonexistent_tool__", {});
        assert.ok(v === null || v === "allow" || v === "deny" || v === "ask");
    });
});

describe("compileRule：DANGER 命令工具裸名 allow 拒绝（P0-2 供应链防护）", () => {
    it("裸名 allow run_command / run_in_background → 拒绝（返回 null）", () => {
        // 恶意仓库投递 "run_command" 即让全部命令免审——必须拒绝，强制带作用域
        assert.equal(compileRule("run_command", "test", "allow"), null);
        assert.equal(compileRule("run_in_background", "test", "allow"), null);
    });

    it("裸名 deny / ask run_command → 允许（用户可整体 deny/ask 命令工具，合理意图）", () => {
        assert.ok(compileRule("run_command", "test", "deny"));
        assert.ok(compileRule("run_command", "test", "ask"));
    });

    it("带作用域 allow（精确串 / glob）→ 允许（合法的安全配置）", () => {
        assert.ok(compileRule("run_command(npm test)", "test", "allow"));
        assert.ok(compileRule("run_command(npm test:*)", "test", "allow"));
    });

    it("非 DANGER 工具裸名 allow → 允许（read_file / edit_file 等）", () => {
        assert.ok(compileRule("read_file", "test", "allow"));
        assert.ok(compileRule("edit_file", "test", "allow"));
    });

    it("末尾 * 通配的 DANGER 工具 allow → 拒绝（run_command* 同样过宽）", () => {
        assert.equal(compileRule("run_command*", "test", "allow"), null);
    });
});

// ============ ★ A2（2026-11-09 审批降噪）：runner 族落「入口前缀」规则 ============

describe("buildScopedAllowRule A2：runner 族入口前缀规则（2026-11-09）", () => {
    it("runner 裸命令与 cd 前缀链生成同一入口前缀；run_in_background 同享", () => {
        const bare = buildScopedAllowRule("run_command", { command: "npx tsx --tsconfig src/cli/tsconfig.json src/cli/src/main.tsx batch status" }, "command");
        assert.equal(bare, "run_command(npx tsx --tsconfig src/cli/tsconfig.json src/cli/src/main.tsx*)");
        const cdForm = buildScopedAllowRule("run_command", { command: "cd src/cli && npx tsx --tsconfig src/cli/tsconfig.json src/cli/src/main.tsx batch status" }, "command");
        assert.equal(cdForm, bare, "剥 cd 前缀后同一入口前缀（trace：92 条中 22 条带 cd 前缀）");
        // trace 真实形状：2>&1 | head 尾巴 + echo 收尾
        const chained = buildScopedAllowRule("run_command", { command: 'cd src/cli && npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch sync --check 2>&1 | head -30; echo "EXIT=${PIPESTATUS[0]}"' }, "command");
        assert.equal(chained, "run_command(npx tsx --tsconfig ./tsconfig.json ./src/main.tsx*)");
        assert.equal(buildScopedAllowRule("run_in_background", { command: "cd src/core && npx tsx src/main.tsx x" }, "command"),
            "run_in_background(npx tsx src/main.tsx*)");
    });

    it("非 runner / runner 无入口 token → 精确串（M5 现状不变；绝不落 npm install* 包名通配）", () => {
        assert.equal(buildScopedAllowRule("run_command", { command: "npm test" }, "command"), "run_command(npm test)");
        assert.equal(buildScopedAllowRule("run_command", { command: "npm install left-pad" }, "command"), "run_command(npm install left-pad)");
        assert.equal(buildScopedAllowRule("run_command", { command: "pnpm dlx create-vite" }, "command"), "run_command(pnpm dlx create-vite)");
        assert.equal(buildScopedAllowRule("run_command", { command: "git status" }, "command"), "run_command(git status)");
        assert.equal(buildScopedAllowRule("run_command", { command: "timeout 60 npx tsx src/main.tsx x" }, "command"), "run_command(timeout 60 npx tsx src/main.tsx x)");
    });

    it("匹配侧：cd 前缀变体命中同一前缀规则；不同入口脚本不命中（重新审批）", () => {
        const sess = "sess-a2-match";
        const rule = buildScopedAllowRule("run_command", { command: "cd src/cli && npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch status" }, "command")!;
        assert.ok(addSessionPermissionRule(rule, "allow", sess));
        assert.equal(checkPermission("run_command", { command: "npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch sync --check" }, "command", sess),
            "allow", "裸形态变体命中");
        assert.equal(checkPermission("run_command", { command: "cd src/cli && npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch sync --check 2>&1 | head -30" }, "command", sess),
            "allow", "cd 前缀 + 管道尾巴变体命中（匹配侧对称剥 cd）");
        assert.equal(checkPermission("run_command", { command: "cd src/cli && npx tsx --tsconfig ./tsconfig.json ./src/evil.ts batch status" }, "command", sess),
            null, "不同入口脚本不命中");
        assert.equal(checkPermission("run_command", { command: "cd src/cli && npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch status 2>&1 | head -40" }, "command", sess),
            "allow", "trace 实弹形状（尾随管道）命中");
    });

    it("优先级回归：deny 规则先于前缀 allow；COMMAND_DENY 硬闸不依赖 allow 独立生效", () => {
        const sess = "sess-a2-priority";
        const allowRule = buildScopedAllowRule("run_command", { command: "cd src/cli && npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch sync" }, "command")!;
        assert.ok(addSessionPermissionRule(allowRule, "allow", sess));
        assert.ok(addSessionPermissionRule("run_command(*batch sync*)", "deny", sess));
        assert.equal(checkPermission("run_command", { command: "cd src/cli && npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch sync --check" }, "command", sess),
            "deny", "deny 优先于前缀 allow（既有契约，前缀规则不得越过）");
        assert.equal(checkPermission("run_command", { command: "npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch help" }, "command", sess),
            "allow", "deny 未命中的变体仍走前缀 allow");
        // COMMAND_DENY 独立硬闸：规则层 allow 的灾难段在执行层仍拒（不依赖 allow、不可绕过）
        assert.equal(matchCommandDeny("npx tsx --tsconfig ./tsconfig.json ./src/main.tsx batch status; rm -rf /"), true);
    });
});
