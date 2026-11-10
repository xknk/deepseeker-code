/**
 * @file cli/tests/batch-tool-matrix.test.ts
 * @description batch 工具全量矩阵守门（2026-11-10「不要我说哪个才测哪个」）。
 *
 *  与逐腿真机票互补的系统性底座：直接枚举 live agentTools 注册表，逐工具断言
 *  「无解锁票（S0）下的可见性与审批走向」，与下方分类表双向对账——
 *   - 注册表有、表里没有 → 测试红（新工具/漏分类，逼补行）；
 *   - 表里有、注册表没有 → 测试红（工具已删，表过期）。
 *  「忘了测某个工具」从此结构性不可能。分类语义（对齐 toolExecution 安全链）：
 *   hidden=对模型不可见（缺省禁用，tools: 可解锁） / safe=可见免审（SAFE 级） /
 *   edit=可见且自动放行（编辑白名单 MUTATION） / card=可见但走审批（白天弹卡·夜间自动拒）。
 *  另配：解锁场景（逐名/通配/伪槽位）+ MCP 分发器合成形态 + N5 闸门流式协议单测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { agentTools } = await import("@/tool/index.ts");
const { buildBatchToolPolicy, makeInterpreterGateWrapper } = await import("../src/batchRunner.ts");

// ============ S0 全量分类表（无 tools: 解锁） ============

const S0: Record<string, "hidden" | "safe" | "edit" | "card"> = {
    // —— 缺省禁用（batchAllowed:false + 名单；tools: 显式解锁才可见）——
    run_command: "hidden",
    delete_path: "hidden",
    run_in_background: "hidden",
    // —— 编辑白名单（MUTATION 级，审批自动应答器 allow-once）——
    edit_file: "edit",
    create_file: "edit",
    write_file: "edit",
    move_file: "edit",
    notebook_edit: "edit",
    // —— 可见但走审批（DANGER / MUTATION-not-whitelisted：白天卡、夜间自动拒留痕）——
    enter_worktree: "card",
    exit_worktree: "card",
    http_request: "card",
    ide_run_task: "card",
    web_fetch: "card",
    web_search: "card",
    git_commit: "card",   // runner 收尾自己提交；agent 中途提交是显式动作，过卡合理
    memory_delete: "card", // 跨会话持久删除，不可逆
    undo_restore: "card",  // 改写磁盘文件
    // —— 只读/免审（SAFE 级，含交互与检索类）——
    ask_question: "safe",
    find_references: "safe",
    get_background_output: "safe",
    get_diagnostics: "safe",
    get_git_diff: "safe",
    git_log: "safe",
    git_status: "safe",
    glob: "safe",
    goto_definition: "safe",
    ide_diagnostics: "safe",
    ide_open_file: "safe",
    inspect_dependencies: "safe",
    list_dir: "safe",
    memory_list: "safe",
    memory_read: "safe",
    memory_save: "safe", // 有意设计：记忆写入非破坏性、免审
    read_docx: "safe",
    read_file: "safe",
    read_image: "safe",
    read_pdf: "safe",
    read_project_guide: "safe",
    read_xlsx: "safe",
    recall: "safe",
    run_workflow: "safe",
    search_grep: "safe",
    spawn_agent: "safe", // 子代理委派是既定设计（批内可用）
    stop_background_task: "safe",
    todo_write: "safe",
    undo_list: "safe",
    view_symbol_outline: "safe",
    wait_http_ready: "safe",
    worktree_status: "safe",
};

// ============ 注册表 ↔ 分类表双向对账 ============

test("注册表全量对账：每个工具都有分类（漏一个就红），分类表无僵尸条目", () => {
    const registryNames = agentTools.map((x: any) => x?.function?.name).filter(Boolean) as string[];
    const unclassified = registryNames.filter((n: string) => !(n in S0));
    assert.deepEqual(unclassified, [], `新工具进注册表必须同步补分类表（batch-tool-matrix.test.ts）：${unclassified.join(", ")}`);
    const stale = Object.keys(S0).filter((n) => !registryNames.includes(n));
    assert.deepEqual(stale, [], `分类表条目已不在注册表（工具已删，表过期）：${stale.join(", ")}`);
});

test("S0 逐工具断言：可见性与审批走向与分类表一致（49 工具全覆盖）", () => {
    const policy = buildBatchToolPolicy([]);
    for (const x of agentTools as any[]) {
        const name = x?.function?.name as string;
        const cat = S0[name];
        const level = x?.function?.safetyLevel;
        const visible = policy.isVisible(x);
        const allowed = policy.isApprovalAllowed(name);
        const wouldAsk = visible && level !== "safe" && !allowed; // toolExecution：SAFE 免审；MUTATION/DANGER 必问（batch 宿主决定放行/卡/拒）
        switch (cat) {
            case "hidden":
                assert.equal(visible, false, `${name} 应缺省不可见`);
                break;
            case "safe":
                assert.equal(visible, true, `${name} 应可见`);
                assert.equal(level, "safe", `${name} 声明应为 SAFE`);
                assert.equal(wouldAsk, false, `${name} 不应触发审批`);
                break;
            case "edit":
                assert.equal(visible, true, `${name} 应可见`);
                assert.equal(allowed, true, `${name} 应被编辑白名单自动放行`);
                break;
            case "card":
                assert.equal(visible, true, `${name} 应可见`);
                assert.equal(allowed, false, `${name} 未解锁不应自动放行`);
                assert.equal(wouldAsk, true, `${name} 应走审批（白天卡/夜间自动拒）`);
                break;
        }
    }
});

// ============ 解锁场景 ============

test("tools: run_command → 可见 + 自动放行（w7ez 场景；真机票已真机验证）", () => {
    const policy = buildBatchToolPolicy(["run_command"]);
    const schema = agentTools.find((x: any) => x?.function?.name === "run_command");
    assert.ok(schema);
    assert.equal(policy.isVisible(schema), true);
    assert.equal(policy.isApprovalAllowed("run_command"), true);
});

test("tools: mcp__playwright__* → 合成 MCP 工具名逐个放行；别的 server 不沾光", () => {
    const policy = buildBatchToolPolicy(["mcp__playwright__*"]);
    assert.equal(policy.isApprovalAllowed("mcp__playwright__browser_click"), true);
    assert.equal(policy.isApprovalAllowed("mcp__playwright__browser_wait_for"), true);
    assert.equal(policy.isApprovalAllowed("mcp__context7__query"), false);
});

test("MCP 分发器合成形态（运行期注入）：mcp_call DANGER 可见走卡（解锁后放行）；mcp_list_tools SAFE 免审", () => {
    const policy = buildBatchToolPolicy([]);
    const mcpCall = { type: "function", function: { name: "mcp_call", safetyLevel: "danger" } };
    const mcpList = { type: "function", function: { name: "mcp_list_tools", safetyLevel: "safe" } };
    assert.equal(policy.isVisible(mcpCall), true);
    assert.equal(policy.isApprovalAllowed("mcp_call"), false); // 未解锁 → 卡（合成名修复后批面正确匹配）
    const unlocked = buildBatchToolPolicy(["mcp__playwright__*"]);
    assert.equal(unlocked.isApprovalAllowed("mcp__playwright__browser_navigate"), true);
    assert.equal(policy.isVisible(mcpList), true);
    assert.equal(policy.isApprovalAllowed("mcp_list_tools"), false); // SAFE 本就不问，白名单无关紧要
});

test("tools: delete_path + interpreter 伪槽位 → 危险工具解锁、闸门逃生门就位", () => {
    const policy = buildBatchToolPolicy(["delete_path", "interpreter"]);
    const schema = agentTools.find((x: any) => x?.function?.name === "delete_path");
    assert.ok(schema);
    assert.equal(policy.isVisible(schema), true);
    assert.equal(policy.isApprovalAllowed("delete_path"), true);
    assert.equal(policy.unlocked.has("interpreter"), true);
});

// ============ N5 供应链闸门流式协议（w7ez 实锤回归钉） ============

const SENTINEL = "⟦DSC_EXIT:0⟧";

const fakeCommandTool = (name: string) => ({
    type: "function",
    function: {
        name,
        async *execute(args: any, _ctx: any) {
            yield `out:${args.command}`;
            yield SENTINEL;
        },
    },
});

const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
    const out: string[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
};

test("闸门协议：包装后 execute 仍是 AsyncGenerator（普通 async 返回 generator=空壳 {} 根因）", async () => {
    const wrap = makeInterpreterGateWrapper({ unlocked: new Set(), onDeny: () => {} });
    const wrapped = wrap(fakeCommandTool("run_command"));
    const result = wrapped.function.execute({ command: "echo x > f" }, {});
    assert.equal(typeof (result as any)[Symbol.asyncIterator], "function", "包装必须保持流式协议");
    await result.return?.();
});

test("闸门协议：放行命令 yield* 委托原 generator——输出与退出码哨兵逐块透传", async () => {
    const wrap = makeInterpreterGateWrapper({ unlocked: new Set(), onDeny: () => {} });
    const wrapped = wrap(fakeCommandTool("run_command"));
    const chunks = await collect(wrapped.function.execute({ command: "echo cmd-ok > f.md" }, {}));
    assert.deepEqual(chunks, ["out:echo cmd-ok > f.md", SENTINEL]);
});

test("闸门协议：解释器直跑仓库脚本（未解锁 interpreter）→ yield 拒绝文案且不执行原命令", async () => {
    const denies: { tool: string; cmd: string; why: string }[] = [];
    const wrap = makeInterpreterGateWrapper({
        unlocked: new Set(),
        onDeny: (tool, cmd, why) => denies.push({ tool, cmd, why }),
    });
    const wrapped = wrap(fakeCommandTool("run_command"));
    const chunks = await collect(wrapped.function.execute({ command: "node ./scripts/build.js" }, {}));
    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /供应链闸门/);
    assert.match(chunks[0], /interpreter/);
    assert.equal(denies.length, 1);
    assert.equal(denies[0].tool, "run_command");
    assert.equal(denies[0].cmd, "node ./scripts/build.js");
    assert.ok(!chunks.includes("out:node ./scripts/build.js"), "原命令不得执行");
});

test("闸门协议：tools: interpreter 解锁后同命令放行；非命令工具原样透传", async () => {
    const wrap = makeInterpreterGateWrapper({ unlocked: new Set(["interpreter"]), onDeny: () => {} });
    const wrapped = wrap(fakeCommandTool("run_command"));
    const chunks = await collect(wrapped.function.execute({ command: "node ./scripts/build.js" }, {}));
    assert.deepEqual(chunks, ["out:node ./scripts/build.js", SENTINEL]);
    const other = fakeCommandTool("read_file");
    assert.equal(wrap(other), other, "非 run_command/run_in_background 不包装");
});
