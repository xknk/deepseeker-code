/**
 * @file kernel-audit-fourthbatch.test.ts
 * @description 内核审查报告第四批（收尾批）守门测试（报告 v3.6，基线 732225d）：
 *  - I-4   allow-session 真会话级（P3 修复）：同进程双会话桶隔离、清桶失效、遗留全局路径零变化、
 *          合并优先级不变（deny>ask>allow）、桶容量上限防 serve 常驻进程无界增长；
 *          接线结构（toolExecution/toolScheduling 传 sessionId、guard 入账带 ctx.sessionId、双宿主清桶）。
 *  - I-3   CLI 后置命令：restoreByUndoId 选择性回退（按 id、防重复、creation_marker 删新建）、
 *          buildRunDiff 净变化红绿汇总（file_content/creation_marker/备份缺失降级/无净变化剔除/已回退过滤）、
 *          CLI 注册与文案结构（LOCAL_COMMAND_NAMES、双语 help、App 分发、组件落位）。
 *  - I-6   CLI 审批完整内容展开：fullDetail 透传链（cliHost meta → PendingApproval → ApprovalModal）+ f 键。
 *  - P2-10 processToolCall 拆分（纯移动）：四阶段编排顺序 + 安全链内部顺序敏感链逐环节钉死。
 *
 *  约定：permissions/undo 等模块加载期即读 dataDir 配置，**静态 import 会先于模块体执行**（env 未及
 *  设置即用真实 ~/.deepseeker-code）——故一律在 env 沙盒就位后动态 import（secondbatch 同法）；
 *  cli/src/diffSummary.ts 为纯 node 数据装配（无 React），可跨包动态加载（@/ 别名经 core tsconfig
 *  解析到 core 模块，与产线 specifier 语义一致）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// —— 沙盒先于一切动态 import（permissions/config 模块加载期即读 dataDir）——
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-audit4-"));
process.env.DEEPSEEKER_CODE_DATA_DIR = SANDBOX;
process.env.WORKSPACE_ROOT = SANDBOX;

const CORE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(CORE_ROOT, "..", "..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(CORE_ROOT, rel), "utf-8");
const readCli = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, "src", "cli", rel), "utf-8");
const readVsc = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, "src", "vscode", rel), "utf-8");

// —— 被测模块（env 就位后动态加载）——
const { initPermissions, checkPermission, addSessionPermissionRule, clearSessionPermissionRules } =
    await import("@/tool/permissions.ts");
const { appendUndoRecord, readUndoIndex } = await import("@/tool/undo/index.ts");
const { restoreByUndoId } = await import("@/tool/undo/restore.ts");
const { getUndoBackupRoot } = await import("@/tool/undo/store.ts");
const { buildRunDiff } = await import("../../cli/src/diffSummary.ts");

/** 写工作区文件（WORKSPACE_ROOT=SANDBOX，Windows 下 path.join 拼 "/" 相对路径）。 */
const writeWs = async (rel: string, content: string): Promise<string> => {
    const abs = path.join(SANDBOX, ...rel.split("/"));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content, "utf-8");
    return abs;
};
const readWs = async (rel: string): Promise<string | null> => {
    try { return await fs.promises.readFile(path.join(SANDBOX, ...rel.split("/")), "utf-8"); }
    catch { return null; }
};

describe("内核审查报告第四批守门（I-4 / I-3 / I-6 / P2-10）", () => {

    // ==================== I-4 allow-session 真会话级 ====================
    describe("I-4 allow-session 真会话级（P3 修复）", () => {
        it("同进程双会话隔离（行为断言）：A 入账 allow，B 与无会话均不可见", async () => {
            await initPermissions(false); // 沙盒空配置起点（无全局/项目规则）
            const a = "audit4-sess-A", b = "audit4-sess-B";
            assert.equal(addSessionPermissionRule("edit_file", "allow", a), true, "入账须成功");
            assert.equal(checkPermission("edit_file", { path: "src/a.ts" }, "src/a.ts", a), "allow",
                "会话 A 内须命中自己的桶规则");
            assert.equal(checkPermission("edit_file", { path: "src/a.ts" }, "src/a.ts", b), null,
                "会话 B 不得看到 A 的桶（跨会话隔离）");
            assert.equal(checkPermission("edit_file", { path: "src/a.ts" }, "src/a.ts"), null,
                "缺省（无 sessionId）走全局，不得看到会话桶");
        });

        it("SessionEnd 等价路径清桶后失效；遗留无 sessionId 入账仍进全局（零变化项）", async () => {
            const c = "audit4-sess-C";
            addSessionPermissionRule("web_fetch", "allow", c);
            assert.equal(checkPermission("web_fetch", { url: "https://x.example" }, "https://x.example", c), "allow");
            clearSessionPermissionRules(c);
            assert.equal(checkPermission("web_fetch", { url: "https://x.example" }, "https://x.example", c), null,
                "清桶（宿主会话切换/删除）后须立即失效");
            // 遗留兼容：不带 sessionId 的入账仍进全局规则（CLI 单会话体感零变化）
            addSessionPermissionRule("glob", "allow");
            assert.equal(checkPermission("glob", { pattern: "*" }, "*", undefined), "allow", "全局规则无会话可见");
            assert.equal(checkPermission("glob", { pattern: "*" }, "*", "audit4-any-sess"), "allow", "全局规则对所有会话可见");
        });

        it("合并优先级不变：桶 deny 压过全局 allow；桶 allow 压不过全局 ask（deny>ask>allow）", () => {
            const s1 = "audit4-sess-P1", s2 = "audit4-sess-P2";
            addSessionPermissionRule("edit_file", "allow"); // 全局 allow（内存级，不落盘）
            addSessionPermissionRule("edit_file", "deny", s1);
            assert.equal(checkPermission("edit_file", {}, undefined, s1), "deny",
                "桶 deny 须与全局 deny 合并后最优先判定");
            addSessionPermissionRule("edit_file", "ask"); // 全局 ask
            addSessionPermissionRule("edit_file", "allow", s2);
            assert.equal(checkPermission("edit_file", {}, undefined, s2), "ask",
                "全局 ask 优先于桶 allow——会话化不改变四级优先序");
        });

        it("桶容量上限（SESSION_BUCKET_CAP）：最旧会话被淘汰，serve 常驻进程不无界增长", () => {
            const tool = "audit4_evict_tool";
            // 首会话先入账，再灌满至淘汰线（64），第 65 个入账时首个被逐出
            const first = "audit4-evict-000";
            addSessionPermissionRule(tool, "allow", first);
            for (let i = 1; i < 65; i++) {
                addSessionPermissionRule(tool, "allow", `audit4-evict-${String(i).padStart(3, "0")}`);
            }
            assert.equal(checkPermission(tool, {}, undefined, "audit4-evict-064"), "allow", "最新桶仍在");
            assert.equal(checkPermission(tool, {}, undefined, first), null, "最旧桶被容量淘汰");
        });

        it("接线结构：checkPermission 调用点传 sessionId、guard 入账带 ctx.sessionId、双宿主清桶", () => {
            const tex = readRepo("src/agent/toolExecution.ts");
            assert.match(tex,
                /checkPermission\(resolveMcpPermissionName\(calledName, state\.calledArgs\), state\.calledArgs, matchedTool\.function\.primaryArg, sessionId\)/,
                "执行层权限判定须传会话 id");
            const sched = readRepo("src/agent/toolScheduling.ts");
            assert.match(sched, /checkPermission\([^)]*sessionId\)/, "调度层 canParallelize 同样按会话判定");
            const guard = readRepo("src/tool/guard.ts");
            assert.match(guard, /addSessionPermissionRule\(ruleStr, 'allow', ctx\.sessionId\)/,
                "allow-session 入账必须归属当前会话（否则跨会话放行=P3 缺陷复活）");
            assert.match(readCli("src/useChatState.ts"), /clearSessionPermissionRules\(/,
                "CLI 会话切换（loadSession/newSession）须清上一会话桶");
            assert.match(readVsc("src/host.ts"), /clearSessionPermissionRules\(/,
                "VSCode setSessionId/deleteSession 须清桶");
        });
    });

    // ==================== I-3 /rewind 选择性回退 + /diff 本 run 汇总 ====================
    describe("I-3 CLI 后置命令（/rewind + /diff）", () => {
        it("restoreByUndoId 选择性回退：目标还原、他文件不动、防重复回退、creation_marker 删新建", async () => {
            const sid = `audit4-i3-${Date.now()}`;
            const now = Date.now();
            // a.txt / b.txt 各一条 file_content 记录（备份=写前 old，磁盘已改成 new）
            await writeWs("audit4/a.txt", "AAA-new\n");
            await writeWs("audit4/b.txt", "BBB-new\n");
            await writeWs("audit4/c-new.txt", "全新文件内容\n");
            const backupRoot = getUndoBackupRoot(sid);
            const mkRecord = (undoId: string, rel: string, kind: string, ts: number): any => ({
                undoId, toolsId: `tid-${undoId.slice(0, 6)}`, sessionId: sid, operationType: "edit_file",
                relativePath: rel, backupKind: kind, backupPath: kind === "creation_marker" ? "" : path.join(backupRoot, undoId, "content"),
                timestamp: new Date(ts).toISOString(), bornDate: new Date(ts).toISOString().slice(0, 10),
            });
            const r1 = mkRecord("audit4undo-aaaa-0001", "audit4/a.txt", "file_content", now - 60_000);
            const r2 = mkRecord("audit4undo-bbbb-0002", "audit4/b.txt", "file_content", now);
            const r3 = mkRecord("audit4undo-cccc-0003", "audit4/c-new.txt", "creation_marker", now);
            await fs.promises.mkdir(path.join(backupRoot, r1.undoId), { recursive: true });
            await fs.promises.writeFile(path.join(backupRoot, r1.undoId, "content"), "AAA-old\n", "utf-8");
            await fs.promises.mkdir(path.join(backupRoot, r2.undoId), { recursive: true });
            await fs.promises.writeFile(path.join(backupRoot, r2.undoId, "content"), "BBB-old\n", "utf-8");
            await appendUndoRecord(r1, sid);
            await appendUndoRecord(r2, sid);
            await appendUndoRecord(r3, sid);

            // 选择性回退 r1：只有 a.txt 被还原，b.txt 保持 new
            const msg = await restoreByUndoId(r1.undoId, sid);
            assert.ok(msg.startsWith("✅"), `回退应成功，实得：${msg.slice(0, 80)}`);
            assert.equal(await readWs("audit4/a.txt"), "AAA-old\n", "目标文件须还原为备份内容");
            assert.equal(await readWs("audit4/b.txt"), "BBB-new\n", "未选择的文件不得被波及（选择性≠restoreLast）");

            // 索引状态：r1 已标记、r2 未动
            const idx = await readUndoIndex(sid);
            const r1After = idx.find(x => x.undoId === r1.undoId);
            const r2After = idx.find(x => x.undoId === r2.undoId);
            assert.equal(r1After?.restored, true, "已回退记录须标记 restored");
            assert.ok(!r2After?.restored, "未回退记录不得被误标");

            // 防重复回退
            const again = await restoreByUndoId(r1.undoId, sid);
            assert.ok(again.startsWith("❌"), "已回退记录须拒绝二次回退");

            // creation_marker：回退=删除新建文件
            const msg3 = await restoreByUndoId(r3.undoId, sid);
            assert.ok(msg3.startsWith("✅"), `creation_marker 回退应成功，实得：${msg3.slice(0, 80)}`);
            assert.equal(await readWs("audit4/c-new.txt"), null, "新建文件须被删除");
        });

        it("buildRunDiff：净变化红绿行、creation_marker 全绿、备份缺失降级 note、无净变化与已回退剔除", async () => {
            const sid = `audit4-diff-${Date.now()}`;
            const backupRoot = getUndoBackupRoot(sid);
            const now = Date.now();
            const mk = (undoId: string, rel: string, kind: string, restored?: boolean): any => ({
                undoId, toolsId: `tid-${undoId.slice(6, 10)}`, sessionId: sid, operationType: "edit_file",
                relativePath: rel, backupKind: kind,
                backupPath: kind === "creation_marker" ? "" : path.join(backupRoot, undoId, "content"),
                timestamp: new Date(now).toISOString(), bornDate: new Date(now).toISOString().slice(0, 10),
                ...(restored ? { restored: true } : {}),
            });
            // d1：file_content 净变化（l2 → l3）
            await writeWs("audit4/d1.txt", "l1\nl3\n");
            await fs.promises.mkdir(path.join(backupRoot, "diff-undo-0001"), { recursive: true });
            await fs.promises.writeFile(path.join(backupRoot, "diff-undo-0001", "content"), "l1\nl2\n", "utf-8");
            // d2：creation_marker（磁盘存在）
            await writeWs("audit4/d2.txt", "brand new line\n");
            // d3：备份缺失
            await writeWs("audit4/d3.txt", "内容无关紧要\n");
            // d4：无净变化（备份=磁盘）
            await writeWs("audit4/d4.txt", "same\n");
            await fs.promises.mkdir(path.join(backupRoot, "diff-undo-0004"), { recursive: true });
            await fs.promises.writeFile(path.join(backupRoot, "diff-undo-0004", "content"), "same\n", "utf-8");
            // d5：已回退（restored）
            await writeWs("audit4/d5.txt", "已被回退的文件\n");

            const out = await buildRunDiff(sid, [
                mk("diff-undo-0001", "audit4/d1.txt", "file_content"),
                mk("diff-undo-0002", "audit4/d2.txt", "creation_marker"),
                mk("diff-undo-0003", "audit4/d3.txt", "file_content"),
                mk("diff-undo-0004", "audit4/d4.txt", "file_content"),
                mk("diff-undo-0005", "audit4/d5.txt", "file_content", true),
            ]);
            const byPath = new Map(out.map(f => [f.path, f]));

            const d1 = byPath.get("audit4/d1.txt");
            assert.ok(d1?.rows, "净变化文件须产出红绿行");
            assert.ok(d1.rows!.some(r => r.t === "del" && r.s.includes("l2")), "须含删除行（改前内容）");
            assert.ok(d1.rows!.some(r => r.t === "add" && r.s.includes("l3")), "须含新增行（改后内容）");

            const d2 = byPath.get("audit4/d2.txt");
            assert.ok(d2?.rows && d2.rows.length > 0, "creation_marker 须以空串为改前产出全绿新增");
            assert.ok(d2.rows!.every(r => r.t !== "del"), "新建文件不得出现删除行");

            const d3 = byPath.get("audit4/d3.txt");
            assert.ok(d3 && d3.rows === null && d3.note, "备份缺失须降级为 note 行而非抛错");

            assert.ok(!byPath.has("audit4/d4.txt"), "无净变化文件不进汇总");
            assert.ok(!byPath.has("audit4/d5.txt"), "已回退记录被过滤");
        });

        it("CLI 注册与文案结构：命令表、双语 help、App 分发、组件落位、选择性回退接线", () => {
            const strings = readCli("src/strings.ts");
            assert.match(strings, /"usage",\s*"rewind",\s*"diff"/,
                "LOCAL_COMMAND_NAMES 注册（紧随 usage，第三批守门形态不破坏）");
            for (const kw of ["/rewind", "/diff"]) {
                assert.ok((strings.match(new RegExp(kw.replace("/", "\\/"), "g")) || []).length >= 2,
                    `${kw} 须在 zh/en 两份 helpText 同时出现`);
            }
            const app = readCli("src/App.tsx");
            assert.match(app, /case "rewind"/, "runLocalSlash 须分发 /rewind");
            assert.match(app, /case "diff"/, "runLocalSlash 须分发 /diff");
            assert.match(app, /RewindPicker/, "回退选择器组件接线");
            assert.match(app, /DiffSummaryCard/, "diff 汇总卡组件接线");
            assert.ok(fs.existsSync(path.join(REPO_ROOT, "src", "cli", "src", "components", "RewindPicker.tsx")), "组件文件存在");
            assert.ok(fs.existsSync(path.join(REPO_ROOT, "src", "cli", "src", "components", "DiffSummaryCard.tsx")), "组件文件存在");
            const ucs = readCli("src/useChatState.ts");
            assert.match(ucs, /listUndoable/, "/rewind 须先列可回退检查点");
            assert.match(ucs, /restoreByUndoId/, "选择后按 undoId 选择性回退（非仅 restoreLast）");
            assert.match(ucs, /buildRunDiff/, "/diff 复用 undo 记录装配汇总");
        });
    });

    // ==================== I-6 CLI 审批完整内容展开 ====================
    describe("I-6 CLI 审批「查看完整内容」", () => {
        it("透传链结构：cliHost meta.fullDetail → PendingApproval → ApprovalModal expanded → f 键切换", () => {
            assert.match(readCli("src/cliHost.ts"), /meta\.fullDetail/,
                "CLI 审批桥须透传截断前全文");
            const ucs = readCli("src/useChatState.ts");
            assert.match(ucs, /fullDetail/, "PendingApproval 须承载 fullDetail");
            const modal = readCli("src/components/ApprovalModal.tsx");
            assert.match(modal, /expanded/, "展开态 prop");
            assert.match(modal, /MAX_FULL_LINES/, "展开态仍须绝对上限防糊屏");
            assert.match(readCli("src/App.tsx"), /ch === "f" \|\| ch === "F"/, "按 f 切换展开");
        });
    });

    // ==================== P2-10 processToolCall 拆分（纯移动） ====================
    describe("P2-10 processToolCall 四阶段拆分", () => {
        it("编排顺序：resolveEarlyOutcome → runSecurityGates → executeTool（!denied 门）→ finalizeOutcome", () => {
            const tex = readRepo("src/agent/toolExecution.ts");
            const at = (needle: string): number => tex.indexOf(needle);
            const early = at("const early = resolveEarlyOutcome(");
            const gates = at("await runSecurityGates(");
            const exec = at("if (!state.denied) await executeTool(");
            const fin = at("return await finalizeOutcome(");
            assert.ok(early > 0, "阶段一（终结/abort/计划门禁）须存在");
            assert.ok(gates > early, "阶段二须在阶段一之后");
            assert.ok(exec > gates, "阶段三须在阶段二之后且带 !denied 门");
            assert.ok(fin > exec, "阶段四收尾恒达（无论是否 denied）");
        });

        it("安全链内部顺序敏感链逐环节钉死（hook→保护路径→权限→灾难命令→锁→分类器→审批→旧位hook→undo备份）", () => {
            const tex = readRepo("src/agent/toolExecution.ts");
            const chain = [
                "runPreHooks(resolveMcpPermissionName(calledName, calledArgs)",      // pre-hook 改写位
                "isProtectedWrite(p, toolCtx.cwd)",                                   // 保护路径硬拒
                "checkPermission(resolveMcpPermissionName",                           // 权限规则（显式 allow/ask/deny）
                "matchCommandDeny(",                                                  // 灾难命令硬闸（不可被 allow 绕过）
                "isLockHeld(state.lockKey)",                                          // 后台工具互斥锁
                "runAutoCheck(resolveMcpPermissionName",                              // 分类器
                "requestApproval(calledName,",                                        // 人工审批
                "runPreHooks(resolveMcpPermissionName(calledName, state.calledArgs)", // 旧位 pre-hook
                "beforeMutationBackup(matchedTool.function.triggersUndo",             // undo 写前备份
            ];
            let prev = -1;
            for (const needle of chain) {
                const pos = tex.indexOf(needle, prev + 1);
                assert.ok(pos > prev, `安全链顺序破坏：[${needle}] 未按序出现（安全链顺序是行为红线）`);
                prev = pos;
            }
        });

        it("拆分形态自证：ToolCallState 中间态 + 四阶段独立函数 + processToolCall 编排器", () => {
            const tex = readRepo("src/agent/toolExecution.ts");
            assert.match(tex, /type ToolCallState = \{/, "可变中间态类型落位");
            assert.match(tex, /const resolveEarlyOutcome = \(/, "阶段一独立函数");
            assert.match(tex, /const runSecurityGates = async \(/, "阶段二独立函数");
            assert.match(tex, /const executeTool = async \(/, "阶段三独立函数");
            assert.match(tex, /const finalizeOutcome = async \(/, "阶段四独立函数");
            assert.match(tex, /export const processToolCall = async \(/, "processToolCall 保留为编排器与对外签名");
        });
    });
});
